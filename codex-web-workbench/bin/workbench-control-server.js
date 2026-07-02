#!/usr/bin/env node
'use strict';

const http = require('http');
const { execFile, spawn } = require('child_process');
const { URL } = require('url');

const HOST = process.env.WORKBENCH_CONTROL_HOST || '127.0.0.1';
const PORT = Number(process.env.WORKBENCH_CONTROL_PORT || 18082);
const BASE_PATH = normalizeBase(process.env.WORKBENCH_CONTROL_BASE_PATH || '/codex/terminal');
const TTYD_PATH = normalizeBase(process.env.WORKBENCH_TTYD_PATH || '/codex/ttyd');
const SESSION = process.env.WORKBENCH_TMUX_SESSION || 'codex-workbench';
const ENSURE_SCRIPT = process.env.WORKBENCH_ENSURE_SCRIPT || '/root/jerry/opt/codex-web-workbench/bin/ensure-workbench-tmux.sh';
const MAX_TEXT_BYTES = Number(process.env.WORKBENCH_CONTROL_MAX_TEXT_BYTES || 65536);

function normalizeBase(value) {
  let base = value || '';
  if (!base.startsWith('/')) base = `/${base}`;
  return base.replace(/\/+$/, '');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout || 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout: stdout || '',
        stderr: stderr || (error ? error.message : ''),
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_TEXT_BYTES + 4096) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function htmlPath(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return clean === '/codex' || clean === BASE_PATH;
}

async function ensureSession() {
  return run(ENSURE_SCRIPT, [], { timeout: 15000 });
}

async function hasSession() {
  const result = await run('tmux', ['has-session', '-t', SESSION]);
  return result.ok;
}

async function capturePane(lines = 80) {
  const result = await run('tmux', ['capture-pane', '-p', '-t', SESSION, '-S', `-${lines}`]);
  if (!result.ok) return '';
  return result.stdout;
}

async function captureWindow(windowIndex, lines = 35) {
  if (!/^\d{1,4}$/.test(String(windowIndex))) return '';
  const result = await run('tmux', ['capture-pane', '-p', '-t', `${SESSION}:${windowIndex}`, '-S', `-${lines}`]);
  if (!result.ok) return '';
  return result.stdout;
}

function inferStatus(command, copyMode, screenText) {
  const screen = String(screenText || '').toLowerCase();
  const cmd = String(command || '').trim().toLowerCase();

  if (
    /\b(approve|approval|allow|deny|permission|escalat)\b/u.test(screen) ||
    /\b(confirm|proceed)\b.{0,40}(\?|\[(y\/n|yes\/no)\])/iu.test(screenText || '') ||
    /(需要|批准|确认|允许).{0,12}(执行|继续|命令|操作)/u.test(screenText || '') ||
    /\[(y\/n|yes\/no|allow|deny)\]/iu.test(screenText || '')
  ) {
    return { status: 'needs_approval', label: '需要确认', icon: '!', className: 'needs-approval' };
  }

  if (
    copyMode ||
    /\b(paused|suspended|stopped|press .{0,20} to continue)\b/u.test(screen) ||
    /\[(paused|suspended|stopped)\]/u.test(screen)
  ) {
    return { status: 'paused', label: '暂停/浏览', icon: 'II', className: 'paused' };
  }

  const idleCommands = new Set(['bash', 'zsh', 'sh', 'fish', 'tmux', 'login', 'sudo', 'su']);
  if (cmd && !idleCommands.has(cmd)) {
    return { status: 'running', label: '运行中', icon: '>', className: 'running' };
  }

  return { status: 'idle', label: '空闲', icon: '-', className: 'idle' };
}

async function listWindows() {
  const format = [
    '#{window_index}',
    '#{window_id}',
    '#{window_name}',
    '#{?window_active,1,0}',
    '#{?automatic-rename,1,0}',
    '#{pane_current_command}',
    '#{pane_in_mode}',
    '#{window_panes}',
  ].join('\t');
  const result = await run('tmux', ['list-windows', '-t', SESSION, '-F', format]);
  if (!result.ok) return [];

  const windows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const index = Number(parts[0]);
    const command = parts[5] || '';
    const copyMode = parts[6] === '1';
    const screen = await captureWindow(index);
    const status = inferStatus(command, copyMode, screen);
    windows.push({
      index,
      id: parts[1] || '',
      name: parts[2] || `window-${index}`,
      active: parts[3] === '1',
      automaticRename: parts[4] === '1',
      currentCommand: command,
      copyMode,
      panes: Number(parts[7] || 0),
      status: status.status,
      statusLabel: status.label,
      statusIcon: status.icon,
      statusClass: status.className,
    });
  }
  return windows;
}

async function pasteText(text, enter) {
  const bytes = Buffer.byteLength(text || '', 'utf8');
  if (bytes === 0) return { ok: false, error: 'empty text' };
  if (bytes > MAX_TEXT_BYTES) return { ok: false, error: `text exceeds ${MAX_TEXT_BYTES} bytes` };

  const load = spawn('tmux', ['load-buffer', '-b', 'workbench-web', '-']);
  load.stdin.write(text);
  load.stdin.end();

  const loaded = await new Promise((resolve) => {
    load.on('close', (code) => resolve(code === 0));
    load.on('error', () => resolve(false));
  });
  if (!loaded) return { ok: false, error: 'tmux load-buffer failed' };

  const paste = await run('tmux', ['paste-buffer', '-b', 'workbench-web', '-t', SESSION]);
  if (!paste.ok) return { ok: false, error: paste.stderr || 'tmux paste-buffer failed' };

  if (enter) {
    const key = await run('tmux', ['send-keys', '-t', SESSION, 'Enter']);
    if (!key.ok) return { ok: false, error: key.stderr || 'tmux send Enter failed' };
  }

  return { ok: true, bytes };
}

const ALLOWED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'C-a',
  'C-c',
  'C-d',
  'C-e',
  'C-l',
  'C-o',
  'C-r',
  'C-u',
  'C-w',
]);

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Server Terminal</title>
  <style>
    :root { color-scheme: dark; --bg:#101214; --panel:#191d21; --text:#eef2f5; --muted:#9aa6b2; --line:#2b333b; --accent:#4ea1ff; --ok:#35d07f; --warn:#ffd166; --paused:#b58cff; --danger:#ff6b6b; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); background: rgba(16,18,20,.97); }
    h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: 0; }
    main { width: min(1180px, 100%); margin: 0 auto; padding: 10px; }
    .status { color: var(--muted); font-size: 13px; }
    .terminal-frame { width: 100%; height: min(58vh, 620px); min-height: 330px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #050607; }
    iframe { width: 100%; height: 100%; border: 0; background: #050607; }
    section { margin-top: 10px; }
    label { display:block; margin: 0 0 6px; color: var(--muted); font-size: 13px; }
    textarea { width: 100%; min-height: 150px; resize: vertical; padding: 11px; border: 1px solid var(--line); border-radius: 8px; background: #0b0d0f; color: var(--text); font: 16px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .buttons, .links { display: flex; flex-wrap: wrap; gap: 8px; }
    a, button { min-height: 42px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; background: var(--panel); color: var(--text); font: inherit; text-decoration: none; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #071018; font-weight: 700; }
    button.danger { color: var(--danger); }
    button:disabled { opacity: 1; cursor: default; }
    button:active, a:active { transform: translateY(1px); }
    input { width: 100%; min-height: 42px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; background: #0b0d0f; color: var(--text); font: inherit; }
    .tabs { display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 6px; scrollbar-width: thin; }
    .tab { min-width: 160px; flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; text-align: left; }
    .tab.active { border-color: rgba(78,161,255,.75); background: rgba(78,161,255,.18); }
    .tab-icon { width: 22px; height: 22px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 22px; background: var(--muted); color: #071018; font-size: 10px; font-weight: 800; }
    .tab.status-running .tab-icon { background: var(--ok); }
    .tab.status-needs-approval .tab-icon { background: var(--warn); }
    .tab.status-paused .tab-icon { background: var(--paused); }
    .tab-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .tab-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .tab-index, .tab-state, .tab-sub { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
    .tab-sub { overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
    .window-tools { display: grid; grid-template-columns: minmax(180px, 1fr) repeat(4, auto); gap: 8px; align-items: center; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 10px; align-items: start; }
    pre { min-height: 150px; max-height: 260px; overflow: auto; white-space: pre-wrap; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #0b0d0f; color: #d9e2ea; font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .drop { border: 1px dashed var(--line); border-radius: 8px; padding: 9px; color: var(--muted); font-size: 13px; }
    .drop.active { border-color: var(--accent); color: var(--text); }
    @media (max-width: 760px) {
      header { align-items: flex-start; flex-direction: column; }
      main { padding: 8px; }
      .terminal-frame { height: 46vh; min-height: 280px; border-radius: 6px; }
      .split { grid-template-columns: 1fr; }
      .window-tools { grid-template-columns: 1fr 1fr; }
      .window-tools input { grid-column: 1 / -1; }
      a, button { flex: 1 1 calc(33.333% - 8px); min-height: 44px; padding-left: 8px; padding-right: 8px; }
      textarea { min-height: 170px; }
      pre { max-height: 180px; }
    }
    @media (max-width: 420px) {
      a, button { flex-basis: calc(50% - 8px); }
    }
  </style>
</head>
<body>
  <header>
    <h1>Server Terminal</h1>
    <div class="status" id="status">Checking session...</div>
  </header>
  <main>
    <nav class="links">
      <a href="/codex/terminal/">Terminal</a>
      <a href="/codex/ide/">IDE</a>
      <a href="${TTYD_PATH}/" target="workbench-terminal">Full View</a>
    </nav>

    <section>
      <div class="tabs" id="tabs"></div>
      <div class="window-tools">
        <input id="windowName" maxlength="64" placeholder="Rename current tab">
        <button id="renameWindow">Rename</button>
        <button id="newWindow">New Tab</button>
        <button id="splitH">Split H</button>
        <button id="splitV">Split V</button>
      </div>
    </section>

    <section class="terminal-frame">
      <iframe id="terminal" name="workbench-terminal" src="${TTYD_PATH}/" title="Terminal"></iframe>
    </section>

    <section class="split">
      <div>
        <label for="prompt">Input</label>
        <textarea id="prompt" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Type or paste text..."></textarea>
        <div class="drop" id="drop">Drop a text file here.</div>
      </div>
      <div>
        <label for="capture">Recent output</label>
        <pre id="capture"></pre>
      </div>
    </section>

    <section class="buttons">
      <button class="primary" id="sendEnter">Send + Enter</button>
      <button id="sendOnly">Paste Only</button>
      <button id="pasteClipboard">Paste Clipboard</button>
      <button id="copyOutput">Copy Output</button>
      <button id="clearBox">Clear Box</button>
    </section>

    <section class="buttons">
      <button data-text="codex" data-enter="true">codex</button>
      <button data-text="codex-lu" data-enter="true">codex-lu</button>
      <button data-text="codex-mi-1" data-enter="true">codex-mi-1</button>
      <button data-text="clear" data-enter="true">clear</button>
      <button id="startSession">Start Shell</button>
      <button id="refresh">Refresh</button>
    </section>

    <section class="buttons">
      <button data-key="Enter">Enter</button>
      <button data-key="Tab">Tab</button>
      <button data-key="Escape">Esc</button>
      <button data-key="Up">Up</button>
      <button data-key="Down">Down</button>
      <button data-key="Left">Left</button>
      <button data-key="Right">Right</button>
      <button data-key="C-c" class="danger">Ctrl+C</button>
      <button data-key="C-d" class="danger">Ctrl+D</button>
      <button data-key="C-l">Ctrl+L</button>
      <button data-key="C-r">Ctrl+R</button>
      <button data-key="C-u">Ctrl+U</button>
      <button data-key="C-w">Ctrl+W</button>
      <button data-key="C-a">Ctrl+A</button>
      <button data-key="C-e">Ctrl+E</button>
    </section>
  </main>
  <script>
    const base = ${JSON.stringify(BASE_PATH)};
    const $ = (id) => document.getElementById(id);
    let currentWindowId = null;

    async function api(path, options = {}) {
      const res = await fetch(base + path, {
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        ...options,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function renderTabs(windows) {
      const tabs = $('tabs');
      tabs.textContent = '';
      if (!Array.isArray(windows) || !windows.length) return;

      for (const meta of windows) {
        const button = document.createElement('button');
        const statusClass = meta.statusClass || meta.status || 'idle';
        const command = meta.currentCommand || 'shell';
        button.type = 'button';
        button.className = 'tab status-' + statusClass + (meta.active ? ' active' : '');
        button.title = '#' + meta.index + ' · ' + (meta.statusLabel || 'unknown') + ' · ' + command;

        const icon = document.createElement('span');
        icon.className = 'tab-icon';
        icon.textContent = meta.statusIcon || '-';

        const main = document.createElement('span');
        main.className = 'tab-main';

        const title = document.createElement('span');
        title.className = 'tab-title';

        const index = document.createElement('span');
        index.className = 'tab-index';
        index.textContent = '#' + meta.index;

        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = meta.name || ('window-' + meta.index);

        const state = document.createElement('span');
        state.className = 'tab-state';
        state.textContent = meta.statusLabel || '';

        const sub = document.createElement('span');
        sub.className = 'tab-sub';
        sub.textContent = command + (Number(meta.panes || 0) > 1 ? ' · ' + meta.panes + ' panes' : '');

        title.append(index, name, state);
        main.append(title, sub);
        button.append(icon, main);

        if (meta.active) {
          button.disabled = true;
        } else {
          button.onclick = () => windowAction('focus', { window: String(meta.index) });
        }
        tabs.appendChild(button);
      }
    }

    function applyStatus(data) {
      const current = data.currentWindow || (Array.isArray(data.windows) ? data.windows.find((window) => window.active) : null);
      $('status').textContent = data.running
        ? 'tmux: ' + data.session + (current ? ' · #' + current.index + ' ' + current.name + ' · ' + current.statusLabel : '')
        : 'tmux: not running';
      $('capture').textContent = data.capture || '';
      renderTabs(data.windows || []);
      if (current && (current.id !== currentWindowId || document.activeElement !== $('windowName'))) {
        $('windowName').value = current.name || '';
        currentWindowId = current.id || null;
      }
    }

    async function refresh() {
      try {
        const data = await api('/api/status');
        applyStatus(data);
      } catch (error) {
        $('status').textContent = 'Error: ' + error.message;
      }
    }

    async function windowAction(action, extra = {}) {
      $('status').textContent = 'Updating tmux...';
      const data = await api('/api/window', { method: 'POST', body: JSON.stringify({ action, ...extra }) });
      applyStatus({ session: ${JSON.stringify(SESSION)}, running: true, ...data });
      $('terminal').contentWindow?.focus?.();
      return data;
    }

    async function sendText(text, enter) {
      if (!text) {
        $('status').textContent = 'Nothing to send';
        return;
      }
      $('status').textContent = 'Sending...';
      await api('/api/send', { method: 'POST', body: JSON.stringify({ text, enter }) });
      $('status').textContent = enter ? 'Sent' : 'Pasted';
      setTimeout(refresh, 500);
    }

    $('sendEnter').onclick = () => sendText($('prompt').value, true);
    $('sendOnly').onclick = () => sendText($('prompt').value, false);
    $('clearBox').onclick = () => { $('prompt').value = ''; $('prompt').focus(); };
    $('refresh').onclick = refresh;
    $('newWindow').onclick = () => windowAction('new');
    $('splitH').onclick = () => windowAction('split_h');
    $('splitV').onclick = () => windowAction('split_v');
    $('renameWindow').onclick = () => windowAction('rename', { name: $('windowName').value });
    $('windowName').onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        $('renameWindow').click();
      }
    };
    $('startSession').onclick = async () => {
      $('status').textContent = 'Starting...';
      await api('/api/start', { method: 'POST', body: '{}' });
      $('terminal').src = $('terminal').src;
      await refresh();
    };
    $('pasteClipboard').onclick = async () => {
      try {
        const text = await navigator.clipboard.readText();
        $('prompt').value += text;
        $('prompt').focus();
      } catch (error) {
        $('status').textContent = 'Clipboard permission denied';
      }
    };
    $('copyOutput').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('capture').textContent || '');
        $('status').textContent = 'Output copied';
      } catch (error) {
        $('status').textContent = 'Clipboard permission denied';
      }
    };

    document.querySelectorAll('button[data-key]').forEach((button) => {
      button.onclick = async () => {
        await api('/api/key', { method: 'POST', body: JSON.stringify({ key: button.dataset.key }) });
        setTimeout(refresh, 300);
      };
    });
    document.querySelectorAll('button[data-text]').forEach((button) => {
      button.onclick = () => sendText(button.dataset.text, button.dataset.enter === 'true');
    });

    const drop = $('drop');
    drop.ondragover = (event) => { event.preventDefault(); drop.classList.add('active'); };
    drop.ondragleave = () => drop.classList.remove('active');
    drop.ondrop = async (event) => {
      event.preventDefault();
      drop.classList.remove('active');
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      $('prompt').value = await file.text();
      $('prompt').focus();
    };

    refresh();
    setInterval(refresh, 30000);
  </script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && htmlPath(pathname)) {
    sendText(res, 200, pageHtml(), 'text/html; charset=utf-8');
    return;
  }
  if (!pathname.startsWith(`${BASE_PATH}/api`)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  try {
    if (req.method === 'GET' && pathname === `${BASE_PATH}/api/status`) {
      const running = await hasSession();
      const windows = running ? await listWindows() : [];
      sendJson(res, 200, {
        session: SESSION,
        running,
        capture: running ? await capturePane(90) : '',
        windows,
        currentWindow: windows.find((window) => window.active) || null,
      });
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/start`) {
      const started = await ensureSession();
      sendJson(res, started.ok ? 200 : 500, { ok: started.ok, output: started.stdout, error: started.stderr });
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/send`) {
      if (!(await hasSession())) await ensureSession();
      const body = await readJson(req);
      const result = await pasteText(String(body.text || ''), body.enter !== false);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/key`) {
      if (!(await hasSession())) await ensureSession();
      const body = await readJson(req);
      const key = String(body.key || '');
      if (!ALLOWED_KEYS.has(key)) {
        sendJson(res, 400, { error: 'key not allowed' });
        return;
      }
      const result = await run('tmux', ['send-keys', '-t', SESSION, key]);
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, error: result.stderr });
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/window`) {
      if (!(await hasSession())) await ensureSession();
      const body = await readJson(req);
      const action = String(body.action || '');
      let result;
      if (action === 'focus') {
        const index = String(body.window ?? '');
        if (!/^\d{1,4}$/.test(index)) {
          sendJson(res, 400, { error: 'invalid window index' });
          return;
        }
        result = await run('tmux', ['select-window', '-t', `${SESSION}:${index}`]);
      } else if (action === 'new') {
        result = await run('tmux', ['new-window', '-t', SESSION]);
      } else if (action === 'rename') {
        const name = String(body.name || '').trim().replace(/\s+/g, ' ');
        if (!name || name.length > 64 || /[\x00-\x1F\x7F]/.test(name)) {
          sendJson(res, 400, { error: 'invalid window name' });
          return;
        }
        const autoRename = await run('tmux', ['set-option', '-w', '-t', `${SESSION}:.`, 'automatic-rename', 'off']);
        result = autoRename.ok
          ? await run('tmux', ['rename-window', '-t', `${SESSION}:.`, name])
          : autoRename;
      } else if (action === 'split_h') {
        result = await run('tmux', ['split-window', '-h', '-t', `${SESSION}:.`]);
      } else if (action === 'split_v') {
        result = await run('tmux', ['split-window', '-v', '-t', `${SESSION}:.`]);
      } else {
        sendJson(res, 400, { error: 'window action not allowed' });
        return;
      }
      const windows = await listWindows();
      sendJson(res, result.ok ? 200 : 500, {
        ok: result.ok,
        error: result.stderr,
        windows,
        currentWindow: windows.find((window) => window.active) || null,
        capture: await capturePane(90),
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message || String(error) });
  }
}

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  console.log(`workbench-control listening on http://${HOST}:${PORT}${BASE_PATH}/`);
});
