#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$PROJECT_DIR/secrets/secrets.env"
BASE_URL="${1:-https://eu.jerrypsy.top}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$SECRETS_FILE"

printf 'unauth /codex/: '
curl -k -s -o /dev/null -w '%{http_code}\n' "$BASE_URL/codex/"

printf 'terminal: '
curl -k -s -u "$CODEX_WEB_USER:$CODEX_WEB_PASSWORD" -o /tmp/workbench-terminal.html -w '%{http_code} %{content_type}\n' "$BASE_URL/codex/terminal/"

printf 'terminal api: '
curl -k -s -u "$CODEX_WEB_USER:$CODEX_WEB_PASSWORD" -o /tmp/workbench-status.json -w '%{http_code} %{content_type}\n' "$BASE_URL/codex/terminal/api/status"

printf 'ttyd: '
curl -k -s -u "$CODEX_WEB_USER:$CODEX_WEB_PASSWORD" -o /tmp/workbench-ttyd.html -w '%{http_code} %{content_type}\n' "$BASE_URL/codex/ttyd/"

printf 'code-server login: '
curl -k -s -H 'Accept: text/html' -u "$CODEX_WEB_USER:$CODEX_WEB_PASSWORD" -o /tmp/workbench-ide.html -w '%{http_code} %{content_type}\n' "$BASE_URL/codex/ide/login"

printf 'session running: '
jq -r '.running' /tmp/workbench-status.json

systemctl is-active codex-tmux.service codex-code-server.service codex-ttyd.service codex-control.service | tr '\n' ' '
printf '\n'
