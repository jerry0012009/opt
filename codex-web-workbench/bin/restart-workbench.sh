#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

nginx -t
systemctl restart codex-tmux.service codex-code-server.service codex-ttyd.service codex-control.service
systemctl reload nginx
systemctl --no-pager --full status codex-tmux.service codex-code-server.service codex-ttyd.service codex-control.service
