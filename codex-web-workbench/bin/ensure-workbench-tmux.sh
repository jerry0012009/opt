#!/usr/bin/env bash
set -euo pipefail

SESSION="${WORKBENCH_TMUX_SESSION:-codex-workbench}"
WORKDIR="${WORKBENCH_WORKDIR:-/root/jerry}"
SHELL_COMMAND="${WORKBENCH_SHELL_COMMAND:-/bin/bash -l}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed" >&2
  exit 1
fi

mkdir -p "$WORKDIR"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c "$WORKDIR" "$SHELL_COMMAND"
fi

tmux display-message -p -t "$SESSION" '#S'
