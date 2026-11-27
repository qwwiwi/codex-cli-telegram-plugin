// Session registry (spec §7.2, D16; contract `SessionRegistry`): `<brain_home>/sessions/<id>.json`
// maps a Codex session to its scope and role, `<brain_home>/intents/<id>.json` holds the bridge's
// announcements of threads it is about to start. A hook knows only its session id and brain_home
// (slice plan K3), so both live above the scopes.

import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'

import {
  type Scope, SESSION_INTENT_TTL_MS, type SessionEntry, SessionEntrySchema, type SessionIntent, SessionIntentSchema,
  type SessionRegistry,
} from '../contract.js'
import { writeFileAtomic } from '../store/atomic.js'
import { type LockOptions, withLock } from '../store/lock.js'
import { ensureHome, type HomePaths, homePaths, LOCAL_SCOPE } from '../store/paths.js'
import { compareBy, readJsonDir, readJsonFile } from './files.js'

const byAge = (a: SessionIntent, b: SessionIntent): number =>
  a.created < b.created ? -1 : a.created > b.created ? 1 : compareBy<SessionIntent>(i => i.id)(a, b)

export class FileSessionRegistry implements SessionRegistry {
  private readonly home: HomePaths

  constructor(private readonly brainHome: string, private readonly lock: LockOptions = {}) {
    this.home = homePaths(brainHome)
  }

  /**
   * Under the home lock: `claim` checks and writes under the same lock, so a bridge `register`
   * (which wins over a claim) can never be overwritten by a claim that checked before it.
   */
  async register(entry: SessionEntry): Promise<void> {
    const value = SessionEntrySchema.parse(entry)
    const home = ensureHome(this.brainHome)
    await withLock(home.lockDir, async () => this.writeEntry(home, value), this.lock)
  }

  private writeEntry(home: HomePaths, entry: SessionEntry): void {
    writeFileAtomic(home.session(entry.session_id), `${JSON.stringify(SessionEntrySchema.parse(entry))}\n`)
  }

  async resolve(sessionId: string): Promise<SessionEntry | null> {
    const entry = readJsonFile(this.home.session(sessionId), SessionEntrySchema)
    return entry?.session_id === sessionId ? entry : null
  }

  async intend(intent: { scope: Scope; role: SessionIntent['role'] }, now: Date): Promise<SessionIntent> {
    const value = SessionIntentSchema.parse({
      id: `i-${now.getTime().toString(36)}-${randomBytes(6).toString('hex')}`,
      scope: intent.scope,
      role: intent.role,
      created: now.toISOString(),
      expires: new Date(now.getTime() + SESSION_INTENT_TTL_MS).toISOString(),
    })
    const home = ensureHome(this.brainHome)
    writeFileAtomic(home.intent(value.id), `${JSON.stringify(value)}\n`)
    return value
  }

  async claim(sessionId: string, now: Date): Promise<SessionEntry> {
    const known = await this.resolve(sessionId)
    if (known !== null) return known
    const home = ensureHome(this.brainHome)
    // Under the home lock, so two sessions starting together cannot use up the same intent.
    return withLock(home.lockDir, async () => {
      const again = await this.resolve(sessionId)
      if (again !== null) return again
      const live = readJsonDir(home.intentsDir, SessionIntentSchema).filter(i => Date.parse(i.expires) > now.getTime()).sort(byAge)
      const oldest = live[0]
      const registered = now.toISOString()
      let entry: SessionEntry
      if (oldest === undefined) {
        entry = { session_id: sessionId, scope: LOCAL_SCOPE, role: 'terminal', registered }
      } else if (live.every(i => i.scope === oldest.scope && i.role === oldest.role)) {
        rmSync(home.intent(oldest.id), { force: true })
        entry = { session_id: sessionId, scope: oldest.scope, role: oldest.role, registered }
      } else {
        entry = { session_id: sessionId, scope: oldest.scope, role: 'guest', registered }
      }
      this.writeEntry(home, entry)
      return entry
    }, this.lock)
  }

  async withdraw(intentId: string): Promise<void> {
    rmSync(this.home.intent(intentId), { force: true })
  }
}
