#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$PROJECT_DIR/secrets/secrets.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/secrets"
chmod 0700 "$PROJECT_DIR/secrets"

if [ ! -f "$SECRETS_FILE" ]; then
  WEB_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
  CODE_SERVER_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
  umask 077
  cat > "$SECRETS_FILE" <<EOF
CODEX_WEB_USER=jerry
CODEX_WEB_PASSWORD=${WEB_PASSWORD}
CODE_SERVER_PASSWORD=${CODE_SERVER_PASSWORD}
EOF
fi

# shellcheck disable=SC1090
. "$SECRETS_FILE"

if [ -z "${CODEX_WEB_USER:-}" ] || [ -z "${CODEX_WEB_PASSWORD:-}" ] || [ -z "${CODE_SERVER_PASSWORD:-}" ]; then
  echo "Missing CODEX_WEB_USER, CODEX_WEB_PASSWORD, or CODE_SERVER_PASSWORD in $SECRETS_FILE" >&2
  exit 1
fi

chmod 0600 "$SECRETS_FILE"

htpasswd -bc /etc/nginx/codex-workbench.htpasswd "$CODEX_WEB_USER" "$CODEX_WEB_PASSWORD" >/dev/null
chown root:www-data /etc/nginx/codex-workbench.htpasswd
chmod 0640 /etc/nginx/codex-workbench.htpasswd

install -d -m 0700 /root/.config/code-server
sed "s#__CODE_SERVER_PASSWORD__#${CODE_SERVER_PASSWORD//\\/\\\\}#g" \
  "$PROJECT_DIR/config/code-server.config.yaml.template" > /root/.config/code-server/config.yaml
chmod 0600 /root/.config/code-server/config.yaml

install -m 0644 "$PROJECT_DIR/systemd/codex-tmux.service" /etc/systemd/system/codex-tmux.service
install -m 0644 "$PROJECT_DIR/systemd/codex-code-server.service" /etc/systemd/system/codex-code-server.service
install -m 0644 "$PROJECT_DIR/systemd/codex-ttyd.service" /etc/systemd/system/codex-ttyd.service
install -m 0644 "$PROJECT_DIR/systemd/codex-control.service" /etc/systemd/system/codex-control.service
install -m 0644 "$PROJECT_DIR/nginx/codex-websocket-map.conf" /etc/nginx/conf.d/codex-websocket-map.conf

chmod 0755 "$PROJECT_DIR/bin/"*.sh "$PROJECT_DIR/bin/"*.js

systemctl daemon-reload
systemctl enable codex-tmux.service codex-code-server.service codex-ttyd.service codex-control.service >/dev/null

echo "Local workbench config applied."
echo "Remember to include nginx/eu.jerrypsy.top.codex-routes.conf inside your HTTPS server block."
