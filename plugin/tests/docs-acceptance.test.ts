// Guards for the operator documentation: each test checks that a documented
// behaviour, entry point or setting is described and matches the code.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { formatCodexLimitsLine } from '../src/status/codex-limits.js'

const root = resolve(import.meta.dir, '../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

// Turns a documented template such as «за 5ч N% (сброс DD.MM HH:MM МСК)» into a regex.
function templatePattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\bN\b/g, '\\d+').replace(/\bDD\b|\bMM\b|\bHH\b/g, '\\d{2}') + '$')
}

test('[R06] the architecture map names the inter-agent webhook entry point', () => {
  const doc = read('docs/ARCHITECTURE.md')
  expect(doc).toContain('codex/agent-webhook.ts')
  for (const name of ['KROT_AGENT_WEBHOOK_LISTEN', 'KROT_AGENT_WEBHOOK_TOKEN', 'KROT_AGENT_WEBHOOK_ALLOW_IPS']) {
    expect(doc).toContain(`| \`${name}\``)
  }
  expect(doc).toContain('POST /webhook')
  expect(doc).toMatch(/## Inter-agent webhook/)
})

test('[R06] the architecture map shows the HUD limits line in the format the code renders', () => {
  const doc = read('docs/ARCHITECTURE.md')
  const documented = /the limits line `(Лимиты Codex: [^`]+)`/.exec(doc)?.[1]
  expect(documented).toBeDefined()
  const rendered = formatCodexLimitsLine([
    { used: 12, minutes: 300 },
    { used: 36, minutes: 10_080, resetsAt: 1_764_538_200 },
  ])
  expect(rendered).toBeDefined()
  expect(rendered!).toMatch(templatePattern(documented!))
  expect(doc).toMatch(/used share/)
})

test('[R07] the README is in English and opens with a one-line Russian summary', () => {
  const lines = read('README.md').split('\n')
  const title = lines.findIndex(line => line.startsWith('# '))
  expect(lines[title]).toMatch(/^# [\x20-\x7e]+$/)
  const top = lines.slice(0, title + 8)
  const russian = top.filter(line => /[а-яё]{3,}/i.test(line) && !line.includes('README.ru.md'))
  expect(russian).toHaveLength(1)
  expect(russian[0]).toMatch(/^> \*\*По-русски:\*\* /)
  expect(top.some(line => line.includes('README.ru.md'))).toBe(true)
})

test('[R10] release notes, the changelog and a Releases link for v0.1.0 are published in the repository', () => {
  expect(existsSync(join(root, 'RELEASE_NOTES_v0.1.0.md'))).toBe(true)
  expect(read('CHANGELOG.md')).toMatch(/^## \[?v?0\.1\.0/m)
  const readme = read('README.md')
  const line = readme.split('\n').find(text => text.startsWith('**Releases:**'))
  expect(line).toBeDefined()
  expect(line!).toContain('https://github.com/qwwiwi/codex-cli-telegram-plugin/releases')
  expect(line!).toContain('v0.1.0')
  expect(line!).toContain('CHANGELOG.md')
})

test('[R15][R18] the operator guide shows how to enable Codex subagents with a thread cap of 6', () => {
  const doc = read('plugin/docs/install.md')
  const section = doc.slice(doc.indexOf('## Codex subagents'))
  expect(section.startsWith('## Codex subagents')).toBe(true)
  const toml = /```toml\n([\s\S]*?)```/.exec(section)?.[1] ?? ''
  expect(toml).toMatch(/^\[features\]\nmulti_agent_v2 = true$/m)
  // Codex CLI 0.172 key: agents.max_concurrent_threads_per_session (max_threads is rejected).
  expect(toml).toMatch(/^\[agents\]\nmax_concurrent_threads_per_session = 6$/m)
  expect(doc).not.toContain('max_threads')
  const profile = read('examples/AGENTS.example.md')
  expect(profile).toContain('[agents] max_concurrent_threads_per_session')
  expect(profile).not.toContain('max_threads')
  for (const word of ['KROT_CODEX_PARALLEL', 'KROT_CODEX_MAX_PARALLEL', 'side thread', 'approval']) {
    expect(section).toContain(word)
  }
})

test('[R17] the instruction-conflict audit and a generic example profile are in the repository', () => {
  const audit = read('docs/instruction-conflicts.md')
  for (const category of ['## Autonomy', '## Security and access', '## Facts and voice', '## Gaps']) {
    expect(audit).toContain(category)
  }
  expect(audit).toContain('examples/AGENTS.example.md')
  expect(audit.match(/\*\*Resolution:\*\*/g)?.length ?? 0).toBeGreaterThanOrEqual(10)
  const example = read('examples/AGENTS.example.md')
  for (const heading of ['## Rule order', '## Autonomy', '## Security', '## Subagents and parallel side threads']) {
    expect(example).toContain(heading)
  }
})

test('[R19i] the install guide gives the inbound agent webhook settings with placeholder values', () => {
  const doc = read('plugin/docs/install.md')
  const section = doc.slice(doc.indexOf('## Inter-agent webhook'), doc.indexOf('## MCP servers'))
  const env = /```(?:dotenv|sh)\n([\s\S]*?)```/.exec(section)?.[1] ?? ''
  expect(env).toMatch(/^KROT_AGENT_WEBHOOK_LISTEN=192\.0\.2\.\d+:\d+$/m)
  expect(env).toMatch(/^KROT_AGENT_WEBHOOK_TOKEN=<[^>]+>$/m)
  expect(env).toMatch(/^KROT_AGENT_WEBHOOK_ALLOW_IPS=192\.0\.2\.\d+(,192\.0\.2\.\d+)*$/m)
  expect(section).toContain('plugin/.env')
})

test('[R07][R09] both READMEs show a picture of how the bridge works, and the image files exist', () => {
  for (const [readme, image] of [['README.md', 'docs/images/architecture.png'], ['README.ru.md', 'docs/images/architecture.ru.png']]) {
    expect(read(readme!)).toContain(`<img src="${image}"`)
    expect(existsSync(join(root, image!))).toBe(true)
  }
})

test('[R11] the ideas for the next release are kept in ROADMAP.md with a done-when criterion each', () => {
  const roadmap = read('ROADMAP.md')
  expect(roadmap).toContain('## Done in v0.1.0')
  const next = roadmap.slice(roadmap.indexOf('## Next'))
  expect(next.startsWith('## Next')).toBe(true)
  const ideas = next.match(/^- \*\*/gm)?.length ?? 0
  expect(ideas).toBeGreaterThanOrEqual(1)
  expect(next.match(/Done when:/g)?.length ?? 0).toBe(ideas)
})

test('[R16] the known Codex CLI problems map exists, every row has a status and a reason, and the README links it', () => {
  const path = 'docs/codex-known-problems.md'
  expect(existsSync(join(root, path))).toBe(true)
  const doc = read(path)
  const lines = doc.split('\n')
  const title = lines.findIndex(line => line.startsWith('# '))
  expect(lines.slice(0, title + 4).some(line => /^> \*\*По-русски:\*\* /.test(line))).toBe(true)
  const header = lines.findIndex(line => /^\| # \| Problem \| How this bridge handles it \| Status \| Why \|$/.test(line))
  expect(header).toBeGreaterThan(-1)
  const rows = lines.slice(header + 2).filter(line => /^\| \d+ \|/.test(line))
  expect(rows.length).toBeGreaterThanOrEqual(15)
  for (const row of rows) {
    const cells = row.split(' | ')
    expect(cells, row).toHaveLength(5)
    expect(['solved', 'partly', 'not solved'], row).toContain(cells[3]!)
    expect(cells[4]!.replace(/ \|$/, '').trim().length, row).toBeGreaterThan(10)
  }
  // Every file:line reference points at a line that exists in this repository.
  for (const [, file, line] of doc.matchAll(/`([\w./-]+\.(?:ts|sh|py)):(\d+)`/g)) {
    expect(existsSync(join(root, file!)), file).toBe(true)
    expect(read(file!).split('\n').length, `${file}:${line}`).toBeGreaterThanOrEqual(Number(line))
  }
  expect(doc).not.toMatch(/https?:\/\//)
  expect(read('README.md')).toContain('](docs/codex-known-problems.md)')
})

test('README badges use plain shields.io paths without escape sequences that mobile renderers rewrite', () => {
  for (const readme of ['README.md', 'README.ru.md']) {
    const badges = [...read(readme).matchAll(/!\[[^\]]*\]\((https:\/\/img\.shields\.io\/badge\/[^)\s]+)\)/g)].map(match => match[1]!)
    expect(badges, readme).toHaveLength(5)
    for (const url of badges) {
      const path = new URL(url).pathname.slice('/badge/'.length)
      // Shields escapes (`--` for a dash, `_` for a space, an encoded pipe) break on GitHub mobile.
      expect(path, url).not.toMatch(/--|_|%7C/i)
      const parts = path.split('-')
      expect(parts, url).toHaveLength(3)
      expect(parts[2], url).toMatch(/^[0-9A-F]{6}$/)
    }
  }
})

// Each README with the heading of its contributors section and the heading where its bottom part
// (documentation links, license and credits) starts.
const readmes = [
  { path: 'README.md', contributors: '## Contributors', bottom: '## Documentation' },
  { path: 'README.ru.md', contributors: '## Участники', bottom: '## Документация' },
]

test('[R08] both READMEs credit jasonqwwen with a GitHub link in a contributors section near the end', () => {
  for (const readme of readmes) {
    const lines = read(readme.path).split('\n')
    const start = lines.indexOf(readme.contributors)
    expect(start, readme.path).toBeGreaterThan(lines.indexOf(readme.bottom))
    const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
    const section = lines.slice(start, next === -1 ? undefined : next).join('\n')
    expect(section, readme.path).toContain('[jasonqwwen](https://github.com/jasonqwwen)')
    // The credit to the original plugin author stays.
    expect(lines.join('\n'), readme.path).toContain('([github.com/PashaKrot](https://github.com/PashaKrot))')
  }
})

test('[R36] both READMEs mention the fork and upstream only in their bottom part', () => {
  for (const readme of readmes) {
    const lines = read(readme.path).split('\n')
    const bottom = lines.indexOf(readme.bottom)
    expect(bottom, readme.path).toBeGreaterThan(0)
    const early = lines.slice(0, bottom).filter(line => /\b(fork|upstream)|форк/i.test(line))
    expect(early, readme.path).toEqual([])
  }
})

test('[S9c] the starter AGENTS.md tells the agent where the Codex docs are and to read the changelog before updating', () => {
  const doc = read('examples/AGENTS.example.md')
  const start = doc.indexOf('## Codex: обновления и документация')
  expect(start).toBeGreaterThan(-1)
  const section = doc.slice(start, doc.indexOf('\n## ', start + 1) === -1 ? undefined : doc.indexOf('\n## ', start + 1))
  for (const page of ['cli', 'models', 'changelog', 'config-reference']) {
    expect(section).toContain('https://developers.openai.com/codex/' + page)
  }
  expect(section).toContain('/update codex')
  expect(section).toMatch(/changelog[^\n]*(before|перед)/i)
})

test('[S9] the architecture map names the self-update modules and the boot guard', () => {
  const doc = read('docs/ARCHITECTURE.md')
  for (const name of ['restart-intent.ts', 'self-update.ts', 'codex-update.ts', 'update-commands.ts', 'watchdogs.ts', 'boot-guard.sh']) {
    expect(doc).toContain(name)
  }
})
