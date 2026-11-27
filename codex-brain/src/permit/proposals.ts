// Pending proposals (spec §7.2, A2): `pending/<id>.json`, candidate facts the owner accepts or
// rejects in `/memory pending`. Nothing here becomes a fact by itself.

import { rmSync } from 'node:fs'

import { isQuarantinedProposal, type Proposal, ProposalSchema, type ProposalStore, type Scope } from '../contract.js'
import { writeFileAtomic } from '../store/atomic.js'
import { ensureScope, type ScopePaths, scopePaths } from '../store/paths.js'
import { compareBy, readJsonDir, readJsonFile } from './files.js'

export class FileProposalStore implements ProposalStore {
  private readonly paths: ScopePaths

  constructor(private readonly brainHome: string, private readonly scope: Scope) {
    this.paths = scopePaths(brainHome, scope)
  }

  async add(proposal: Proposal): Promise<void> {
    const value = ProposalSchema.parse(proposal)
    const paths = ensureScope(this.brainHome, this.scope)
    writeFileAtomic(paths.proposal(value.id), `${JSON.stringify(value)}\n`)
  }

  async list(): Promise<Proposal[]> {
    return readJsonDir(this.paths.pendingDir, ProposalSchema).filter(p => !isQuarantinedProposal(p)).sort(compareBy(p => p.id))
  }

  async get(id: string): Promise<Proposal | null> {
    const proposal = readJsonFile(this.paths.proposal(id), ProposalSchema)
    return proposal?.id === id && !isQuarantinedProposal(proposal) ? proposal : null
  }

  async remove(id: string): Promise<void> {
    rmSync(this.paths.proposal(id), { force: true })
  }
}
