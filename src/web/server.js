import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { VisitorSessions } from './visitors.js'
import { MemoryStore } from '../storage/memory.js'
import { WhatsAppManager } from '../whatsapp/manager.js'
import { normalizePhone } from '../utils/phone.js'
import { maskNumber } from '../utils/phone.js'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets')
const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const TOKEN_TTL_MS = 10 * 60_000 // durée pendant laquelle la personne qui appaire peut voir le code / QR / SESSION_ID
const PAIR_COOLDOWN_MS = 15_000
const MAX_BODY = 64 * 1024
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"

const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest()
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b))

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function clientIp(req) {
  const forwarded = process.env.RENDER === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() : ''
  return forwarded || req.socket?.remoteAddress || '?'
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'Requête trop volumineuse.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    throw new HttpError(400, 'JSON invalide.')
  }
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string'
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...headers,
  })
  res.end(isText ? body : JSON.stringify(body))
}

/** Fichiers du dossier public/assets (un seul niveau, noms simples : pas de « .. » possible). */
async function sendAsset(res, rawName, head) {
  let name = ''
  try {
    name = decodeURIComponent(rawName)
  } catch {}
  const type = ASSET_TYPES[path.extname(name).toLowerCase()]
  if (!type || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return send(res, 404, { error: 'Page introuvable.' })
  let body
  try {
    body = await readFile(path.join(ASSETS_DIR, name))
  } catch {
    return send(res, 404, { error: 'Page introuvable.' })
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(head ? undefined : body)
}

/** Catalogue public des commandes (le même que .help), pour la page « Commandes » du site. */
function buildCatalog(commands, prefix) {
  const help = Array.isArray(commands?.HELP) ? commands.HELP : []
  const table = commands?.COMMANDS || {}
  return {
    prefix,
    categories: (commands?.HELP_CATS || []).map(([id, title]) => ({ id, title })),
    commands: help.map((h) => ({
      cmd: h.cmd,
      cat: h.cat,
      args: h.args || '',
      short: h.short || '',
      detail: h.detail || '',
      examples: h.examples || [],
      aliases: Object.keys(table).filter((k) => k !== h.cmd && table[h.cmd] && table[k] === table[h.cmd]),
    })),
  }
}

/** Site public de sessions isolées et administration privée du compte propriétaire. */
export function createWebServer({ wa, config, log, settings, commands, visitors = new VisitorSessions({
  max: config.maxPublicSessions || 10,
  createManager: () => new WhatsAppManager({ kv: new MemoryStore(), log }),
}) }) {
  const adminSessions = new Map()
  const cookieName = 'wai_admin'
  const cookieOptions = `Path=/api/admin; HttpOnly; SameSite=Strict${config.externalUrl?.startsWith('https:') ? '; Secure' : ''}`
  const publicDefaults = { status: 'idle', connected: false, hasSession: false, pairing: null, qr: null,
    storage: 'memory', needsPassword: false, canPair: true, sessionAvailable: false,
    botName: config.botName || 'Nova', uptime: Math.round(process.uptime()) }

  const hasPassword = Boolean(config.adminPassword)
  const catalog = buildCatalog(commands, config.prefix || '.')
  let token = null // { value, expiresAt } remis à la personne qui vient de demander un code ou un QR
  let lastPairAt = 0
  const failures = new Map() // ip -> { count, until } (anti force brute)

  function checkBruteForce(ip) {
    const f = failures.get(ip)
    if (f && f.until > Date.now() && f.count >= 10) throw new HttpError(429, 'Trop de tentatives. Réessaie dans 10 minutes.')
  }

  function noteFailure(ip) {
    const now = Date.now()
    const f = failures.get(ip)
    if (!f || f.until < now) failures.set(ip, { count: 1, until: now + 10 * 60_000 })
    else f.count++
    if (failures.size > 1000) failures.delete(failures.keys().next().value)
  }

  function isAdmin(req) {
    if (!hasPassword) return false
    const value = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    const until = adminSessions.get(value)
    if (!until || until <= Date.now()) { adminSessions.delete(value); return false }
    return true
  }

  function requireAdmin(req) {
    if (!hasPassword) {
      throw new HttpError(403, "Ajoute la variable ADMIN_PASSWORD sur Render pour utiliser cette fonction depuis le site (ou envoie .session dans ta discussion « Moi »).")
    }
    if (!isAdmin(req)) throw new HttpError(401, 'Mot de passe incorrect.')
  }

  function requirePairingAllowed(req) { requireAdmin(req) }

  function tokenFrom(req, url) {
    return String(req.headers['x-pair-token'] || '')
  }

  function validToken(value) {
    return Boolean(token && value && token.expiresAt > Date.now() && safeEqual(value, token.value))
  }

  function newToken() {
    token = { value: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + TOKEN_TTL_MS }
    return token.value
  }

  function throttlePairing() {
    const wait = lastPairAt + PAIR_COOLDOWN_MS - Date.now()
    if (wait > 0) throw new HttpError(429, `Patiente ${Math.ceil(wait / 1000)} s avant de redemander un code.`)
    lastPairAt = Date.now()
  }

  function statusFor(req, url) {
    const st = wa.publicStatus()
    const trusted = true // statusFor is only reached by authenticated admin routes
    return {
      status: st.status,
      connected: st.connected,
      me: st.me ? { number: st.me.number ? maskNumber(st.me.number) : null, name: st.me.name || null } : null,
      hasSession: st.hasSession,
      storage: st.storage,
      lastError: st.lastError,
      connectedAt: st.connectedAt,
      botName: settings?.get('botName') || config.botName,
      model: settings?.get('model') || config.nvidiaModel || null,
      aiConfigured: Boolean(config.nvidiaApiKey),
      uptime: Math.round(process.uptime()),
      needsPassword: hasPassword,
      canPair: hasPassword || !st.connected,
      pairing: trusted && st.pairing ? { code: st.pairing.code, expiresAt: st.pairing.expiresAt } : null,
      qr: trusted ? st.qr : null,
      sessionAvailable: trusted && st.connected,
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    let route = `${req.method} ${url.pathname}`
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      const expected = config.externalUrl || `http://${req.headers.host}`
      if (req.headers.origin !== new URL(expected).origin) throw new HttpError(403, 'Origine refusée.')
    }
    // Routes publiques : aucun accès au gestionnaire WhatsApp du propriétaire.
    if (route === 'POST /api/visitors') return send(res, 201, visitors.create(clientIp(req)))
    if (route === 'GET /api/status') {
      const value = tokenFrom(req, url)
      return send(res, 200, { ...publicDefaults, ...(value ? visitors.status(value) : {}), uptime: Math.round(process.uptime()) })
    }
    if (route === 'POST /api/pair' || route === 'POST /api/qr') {
      const value = tokenFrom(req, url)
      visitors.get(value)
      const body = await readJson(req)
      const phone = route.endsWith('/qr') ? null : normalizePhone(String(body.phone || ''))
      const result = await visitors.pair(value, phone)
      return send(res, 200, { ...result, token: value })
    }
    if (route === 'GET /api/session') return send(res, 200, { sessionId: visitors.export(tokenFrom(req, url)) })
    if (route === 'DELETE /api/visitors') {
      visitors.get(tokenFrom(req, url))
      visitors.remove(tokenFrom(req, url))
      return send(res, 200, { ok: true })
    }
    if (route === 'POST /api/import' || route === 'POST /api/logout' || route === 'POST /api/login') throw new HttpError(404, 'Page introuvable.')
    if (url.pathname.startsWith('/api/admin/')) {
      if (url.pathname !== '/api/admin/login') requireAdmin(req)
      route = `${req.method} ${url.pathname.replace('/api/admin/', '/api/')}`
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/assets/')) {
      return sendAsset(res, url.pathname.slice('/assets/'.length), req.method === 'HEAD')
    }
    switch (route) {
      case 'GET /':
      case 'GET /index.html':
      case 'GET /admin': {
        let html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
        if (url.pathname === '/admin') html = html.replace('<html lang="fr"', '<html lang="fr" data-admin="true"').replace('content="index, follow"', 'content="noindex, nofollow"')
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP })
      }
      case 'GET /health':
      case 'HEAD /health':
        return send(res, 200, { ok: true, status: wa.status, uptime: Math.round(process.uptime()) })
      case 'GET /favicon.ico':
        res.writeHead(204)
        return res.end()
      case 'GET /api/status':
        return send(res, 200, statusFor(req, url))
      case 'GET /api/commands':
        return send(res, 200, catalog)
      case 'POST /api/login': {
        if (!hasPassword) throw new HttpError(403, 'Configure ADMIN_PASSWORD dans Render pour activer l’administration.')
        const ip = clientIp(req)
        checkBruteForce(ip)
        const { password } = await readJson(req)
        if (!password || !safeEqual(password, config.adminPassword)) {
          noteFailure(ip)
          throw new HttpError(401, 'Mot de passe incorrect.')
        }
        failures.delete(ip)
        for (const [id, until] of adminSessions) if (until <= Date.now()) adminSessions.delete(id)
        if (adminSessions.size >= 20) adminSessions.delete(adminSessions.keys().next().value)
        const id = crypto.randomBytes(32).toString('base64url')
        adminSessions.set(id, Date.now() + 60 * 60_000)
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=${id}; ${cookieOptions}; Max-Age=3600` })
      }
      case 'POST /api/signout': {
        const value = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
        adminSessions.delete(value)
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; ${cookieOptions}; Max-Age=0` })
      }
      case 'GET /api/visitors':
        requireAdmin(req)
        visitors.sweep()
        return send(res, 200, { active: visitors.entries.size, capacity: visitors.max })
      case 'POST /api/pair': {
        requirePairingAllowed(req)
        const { phone } = await readJson(req)
        if (!phone) throw new HttpError(400, 'Indique ton numéro WhatsApp.')
        throttlePairing()
        const code = await wa.requestPairing(String(phone))
        return send(res, 200, { code, expiresAt: wa.pairing?.expiresAt || Date.now() + 3 * 60_000, token: newToken() })
      }
      case 'POST /api/qr': {
        requirePairingAllowed(req)
        throttlePairing()
        const qr = await wa.requestQr()
        return send(res, 200, { qr, token: newToken() })
      }
      case 'GET /api/session': {
        if (!validToken(tokenFrom(req, url))) requireAdmin(req)
        const sessionId = wa.exportSession()
        if (!sessionId) throw new HttpError(404, "Aucune session : connecte d'abord ton WhatsApp.")
        return send(res, 200, { sessionId })
      }
      case 'POST /api/logout': {
        requireAdmin(req)
        await wa.logout()
        token = null
        return send(res, 200, { ok: true })
      }
      case 'POST /api/import': {
        if (hasPassword) requireAdmin(req)
        else if (wa.connected) throw new HttpError(409, 'Le bot est déjà connecté.')
        const { sessionId } = await readJson(req)
        if (!sessionId) throw new HttpError(400, 'Colle ton SESSION_ID.')
        await wa.importSession(String(sessionId).trim())
        return send(res, 200, { ok: true })
      }
      default:
        return send(res, 404, { error: 'Page introuvable.' })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 400
      if (!(err instanceof HttpError)) log.warn({ err: err?.message }, 'Erreur API')
      if (!res.headersSent) send(res, status, { error: err?.message || 'Erreur inconnue.' })
      else res.end()
    })
  })
  server.on('close', () => { visitors.close(); adminSessions.clear() })
  server.closeVisitors = () => visitors.close()
  server.requestTimeout = 90_000
  return server
}

export function startWebServer(options) {
  const { config, log } = options
  const server = createWebServer(options)
  server.listen(config.port, '0.0.0.0', () => log.info(`🌐 Site d'appairage en ligne sur le port ${config.port}`))
  return server
}
