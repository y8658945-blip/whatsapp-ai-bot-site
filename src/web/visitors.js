import crypto from 'node:crypto'

// Authentification des visiteurs en mémoire uniquement : aucun identifiant sur disque.
export class VisitorSessions {
  constructor({ createManager, max = 10, ttlMs = 10 * 60_000, now = Date.now }) {
    this.createManager = createManager
    this.max = max
    this.ttlMs = ttlMs
    this.now = now
    this.entries = new Map()
    this.attempts = new Map()
    this.closed = false
    this.timer = setInterval(() => this.sweep(), 30_000)
    this.timer.unref()
  }

  error(status, message) { return Object.assign(new Error(message), { status }) }

  sweep() {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.remove(token)
    }
    for (const [ip, limit] of this.attempts) if (limit.until <= this.now()) this.attempts.delete(ip)
  }

  create(ip) {
    this.sweep()
    if (this.closed) throw this.error(503, 'Le service redémarre.')
    const limit = this.attempts.get(ip)
    if (limit?.count >= 5) throw this.error(429, 'Trop de sessions créées. Réessaie dans 10 minutes.')
    if (this.entries.size >= this.max) throw this.error(503, 'Le service est occupé. Réessaie dans quelques minutes.')
    if (this.attempts.size >= 5000 && !limit) throw this.error(503, 'Le service est occupé.')
    this.attempts.set(ip, { count: (limit?.count || 0) + 1, until: limit?.until || this.now() + this.ttlMs })
    const token = crypto.randomBytes(32).toString('base64url')
    const entry = { wa: this.createManager(), expiresAt: this.now() + this.ttlMs, lastPairAt: null, busy: false, sessionId: null }
    this.entries.set(token, entry)
    return { token, expiresAt: entry.expiresAt }
  }

  get(token) {
    const entry = this.entries.get(token)
    if (!entry || entry.expiresAt <= this.now()) {
      this.remove(token)
      throw this.error(401, 'Session temporaire expirée. Recommence pour obtenir un code.')
    }
    return entry
  }

  async pair(token, phone) {
    const entry = this.get(token)
    if (entry.sessionId) throw this.error(409, 'Cette session est prête. Crée une nouvelle session pour recommencer.')
    if (entry.busy || (entry.lastPairAt !== null && this.now() - entry.lastPairAt < 15_000)) {
      throw this.error(429, 'Patiente 15 secondes avant de redemander un code.')
    }
    entry.busy = true
    entry.lastPairAt = this.now()
    try {
      return phone === null ? { qr: await entry.wa.requestQr() } : { code: await entry.wa.requestPairing(phone), expiresAt: entry.wa.pairing?.expiresAt }
    } finally { entry.busy = false }
  }

  status(token) {
    const entry = this.get(token)
    if (entry.sessionId) return { status: 'connected', connected: true, hasSession: true, sessionAvailable: true, storage: 'memory' }
    const st = entry.wa.publicStatus()
    return { status: st.status, connected: st.connected, hasSession: st.hasSession, pairing: st.pairing && { code: st.pairing.code, expiresAt: st.pairing.expiresAt }, qr: st.qr, lastError: st.lastError ? 'Connexion WhatsApp interrompue. Réessaie.' : null, sessionAvailable: st.connected, storage: 'memory' }
  }

  export(token) {
    const entry = this.get(token)
    if (!entry.sessionId) {
      if (!entry.wa.connected) throw this.error(409, "Termine d'abord la connexion dans WhatsApp.")
      entry.sessionId = entry.wa.exportSession()
      if (!entry.sessionId) throw this.error(409, 'Session indisponible.')
      // Ferme le socket sans révoquer l’appareil : le bot du visiteur prendra le relais.
      entry.wa.stop()
      entry.wa.kv?.map.clear()
    }
    return entry.sessionId
  }

  remove(token) {
    const entry = this.entries.get(token)
    if (!entry) return
    entry.wa.stop()
    entry.wa.removeAllListeners?.()
    entry.wa.kv?.map.clear()
    entry.sessionId = null
    this.entries.delete(token)
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
    for (const token of this.entries.keys()) this.remove(token)
    this.attempts.clear()
  }
}
