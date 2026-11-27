import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { safetyHook } from '../../../codex-hooks/src/pre.js'
import { assess, assessPatch, type SafetyView } from '../../../codex-hooks/src/safety.js'
import type { HookContext } from '../../../codex-hooks/src/types.js'

const OWNER = 'AGENTS.md меняет только владелец. Предложи правку владельцу.'
const HINT = 'write it as plain commands, one per line'
const view: SafetyView = {
  cwd: '/work/repo', home: '/home/u', branchOf: () => undefined, exists: () => false,
}

const shellWrites = [
  ['overwrite redirect', 'echo x > ~/.codex/AGENTS.md'],
  ['append redirect', 'echo x >> ~/.codex/AGENTS.override.md'],
  ['clobber redirect', 'echo x >| ~/.codex/AGENTS.md'],
  ['read/write redirect', ': <> ~/.codex/AGENTS.md'],
  ['CODEX_HOME redirect', 'echo x > "${CODEX_HOME}/AGENTS.md"'],
  ['HOME redirect', 'echo x >> "$HOME/.codex/AGENTS.md"'],
  ['tee overwrite', 'echo x | tee ~/.codex/AGENTS.md'],
  ['tee append', 'echo x | tee -a ~/.codex/AGENTS.md'],
  ['cp destination', 'cp draft ~/.codex/sub/../AGENTS.md'],
  ['mv destination', 'mv draft ~/.codex/AGENTS.md'],
  ['mv source', 'mv ~/.codex/AGENTS.md draft'],
  ['rm target', 'rm ~/.codex/AGENTS.md'],
  ['rm glob', 'rm ~/.codex/AGENTS*.md'],
  ['rm parent directory', 'rm -r ~/.codex'],
  ['ln destination', 'ln -sf draft ~/.codex/AGENTS.md'],
  ['ln hard-link source', 'ln ~/.codex/AGENTS.md copy'],
  ['sed in place', "sed -Ei 's/a/b/' ~/.codex/AGENTS.md"],
  ['perl in place', "perl -pi.bak -e 's/a/b/' ~/.codex/AGENTS.md"],
  ['perl in place with warnings', "perl -wpi -e 's/a/b/' ~/.codex/AGENTS.md"],
  ['truncate target', 'truncate -s 0 ~/.codex/AGENTS.md'],
  ['chmod target', 'chmod 644 ~/.codex/AGENTS.md'],
  ['chmod recursive target', 'chmod -R 744 ~/.codex'],
  ['chown target', 'chown -h u ~/.codex/AGENTS.md'],
  ['chown recursive target', 'chown --recursive u ~/.codex'],
  ['relative target after cd', 'cd ~/.codex && tee AGENTS.md'],
  ['relative target after CODEX_HOME cd', 'cd "$CODEX_HOME" && tee -a AGENTS.md'],
  ['wrapper working directory', 'env -C ~/.codex tee -a AGENTS.md'],
] as const

for (const [label, command] of shellWrites) {
  test(`owner instructions deny ${label}`, () => {
    expect(assess(command, view)).toEqual({ deny: `Заблокировано защитой: ${OWNER}`, plans: [] })
  })
}

for (const [label, command] of [
  ['Python inline write', `python3 -c 'open("/home/u/.codex/AGENTS.md", "w")'`],
  ['Python inline write using Path.home', `python3 -c 'from pathlib import Path; (Path.home() / ".codex" / "AGENTS.md").write_text("x")'`],
  ['Node -c inline write', `node -c 'require("fs").writeFileSync("/home/u/.codex/AGENTS.md", "x")'`],
  ['Node inline write', `node -e 'require("fs").appendFileSync("/home/u/.codex/AGENTS.override.md", "x")'`],
  ['Node inline write joining path segments', `node -e 'require("fs").writeFileSync(require("path").join("/home/u/.codex", "AGENTS.md"), "x")'`],
  ['nested shell write', `bash -c 'echo x >> ~/.codex/AGENTS.md'`],
  ['nested read followed by an owner write', `bash -c 'cat ~/.codex/AGENTS.md && tee ~/.codex/AGENTS.md'`],
  ['nested read with an owner output redirect', `sh -c 'cat ~/.codex/AGENTS.md > ~/.codex/AGENTS.override.md'`],
  ['nested override write after a variable cd', `bash -c 'ls ~/.codex; base=~; cd "$base"/.codex && printf x >> AGENTS.override.md'`],
  ['nested main instructions write after a variable cd', `bash -c 'ls ~/.codex; base=~; cd "$base"/.codex && printf x >> AGENTS.md'`],
  ['nested write inheriting an unresolved directory', `base=~; cd "$base"/.codex && bash -c 'ls ~/.codex; printf x >> AGENTS.md'`],
  ['nested variable output target after a directory listing', `bash -c 'ls ~/.codex; printf x >> "$file"'`],
  ['nested ambiguous write after a directory listing', `bash -c 'ls ~/.codex; dir="/home/u/.codex"; file=AGENTS.md; echo x > "$dir/$file"'`],
] as const) {
  test(`owner instructions deny ${label} with the plain-commands hint`, () => {
    const verdict = assess(command, view)
    expect(verdict.deny).toContain(OWNER)
    expect(verdict.deny).toContain(HINT)
    expect(verdict.plans).toEqual([])
  })
}

for (const [label, directives] of [
  ['patch add', '*** Add File: /home/u/.codex/AGENTS.md\n+x'],
  ['patch update', '*** Update File: ~/.codex/AGENTS.md\n@@\n-old\n+new'],
  ['patch delete', '*** Delete File: /home/u/.codex/sub/../AGENTS.override.md'],
  ['patch move in', '*** Update File: draft\n*** Move to: /home/u/.codex/AGENTS.md'],
  ['patch move out', '*** Update File: /home/u/.codex/AGENTS.md\n*** Move to: draft'],
] as const) {
  test(`owner instructions deny ${label}`, () => {
    expect(assessPatch(`*** Begin Patch\n${directives}\n*** End Patch`, view))
      .toEqual({ deny: `Заблокировано защитой: ${OWNER}`, plans: [] })
  })
}

for (const [label, command] of [
  ['cat', 'cat ~/.codex/AGENTS.md'],
  ['cat in sh -c', `sh -c 'cat ~/.codex/AGENTS.md'`],
  ['grep in bash -c', `bash -c 'grep x ~/.codex/AGENTS.md'`],
  ['grep via stdin in bash -c', `bash -c 'grep x < ~/.codex/AGENTS.md'`],
  ['grep via stdin with a project output in bash -c', `bash -c 'grep x < ~/.codex/AGENTS.md > AGENTS.md'`],
  ['nested directory listing before a project edit', `sh -c 'ls ~/.codex' && echo x >> AGENTS.md`],
  ['directory listing and project edit in bash -c', `bash -c 'ls ~/.codex && echo x >> AGENTS.md'`],
  ['grep', 'grep owner "${CODEX_HOME}/AGENTS.override.md"'],
  ['cp from owner file', 'cp ~/.codex/AGENTS.md draft'],
  ['grep via stdin', 'grep owner < ~/.codex/AGENTS.md'],
  ['sed without in-place flag', "sed 's/a/b/' ~/.codex/AGENTS.md"],
  ['chmod reference', 'chmod --reference=/home/u/.codex/AGENTS.md draft'],
  ['project file edit', "sed -i 's/a/b/' AGENTS.md && echo x >> AGENTS.override.md"],
  ['other .codex directory', 'echo x >> repo/.codex/AGENTS.md'],
  ['quoted wildcard filename', 'echo x >> "$CODEX_HOME/AGENTS*.md"'],
  ['project filename in inline code', `python -c 'open("AGENTS.md", "w")'`],
] as const) {
  test(`owner instructions allow ${label}`, () => {
    expect(assess(command, view).deny).toBeUndefined()
  })
}

test('owner instructions allow project patches', () => {
  expect(assessPatch('*** Begin Patch\n*** Add File: AGENTS.md\n+x\n*** End Patch', view).deny).toBeUndefined()
})

test('owner instructions allow a literal wildcard filename in a patch', () => {
  expect(assessPatch('*** Begin Patch\n*** Add File: /home/u/.codex/AGENTS*.md\n+x\n*** End Patch', view).deny).toBeUndefined()
})

test('PreToolUse protects configured Codex home through symlinks and parent segments', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-owner-agents-'))
  try {
    const codexHome = join(root, 'settings', 'codex')
    const folder = join(codexHome, 'sub')
    const cwd = join(root, 'repo')
    mkdirSync(folder, { recursive: true })
    mkdirSync(join(cwd, 'sub'), { recursive: true })
    symlinkSync(folder, join(cwd, 'hop'))
    symlinkSync(join(cwd, 'sub'), join(codexHome, 'towards-repo'))
    symlinkSync(join(codexHome, 'AGENTS.md'), join(cwd, 'dangling'))
    const ctx: HookContext = {
      event: 'PreToolUse', input: { cwd }, config: DEFAULT_CONFIG, home: root, codexHome,
      stateDir: join(root, 'state'), now: () => 0, gbrain: undefined, log: () => undefined,
      run: () => ({ code: 1, stdout: '' }),
    }
    const shell = (command: string, workdir?: string) => safetyHook({ ...ctx, input: { cwd, tool_name: 'Bash', tool_input: { command, workdir } } })
    const patch = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`
    for (const command of ['echo x >> hop/../AGENTS.md', 'echo x >> dangling',
      'cp AGENTS.override.md "$CODEX_HOME"', 'ln -s AGENTS.md -t "$CODEX_HOME"',
      `true && env apply_patch '${patch('hop/../AGENTS.md')}'`]) {
      expect({ command, deny: shell(command).deny }).toEqual({ command, deny: expect.stringContaining(OWNER) })
    }
    expect(safetyHook({ ...ctx, input: { cwd, tool_name: 'apply_patch', tool_input: { input: patch('hop/../AGENTS.md') } } }).deny)
      .toContain(OWNER)
    expect(shell('echo x >> ~/.codex/AGENTS.md')).toEqual({})
    expect(shell('cat hop/../AGENTS.md')).toEqual({})
    expect(shell('echo x >> AGENTS.override.md', codexHome).deny).toContain(OWNER)
    expect(shell('cd "$CODEX_HOME" && echo x >> towards-repo/../AGENTS.md')).toEqual({})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
