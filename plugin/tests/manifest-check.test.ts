// Tests for scripts/manifest-check.sh, the acceptance judge's requirement check: fixtures of
// `bun test --reporter=junit` output, and real `bun test` runs in a throwaway repository.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const script = join(import.meta.dir, '..', '..', 'scripts', 'manifest-check.sh')
const fixtures = join(import.meta.dir, 'fixtures', 'manifest-check')
const checklist = join(fixtures, 'CHECKLIST.md')

interface Run { out: string; code: number }

// Runs the script with POSIX /bin/sh in cwd. The caller's MANIFEST_* settings belong to the caller's
// run, not to the fixture's, so they are dropped.
function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Run {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('MANIFEST_') && value !== undefined) env[key] = value
  }
  const tmp = mkdtempSync(join(tmpdir(), 'manifest-check-tmp-'))
  try {
    const proc = Bun.spawnSync(['/bin/sh', script, ...args], { cwd, env: { ...env, TMPDIR: tmp, ...extraEnv } })
    return { out: proc.stdout.toString() + proc.stderr.toString(), code: proc.exitCode }
  } finally { rmSync(tmp, { force: true, recursive: true }) }
}

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-check-'))
  try { body(dir) } finally { rmSync(dir, { force: true, recursive: true }) }
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
}

const header = '| ID | Brief quote | Contract | Rationale |\n|---|---|---|---|\n'

test('every live requirement with a passing tagged test exits 0; D rows and non-live tags only count as notes', () => {
  withDir((dir) => {
    const { out, code } = run(dir, [join(fixtures, 'pass.xml')], { MANIFEST_CHECKLIST: checklist })
    expect(code).toBe(0)
    for (const want of [
      'ok       R01  tests/login.test.ts:4 [R01] login page renders',
      'ok       R02  tests/login.test.ts:5 [R02][R03i] logout keeps the session',
      'ok       R03i  tests/login.test.ts:5 [R02][R03i] logout keeps the session',
      'ok       G01  tests/audit.test.ts:2 [G01] writes "quoted" & <tagged> lines',
      'note     [R04] tags tests/audit.test.ts:3 [R04] draft report but is not a live requirement',
      'manifest-check: 4 of 4 live requirements have a passing tagged test',
    ]) expect(out).toContain(want)
    expect(out).not.toContain('D01')
  })
})

test('failed, errored, skipped, todo, describe-only and output-only tags do not count: exit 1 names each', () => {
  withDir((dir) => {
    const { out, code } = run(dir, [join(fixtures, 'missing.xml')], { MANIFEST_CHECKLIST: checklist })
    expect(code).toBe(1)
    for (const want of [
      'ok       R01  tests/login.test.ts:2 [R01] login page renders',
      'MISSING  R02  no passing test tagged [R02] (failed: tests/login.test.ts:3 [R02] logout)',
      'MISSING  R03i  no passing test tagged [R03i]\n',
      'MISSING  G01  no passing test tagged [G01] (failed: tests/login.test.ts:5 [G01] audit log)',
      'manifest-check: 1 of 4 live requirements have a passing tagged test',
    ]) expect(out).toContain(want)
  })
})

test('bad input exits 2: no checklist, no live requirement, empty test report', () => {
  withDir((dir) => {
    let r = run(dir, [join(fixtures, 'pass.xml')])
    expect(r.code).toBe(2)
    expect(r.out).toContain('brief/CHECKLIST.md not found')

    const noLive = join(dir, 'none.md')
    writeFileSync(noLive, `${header}| R01 | x | deferred | later |\n`)
    r = run(dir, [join(fixtures, 'pass.xml')], { MANIFEST_CHECKLIST: noLive })
    expect(r.code).toBe(2)
    expect(r.out).toContain('no live requirements')

    const empty = join(dir, 'empty.xml')
    writeFileSync(empty, '')
    r = run(dir, [empty], { MANIFEST_CHECKLIST: checklist })
    expect(r.code).toBe(2)
    expect(r.out).toContain('no bun test output')
  })
})

const loginTest = (extra: string) => "import { expect, test } from 'bun:test'\nimport { existsSync, writeFileSync } from 'node:fs'\n" +
  "test('[R01] login page renders', () => {\n" + extra + "  expect(existsSync('broken')).toBe(false)\n})\n"

test('without an argument it runs bun test in plugin/ itself and fails once the tagged test fails', () => {
  withDir((repo) => {
    writeTree(repo, {
      'brief/CHECKLIST.md': `${header}| R01 | «a login page» | live | brief |\n`,
      'plugin/package.json': '{ "name": "fixture", "private": true }\n',
      'plugin/tests/app.test.ts': loginTest(''),
    })
    let r = run(repo, [])
    expect(r.out).toContain('manifest-check: bun test exit 0')
    expect(r.out).toContain('ok       R01  tests/app.test.ts:3 [R01] login page renders')
    expect(r.code).toBe(0)

    writeFileSync(join(repo, 'plugin', 'broken'), '')
    r = run(repo, [])
    expect(r.out).toContain('MISSING  R01  no passing test tagged [R01] (failed: tests/app.test.ts:3 [R01] login page renders)')
    expect(r.code).toBe(1)
  })
})

test('live IDs are read before the tests run, so a test that shrinks the checklist cannot drop a requirement', () => {
  withDir((repo) => {
    const shrunk = JSON.stringify(`${header}| R01 | «a login page» | live | brief |\n`)
    writeTree(repo, {
      'brief/CHECKLIST.md': `${header}| R01 | «a login page» | live | brief |\n| R02 | «a logout button» | live | brief |\n`,
      'plugin/package.json': '{ "name": "fixture", "private": true }\n',
      'plugin/tests/app.test.ts': loginTest(`  writeFileSync('../brief/CHECKLIST.md', ${shrunk})\n`),
    })
    const r = run(repo, [])
    expect(r.out).toContain('MISSING  R02  no passing test tagged [R02]')
    expect(r.out).toContain('manifest-check: 1 of 2 live requirements have a passing tagged test')
    expect(r.code).toBe(1)
    expect(readFileSync(join(repo, 'brief', 'CHECKLIST.md'), 'utf8')).not.toContain('R02')
  })
})

test('the script is a regular executable file', () => {
  expect(existsSync(script)).toBe(true)
  expect(Bun.spawnSync(['test', '-x', script]).exitCode).toBe(0)
})
