#!/usr/bin/env bash
set -euo pipefail

BASE_SESSION="${WORKBENCH_TMUX_SESSION:-codex-workbench}"
VIEW_PREFIX="${WORKBENCH_VIEW_SESSION_PREFIX:-${BASE_SESSION}-view-}"
VIEW_ID=''

for arg in "$@"; do
  case "$arg" in
    view=*) VIEW_ID="${arg#view=}";;
    session=*) VIEW_ID="${arg#session=}";;
    view%3D*) VIEW_ID="${arg#view%3D}";;
    view%3d*) VIEW_ID="${arg#view%3d}";;
    session%3D*) VIEW_ID="${arg#session%3D}";;
    session%3d*) VIEW_ID="${arg#session%3d}";;
  esac
done

if [[ "$VIEW_ID" =~ ^[a-f0-9]{32}$ ]]; then
  VIEW_SESSION="${VIEW_PREFIX}${VIEW_ID}"

  if ! tmux has-session -t "$BASE_SESSION" 2>/dev/null; then
    /root/jerry/opt/codex-web-workbench/bin/ensure-workbench-tmux.sh >/dev/null
  fi

  if ! tmux has-session -t "$VIEW_SESSION" 2>/dev/null; then
    tmux new-session -d -t "$BASE_SESSION" -s "$VIEW_SESSION"
  fi

  SESSION_GROUP="$(tmux display-message -p -t "$VIEW_SESSION" '#{session_group}' 2>/dev/null || true)"
  if [[ "$SESSION_GROUP" == "$BASE_SESSION" ]]; then
    exec tmux attach-session -t "$VIEW_SESSION"
  fi
fi

exec tmux attach-session -t "$BASE_SESSION"
