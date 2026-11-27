#!/usr/bin/env bash
# Boot guard (docs/design/self-update-spec.md, S9): ExecStartPre=- of krotov-telegram.service.
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
# It never fails the start: every error is logged and the bridge starts anyway.
set -euo pipefail

log() { echo "boot-guard: $*" >&2; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || { log 'not a git checkout, nothing to do'; exit 0; }
pending=$(git rev-parse --path-format=absolute --git-path krotov-update-pending 2>/dev/null) || exit 0
[[ -f $pending ]] || exit 0

v='' phase='' from='' to='' boots='' at='' fails=0 outcome=''
while IFS='=' read -r key value; do
  case $key in
    v) v=$value ;; phase) phase=$value ;; from) from=$value ;; to) to=$value ;; boots) boots=$value ;; at) at=$value ;;
    fails) fails=$value ;; outcome) outcome=$value ;;
  esac
done < "$pending"

sha='^[0-9a-f]{40}$'
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

roll_back() {
  log "rolling back from ${to:0:12} to ${from:0:12}"
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
          roll_back ;;
        *)
          fails=$((fails + 1))
          if (( fails >= 2 )); then
            log "trial boot of ${to:0:12} failed $fails times"
            roll_back
          else
            write_record trial $((boots + 1)) "$fails"
            log "trial boot of ${to:0:12} ended early (${outcome:-killed}); one more try"
          fi ;;
      esac
    fi ;;
  *) ;;
esac
exit 0
