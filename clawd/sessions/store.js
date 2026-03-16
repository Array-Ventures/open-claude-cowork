import fs from 'fs'
import path from 'path'
import os from 'os'

const SESSIONS_FILE = path.join(os.homedir(), '.clawd', 'sessions.json')

/**
 * Persistent session store backed by ~/.clawd/sessions.json
 *
 * Stores SDK session mappings (sdkSessionId, messageCount, etc.)
 * so conversation context survives gateway restarts.
 *
 * Exposes a Map-like API so consumers don't need to know about persistence.
 */
export default class SessionStore {
  constructor() {
    this.data = new Map()
    this.load()
  }

  // --- Map-like API ---

  has(key) {
    return this.data.has(key)
  }

  get(key) {
    return this.data.get(key)
  }

  set(key, value) {
    this.data.set(key, value)
    return this
  }

  delete(key) {
    const result = this.data.delete(key)
    if (result) this.save()
    return result
  }

  get size() {
    return this.data.size
  }

  entries() {
    return this.data.entries()
  }

  // --- Persistence ---

  load() {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8')
      const parsed = JSON.parse(raw)
      for (const [key, session] of Object.entries(parsed)) {
        this.data.set(key, session)
      }
      console.log(`[SessionStore] Loaded ${this.data.size} sessions from ${SESSIONS_FILE}`)
    } catch (err) {
      console.error('[SessionStore] Failed to load:', err.message)
    }
  }

  save() {
    try {
      const dir = path.dirname(SESSIONS_FILE)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const obj = Object.fromEntries(this.data)
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2))
    } catch (err) {
      console.error('[SessionStore] Failed to save:', err.message)
    }
  }
}
