import { describe, expect, test } from 'bun:test'
import { dangerReason, type SafetyView } from '../../../codex-hooks/src/safety.js'
import { readCommand } from '../../../codex-hooks/src/shell.js'

// Nothing on disk exists and no repository is dirty: only the reader and the mention rule decide.
const view: SafetyView = {
  cwd: '/work/repo', home: '/home/u', branchOf: () => 'feature/x', exists: () => false, dirty: () => false,
  tmpDirs: ['/tmp'],
}
const HINT = 'write it as plain commands, one per line'

describe('S1 strict reader', () => {
  const bypasses = [
    'if true; then rm -rf src; fi',
    '( rm notes.md )',
    '{ rm -rf src; }',
    '! rm -rf src',
    'for f in a b; do rm -rf $f; done',
    'while true; do rm -rf src; break; done',
    '(git push origin main)',
    'echo $(git push origin HEAD:main)',
    'x=`git push origin main`',
    'bash -c "rm -rf src"',
    'sh -c "git push origin main"',
    'find . -exec sh -c \'rm "$1"\' _ {} \;',
    'eval "rm -rf src"',
    'rm -rf src &',
    'cat <(cat .env)',
    'bash <<EOF\nrm -rf src\nEOF',
  ]
  for (const command of bypasses) {
    test(`[R17] unparsed and naming a guarded token is denied with the plain-commands hint: ${command}`, () => {
      expect(readCommand(command, view.cwd, '/home/u').unparsed).toBeDefined()
      expect(dangerReason(command, view)).toContain(HINT)
    })
  }

  test('[R17] an unparsed form that names no guarded token is allowed', () => {
    for (const command of ['for f in a b; do echo $f; done', 'echo "today: $(date +%F)"', 'if [ -f package.json ]; then bun install; fi']) {
      expect(readCommand(command, view.cwd, '/home/u').unparsed).toBeDefined()
      expect(dangerReason(command, view)).toBeUndefined()
    }
  })

  test('[R17] a redirect-only command is a parsed command that writes its target', () => {
    const reading = readCommand('> notes.md', view.cwd, '/home/u')
    expect(reading.unparsed).toBeUndefined()
    expect(reading.commands[0]?.writes[0]?.word.text).toBe('notes.md')
  })

  test('[R17] a heredoc into a non-shell program is data and stays parsed', () => {
    const reading = readCommand("cat > notes.md <<'EOF'\nrm -rf / ; git push origin main\nEOF", view.cwd, '/home/u')
    expect(reading.unparsed).toBeUndefined()
  })

  // Ordinary commands an agent writes in a working day: none of them may be denied.
  const corpus = [
    'ls -la',
    'pwd',
    'git status',
    'git status --short',
    'git diff',
    'git diff --stat HEAD~1',
    'git log --oneline -20',
    'git log --oneline | head -5',
    'git add -A',
    'git add src/app.ts tests/app.test.ts',
    'git commit -m "fix: handle empty input"',
    "git commit -m \"$(cat <<'EOF'\nfeat: add parser\n\nLonger body.\nEOF\n)\"",
    'git switch -c feature/parser',
    'git fetch origin',
    'git show HEAD --stat',
    'git rev-parse HEAD',
    'git stash list',
    'cd plugin && bun install',
    'cd plugin && bun test',
    'bun run build',
    'npm test',
    'npm run lint -- --fix',
    'npx tsc --noEmit -p .',
    'python3 -m pytest -q',
    'python3 scripts/report.py --out /tmp/report.md',
    'node -e "console.log(process.version)"',
    'cat README.md',
    'head -n 40 src/index.ts',
    'tail -f /tmp/server.log',
    'grep -rn "TODO" src',
    'rg -n "export function" src',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'wc -l src/*.ts',
    'sed -n 1,80p src/app.ts',
    'mkdir -p out/reports',
    'cp src/a.ts /tmp/a.ts',
    'mv draft.md /tmp/draft.md',
    'echo "done" > /tmp/flag',
    'echo hello >> notes.log',
    'curl -fsS https://example.com/api/health',
    'jq .version package.json',
    'date -u +%H:%M',
    'which bun',
    'test -f .env && echo present',
    'for f in src/*.ts; do wc -l "$f"; done',
    'for i in 1 2 3; do echo $i; sleep 1; done',
    'if [ -d node_modules ]; then echo ok; fi',
    'echo "$(date +%s) start" >> /tmp/run.log',
    'docker ps',
    'du -sh dist',
  ]
  test('[R17] the 50-command ordinary corpus gives 0 denies', () => {
    expect(corpus.length).toBe(50)
    const denied = corpus.filter(command => dangerReason(command, view) !== undefined)
    expect(denied).toEqual([])
  })
})
