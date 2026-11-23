#!/usr/bin/env node
'use strict';

/**
 * Non-destructive live CDP verifier for Antigravity Theme Studio.
 * Scans both Antigravity (port 9222) and Antigravity IDE (port 9223).
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

if (typeof globalThis.WebSocket !== 'function') {
  console.error('[verify] Cần Node.js >= 22 (có sẵn WebSocket).');
  process.exit(1);
}

function resolveCdpPorts() {
  const ports = new Set();
  if (process.env.ATS_CDP_PORT) {
    for (const part of String(process.env.ATS_CDP_PORT).split(',')) {
      const p = parseInt(part.trim(), 10);
      if (Number.isFinite(p) && p > 0) ports.add(p);
    }
  }

  const home = os.homedir();
  const candidates = [];
  if (process.env.ATS_PORT_FILE) candidates.push(process.env.ATS_PORT_FILE);

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(
      path.join(appData, 'antigravity', 'DevToolsActivePort'),
      path.join(appData, 'Antigravity', 'DevToolsActivePort'),
      path.join(appData, 'Antigravity IDE', 'DevToolsActivePort'),
      path.join(appData, 'antigravity-ide', 'DevToolsActivePort'),
      path.join(appData, 'Code', 'DevToolsActivePort')
    );
  } else if (process.platform === 'darwin') {
    const sup = path.join(home, 'Library', 'Application Support');
    candidates.push(
      path.join(sup, 'antigravity', 'DevToolsActivePort'),
      path.join(sup, 'Antigravity', 'DevToolsActivePort'),
      path.join(sup, 'Antigravity IDE', 'DevToolsActivePort'),
      path.join(sup, 'Code', 'DevToolsActivePort')
    );
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(
      path.join(xdg, 'antigravity', 'DevToolsActivePort'),
      path.join(xdg, 'Antigravity', 'DevToolsActivePort'),
      path.join(xdg, 'Antigravity IDE', 'DevToolsActivePort'),
      path.join(xdg, 'Code', 'DevToolsActivePort')
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const port = parseInt(fs.readFileSync(p, 'utf8').trim().split(/\r?\n/)[0], 10);
        if (Number.isFinite(port) && port > 0) ports.add(port);
      } catch (_) {}
    }
  }

  ports.add(9222);
  ports.add(9223);
  ports.add(9224);
  return Array.from(ports);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
  });
}

function evalCdp(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error('CDP evaluation timeout'));
    }, 4000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });

    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) reject(new Error(msg.error.message));
          else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text || 'Runtime exception'));
          else resolve(msg.result?.result?.value ?? null);
        }
      } catch (_) {}
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function isAntigravityTarget(t) {
  if (!t || !t.webSocketDebuggerUrl) return false;
  const url = String(t.url || '');
  if (!url || url.startsWith('devtools://') || url.startsWith('chrome-extension://') || url.startsWith('data:') || url.startsWith('about:')) {
    return false;
  }
  const isExtIframe = t.type === 'iframe' && url.includes('extensionView=true');
  if (t.type !== 'page' && !isExtIframe) return false;
  return url.includes('127.0.0.1') || url.includes('workbench') || url.includes('launchpad') || url.startsWith('vscode-file://');
}

const INSPECT_EXPR = `(() => {
  const styleEl = document.getElementById('ats-active-theme');
  const agyShell = document.querySelector('.agy-shell');
  const ideWorkbench = document.querySelector('.monaco-workbench');
  const isExtView = /[?&]extensionView=true\\b/i.test(location.search || '');
  const videoEl = document.getElementById('ats-live-bg-video');
  const scrollers = Array.from(document.querySelectorAll(':is(.agy-shell, .monaco-workbench) :is(.overflow-y-auto, [data-main-content-body], [data-side-panel-body], .monaco-scrollable-element)'));
  const liveBlurScrollers = scrollers.filter((el) => /blur\\(/i.test(getComputedStyle(el).backdropFilter || ''));
  const hostType = isExtView
    ? (/Visual\\+Studio\\+Code/i.test(location.search || '') ? 'VS Code (Extension View)' : 'Antigravity IDE (Extension View)')
    : agyShell
      ? 'Antigravity'
      : (ideWorkbench ? (/Visual Studio Code/i.test(document.title) ? 'VS Code' : 'Antigravity IDE') : 'Unknown');
  const extBeforeContent = (isExtView && agyShell) ? getComputedStyle(agyShell, '::before').content : 'none';
  return {
    hostType,
    url: location.href,
    engineVersion: window.__ATS_ENGINE__ ? window.__ATS_ENGINE__.version : null,
    themeActive: Boolean(styleEl),
    bodyActive: document.body.classList.contains('ats-active'),
    hasBgLayer: Boolean(document.getElementById('ats-live-bg-layer')),
    videoPlaying: Boolean(videoEl && !videoEl.paused && videoEl.readyState >= 2),
    sidebarBtnPresent: Boolean(document.getElementById('ats-sidebar-btn')),
    extRectSynced: isExtView ? Boolean(window.__ATS_EXT_RECT__) : null,
    extUnifiedGlassLeak: isExtView ? (extBeforeContent !== 'none' && extBeforeContent !== '') : false,
    hasLiveBlurRule: liveBlurScrollers.length > 0
  };
})()`;

async function main() {
  const ports = resolveCdpPorts();
  const pages = [];

  for (const port of ports) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      if (!Array.isArray(targets)) continue;
      for (const t of targets.filter(isAntigravityTarget)) {
        pages.push({ port, ...t });
      }
    } catch (_) {}
  }

  if (!pages.length) {
    console.error('[verify] Không thấy cửa sổ Antigravity / Antigravity IDE nào đang mở cổng CDP (9222 / 9223).');
    console.error('         Hãy mở app bằng: npm run launch  hoặc  npm run launch-ide');
    process.exit(1);
  }

  const results = [];
  for (const page of pages) {
    const info = await evalCdp(page.webSocketDebuggerUrl, INSPECT_EXPR);
    results.push({ port: page.port, id: page.id, title: page.title, ...info });
  }

  console.log(JSON.stringify(results, null, 2));

  const themed = results.filter((r) => r.themeActive && r.bodyActive);
  if (themed.length === 0) {
    console.error('\nFAIL — Chưa thấy Theme Studio được tiêm vào cửa sổ nào. Hãy đảm bảo daemon đang chạy.');
    process.exit(1);
  }
  if (themed.some((r) => r.hasLiveBlurRule)) {
    console.error('\nFAIL — Phát hiện live backdrop-filter blur trên vùng cuộn.');
    process.exit(1);
  }
  if (themed.some((r) => r.extUnifiedGlassLeak)) {
    console.error('\nFAIL — Phát hiện .agy-shell::before (Unified Glass) bị rò sang khung extensionView của IDE.');
    process.exit(1);
  }

  console.log(`\nPASS — Antigravity Theme Studio hoạt động ổn định trên ${themed.length}/${results.length} cửa sổ (0 live blur)!`);
}

main().catch((err) => {
  console.error('[verify] Lỗi:', err.message);
  process.exit(1);
});
