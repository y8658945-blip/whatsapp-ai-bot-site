import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VisitorSessions } from '../src/web/visitors.js'
import { createWebServer } from '../src/web/server.js'
import { MemoryStore } from '../src/storage/memory.js'

const silent = { info() {}, warn() {}, error() {} }
let sequence = 0
class FakeManager {
  constructor() { this.id = ++sequence; this.kv = new MemoryStore(); this.connected = false; this.status = 'idle'; this.stops = 0 }
  publicStatus() { return { status: this.status, connected: this.connected, pairing: this.pairing, qr: this.qr, hasSession: this.connected, me: { name: 'OWNER SECRET' } } }
  async requestPairing(phone) { this.pairing = { code: `CODE-${this.id}`, phone, expiresAt: Date.now() + 180000 }; this.status = 'waiting_pair'; return this.pairing.code }
  async requestQr() { this.qr = 'data:image/png;base64,synthetic'; this.status = 'waiting_qr'; return this.qr }
  exportSession() { return `WAI~synthetic-${this.id}` }
  stop() { this.stops++ }
  async logout() { this.loggedOut = true }
  async importSession(value) { this.imported = value }
}

async function fixture(t, options = {}) {
  const managers = []
  const visitors = new VisitorSessions({ createManager: () => { const wa = new FakeManager(); managers.push(wa); return wa }, ...options })
  const owner = new FakeManager(); owner.connected = true; owner.status = 'connected'
  const server = createWebServer({ wa: owner, config: { adminPassword: 'test-only-password', botName: 'Nova', externalUrl: 'https://example.test' }, visitors, log: silent })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { method = 'GET', token, cookie, body, origin, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-pair-token': token } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, text, json: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie') }
  }
  return { call, visitors, managers, owner }
}

test('Deux visiteurs simultanés restent isolés du propriétaire et entre eux', async (t) => {
  const { call, managers, owner } = await fixture(t)
  const a = (await call('/api/visitors', { method: 'POST' })).json.token
  const b = (await call('/api/visitors', { method: 'POST' })).json.token
  assert.notEqual(a, b)
  const [pa, pb] = await Promise.all([call('/api/pair', { method: 'POST', token: a, body: { phone: '33612345678' } }), call('/api/pair', { method: 'POST', token: b, body: { phone: '33712345678' } })])
  assert.equal(pa.status, 200); assert.equal(pb.status, 200)
  assert.notEqual(pa.json.code, pb.json.code)
  assert.equal((await call('/api/status', { token: a })).json.pairing.code, pa.json.code)
  const publicStatus = await call('/api/status')
  assert.equal(publicStatus.json.connected, false)
  assert.ok(!publicStatus.text.includes('OWNER SECRET'))
  assert.equal((await call('/api/session')).status, 401)
  assert.equal((await call('/api/session?token=' + a)).status, 401, 'pas de secret dans les URL')
  assert.equal((await call('/api/session', { token: 'forged' })).status, 401)
  assert.equal((await call('/api/session', { token: a })).status, 409)
  managers[0].connected = true
  const session = await call('/api/session', { token: a })
  assert.equal(session.json.sessionId, managers[0].exportSession())
  assert.equal(managers[0].stops, 1, 'socket fermé pour le transfert vers le bot personnel')
  assert.equal((await call('/api/session', { token: a })).json.sessionId, session.json.sessionId)
  assert.equal((await call('/api/status', { token: a })).json.connected, true)
  assert.equal((await call('/api/session', { token: b })).status, 409)
  assert.equal(owner.stops, 0)
  assert.equal(owner.connected, true)
})

test('QR, cooldown et suppression ne modifient pas un autre visiteur', async (t) => {
  const { call, managers, owner } = await fixture(t)
  const a = (await call('/api/visitors', { method: 'POST' })).json.token
  const b = (await call('/api/visitors', { method: 'POST' })).json.token
  assert.equal((await call('/api/qr', { method: 'POST', token: a })).status, 200)
  assert.equal((await call('/api/pair', { method: 'POST', token: a, body: { phone: '33612345678' } })).status, 429)
  assert.equal((await call('/api/status', { token: b })).json.qr, undefined)
  assert.equal((await call('/api/visitors', { method: 'DELETE', token: a })).status, 200)
  assert.equal((await call('/api/status', { token: a })).status, 401)
  assert.equal(managers[0].stops, 1)
  assert.equal(managers[0].loggedOut, undefined)
  assert.equal((await call('/api/status', { token: b })).status, 200)
  assert.equal(owner.stops, 0)
})

test('Expiration, capacité, limite par adresse et arrêt libèrent les ressources', async () => {
  let now = 0
  const pool = new VisitorSessions({ createManager: () => new FakeManager(), max: 1, ttlMs: 1000, now: () => now })
  try {
    const a = pool.create('one').token
    const wa = pool.get(a).wa
    wa.kv.set('secret', 'synthetic')
    assert.throws(() => pool.create('two'), { status: 503 })
    now = 1001; pool.sweep()
    assert.equal(wa.stops, 1); assert.equal(wa.kv.map.size, 0)
    assert.throws(() => pool.get(a), { status: 401 })
    for (let i = 0; i < 5; i++) { const { token } = pool.create('one'); pool.remove(token) }
    assert.throws(() => pool.create('one'), { status: 429 })
    now = 2002; pool.sweep()
    const last = pool.create('one').token
    const lastWa = pool.get(last).wa
    pool.close()
    assert.equal(lastWa.stops, 1)
    assert.throws(() => pool.create('three'), { status: 503 })
  } finally { pool.close() }
})

test('Mot de passe admin, cookie sécurisé, déconnexion et contrôle des origines', async (t) => {
  const { call, owner } = await fixture(t)
  for (const path of ['/api/admin/status', '/api/admin/session', '/api/admin/visitors']) assert.equal((await call(path)).status, 401)
  assert.equal((await call('/api/admin/status', { headers: { 'x-admin-password': 'test-only-password' } })).status, 401)
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401)
  assert.equal((await call('/api/admin/login', { method: 'POST', origin: 'https://attacker.test', body: { password: 'test-only-password' } })).status, 403)
  const login = await call('/api/admin/login', { method: 'POST', origin: 'https://example.test', body: { password: 'test-only-password' } })
  assert.equal(login.status, 200)
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/admin']) assert.ok(login.cookie.includes(flag))
  const cookie = login.cookie.split(';')[0]
  assert.equal((await call('/api/admin/status', { cookie })).json.connected, true)
  assert.equal((await call('/api/admin/session', { cookie })).json.sessionId, owner.exportSession())
  for (const path of ['/api/import', '/api/logout', '/api/login']) assert.equal((await call(path, { method: 'POST', cookie })).status, 404)
  assert.equal((await call('/api/admin/logout', { method: 'POST', cookie, origin: 'https://attacker.test' })).status, 403)
  assert.equal(owner.loggedOut, undefined)
  assert.equal((await call('/api/admin/import', { method: 'POST', cookie, body: { sessionId: 'WAI~synthetic-import' } })).status, 200)
  assert.equal(owner.imported, 'WAI~synthetic-import')
  assert.equal((await call('/api/admin/signout', { method: 'POST', cookie })).status, 200)
  assert.equal((await call('/api/admin/status', { cookie })).status, 401)
})

test('Anti brute force admin, site public et absence de clé dans les pages', async (t) => {
  const { call } = await fixture(t)
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401)
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'test-only-password' } })).status, 429)
  const home = await call('/'); const admin = await call('/admin')
  assert.equal(home.status, 200); assert.equal(admin.status, 200)
  assert.ok(!home.text.includes('data-admin="true"'))
  assert.ok(admin.text.includes('data-admin="true"'))
  assert.ok(!admin.text.includes('test-only-password'))
  assert.equal((await call('/api/status')).status, 200, 'le blocage admin ne bloque pas les visiteurs')
})

test('Une requête lente ne permet pas deux appairages sur le même gestionnaire', async () => {
  let finish
  const pool = new VisitorSessions({ createManager: () => {
    const wa = new FakeManager()
    wa.requestQr = () => new Promise((resolve) => { finish = resolve })
    return wa
  } })
  try {
    const { token } = pool.create('one')
    const pending = pool.pair(token, null)
    await assert.rejects(pool.pair(token, null), { status: 429 })
    finish('data:image/png;base64,synthetic')
    assert.ok((await pending).qr)
  } finally { pool.close() }
})

test('Sans mot de passe, admin fermé et génération publique disponible', async (t) => {
  const visitors = new VisitorSessions({ createManager: () => new FakeManager() })
  const server = createWebServer({ wa: new FakeManager(), config: {}, log: silent, visitors })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(base + '/api/admin/status')).status, 403)
  assert.equal((await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '' }) })).status, 403)
  assert.equal((await fetch(base + '/api/visitors', { method: 'POST' })).status, 201)
})
