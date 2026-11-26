// Which approval cards the bridge shows, from plugin/.env.
//
//   KROT_CODEX_APPROVALS=1 (written by the installer)  cards on, approvalPolicy on-request
//   + KROT_CODEX_APPROVAL_MODE=risky                    routine requests decided by the bridge
//   KROT_CODEX_APPROVALS unset                          no cards, approvalPolicy never
//   KROT_CODEX_APPROVAL_MODE=never                      no cards, approvalPolicy never,
//                                                       whatever KROT_CODEX_APPROVALS says
//
// `never` is the owner's explicit autonomous choice: it wins over the
// KROT_CODEX_APPROVALS=1 the installer writes, so switching to it is one line.

import type { ApprovalDecision, ApprovalRequest } from './session.js'

export interface ApprovalEnv {
  KROT_CODEX_APPROVALS?: string | undefined
  KROT_CODEX_APPROVAL_MODE?: string | undefined
}

export interface ApprovalSetup {
  // Approval cards (Codex commands, file changes, network, MCP and GitHub
  // connector calls, policy webhook) reach the owner in Telegram.
  cards: boolean
  risky: boolean
}

export function resolveApprovalSetup(env: ApprovalEnv): ApprovalSetup {
  if (env.KROT_CODEX_APPROVAL_MODE === 'never') return { cards: false, risky: false }
  const risky = env.KROT_CODEX_APPROVAL_MODE === 'risky'
  if (risky && env.KROT_CODEX_APPROVALS !== '1') {
    throw new Error('KROT_CODEX_APPROVAL_MODE=risky requires KROT_CODEX_APPROVALS=1')
  }
  return { cards: env.KROT_CODEX_APPROVALS === '1', risky }
}

export interface ApprovalCardSink {
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>
}

// CodexSession approval settings. Without `approve` the session runs Codex with
// approvalPolicy never and answers every approval request without a card.
export function sessionApprovalOptions(setup: ApprovalSetup, cards: ApprovalCardSink | undefined): {
  approve?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>
  riskyApprovals?: boolean
} {
  if (!setup.cards || !cards) return {}
  return { approve: (request, signal) => cards.request(request, signal), riskyApprovals: setup.risky }
}
