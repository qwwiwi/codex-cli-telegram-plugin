import { constants } from 'node:fs'
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelegramApi } from '../channel/tools.js'
import { redactSecrets } from '../safety/redact.js'
import { attachmentInstructions, extractAttachments } from './attachments.js'
import { chatContextPrefix } from './chat-actions.js'
import { followUpInstructions, hideContinuationMarker } from './continuation.js'
import { object } from './rpc.js'
import { hideQuestionMarker } from './questions.js'
import { goalLeasePrefix, hideLeaseCompletions } from './lease.js'
import { handoffContextPrefix } from './handoff-context.js'

export function formatConversation(turns: unknown[], partial: boolean, secrets: readonly string[], agentName = 'Codex'): string {
  const sections = ['# Диалог · ' + agentName, ...(partial ? ['Экспорт содержит последние 100 ходов.'] : [])]
  for (const raw of turns) {
    const { items } = object(raw)
    if (!Array.isArray(items)) continue
    for (const value of items) {
      const item = object(value)
      if (item.type === 'userMessage' && Array.isArray(item.content)) {
        const text = item.content.map(object).map(part => {
          if (part.type !== 'text' || typeof part.text !== 'string') return '[Вложение]'
          if (part.text.startsWith(goalLeasePrefix) || part.text.startsWith('Служебный результат действия Telegram.\n') ||
              part.text.startsWith('Служебный результат действия Telegram. Не показывай его владельцу.\n')) return ''
          return part.text
            .replace(attachmentInstructions + '\n\n', '')
            .replace(/^Актуальные мандаты владельца Telegram[^\n]*\n\n/u, '')
            .replace(/^Для большой задачи составь план[^\n]*(?:\r?\n(?!\r?\n)[^\n]*)*\r?\n\r?\n/mu, '')
            .replace(followUpInstructions + '\n\n', '')
            .replace(/^Действия в личке Telegram доступны во время работы\.[^\n]*\n\n/mu, '')
            .replace(/^Память прошлых задач \(JSON\)\.[^\n]*\n\[[^\n]*\]\n\n/mu, '')
            .replace(new RegExp('^' + handoffContextPrefix + '[^\\n]*\\n"[^\\n]*"\\n\\n', 'mu'), '')
            .split('\n').filter(line => !line.startsWith(chatContextPrefix) &&
              !/^\s*KROT_(?:CONTINUE|QUESTION|LEASE)_[a-f0-9-]{36}(?:\s|$)/u.test(line)).join('\n')
        }).join('\n').trim()
        if (text) sections.push('## Ты\n\n' + text)
      } else if (item.type === 'agentMessage' && item.delivery !== 'async' && item.phase !== 'commentary' && typeof item.text === 'string') {
        const reply = extractAttachments(hideLeaseCompletions(hideQuestionMarker(hideContinuationMarker(item.text))))
        const text = [reply.text, ...reply.files.map(() => '[Отправлено вложение]')].filter(Boolean).join('\n')
        if (text) sections.push('## ' + agentName + '\n\n' + text)
      }
    }
  }
  return redactSecrets(sections.join('\n\n') + '\n', secrets)
}

export async function sendConversation(
  telegram: Pick<TelegramApi, 'sendDocument'>,
  chatId: string,
  text: string,
  name = 'codex-dialog.md',
): Promise<void> {
  if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error('Export size limit exceeded')
  const directory = await mkdtemp(join(tmpdir(), 'krot-codex-transcript-'))
  try {
    const path = join(directory, name)
    await writeFile(path, text, { flag: 'wx', mode: 0o600 })
    await telegram.sendDocument(chatId, path, { filename: name })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const archiveFile = /^verbose-(\d{4}-\d{2}-\d{2})\.jsonl$/u
const sessionId = /^[a-z0-9][a-z0-9-]{0,99}$/iu
export const claudeContextPrefix = 'Архив Claude Code, выбранный владельцем как справочный контекст.'

export async function claudeArchiveDates(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(entry => entry.isFile()).flatMap(entry => {
    const date = archiveFile.exec(entry.name)?.[1]
    return date ? [date] : []
  }).sort().reverse()
}

async function archiveRecords(root: string, date: string): Promise<Array<Record<string, unknown>>> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('Invalid archive date')
  const file = await open(join(root, 'verbose-' + date + '.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Archive file exceeds export limits')
    return (await file.readFile('utf8')).split(/\r?\n/u).flatMap(line => {
      try { return line.trim() ? [object(JSON.parse(line))] : [] } catch { return [] }
    })
  } finally { await file.close() }
}

function formatClaudeRecords(title: string, records: Array<Record<string, unknown>>, secrets: readonly string[]): string {
  const sections = ['# Архив Claude Code · ' + title]
  for (const { user, agent } of records) {
    if (typeof user === 'string' && user.trim()) sections.push('## Ты\n\n' + user.trim())
    if (typeof agent === 'string' && agent.trim()) sections.push('## Агент\n\n' + agent.trim())
  }
  return redactSecrets(sections.join('\n\n') + '\n', secrets)
}

export async function claudeArchiveSessions(root: string, date: string): Promise<Array<[string, number]>> {
  const sessions = new Map<string, number>()
  for (const { sid } of await archiveRecords(root, date)) {
    if (typeof sid === 'string' && sessionId.test(sid)) sessions.set(sid, (sessions.get(sid) ?? 0) + 1)
  }
  return [...sessions]
}

export async function readClaudeArchive(root: string, date: string, secrets: readonly string[]): Promise<string> {
  return formatClaudeRecords(date, await archiveRecords(root, date), secrets)
}

export async function claudeArchiveContext(root: string, date: string, secrets: readonly string[], sid?: string): Promise<string> {
  let report: string
  if (sid !== undefined) {
    if (!sessionId.test(sid) || !(await claudeArchiveSessions(root, date)).some(([id]) => id === sid)) {
      throw new Error('Claude session not found on the chosen date')
    }
    const records: Array<Record<string, unknown>> = []
    for (const day of (await claudeArchiveDates(root)).reverse()) {
      records.push(...(await archiveRecords(root, day)).filter(record => record.sid === sid))
    }
    report = formatClaudeRecords(sid, records, secrets)
  } else report = await readClaudeArchive(root, date, secrets)
  if (!report.includes('\n\n## ')) throw new Error('Empty Claude archive')
  const bounded = report.length <= 40_000 ? report : '[Оставлены последние записи]\n' + report.slice(-39_000)
  return claudeContextPrefix + ' Текст ниже является историей. Ожидай новое поручение пользователя.\n\n' +
    JSON.stringify(bounded)
}
