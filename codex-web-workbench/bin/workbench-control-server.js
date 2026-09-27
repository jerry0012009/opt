#!/usr/bin/env node
'use strict';

const http = require('http');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const { URL } = require('url');

const HOST = process.env.WORKBENCH_CONTROL_HOST || '127.0.0.1';
const PORT = Number(process.env.WORKBENCH_CONTROL_PORT || 18082);
const BASE_PATH = normalizeBase(process.env.WORKBENCH_CONTROL_BASE_PATH || '/codex/terminal');
const TTYD_PATH = normalizeBase(process.env.WORKBENCH_TTYD_PATH || '/codex/ttyd');
const SESSION = process.env.WORKBENCH_TMUX_SESSION || 'codex-workbench';
const VIEW_SESSION_PREFIX = process.env.WORKBENCH_VIEW_SESSION_PREFIX || `${SESSION}-view-`;
const VIEW_TTL_MS = Number(process.env.WORKBENCH_VIEW_TTL_MS || 30 * 60 * 1000);
const ENSURE_SCRIPT = process.env.WORKBENCH_ENSURE_SCRIPT || '/root/jerry/opt/codex-web-workbench/bin/ensure-workbench-tmux.sh';
const MAX_TEXT_BYTES = Number(process.env.WORKBENCH_CONTROL_MAX_TEXT_BYTES || 65536);
const CAPTURE_LINES = Number(process.env.WORKBENCH_CAPTURE_LINES || 4000);
const VIEW_ID_PATTERN = /^[a-f0-9]{32}$/;
const viewLastSeen = new Map();

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

function clampPercent(value) {
  return Math.round(Math.max(0, Math.min(100, value)));
}

async function getResourceUsage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const disk = await run('df', ['-P', '-k', '/'], { timeout: 5000 });
  let diskUsedPercent = null;

  if (disk.ok) {
    const lines = disk.stdout.trim().split(/\r?\n/).filter(Boolean);
    const fields = lines.length ? lines[lines.length - 1].trim().split(/\s+/) : [];
    const match = String(fields[4] || '').match(/^(\d+)%$/);
    if (match) diskUsedPercent = clampPercent(Number(match[1]));
  }

  return {
    diskUsedPercent,
    memoryUsedPercent: totalMemory > 0
      ? clampPercent(((totalMemory - freeMemory) / totalMemory) * 100)
      : null,
  };
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

async function hasSession(target = SESSION) {
  const result = await run('tmux', ['has-session', '-t', target]);
  return result.ok;
}

function viewSessionName(viewId) {
  return `${VIEW_SESSION_PREFIX}${viewId}`;
}

function isValidViewId(viewId) {
  return VIEW_ID_PATTERN.test(String(viewId || ''));
}

async function ensureViewSession(viewId) {
  if (!isValidViewId(viewId)) return SESSION;
  if (!(await hasSession())) await ensureSession();

  const target = viewSessionName(viewId);
  if (!(await hasSession(target))) {
    const created = await run('tmux', ['new-session', '-d', '-t', SESSION, '-s', target]);
    if (!created.ok && !(await hasSession(target))) {
      throw new Error(created.stderr || 'could not create workbench view session');
    }
  }
  viewLastSeen.set(viewId, Date.now());
  return target;
}

async function resolveViewSession(viewId) {
  return isValidViewId(viewId) ? ensureViewSession(viewId) : SESSION;
}

async function capturePane(target = SESSION, lines = 80) {
  const result = await run('tmux', ['capture-pane', '-p', '-t', target, '-S', `-${lines}`]);
  if (!result.ok) return '';
  return result.stdout;
}

async function captureWindow(target, windowIndex, lines = 35) {
  if (!/^\d{1,4}$/.test(String(windowIndex))) return '';
  const result = await run('tmux', ['capture-pane', '-p', '-t', `${target}:${windowIndex}`, '-S', `-${lines}`]);
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

async function listWindows(target = SESSION) {
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
  const result = await run('tmux', ['list-windows', '-t', target, '-F', format]);
  if (!result.ok) return [];

  const windows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const index = Number(parts[0]);
    const command = parts[5] || '';
    const copyMode = parts[6] === '1';
    const screen = await captureWindow(target, index);
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

async function pasteText(text, enter, target = SESSION, bufferName = 'workbench-web') {
  const bytes = Buffer.byteLength(text || '', 'utf8');
  if (bytes === 0) return { ok: false, error: 'empty text' };
  if (bytes > MAX_TEXT_BYTES) return { ok: false, error: `text exceeds ${MAX_TEXT_BYTES} bytes` };

  const load = spawn('tmux', ['load-buffer', '-b', bufferName, '-']);
  load.stdin.write(text);
  load.stdin.end();

  const loaded = await new Promise((resolve) => {
    load.on('close', (code) => resolve(code === 0));
    load.on('error', () => resolve(false));
  });
  if (!loaded) return { ok: false, error: 'tmux load-buffer failed' };

  const paste = await run('tmux', ['paste-buffer', '-b', bufferName, '-t', target]);
  if (!paste.ok) return { ok: false, error: paste.stderr || 'tmux paste-buffer failed' };

  if (enter) {
    const key = await run('tmux', ['send-keys', '-t', target, 'Enter']);
    if (!key.ok) return { ok: false, error: key.stderr || 'tmux send Enter failed' };
  }

  await run('tmux', ['delete-buffer', '-b', bufferName]);
  return { ok: true, bytes };
}

async function cleanupViewSessions() {
  const now = Date.now();
  for (const [viewId, lastSeen] of viewLastSeen) {
    if (now - lastSeen < VIEW_TTL_MS) continue;
    const target = viewSessionName(viewId);
    const clients = await run('tmux', ['list-clients', '-t', target, '-F', '#{client_name}']);
    if (clients.ok && clients.stdout.trim()) {
      viewLastSeen.set(viewId, now);
      continue;
    }
    await run('tmux', ['kill-session', '-t', target]);
    viewLastSeen.delete(viewId);
  }
}

function requestViewId(url, body = {}) {
  const value = body.view || url.searchParams.get('view') || '';
  return isValidViewId(value) ? value : '';
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
    .compact-action { flex: 0 0 auto; min-height: 34px; padding: 6px 10px; font-size: 13px; }
    .terminal-nav { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .terminal-nav button { flex: 0 0 auto; min-height: 34px; padding: 5px 9px; border-color: #35414c; color: var(--muted); background: #15191d; font-size: 13px; }
    .terminal-nav button:hover:not(:disabled) { color: var(--text); border-color: #566676; background: #20262c; }
    .terminal-nav .live { color: #9cc9aa; border-color: rgba(53,208,127,.35); }
    .terminal-nav .nav-label { margin-right: 2px; color: #687582; font-size: 12px; user-select: none; }
    a, button { min-height: 42px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; background: var(--panel); color: var(--text); font: inherit; text-decoration: none; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #071018; font-weight: 700; }
    button.danger { color: var(--danger); border-color: rgba(255,107,107,.45); }
    button.danger:hover:not(:disabled) { background: rgba(255,107,107,.12); }
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
    .window-more, .window-more-items, .nav-more, .nav-more-items, .more-controls, .more-controls-content { display: contents; }
    .window-more > summary, .nav-more > summary, .more-controls > summary { display: none; }
    .controls-wrapper { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 10px; align-items: start; }
    .controls-wrapper > .history-panel { grid-column: 2; grid-row: 1; margin-top: 0; }
    .controls-wrapper > .more-controls .input-panel { grid-column: 1; grid-row: 1; }
    .controls-wrapper > .more-controls > .more-controls-content > .buttons,
    .controls-wrapper > .terminal-nav { grid-column: 1 / -1; }
    .input-panel { margin-top: 0; }
    pre { min-height: 180px; height: min(60vh, 576px); max-height: 576px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #0b0d0f; color: #d9e2ea; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .drop { border: 1px dashed var(--line); border-radius: 8px; padding: 9px; color: var(--muted); font-size: 13px; }
    .drop.active { border-color: var(--accent); color: var(--text); }
    .status-group { min-width: 0; text-align: right; }
    .resources { color: #74818d; font-size: 12px; white-space: nowrap; }
    summary { list-style: none; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    @media (max-width: 760px) {
      header { position: static; align-items: flex-start; flex-direction: column; }
      .status-group { width: 100%; text-align: left; }
      .resources { white-space: normal; }
      main { padding: 8px; }
      .terminal-frame { height: clamp(560px, 100dvh, 760px); min-height: 560px; border-radius: 6px; }
      .controls-wrapper { display: block; }
      .controls-wrapper > .history-panel { margin-top: 10px; }
      .nav-more, .window-more, .more-controls { display: block; }
      .nav-more { flex: 1 1 calc(50% - 8px); min-width: 0; }
      .nav-more > summary, .window-more > summary, .more-controls > summary {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 44px;
        padding: 9px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        font: inherit;
      }
      .nav-more > summary::after, .window-more > summary::after, .more-controls > summary::after { content: '+'; color: var(--muted); font-size: 18px; line-height: 1; }
      .nav-more[open] > summary::after, .window-more[open] > summary::after, .more-controls[open] > summary::after { content: '−'; }
      .nav-more-items, .window-more-items, .more-controls-content { display: none; }
      .nav-more[open] .nav-more-items, .window-more[open] .window-more-items, .more-controls[open] .more-controls-content { display: grid; gap: 8px; margin-top: 8px; }
      .nav-more[open] .nav-more-items { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .window-more[open] .window-more-items { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .more-controls[open] .more-controls-content { display: block; }
      .window-tools { grid-template-columns: minmax(0, 1fr) auto; }
      .window-tools input { grid-column: auto; }
      .window-more { grid-column: 1 / -1; }
      a, button { flex: 1 1 calc(33.333% - 8px); min-height: 44px; padding-left: 8px; padding-right: 8px; }
      textarea { min-height: 170px; }
      pre { height: min(52vh, 480px); max-height: 480px; }
      .controls-wrapper { display: flex; flex-direction: column; }
      .controls-wrapper > .terminal-nav { order: 1; margin-bottom: 2px; }
      .controls-wrapper > .history-panel { order: 2; }
      .controls-wrapper > .more-controls { order: 3; }
      .more-controls { margin-top: 10px; }
    }
    @media (max-width: 420px) {
      a, button { flex-basis: calc(50% - 8px); }
    }
  </style>
</head>
<body>
  <header>
    <h1>Server Terminal</h1>
    <div class="status-group">
      <div class="status" id="status">Checking session...</div>
      <div class="resources" id="resources" aria-live="polite">Checking resources...</div>
    </div>
  </header>
  <main>
    <nav class="links">
      <a href="/codex/terminal/">Terminal</a>
      <details class="nav-more" open data-mobile-collapse>
        <summary>More</summary>
        <div class="nav-more-items">
          <a href="/codex/ide/">IDE</a>
          <a id="fullView" href="${TTYD_PATH}/" target="workbench-terminal">Full View</a>
        </div>
      </details>
    </nav>

    <section>
      <div class="tabs" id="tabs"></div>
      <div class="window-tools">
        <input id="windowName" maxlength="64" placeholder="Rename current tab">
        <button id="renameWindow">Rename</button>
        <details class="window-more" open data-mobile-collapse>
          <summary>Window actions</summary>
          <div class="window-more-items">
            <button id="newWindow">New Tab</button>
            <button id="splitH">Split H</button>
            <button id="splitV">Split V</button>
          </div>
        </details>
      </div>
    </section>

    <section class="terminal-frame" id="terminalFrame">
      <iframe id="terminal" name="workbench-terminal" src="about:blank" title="Terminal"></iframe>
    </section>

    <section class="controls-wrapper">
      <section class="history-panel">
        <label for="capture">Recent output</label>
        <pre id="capture"></pre>
      </section>

      <details class="more-controls" open data-mobile-collapse>
        <summary>More controls</summary>
        <div class="more-controls-content">
          <section class="input-panel">
            <label for="prompt">Input</label>
            <textarea id="prompt" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Type or paste text..."></textarea>
            <div class="drop" id="drop">Drop a text file here.</div>
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
            <button id="killPane" class="danger compact-action">Close Pane</button>
            <button id="killWindow" class="danger compact-action">Close Window</button>
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
        </div>
      </details>

      <section class="terminal-nav" aria-label="Terminal navigation">
        <span class="nav-label">scroll</span>
        <button type="button" data-navigation="scroll_up" title="Scroll up 24 lines" aria-label="Scroll up 24 lines">▲ 24</button>
        <button type="button" data-navigation="scroll_down" title="Scroll down 24 lines" aria-label="Scroll down 24 lines">▼ 24</button>
        <button type="button" class="live" data-navigation="live" title="Exit copy mode and return to live input" aria-label="Exit copy mode and return to live input">● Live</button>
      </section>
    </section>
  </main>
  <script>
    const base = ${JSON.stringify(BASE_PATH)};
    const ttydBase = ${JSON.stringify(`${TTYD_PATH}/`)};
    const $ = (id) => document.getElementById(id);
    const mobileLayout = window.matchMedia('(max-width: 760px)');
    function syncCollapsibleControls() {
      document.querySelectorAll('details[data-mobile-collapse]').forEach((details) => {
        details.open = !mobileLayout.matches;
      });
    }
    syncCollapsibleControls();
    mobileLayout.addEventListener?.('change', syncCollapsibleControls);
    const viewId = (() => {
      const key = 'codex-workbench-view-id';
      const viewIdPattern = /^[a-f0-9]{32}$/;
      const stored = window.sessionStorage.getItem(key);
      if (viewIdPattern.test(stored || '')) return stored;
      const generated = crypto.randomUUID().replace(/-/g, '');
      window.sessionStorage.setItem(key, generated);
      return generated;
    })();
    const ttydUrl = ttydBase + '?arg=view=' + viewId;
    $('terminal').src = ttydUrl;
    $('fullView').href = ttydUrl;
    let currentWindowId = null;
    // Keep the ttyd iframe stable while a mobile IME owns xterm's hidden textarea.
    const mobileInputEvents = [];
    const mobileInput = {
      engaged: false,
      focused: false,
      composing: false,
      locked: false,
      unlockTimer: null,
      viewportHeight: window.visualViewport?.height || window.innerHeight,
      maxViewportHeight: window.visualViewport?.height || window.innerHeight,
    };
    window.workbenchMobileInputEvents = mobileInputEvents;

    function recordMobileInputEvent(type, detail = {}) {
      mobileInputEvents.push({
        at: new Date().toISOString(),
        type,
        engaged: mobileInput.engaged,
        focused: mobileInput.focused,
        composing: mobileInput.composing,
        frameHeight: Math.round($('terminalFrame').getBoundingClientRect().height),
        viewportHeight: Math.round(window.visualViewport?.height || window.innerHeight),
        ...detail,
      });
      if (mobileInputEvents.length > 100) mobileInputEvents.shift();
    }

    function usesTouchKeyboard() {
      return navigator.maxTouchPoints > 0 &&
        window.matchMedia('(hover: none), (pointer: coarse)').matches;
    }

    function lockTerminalHeight(reason) {
      if (!usesTouchKeyboard()) return;
      if (mobileInput.unlockTimer) {
        clearTimeout(mobileInput.unlockTimer);
        mobileInput.unlockTimer = null;
      }
      if (!mobileInput.locked) {
        const frame = $('terminalFrame');
        frame.style.height = Math.round(frame.getBoundingClientRect().height) + 'px';
        frame.dataset.keyboardLocked = 'true';
        mobileInput.locked = true;
      }
      recordMobileInputEvent('height-lock', { reason });
    }

    function unlockTerminalHeight(reason, delay = 650) {
      if (!mobileInput.locked) return;
      if (mobileInput.unlockTimer) clearTimeout(mobileInput.unlockTimer);
      mobileInput.unlockTimer = setTimeout(() => {
        if (mobileInput.focused || mobileInput.composing) return;
        const frame = $('terminalFrame');
        frame.style.removeProperty('height');
        delete frame.dataset.keyboardLocked;
        mobileInput.locked = false;
        mobileInput.unlockTimer = null;
        recordMobileInputEvent('height-unlock', { reason });
      }, delay);
    }

    function isXtermInput(target) {
      return Boolean(target?.classList?.contains('xterm-helper-textarea'));
    }

    function wireTerminalInputEvents() {
      if (!usesTouchKeyboard()) return;
      const terminalWindow = $('terminal').contentWindow;
      const terminalDocument = terminalWindow?.document;
      if (!terminalDocument || terminalDocument.__workbenchMobileInputWired) return;
      terminalDocument.__workbenchMobileInputWired = true;

      const interactionEvent = 'PointerEvent' in terminalWindow ? 'pointerdown' : 'touchstart';
      terminalDocument.addEventListener(interactionEvent, (event) => {
        if (!event.target?.closest?.('.xterm')) return;
        mobileInput.engaged = true;
        mobileInput.focused = isXtermInput(terminalDocument.activeElement);
        lockTerminalHeight('terminal-pointerdown');
        recordMobileInputEvent(interactionEvent);
      }, true);
      terminalDocument.addEventListener('focusin', (event) => {
        if (!isXtermInput(event.target)) return;
        mobileInput.focused = true;
        if (mobileInput.engaged) lockTerminalHeight('focus');
        recordMobileInputEvent('focus');
      }, true);
      terminalDocument.addEventListener('focusout', (event) => {
        if (!isXtermInput(event.target)) return;
        mobileInput.focused = false;
        mobileInput.composing = false;
        recordMobileInputEvent('blur', {
          relatedTarget: event.relatedTarget?.className || event.relatedTarget?.tagName || '',
        });
        mobileInput.engaged = false;
        unlockTerminalHeight('blur');
      }, true);
      terminalDocument.addEventListener('keydown', (event) => {
        if (!isXtermInput(event.target)) return;
        if (event.keyCode !== 229 && event.which !== 229) return;
        // xterm.js can emit Android IME text once for keyCode 229 and again for input.
        event.stopImmediatePropagation();
        recordMobileInputEvent('ime-keydown-suppressed');
      }, true);
      terminalDocument.addEventListener('compositionstart', (event) => {
        if (!isXtermInput(event.target)) return;
        mobileInput.engaged = true;
        mobileInput.composing = true;
        lockTerminalHeight('compositionstart');
        recordMobileInputEvent('compositionstart');
      }, true);
      terminalDocument.addEventListener('compositionend', (event) => {
        if (!isXtermInput(event.target)) return;
        mobileInput.composing = false;
        recordMobileInputEvent('compositionend', { dataLength: String(event.data || '').length });
      }, true);
    }

    async function api(path, options = {}) {
      const request = { ...options };
      const method = String(request.method || 'GET').toUpperCase();
      const separator = path.includes('?') ? '&' : '?';
      const requestPath = path + separator + 'view=' + encodeURIComponent(viewId);
      if (method !== 'GET') {
        let body = {};
        if (request.body) {
          try {
            body = JSON.parse(request.body);
          } catch {
            throw new Error('invalid request body');
          }
        }
        body.view = viewId;
        request.body = JSON.stringify(body);
      }
      const res = await fetch(base + requestPath, {
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        ...request,
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

    function formatResources(resources) {
      const parts = [];
      if (Number.isFinite(resources?.diskUsedPercent)) parts.push('Disk ' + resources.diskUsedPercent + '%');
      if (Number.isFinite(resources?.memoryUsedPercent)) parts.push('RAM ' + resources.memoryUsedPercent + '%');
      return parts.length ? parts.join(' · ') : 'Resource data unavailable';
    }

    function applyStatus(data) {
      const current = data.currentWindow || (Array.isArray(data.windows) ? data.windows.find((window) => window.active) : null);
      const windows = Array.isArray(data.windows) ? data.windows : [];
      $('status').textContent = data.running
        ? 'tmux: ' + data.session + (current ? ' · #' + current.index + ' ' + current.name + ' · ' + current.statusLabel : '')
        : 'tmux: not running';
      if (data.resources) $('resources').textContent = formatResources(data.resources);
      $('capture').textContent = data.capture || '';
      renderTabs(windows);
      $('killPane').disabled = !current || Number(current.panes || 0) < 2;
      $('killPane').title = current && Number(current.panes || 0) >= 2
        ? 'Close the active pane in the selected window'
        : 'This window has only one pane';
      $('killWindow').disabled = !current || windows.length < 2;
      $('killWindow').title = windows.length >= 2
        ? 'Close the selected tmux window'
        : 'The last tmux window cannot be closed';
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
      try {
        const data = await api('/api/window', { method: 'POST', body: JSON.stringify({ action, ...extra }) });
        applyStatus({ session: ${JSON.stringify(SESSION)}, running: true, ...data });
        $('terminal').contentWindow?.focus?.();
        return data;
      } catch (error) {
        $('status').textContent = 'Error: ' + error.message;
        return null;
      }
    }

    function confirmWindowAction(action) {
      const status = $('status').textContent;
      const current = status || 'the selected tmux target';
      if (action === 'kill_pane') {
        return window.confirm(
          'Close the active pane in ' + current + '?\\n\\n' +
          'Any process running in that pane will be terminated.'
        );
      }
      return window.confirm(
        'Close the selected tmux window (' + current + ')?\\n\\n' +
        'All panes and processes in that window will be terminated.'
      );
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
    $('killPane').onclick = () => {
      if (confirmWindowAction('kill_pane')) windowAction('kill_pane');
    };
    $('killWindow').onclick = () => {
      if (confirmWindowAction('kill_window')) windowAction('kill_window');
    };
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
    document.querySelectorAll('button[data-navigation]').forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api('/api/navigation', {
            method: 'POST',
            body: JSON.stringify({ action: button.dataset.navigation }),
          });
          await refresh();
        } catch (error) {
          $('status').textContent = 'Error: ' + error.message;
        } finally {
          button.disabled = false;
        }
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

    $('terminal').addEventListener('load', () => {
      try {
        wireTerminalInputEvents();
      } catch (error) {
        recordMobileInputEvent('wire-error', { message: error.message || String(error) });
      }
    });
    window.visualViewport?.addEventListener('resize', () => {
      const nextHeight = window.visualViewport.height;
      const previousHeight = mobileInput.viewportHeight;
      mobileInput.maxViewportHeight = Math.max(mobileInput.maxViewportHeight, nextHeight);
      recordMobileInputEvent('viewport-resize', {
        previousHeight: Math.round(previousHeight),
        nextHeight: Math.round(nextHeight),
      });
      mobileInput.viewportHeight = nextHeight;
      if (
        mobileInput.locked &&
        !mobileInput.composing &&
        nextHeight - previousHeight > 160 &&
        nextHeight > mobileInput.maxViewportHeight * 0.8
      ) {
        mobileInput.engaged = false;
        mobileInput.focused = false;
        unlockTerminalHeight('keyboard-closed', 0);
      }
    });
    window.addEventListener('orientationchange', () => {
      mobileInput.engaged = false;
      mobileInput.focused = false;
      mobileInput.composing = false;
      mobileInput.maxViewportHeight = window.visualViewport?.height || window.innerHeight;
      unlockTerminalHeight('orientationchange', 0);
    });

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
      const viewId = requestViewId(url);
      const target = running ? await resolveViewSession(viewId) : SESSION;
      const windows = running ? await listWindows(target) : [];
      const resources = await getResourceUsage();
      sendJson(res, 200, {
        session: SESSION,
        viewSession: target,
        running,
        resources,
        capture: running ? await capturePane(target, CAPTURE_LINES) : '',
        windows,
        currentWindow: windows.find((window) => window.active) || null,
      });
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/start`) {
      const body = await readJson(req);
      const started = await ensureSession();
      const target = started.ok ? await resolveViewSession(requestViewId(url, body)) : SESSION;
      sendJson(res, started.ok ? 200 : 500, {
        ok: started.ok,
        output: started.stdout,
        error: started.stderr,
        viewSession: target,
      });
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/send`) {
      if (!(await hasSession())) await ensureSession();
      const body = await readJson(req);
      const target = await resolveViewSession(requestViewId(url, body));
      const bufferName = `workbench-web-${requestViewId(url, body) || 'legacy'}`;
      const result = await pasteText(String(body.text || ''), body.enter !== false, target, bufferName);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/key`) {
      if (!(await hasSession())) await ensureSession();
      const body = await readJson(req);
      const target = await resolveViewSession(requestViewId(url, body));
      const key = String(body.key || '');
      if (!ALLOWED_KEYS.has(key)) {
        sendJson(res, 400, { error: 'key not allowed' });
        return;
      }
      const result = await run('tmux', ['send-keys', '-t', `${target}:.`, key]);
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, error: result.stderr });
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/navigation`) {
      if (!(await hasSession())) await ensureSession();
      const body = await readJson(req);
      const target = await resolveViewSession(requestViewId(url, body));
      const action = String(body.action || '');
      let result;
      if (action === 'live') {
        result = await run('tmux', ['copy-mode', '-q', '-t', `${target}:.`]);
      } else if (action === 'scroll_up' || action === 'scroll_down') {
        const mode = await run('tmux', ['display-message', '-p', '-t', `${target}:.`, '#{pane_in_mode}']);
        if (!mode.ok) {
          sendJson(res, 500, { error: mode.stderr || 'could not inspect tmux mode' });
          return;
        }
        if (mode.stdout.trim() !== '1') {
          if (action === 'scroll_up') {
            const entered = await run('tmux', ['copy-mode', '-e', '-t', `${target}:.`]);
            result = entered.ok
              ? await run('tmux', [
                  'send-keys',
                  '-X',
                  '-N',
                  '24',
                  '-t',
                  `${target}:.`,
                  'scroll-up',
                ])
              : entered;
          } else {
            result = { ok: true, stderr: '' };
          }
        } else {
          result = await run('tmux', [
            'send-keys',
            '-X',
            '-N',
            '24',
            '-t',
            `${target}:.`,
            action === 'scroll_up' ? 'scroll-up' : 'scroll-down',
          ]);
        }
      } else {
        sendJson(res, 400, { error: 'navigation action not allowed' });
        return;
      }
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, error: result.stderr });
      return;
    }
    if (req.method === 'POST' && pathname === `${BASE_PATH}/api/window`) {
      if (!(await hasSession())) await ensureSession();
      const body = await readJson(req);
      const target = await resolveViewSession(requestViewId(url, body));
      const action = String(body.action || '');
      let result;
      if (action === 'focus') {
        const index = String(body.window ?? '');
        if (!/^\d{1,4}$/.test(index)) {
          sendJson(res, 400, { error: 'invalid window index' });
          return;
        }
        result = await run('tmux', ['select-window', '-t', `${target}:${index}`]);
      } else if (action === 'new') {
        result = await run('tmux', ['new-window', '-t', target]);
      } else if (action === 'rename') {
        const name = String(body.name || '').trim().replace(/\s+/g, ' ');
        if (!name || name.length > 64 || /[\x00-\x1F\x7F]/.test(name)) {
          sendJson(res, 400, { error: 'invalid window name' });
          return;
        }
        const autoRename = await run('tmux', ['set-option', '-w', '-t', `${target}:.`, 'automatic-rename', 'off']);
        result = autoRename.ok
          ? await run('tmux', ['rename-window', '-t', `${target}:.`, name])
          : autoRename;
      } else if (action === 'split_h') {
        result = await run('tmux', ['split-window', '-h', '-t', `${target}:.`]);
      } else if (action === 'split_v') {
        result = await run('tmux', ['split-window', '-v', '-t', `${target}:.`]);
      } else if (action === 'kill_window' || action === 'kill_pane') {
        const windowsBefore = await listWindows(target);
        const current = windowsBefore.find((window) => window.active);
        if (!current) {
          sendJson(res, 400, { error: 'no active tmux window' });
          return;
        }
        if (action === 'kill_window' && windowsBefore.length < 2) {
          sendJson(res, 400, { error: 'cannot close the last tmux window' });
          return;
        }
        if (action === 'kill_pane' && Number(current.panes || 0) < 2) {
          sendJson(res, 400, { error: 'cannot close the only pane; close the window instead' });
          return;
        }
        result = action === 'kill_window'
          ? await run('tmux', ['kill-window', '-t', `${target}:.`])
          : await run('tmux', ['kill-pane', '-t', `${target}:.`]);
      } else {
        sendJson(res, 400, { error: 'window action not allowed' });
        return;
      }
      const windows = await listWindows(target);
      sendJson(res, result.ok ? 200 : 500, {
        ok: result.ok,
        error: result.stderr,
        viewSession: target,
        windows,
        currentWindow: windows.find((window) => window.active) || null,
        capture: await capturePane(target, CAPTURE_LINES),
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

const cleanupTimer = setInterval(() => {
  cleanupViewSessions().catch((error) => {
    console.error(`view session cleanup failed: ${error.message || error}`);
  });
}, 60 * 1000);
cleanupTimer.unref();
