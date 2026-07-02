# Codex Web Workbench

This project provides a root web terminal workbench for `eu.jerrypsy.top/codex`.

Primary routes:

- `/codex/` - mobile-friendly combined terminal page.
- `/codex/terminal/` - same combined terminal page.
- `/codex/ide/` - code-server for editing, uploads, and integrated terminals.
- `/codex/ttyd/` - raw ttyd terminal view used by the combined page.

The terminal opens a persistent root `tmux` shell named `codex-workbench`.
It does not auto-run a specific Codex binary. From the web terminal, choose the
CLI you want:

```bash
codex
codex-lu
codex-mi-1
```

Local ports:

- `127.0.0.1:18080` - code-server.
- `127.0.0.1:18081` - ttyd.
- `127.0.0.1:18082` - mobile terminal control page.

Terminal stability defaults:

- ttyd uses `--ping-interval 2` so the websocket stays active even on
  short-idle browser/network paths.
- ttyd allows up to 16 clients because delayed close detection can leave stale
  websocket clients around briefly.

Operational commands:

```bash
systemctl status codex-tmux.service codex-code-server.service codex-ttyd.service codex-control.service
systemctl restart codex-tmux.service codex-code-server.service codex-ttyd.service codex-control.service
tmux attach -t codex-workbench
/root/jerry/opt/codex-web-workbench/bin/show-credentials.sh
```

Credentials:

- Local secrets live in `secrets/` and are ignored by Git.
- Nginx reads `/etc/nginx/codex-workbench.htpasswd`, generated from the local
  secret file.
- Do not commit generated credentials.

Mobile workflow:

1. Open `/codex/terminal/`.
2. Use the embedded terminal for normal shell interaction.
3. Use the large input box for paste-heavy prompts or long commands.
4. Use shortcut buttons for keys that are awkward on phones, such as `Tab`,
   arrows, `Ctrl+C`, `Ctrl+D`, `Ctrl+R`, and `Ctrl+U`.
5. Use quick buttons to start `codex`, `codex-lu`, or `codex-mi-1`.

Install notes for a new server:

1. Install `tmux`, `ttyd`, `code-server`, `nginx`, `apache2-utils`, and Node.js.
2. Run `bin/apply-local-config.sh` to generate local secrets, code-server config,
   Nginx auth, and systemd units.
3. Add the Nginx route snippet from `nginx/eu.jerrypsy.top.codex-routes.conf`
   inside the HTTPS server block.
4. Install `nginx/codex-websocket-map.conf` into `/etc/nginx/conf.d/`.
5. Run `bin/restart-workbench.sh`.

Fast path on Ubuntu:

```bash
cd /root/jerry/opt/codex-web-workbench
bin/install-deps-ubuntu.sh
bin/apply-local-config.sh
# Add nginx/eu.jerrypsy.top.codex-routes.conf into your HTTPS server block.
bin/restart-workbench.sh
bin/show-credentials.sh
bin/verify-workbench.sh https://eu.jerrypsy.top
```

code-server portability:

- `config/code-server.config.yaml.template` is committed.
- `/root/.config/code-server/config.yaml` is generated per machine by
  `bin/apply-local-config.sh`.
- The generated config contains a local password and must not be committed.
