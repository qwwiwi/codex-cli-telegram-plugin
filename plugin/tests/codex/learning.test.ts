import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningMemory } from '../../src/codex/learning.js'
import { reviewLearning } from '../../src/codex/learning-review.js'

const proposals = [
  { kind: 'user', key: 'reports', text: 'Начинай отчёт с результата.', triggers: [], evidence: [0] },
  { kind: 'memory', key: 'release-check', text: 'Сверяй тесты с результатом до правки.', triggers: [], evidence: [0] },
  { kind: 'skill', key: 'release', text: '1. Проверь сборку.\n2. Сверь версию.', triggers: ['выпуск версии', 'release'], evidence: [0] },
]

test('stages three kinds, persists approvals, and retrieves skills only for matching tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-learning-'))
  try {
    const learn = new LearningMemory(root, 1, [], async () => JSON.stringify({ entries: proposals }))
    learn.observe('Всегда начинай отчёт с результата. Выпуск версии проверили.', 'Сборка прошла.')
    expect(await learn.review()).toBe(3)
    expect(learn.context('проверяем выпуск версии')).toBe('')
    for (const proposal of proposals) expect(learn.command('approve ' + proposal.kind + '/' + proposal.key)).toContain('Сохранено')
    const reopened = new LearningMemory(root, 1, [], async () => '')
    expect(reopened.context('погода')).toContain(proposals[0]!.text)
    expect(reopened.context('погода')).toContain(proposals[1]!.text)
    expect(reopened.context('погода')).not.toContain('Проверь сборку')
    expect(reopened.context('Делаем выпуск версии.')).toContain('Проверь сборку')
    expect(readFileSync(join(root, 'skills', 'release', 'SKILL.md'), 'utf8')).toContain('Проверь сборку')
    expect(reopened.command('forget user/reports')).toContain('Удалено')
    expect(reopened.context('погода')).not.toContain(proposals[0]!.text)
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('does not send known secrets and rejects ungrounded or secret proposals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-learning-'))
  try {
    const secret = 'my-private-test-key'
    const learn = new LearningMemory(root, 1, [secret], async prompt => {
      expect(prompt).not.toContain(secret)
      return JSON.stringify({ entries: [
        { ...proposals[0], text: secret },
        { ...proposals[1], evidence: [12] },
      ] })
    })
    learn.observe('Вот ключ ' + secret, 'Принял')
    expect(await learn.review()).toBe(0)
    expect(learn.command('pending')).toContain('нет')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('auto mode saves all three kinds and updates existing entries without staging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-learning-auto-'))
  try {
    let entries = proposals
    const prompts: string[] = []
    const learn = new LearningMemory(root, 1, [], async prompt => {
      prompts.push(prompt)
      return JSON.stringify({ entries })
    }, true)
    learn.observe('Первый обмен', 'Готово')
    expect(await learn.review()).toBe(3)
    expect(learn.command('pending')).toContain('нет')
    expect(learn.context('выпуск версии')).toContain('Проверь сборку')
    entries = [
      { ...proposals[0]!, text: 'Начинай отчёт с результата и указывай дату.' },
      { ...proposals[2]!, text: '1. Проверь сборку.\n2. Проверь changelog.' },
    ]
    learn.observe('Теперь указывай дату, а при выпуске проверь changelog.', 'Проверено')
    expect(await learn.review()).toBe(2)
    expect(prompts[1]).toContain(proposals[0]!.text)
    expect(prompts[1]).toContain('"key":"release"')
    const reopened = new LearningMemory(root, 1, [], async () => '', true)
    expect(reopened.command('pending')).toContain('нет')
    expect(reopened.context('выпуск версии')).toContain('Проверь changelog')
    expect(reopened.context('отчёт')).toContain('указывай дату')
    expect(reopened.context('отчёт')).not.toContain('changelog')
    expect(readFileSync(join(root, 'skills', 'release', 'SKILL.md'), 'utf8')).toContain('Проверь changelog')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('review uses its own ephemeral App Server thread and rejects a different sandbox', async () => {
  const command = [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'] as const
  const signal = new AbortController().signal
  expect(await reviewLearning(import.meta.dir, process.env, 'example', signal, undefined, command))
    .toBe('{"entries":[]}')
  await expect(reviewLearning(import.meta.dir, process.env, 'example', signal, undefined, [...command, 'wrong-sandbox']))
    .rejects.toThrow('ephemeral read-only')
})
