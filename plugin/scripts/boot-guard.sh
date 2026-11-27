#!/usr/bin/env bash
# krotov-boot-guard-version: 2
# The bridge refuses to update while the installed copy carries an older version (GUARD_VERSION in
# plugin/src/codex/self-update.ts): bump both together whenever the bridge starts relying on new behaviour.
# Boot guard (docs/design/self-update-spec.md, S9): ExecStartPre=- of the configured bridge service.
# The unit runs a copy of this file kept outside the checkout (<state>/boot-guard.sh, written by
# install.sh and refreshed only when an update reached its health mark), so an update that deletes
# or breaks plugin/scripts/boot-guard.sh can still be rolled back. It runs in the unit's
# WorkingDirectory (the plugin directory), in bash only, so it works even when the new TypeScript
# cannot be loaded at all.
#
# It reads <git-dir>/krotov-update-pending, written by /update (plugin/src/codex/self-update.ts):
#   phase=trial, boots=0        -> the trial boot of the new commit: count it and start.
#   phase=trial, boots>=1       -> a trial boot ended before the health mark; the bridge wrote how
#                                  (outcome=stop|crash|watchdog|planned, nothing when it was killed):
#       stop                    -> an operator stop or a reboot: not a failure, try again;
#       crash, watchdog         -> roll back now;
#       planned or nothing      -> one failed trial boot (fails+1); the second one rolls back (S9.5).
#   phase=trial, HEAD == from   -> a rollback cut off after its reset: finish it (install again).
#   phase=applying              -> the bridge died in the middle of /update: roll back.
# Rolling back = git reset --keep <from>, then bun install --frozen-lockfile --ignore-scripts. The
# result is phase=rolled_back (the old version tells the owner) or phase=rollback_failed. Every step
# is safe to repeat, so a guard killed at any point is finished by the next start.
# A commit rolled back because its own boots failed is appended to <git-dir>/krotov-update-bad:
# an automatic update never installs it again (an interrupted apply is not the commit's fault).
#
# Probation (R29): after the health mark the bridge writes <git-dir>/krotov-update-probation
# (from, to, until = health mark + 600 s, crashes) and each boot of that commit writes how it ended.
# A crash, a watchdog exit or a kill (no outcome) counts; the third one before `until` rolls back
# like a failed trial. A clean stop or a planned restart does not count; past `until` the file goes.
# It never fails the start: every error is logged and the bridge starts anyway.
set -euo pipefail

log() { echo "boot-guard: $*" >&2; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || { log 'not a git checkout, nothing to do'; exit 0; }
pending=$(git rev-parse --path-format=absolute --git-path krotov-update-pending 2>/dev/null) || exit 0
bad=$(git rev-parse --path-format=absolute --git-path krotov-update-bad 2>/dev/null) || exit 0
probation=$(git rev-parse --path-format=absolute --git-path krotov-update-probation 2>/dev/null) || exit 0
sha='^[0-9a-f]{40}$'

# mark_bad SHA: listed once; a failure to write is logged, the rollback still goes on.
mark_bad() {
  if [[ -f $bad ]] && grep -qxF -- "$1" "$bad"; then return 0; fi
  printf '%s\n' "$1" >> "$bad" || log "could not mark ${1:0:12} as bad"
}

# A commit on probation after its health mark (see the header).
check_probation() {
  local v='' from='' to='' until='' crashes='' outcome='' key value head now tmp
  while IFS='=' read -r key value; do
    case $key in
      v) v=$value ;; from) from=$value ;; to) to=$value ;; until) until=$value ;; crashes) crashes=$value ;;
      outcome) outcome=$value ;;
    esac
  done < "$probation"
  if [[ $v != 1 || ! $from =~ $sha || ! $to =~ $sha || ! $until =~ ^[0-9]+$ || ! $crashes =~ ^[0-9]+$ ]]; then
    log 'malformed probation record, removed'
    rm -f -- "$probation"
    return 0
  fi
  head=$(git -C "$top" rev-parse HEAD)
  now=$(date +%s)
  if [[ $head != "$to" ]] || (( now > until )); then
    rm -f -- "$probation"
    return 0
  fi
  case $outcome in
    stop|planned) ;;
    *) crashes=$((crashes + 1))
       log "updated commit ${to:0:12} ended with ${outcome:-a kill} on probation ($crashes of 3)" ;;
  esac
  if (( crashes >= 3 )); then
    log "rolling back from ${to:0:12} to ${from:0:12} after $crashes crashes"
    mark_bad "$to"
    # phase=applying first: a guard killed during the reset or the install is finished by the next
    # start through the applying branch below. The end is the record a failed trial leaves, so the
    # old version tells the owner once (phase=rolled_back).
    write_probation_record() {
      printf 'v=1\nphase=%s\nfrom=%s\nto=%s\nboots=0\nat=%s000\nfails=0\n' "$1" "$from" "$to" "$now" > "$pending.tmp"
      mv -f -- "$pending.tmp" "$pending"
    }
    write_probation_record applying
    rm -f -- "$probation"
    local phase=rolled_back
    if ! git -C "$top" reset -q --keep "$from" || ! (cd "$top/plugin" && bun install --frozen-lockfile --ignore-scripts); then
      phase=rollback_failed
    fi
    write_probation_record "$phase"
    log "$phase"
    return 0
  fi
  tmp="$probation.tmp"
  printf 'v=1\nfrom=%s\nto=%s\nuntil=%s\ncrashes=%s\n' "$from" "$to" "$until" "$crashes" > "$tmp"
  mv -f -- "$tmp" "$probation"
}

if [[ ! -f $pending ]]; then
  if [[ -f $probation ]]; then check_probation || log 'probation check failed'; fi
  exit 0
fi

v='' phase='' from='' to='' boots='' at='' fails=0 outcome=''
while IFS='=' read -r key value; do
  case $key in
    v) v=$value ;; phase) phase=$value ;; from) from=$value ;; to) to=$value ;; boots) boots=$value ;; at) at=$value ;;
    fails) fails=$value ;; outcome) outcome=$value ;;
  esac
done < "$pending"

if [[ $v != 1 || ! $from =~ $sha || ! $to =~ $sha || ! $boots =~ ^[0-9]+$ || ! $at =~ ^[0-9]+$ || ! $fails =~ ^[0-9]+$ ]]; then
  log 'malformed update record, ignored'
  exit 0
fi

# write_record PHASE BOOTS FAILS: the outcome of the previous boot is consumed, the next boot writes its own.
write_record() {
  local tmp="$pending.tmp"
  printf 'v=1\nphase=%s\nfrom=%s\nto=%s\nboots=%s\nat=%s\nfails=%s\n' "$1" "$from" "$to" "$2" "$at" "$3" > "$tmp"
  mv -f -- "$tmp" "$pending"
}

# roll_back [bad]: with `bad` the new commit failed on its own and is never installed automatically again.
roll_back() {
  log "rolling back from ${to:0:12} to ${from:0:12}"
  if [[ ${1:-} == bad ]]; then mark_bad "$to"; fi
  if git -C "$top" reset -q --keep "$from" && (cd "$top/plugin" && bun install --frozen-lockfile --ignore-scripts); then
    write_record rolled_back "$boots" "$fails"
    log 'rolled back'
  else
    write_record rollback_failed "$boots" "$fails"
    log 'rollback failed; check git status and dependencies'
  fi
}

case $phase in
  applying)
    roll_back ;;
  trial)
    head=$(git -C "$top" rev-parse HEAD)
    if [[ $head == "$from" ]]; then
      log 'finishing a rollback that was cut off'
      roll_back
    elif [[ $head != "$to" ]]; then
      log 'HEAD moved since the update, record left as is'
    elif (( boots == 0 )); then
      write_record trial 1 "$fails"
      log "trial boot of ${to:0:12}"
    else
      case $outcome in
        stop)
          write_record trial $((boots + 1)) "$fails"
          log "trial boot of ${to:0:12} was stopped cleanly; trying it again" ;;
        crash|watchdog)
          log "trial boot of ${to:0:12} ended with $outcome"
          roll_back bad ;;
        *)
          fails=$((fails + 1))
          if (( fails >= 2 )); then
            log "trial boot of ${to:0:12} failed $fails times"
            roll_back bad
          else
            write_record trial $((boots + 1)) "$fails"
            log "trial boot of ${to:0:12} ended early (${outcome:-killed}); one more try"
          fi ;;
      esac
    fi ;;
  *) ;;
esac
exit 0
