#!/bin/sh
# manifest-check.sh: the acceptance judge's requirement check for this repository (bun + TypeScript),
# adapted from the agent-jobs reference scripts/manifest-check.sh for Go repositories.
#
# Every live requirement of brief/CHECKLIST.md (an R, Ri or G row with contract live) needs at least
# one test tagged with its ID that passed in this run; otherwise the script exits non-zero. A test is
# tagged by its own name: test('[R01] login works', ...). One name may carry several tags
# ("[R01][R03i] ..."). A tag in a describe() name does not count: bun's JUnit report keeps only the
# test's own name reliably.
#
# Usage: scripts/manifest-check.sh [junit-xml-file]
#   With a file, it reads `bun test --reporter=junit` output from it; without one it runs
#   `cd plugin && bun test --reporter=junit $MANIFEST_BUN_TEST_ARGS` itself, from the repository root,
#   after `bun install --frozen-lockfile` when plugin/node_modules is missing (at most
#   MANIFEST_INSTALL_TIMEOUT seconds, default 300; a cold cache needs the npm registry), and reports
#   the type check (`tsc --noEmit` of plugin's own TypeScript, run by bun) for information.
# Environment: MANIFEST_CHECKLIST (default brief/CHECKLIST.md).
# Exit: 0 every live requirement has a passing tagged test; 1 at least one has none;
#       2 bad input (no checklist, no live requirement, no test output, no bun, failed install).
#
# POSIX sh and awk only: no jq, no bash.
set -u

checklist=${MANIFEST_CHECKLIST:-brief/CHECKLIST.md}
if [ ! -f "$checklist" ]; then
  echo "manifest-check: $checklist not found" >&2
  exit 2
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/manifest-check.XXXXXX") || exit 2
trap 'rm -rf "$tmp"' EXIT
trap 'exit 2' HUP INT TERM

# The live requirement IDs, read before any test runs (a test that rewrites the checklist cannot
# shrink the set): table rows whose ID is R<nn>, R<nn>i or G<nn> and whose contract names live.
# Cells may hold escaped pipes (\|) and backslashes (\\), as agent-jobs writes them.
awk '
/^[ \t]*\|/ {
  line = $0
  gsub(/\\\\/, "\001", line)
  gsub(/\\\|/, "\002", line)
  n = split(line, c, "|")
  if (n < 5) next
  id = c[2]
  gsub(/^[ \t]+|[ \t]+$/, "", id)
  if (id !~ /^(R[0-9][0-9]+i?|G[0-9][0-9]+)$/) next
  contract = tolower(c[4])
  gsub(/,/, " ", contract)
  m = split(contract, w, /[ \t]+/)
  for (i = 1; i <= m; i++) if (w[i] == "live") { print id; break }
}' "$checklist" | sort -u >"$tmp/live"

if [ ! -s "$tmp/live" ]; then
  echo "manifest-check: $checklist has no live requirements" >&2
  exit 2
fi

if [ $# -gt 0 ]; then
  xml=$1
  if [ ! -f "$xml" ]; then
    echo "manifest-check: $xml not found" >&2
    exit 2
  fi
else
  xml=$tmp/junit.xml
  if ! command -v bun >/dev/null 2>&1; then
    echo "manifest-check: bun not found on PATH" >&2
    exit 2
  fi
  if [ ! -d plugin/node_modules ] && [ -f plugin/bun.lock ]; then
    limit=${MANIFEST_INSTALL_TIMEOUT:-300}
    if command -v timeout >/dev/null 2>&1; then
      (cd plugin && timeout "$limit" bun install --frozen-lockfile) >"$tmp/install.out" 2>&1
    else
      (cd plugin && bun install --frozen-lockfile) >"$tmp/install.out" 2>&1
    fi
    rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "manifest-check: bun install --frozen-lockfile exit $rc (a cold cache needs the npm registry)" >&2
      tail -n 20 "$tmp/install.out" >&2
      exit 2
    fi
  fi
  # shellcheck disable=SC2086 # the argument list is split on purpose
  (cd plugin && bun test --reporter=junit --reporter-outfile="$xml" ${MANIFEST_BUN_TEST_ARGS:-}) >"$tmp/bun-test.out" 2>&1
  echo "manifest-check: bun test exit $? (failing untagged tests are not this script's business)"
  if [ -f plugin/node_modules/typescript/bin/tsc ]; then
    (cd plugin && bun node_modules/typescript/bin/tsc --noEmit) >"$tmp/tsc.out" 2>&1
    rc=$?
    echo "manifest-check: tsc --noEmit exit $rc (for information; it does not change this script's exit code)"
    if [ "$rc" -ne 0 ]; then head -n 20 "$tmp/tsc.out"; fi
  else
    echo "manifest-check: tsc --noEmit skipped (plugin/node_modules/typescript not installed)"
  fi
fi

if [ ! -s "$xml" ]; then
  echo "manifest-check: no bun test output" >&2
  if [ -s "$tmp/bun-test.out" ]; then tail -n 20 "$tmp/bun-test.out" >&2; fi
  exit 2
fi

# The tagged tests that passed or failed, one line per tag: <state> TAB <ID> TAB <file:line name>.
# bun writes one <testcase> element per test: self-closing when it passed, with a <failure>, <error>
# or <skipped> child otherwise. Test output never lands inside the report as markup (it is escaped
# or absent), so a tag printed by another test cannot count.
awk '
function attr(s, key,    v) {
  if (!match(s, "[ \t]" key "=\"[^\"]*\"")) return ""
  v = substr(s, RSTART, RLENGTH)
  sub(/^[ \t][^=]*="/, "", v)
  sub(/"$/, "", v)
  return v
}
function unescape(s) {
  gsub(/&quot;/, "\"", s); gsub(/&apos;/, "'\''", s)
  gsub(/&lt;/, "<", s); gsub(/&gt;/, ">", s); gsub(/&amp;/, "\\&", s)
  return s
}
function emit(    rest) {
  rest = name
  while (match(rest, /\[[RG][0-9][0-9]+i?\]/)) {
    if (state != "skip") printf "%s\t%s\t%s\n", state, substr(rest, RSTART + 1, RLENGTH - 2), label
    rest = substr(rest, RSTART + RLENGTH)
  }
  open = 0
}
function scan(s) {
  if (s ~ /<(failure|error)[ \t\/>]/) state = "fail"
  else if (s ~ /<skipped[ \t\/>]/ && state != "fail") state = "skip"
  if (s ~ /<\/testcase>/) emit()
}
/^[ \t]*<testcase[ \t>]/ {
  tag = $0
  sub(/^[ \t]*/, "", tag)
  rest = ""
  if (index(tag, ">") > 0) { rest = substr(tag, index(tag, ">") + 1); tag = substr(tag, 1, index(tag, ">")) }
  name = unescape(attr(tag, "name"))
  label = unescape(attr(tag, "file")) ":" attr(tag, "line") " " name
  state = "pass"
  open = 1
  if (tag ~ /\/>$/) emit()
  else scan(rest)
  next
}
open { scan($0) }' "$xml" >"$tmp/tagged"

total=0
missing=0
while IFS= read -r id; do
  total=$((total + 1))
  hit=$(awk -F '\t' -v id="$id" '$1 == "pass" && $2 == id { print $3; exit }' "$tmp/tagged")
  if [ -n "$hit" ]; then
    echo "ok       $id  $hit"
  else
    missing=$((missing + 1))
    failed=$(awk -F '\t' -v id="$id" '$1 == "fail" && $2 == id { print $3; exit }' "$tmp/tagged")
    if [ -n "$failed" ]; then
      echo "MISSING  $id  no passing test tagged [$id] (failed: $failed)"
    else
      echo "MISSING  $id  no passing test tagged [$id]"
    fi
  fi
done <"$tmp/live"

# Tags that name no live requirement: a typo, or a deferred or dropped row.
awk -F '\t' 'NR == FNR { live[$1] = 1; next } !($2 in live) && !seen[$2]++ { print "note     [" $2 "] tags " $3 " but is not a live requirement" }' \
  "$tmp/live" "$tmp/tagged"

echo "manifest-check: $((total - missing)) of $total live requirements have a passing tagged test"
if [ "$missing" -gt 0 ]; then
  exit 1
fi
exit 0
