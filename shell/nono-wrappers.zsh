# nono-wrappers.zsh — harness launchers under nono, with on-the-fly
# profile expansion.
#
# Flow: run the harness sandboxed; if the session leaves ANY new profile
# draft when it exits (the agent proposing a grant it was denied), run
# `nono profile promote` per draft — nono itself renders the diff and
# asks "Promote this draft? [y/N]"; that prompt is the human gate and
# this script never answers it — then resume the same conversation.
# Grants apply only on y; on N the profile is unchanged and the draft
# stays in profile-drafts/ (the mtime fence keeps it from retriggering).
#
# Profile handoff rule: if a freshly promoted draft's name starts with
# the current profile name (claude → claude-desktop, claude-local), it
# is a derived SESSION profile and the relaunch switches to it. Other
# promotes (e.g. agent-base) update inherited grants; the relaunch
# keeps the current profile and picks them up at start.
#
# Install: source this file from ~/.zshrc and remove any older
# claude/codex aliases (zsh aliases would shadow these functions).
# Override the launch profile per invocation:
#   claude --nono-profile claude-desktop
# Design rationale + verification: me/_Security/how-to-use-nono.md
# § "On-the-fly profile expansion".

_nono_harness() {
  emulate -L zsh
  setopt local_options null_glob
  local profile=$1 cmd=$2 resume_args=$3
  shift 3
  local drafts=${XDG_CONFIG_HOME:-$HOME/.config}/nono/profile-drafts
  local marker rc d name switch_to
  local -a args=("$@")
  while true; do
    # Timestamp fence: only drafts written DURING this run count as
    # pending; stale (previously declined) drafts are ignored.
    marker=$(mktemp) || return 1
    command nono run --profile "$profile" -- "$cmd" "${args[@]}"
    rc=$?
    switch_to=""
    local promoted=0
    for d in "$drafts"/*.json; do
      [[ -f $d && $d -nt $marker ]] || continue
      name=${${d:t}%.json}
      print -P "%F{yellow}pending profile draft:%f $name"
      if nono profile promote "$name"; then   # human gate: nono shows diff, asks [y/N]
        promoted=1
        # Runnable session profiles are named after the harness
        # (claude, claude-desktop, claude-dummy, ...). Any freshly
        # promoted one becomes the relaunch target — including
        # SIBLINGS of the current profile (claude-desktop →
        # claude-dummy). Non-harness promotes (agent-base) only
        # update inherited grants. Last promoted wins; the resume
        # banner names the landing profile; --nono-profile overrides.
        [[ $name == ${cmd}* && $name != $profile ]] && switch_to=$name
      fi
    done
    rm -f -- "$marker"
    if (( promoted )); then
      if [[ -n $switch_to ]]; then
        print -P "%F{green}switching session profile:%f $profile → $switch_to"
        profile=$switch_to
      fi
      print -P "%F{green}resuming under profile:%f $profile"
      args=(${=resume_args})   # resume the same conversation
      continue
    fi
    return $rc
  done
}

# Older alias definitions may still be loaded in the live shell (e.g.
# re-sourcing .zshrc after removing them from the file). zsh expands
# aliases while PARSING function definitions, so clear them first and
# use the `function` keyword form, which is immune to alias expansion.
unalias claude codex humanlayer claude-raw codex-raw humanlayer-raw 2>/dev/null

typeset -g NONO_WRAPPERS_DIR=${${(%):-%N}:A:h}

# Sandboxed by default. Each relaunch is a fresh nono supervisor →
# expect one 1Password authorization per (re)start.
function claude {
  local p=claude
  [[ $1 == --nono-profile ]] && { p=$2; shift 2 }
  _nono_harness "$p" claude '--continue' "$@"
}
function codex {
  local p=codex
  [[ $1 == --nono-profile ]] && { p=$2; shift 2 }
  _nono_harness "$p" codex 'resume --last' "$@"
}

# Escape hatches: run the bare harness, no sandbox. For sessions that
# need something the profiles don't grant yet.
function claude-raw { command claude "$@" }
function codex-raw  { command codex  "$@" }
