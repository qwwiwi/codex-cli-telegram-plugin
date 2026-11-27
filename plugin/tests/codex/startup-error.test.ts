import { expect, test } from 'bun:test'

import { PublicHomeError } from '../../src/codex/public-home.js'
import { startupErrorMessage } from '../../src/codex/startup-error.js'

test('S4 R4: a public home error is printed as itself, not as the generic could-not-start line', () => {
  const message = 'MCP server "kbase" carries credentials; mark it public_safe'
  expect(startupErrorMessage(new PublicHomeError(message))).toBe('Multi-user mode cannot start: ' + message)
})

test('S4 R4: a printed public home error is sanitized: one line, bounded, no token-looking values', () => {
  const printed = startupErrorMessage(new PublicHomeError('bad\nline\u0007 sk-FAKE0123456789abcdefFAKE0123456789 ' + 'x'.repeat(2000)))
  expect(printed).not.toContain('\n')
  expect(printed).not.toContain('\u0007')
  expect(printed).not.toContain('sk-FAKE0123456789abcdefFAKE0123456789')
  expect(printed.length).toBeLessThanOrEqual(600)
})

test('S4 R4: an unknown error still prints only the generic line; known startup messages pass as before', () => {
  expect(startupErrorMessage(new Error('token=abc leaked'))).toBe('Krot Codex pilot could not start')
  expect(startupErrorMessage('boom')).toBe('Krot Codex pilot could not start')
  expect(startupErrorMessage(new Error('Multi-user mode cannot start (guest): x'))).toBe('Multi-user mode cannot start (guest): x')
})
