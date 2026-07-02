#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root to read /root/jerry/opt/codex-web-workbench/secrets/secrets.env" >&2
  exit 1
fi

# shellcheck disable=SC1091
. /root/jerry/opt/codex-web-workbench/secrets/secrets.env

cat <<EOF
Workbench URL:      https://eu.jerrypsy.top/codex/
Workbench user:     ${CODEX_WEB_USER}
Workbench password: ${CODEX_WEB_PASSWORD}

code-server URL:    https://eu.jerrypsy.top/codex/ide/
code-server pass:   ${CODE_SERVER_PASSWORD}
EOF
