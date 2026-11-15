// Même interface que KVStore, sans écritures ni timers : sessions publiques temporaires.
export class MemoryStore {
  constructor() { this.map = new Map(); this.kind = 'memory' }
  get(key, fallback) { return this.map.has(key) ? this.map.get(key) : fallback }
  has(key) { return this.map.has(key) }
  set(key, value) { if (value == null) this.del(key); else this.map.set(key, value) }
  del(key) { this.map.delete(key) }
  keys(prefix = '') { return [...this.map.keys()].filter((key) => key.startsWith(prefix)) }
  deletePrefix(prefix) { for (const key of this.keys(prefix)) this.del(key) }
  async flush() {}
  async close() { this.map.clear() }
}
