// Turn permits (spec §7.2): `state/permits/<turn_id>.json`, written by the bridge when a turn
// starts. A permit is a plain file, so the agent could forge one; the defence is the receipt
// audit (`auditFactWrites`), which flags writes whose turn id the bridge never issued.

import { rmSync } from 'node:fs'

import { type Permit, PermitSchema, type PermitStore, type Scope } from '../contract.js'
import { writeFileAtomic } from '../store/atomic.js'
import { ensureScope, type ScopePaths, scopePaths } from '../store/paths.js'
import { compareBy, readJsonDir, readJsonFile } from './files.js'

export class FilePermitStore implements PermitStore {
  private readonly paths: ScopePaths

  constructor(private readonly brainHome: string, private readonly scope: Scope) {
    this.paths = scopePaths(brainHome, scope)
  }

  async put(permit: Permit): Promise<void> {
    const value = PermitSchema.parse(permit)
    if (value.scope !== this.scope) throw new Error(`permit of scope ${value.scope} cannot be stored in scope ${this.scope}`)
    const paths = ensureScope(this.brainHome, this.scope)
    writeFileAtomic(paths.permit(value.turn_id), `${JSON.stringify(value)}\n`)
  }

  async get(turnId: string): Promise<Permit | null> {
    const permit = readJsonFile(this.paths.permit(turnId), PermitSchema)
    return permit !== null && permit.turn_id === turnId && permit.scope === this.scope ? permit : null
  }

  /** Every readable permit of this scope, expired ones included, sorted by turn id. */
  async all(): Promise<Permit[]> {
    return readJsonDir(this.paths.permitsDir, PermitSchema).filter(p => p.scope === this.scope).sort(compareBy(p => p.turn_id))
  }

  async live(now: Date): Promise<Permit[]> {
    return (await this.all()).filter(permit => Date.parse(permit.expires) > now.getTime())
  }

  async remove(turnId: string): Promise<void> {
    rmSync(this.paths.permit(turnId), { force: true })
  }
}
