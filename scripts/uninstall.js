#!/usr/bin/env node
'use strict';

/**
 * Cleanly uninstalls Antigravity Theme Studio:
 * 1. Removes Windows Startup shortcut & silent-start.vbs
 * 2. Safely stops the running daemon process and removes daemon.pid
 * 3. Calls window.__ATS_ENGINE__.cleanup() on all open Antigravity CDP targets
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, 'daemon.pid');
const VBS_FILE = path.join(ROOT_DIR, 'silent-start.vbs');

function isNodeProcess(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      return /"node\.exe"/i.test(out);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    return /node/i.test(out);
  } catch (_) {
    return false;
  }
}

function stopDaemon() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('[uninstall] Không tìm thấy daemon.pid đang chạy.');
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (pid && isNodeProcess(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[uninstall] Đã dừng daemon (PID ${pid}).`);
    } catch (_) {}
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

function removeStartupShortcut() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const lnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AntigravityThemeStudio.lnk');
    if (fs.existsSync(lnk)) {
      fs.unlinkSync(lnk);
      console.log(`[uninstall] Đã xóa lối tắt Startup: ${lnk}`);
    }

    try {
      const psScript = `
        $dirs = @(
          [Environment]::GetFolderPath('Desktop'),
          [Environment]::GetFolderPath('StartMenu'),
          (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
        ) | Where-Object { $_ -and (Test-Path $_) }
        $wsh = New-Object -ComObject WScript.Shell
        foreach ($d in $dirs) {
          Get-ChildItem -Path $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -in @('Antigravity.lnk', 'Antigravity IDE.lnk', 'Visual Studio Code.lnk') } |
            ForEach-Object {
              $sc = $wsh.CreateShortcut($_.FullName)
              if ($sc.Arguments -match '--remote-debugging-port=\\d+') {
                $sc.Arguments = ($sc.Arguments -replace '\\s*--remote-debugging-port=\\d+', '').Trim()
                $sc.Save()
                Write-Output "[uninstall] Đã gỡ cờ CDP khỏi: $($_.FullName)"
              }
            }
        }
      `;
      const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { encoding: 'utf8' }).trim();
      if (out) console.log(out);
    } catch (_) {}
  }
  if (fs.existsSync(VBS_FILE)) {
    fs.unlinkSync(VBS_FILE);
    console.log('[uninstall] Đã xóa silent-start.vbs');
  }
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
      path.join(appData, 'Antigravity IDE', 'DevToolsActivePort')
    );
  } else if (process.platform === 'darwin') {
    const sup = path.join(home, 'Library', 'Application Support');
    candidates.push(
      path.join(sup, 'antigravity', 'DevToolsActivePort'),
      path.join(sup, 'Antigravity', 'DevToolsActivePort'),
      path.join(sup, 'Antigravity IDE', 'DevToolsActivePort')
    );
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(
      path.join(xdg, 'antigravity', 'DevToolsActivePort'),
      path.join(xdg, 'Antigravity', 'DevToolsActivePort'),
      path.join(xdg, 'Antigravity IDE', 'DevToolsActivePort')
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

function cleanupPage(wsUrl) {
  return new Promise((resolve) => {
    if (typeof globalThis.WebSocket !== 'function') return resolve();
    const ws = new globalThis.WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve();
    }, 2500);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: 'window.__ATS_ENGINE__ && window.__ATS_ENGINE__.cleanup();' }
      }));
    });
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } catch (_) {}
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function cleanupOpenPages() {
  const ports = resolveCdpPorts();
  for (const port of ports) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const pages = (Array.isArray(targets) ? targets : []).filter((t) => {
        if (!t || !t.webSocketDebuggerUrl) return false;
        const url = String(t.url || '');
        if (t.type !== 'page' && !(t.type === 'iframe' && url.includes('extensionView=true'))) return false;
        return url.includes('127.0.0.1') || url.includes('workbench') || url.includes('launchpad') || url.startsWith('vscode-file://');
      });

      for (const p of pages) {
        await cleanupPage(p.webSocketDebuggerUrl);
        console.log(`[uninstall] Đã khôi phục giao diện gốc trên trang ${p.id} (port ${port}).`);
      }
    } catch (_) {}
  }
}

async function main() {
  removeStartupShortcut();
  stopDaemon();
  await cleanupOpenPages();
  console.log('[uninstall] Gỡ cài đặt hoàn tất.');
}

main();
