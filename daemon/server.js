#!/usr/bin/env node
'use strict';

/**
 * Antigravity Theme Studio — Background Daemon & Local Media Server
 * - Connects to Antigravity via CDP (DevToolsActivePort or ATS_CDP_PORT)
 * - Enables Page.setBypassCSP, injects dist/bundle.js & hot-reloads on rebuild
 * - Syncs theme_config.json across all open Antigravity windows
 * - Serves local video/image/audio assets with HTTP Range 206 support
 * - Handles media upload (MD5 deduplication) & deletion (with config cleanup)
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

if (typeof globalThis.WebSocket !== 'function') {
  console.error('[ats-daemon] Node.js >= 22 with native WebSocket is required.');
  process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, 'daemon.pid');
const LOG_FILE = path.join(ROOT_DIR, 'daemon.log');
const CONFIG_FILE = process.env.ATS_CONFIG_PATH || path.join(ROOT_DIR, 'theme_config.json');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const BUNDLE_PATH = path.join(DIST_DIR, 'bundle.js');
const ASSETS_DIR = path.join(ROOT_DIR, 'themes', 'assets');
const USER_MEDIA_DIR = path.join(ROOT_DIR, 'themes', 'user_media');

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

const md5Cache = new Map();
const sessions = new Map();
const portWebviewRects = new Map();
let lastGlobalTaskSoundAt = 0;
let mediaPort = 0;
let mediaServer = null;
let pollingCdp = false;
let missingBundleLogged = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) {
      fs.writeFileSync(LOG_FILE, '');
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
  if (process.stdout.isTTY || process.env.ATS_STDOUT === '1') {
    process.stdout.write(line);
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquirePidLock() {
  if (fs.existsSync(PID_FILE)) {
    const existing = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (existing && existing !== process.pid && isPidAlive(existing)) {
      log(`Daemon already running (PID ${existing}). Exiting.`);
      process.exit(0);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function removePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(PID_FILE);
    }
  } catch (_) {}
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    log(`Config read error: ${err.message}`);
  }
  return {};
}

function saveConfig(patch) {
  try {
    const merged = { ...readConfig(), ...patch };
    const serialized = JSON.stringify(merged, null, 2);
    const tmpFile = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, serialized, 'utf8');
    try {
      fs.renameSync(tmpFile, CONFIG_FILE);
    } catch (renameErr) {
      // Windows AV/indexer can briefly lock CONFIG_FILE during renameSync -> safe direct write fallback
      fs.writeFileSync(CONFIG_FILE, serialized, 'utf8');
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
    return merged;
  } catch (err) {
    log(`Config save error: ${err.message}`);
    return null;
  }
}

function getMediaKind(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

function stripTimestamp(name) {
  return String(name || '').replace(/^\d{10,}_/, '');
}

function normalizeUserMediaFileName(urlOrName) {
  if (!urlOrName) return '';
  let s = String(urlOrName).trim();
  if (!s) return '';
  const match = s.match(/(?:^|\/)user_media\/([^?#]+)/i);
  if (match) s = match[1];
  try {
    s = decodeURIComponent(s);
  } catch (_) {}
  const base = path.basename(s);
  if (!base || base === '.' || base === '..' || base === '.gitkeep') return '';
  return base;
}

function getFileMd5(filePath, stat) {
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = md5Cache.get(cacheKey);
  if (cached) return cached;
  const hashObj = crypto.createHash('md5');
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hashObj.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  const hash = hashObj.digest('hex');
  if (md5Cache.size > 500) md5Cache.clear();
  md5Cache.set(cacheKey, hash);
  return hash;
}

function scanUserMedia() {
  const videos = [];
  const images = [];
  const audios = [];
  if (!fs.existsSync(USER_MEDIA_DIR)) {
    return { videos, images, audios };
  }

  const cfg = readConfig();
  const activeVid = normalizeUserMediaFileName(cfg.activeVideo);
  const activeImg = normalizeUserMediaFileName(cfg.activeImage);
  const activeAud = normalizeUserMediaFileName(cfg.activeAudio);

  let entries = [];
  try {
    entries = fs.readdirSync(USER_MEDIA_DIR, { withFileTypes: true });
  } catch (_) {
    return { videos, images, audios };
  }

  const byHash = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.gitkeep') continue;
    const kind = getMediaKind(entry.name);
    if (!kind) continue;
    const fullPath = path.join(USER_MEDIA_DIR, entry.name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }
    const md5 = getFileMd5(fullPath, stat);
    const item = {
      fileName: entry.name,
      name: stripTimestamp(entry.name),
      url: `user_media/${encodeURIComponent(entry.name)}`,
      kind,
      size: stat.size,
      addedAt: Math.round(stat.mtimeMs),
    };
    const isActive = entry.name === activeVid || entry.name === activeImg || entry.name === activeAud;
    const existing = byHash.get(md5);
    if (!existing) {
      byHash.set(md5, { item, isActive });
    } else if (isActive && !existing.isActive) {
      byHash.set(md5, { item, isActive: true });
    } else if (!existing.isActive && item.addedAt > existing.item.addedAt) {
      byHash.set(md5, { item, isActive: false });
    }
  }

  for (const { item } of byHash.values()) {
    if (item.kind === 'video') videos.push(item);
    else if (item.kind === 'image') images.push(item);
    else audios.push(item);
  }

  videos.sort((a, b) => b.addedAt - a.addedAt);
  images.sort((a, b) => b.addedAt - a.addedAt);
  audios.sort((a, b) => b.addedAt - a.addedAt);
  return { videos, images, audios };
}

// ----------------------------------------------------------------------------
// 1. Local HTTP Media Server (Range 206 Streaming + Upload/Delete API)
// ----------------------------------------------------------------------------
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function pipeStreamSafely(stream, res) {
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Stream error');
    } else {
      res.destroy();
    }
  });
  res.on('close', () => {
    stream.destroy();
  });
  stream.pipe(res);
}

function serveStaticWithRange(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
  } catch (_) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    if (stat.size === 0) {
      res.writeHead(416, { 'Content-Range': 'bytes */0' });
      res.end();
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }

    let start;
    let end;
    if (!match[1] && match[2]) {
      // Suffix-byte-range: bytes=-500 (last 500 bytes)
      const suffix = parseInt(match[2], 10);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    });
    pipeStreamSafely(fs.createReadStream(filePath, { start, end }), res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    });
    pipeStreamSafely(fs.createReadStream(filePath), res);
  }
}

function startMediaServer() {
  return new Promise((resolve) => {
    mediaServer = http.createServer((req, res) => {
      setCors(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      let urlObj;
      let pathname;
      try {
        urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        pathname = decodeURIComponent(urlObj.pathname || '/');
      } catch (_) {
        sendJson(res, 400, { ok: false, error: 'Invalid request URL' });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/media') {
        try {
          sendJson(res, 200, { ok: true, ...scanUserMedia() });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/claim-sound') {
        const now = Date.now();
        if (now - lastGlobalTaskSoundAt < 3000) {
          sendJson(res, 200, { ok: true, allowed: false });
        } else {
          lastGlobalTaskSoundAt = now;
          sendJson(res, 200, { ok: true, allowed: true });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/upload') {
        const rawName = urlObj.searchParams.get('name') || '';
        const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
        const kind = getMediaKind(safeName);
        if (!safeName || !kind) {
          sendJson(res, 400, {
            ok: false,
            error: 'Định dạng tệp không được hỗ trợ (chỉ nhận Video, Ảnh hoặc Âm thanh).',
          });
          req.resume();
          return;
        }

        fs.mkdirSync(USER_MEDIA_DIR, { recursive: true });
        const tmpName = `.upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;
        const tmpPath = path.join(USER_MEDIA_DIR, tmpName);
        const writeStream = fs.createWriteStream(tmpPath);
        const hash = crypto.createHash('md5');
        let total = 0;
        let rejected = false;
        const MAX_BYTES = 150 * 1024 * 1024;

        const cleanupTmp = () => {
          try { writeStream.destroy(); } catch (_) {}
          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        };

        writeStream.on('error', (err) => {
          if (rejected) return;
          rejected = true;
          cleanupTmp();
          sendJson(res, 500, { ok: false, error: err.message });
          req.destroy();
        });

        req.on('data', (chunk) => {
          if (rejected) return;
          total += chunk.length;
          if (total > MAX_BYTES) {
            rejected = true;
            cleanupTmp();
            sendJson(res, 413, { ok: false, error: 'Tệp vượt quá giới hạn 150MB' });
            req.destroy();
            return;
          }
          hash.update(chunk);
          if (!writeStream.write(chunk)) {
            req.pause();
            writeStream.once('drain', () => {
              if (!rejected) req.resume();
            });
          }
        });

        req.on('error', () => {
          rejected = true;
          cleanupTmp();
        });

        req.on('end', () => {
          if (rejected) return;
          writeStream.end(() => {
            if (rejected) return;
            try {
              const md5 = hash.digest('hex');

              for (const entry of fs.readdirSync(USER_MEDIA_DIR, { withFileTypes: true })) {
                if (!entry.isFile() || entry.name === '.gitkeep' || entry.name.startsWith('.upload_')) continue;
                const existingPath = path.join(USER_MEDIA_DIR, entry.name);
                try {
                  const stat = fs.statSync(existingPath);
                  if (stat.size === total && getFileMd5(existingPath, stat) === md5) {
                    cleanupTmp();
                    sendJson(res, 200, {
                      ok: true,
                      duplicate: true,
                      fileName: entry.name,
                      name: stripTimestamp(entry.name),
                      url: `user_media/${encodeURIComponent(entry.name)}`,
                      kind: getMediaKind(entry.name) || kind,
                    });
                    return;
                  }
                } catch (_) {}
              }

              const fileName = `${Date.now()}_${safeName}`;
              const finalPath = path.join(USER_MEDIA_DIR, fileName);
              fs.renameSync(tmpPath, finalPath);
              sendJson(res, 200, {
                ok: true,
                duplicate: false,
                fileName,
                name: stripTimestamp(fileName),
                url: `user_media/${encodeURIComponent(fileName)}`,
                kind,
              });
            } catch (err) {
              cleanupTmp();
              sendJson(res, 500, { ok: false, error: err.message });
            }
          });
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/delete') {
        const chunks = [];
        let total = 0;
        let rejected = false;
        const MAX_JSON = 64 * 1024;

        req.on('data', (chunk) => {
          if (rejected) return;
          total += chunk.length;
          if (total > MAX_JSON) {
            rejected = true;
            sendJson(res, 413, { ok: false, error: 'Payload too large' });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });

        req.on('error', () => {
          rejected = true;
        });

        req.on('end', () => {
          if (rejected) return;
          try {
            let targetInput = urlObj.searchParams.get('name') || '';
            if (!targetInput && chunks.length > 0) {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              targetInput = body.url || body.fileName || body.name || '';
            }
            const fileName = normalizeUserMediaFileName(targetInput);
            if (!fileName) {
              sendJson(res, 400, { ok: false, error: 'Invalid media target' });
              return;
            }

            const baseDir = path.resolve(USER_MEDIA_DIR);
            const resolved = path.resolve(baseDir, fileName);
            if (!resolved.startsWith(baseDir + path.sep)) {
              sendJson(res, 403, { ok: false, error: 'Forbidden path' });
              return;
            }

            const deletedFiles = [];
            if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
              const targetStat = fs.statSync(resolved);
              const targetMd5 = getFileMd5(resolved, targetStat);
              for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
                if (!entry.isFile() || entry.name === '.gitkeep') continue;
                const candidatePath = path.join(baseDir, entry.name);
                try {
                  const cStat = fs.statSync(candidatePath);
                  if (
                    candidatePath === resolved ||
                    (cStat.size === targetStat.size && getFileMd5(candidatePath, cStat) === targetMd5)
                  ) {
                    fs.unlinkSync(candidatePath);
                    deletedFiles.push(entry.name);
                  }
                } catch (_) {}
              }
            }

            const deletedSet = new Set(deletedFiles.concat(fileName));
            const cfg = readConfig();
            const patch = {};
            if (deletedSet.has(normalizeUserMediaFileName(cfg.activeVideo))) {
              patch.activeVideo = 'assets/wallpaper.mp4';
            }
            if (deletedSet.has(normalizeUserMediaFileName(cfg.activeImage))) {
              patch.activeImage = '';
            }
            if (deletedSet.has(normalizeUserMediaFileName(cfg.activeAudio))) {
              patch.activeAudio = '';
            }
            if (deletedSet.has(normalizeUserMediaFileName(cfg.bootAudio))) {
              patch.bootAudio = '';
            }
            if (Object.keys(patch).length > 0) {
              saveConfig(patch);
            }

            sendJson(res, 200, { ok: true, deleted: deletedFiles, media: scanUserMedia() });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
        });
        return;
      }

      let baseDir = null;
      let rel = '';
      if (pathname.startsWith('/assets/')) {
        baseDir = path.resolve(ASSETS_DIR);
        rel = pathname.slice('/assets/'.length);
      } else if (pathname.startsWith('/user_media/')) {
        baseDir = path.resolve(USER_MEDIA_DIR);
        rel = pathname.slice('/user_media/'.length);
      }

      if (baseDir) {
        const fullPath = path.resolve(baseDir, rel);
        if (!fullPath.startsWith(baseDir + path.sep)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        serveStaticWithRange(req, res, fullPath);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    mediaServer.listen(0, '127.0.0.1', () => {
      const addr = mediaServer.address();
      mediaPort = addr && typeof addr === 'object' ? addr.port : 0;
      log(`Media Server listening at http://127.0.0.1:${mediaPort}`);
      resolve();
    });
  });
}

// ----------------------------------------------------------------------------
// 2. CDP Discovery & Payload Injection
// ----------------------------------------------------------------------------
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

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const firstLine = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0];
        const port = parseInt(firstLine, 10);
        if (Number.isFinite(port) && port > 0) ports.add(port);
      } catch (_) {}
    }
  }

  // Always include default Antigravity (9222), Antigravity IDE (9223), and VS Code (9224) ports
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
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
  });
}

function resolveLocalMediaAsDataUri(relPath, maxBytes) {
  if (!relPath || typeof relPath !== 'string') return '';
  let s = relPath.trim();
  if (!s || /^(?:data:|https?:|blob:)/i.test(s)) return '';
  let baseDir = null;
  let rel = '';
  if (s.startsWith('user_media/')) {
    baseDir = path.resolve(USER_MEDIA_DIR);
    rel = s.slice('user_media/'.length);
  } else if (s.startsWith('assets/')) {
    baseDir = path.resolve(ASSETS_DIR);
    rel = s.slice('assets/'.length);
  } else {
    return '';
  }
  try { rel = decodeURIComponent(rel); } catch (_) {}
  const fullPath = path.resolve(baseDir, rel);
  if (!fullPath.startsWith(baseDir + path.sep)) return '';
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return '';
    const ext = path.extname(fullPath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(fullPath).toString('base64')}`;
  } catch (_) {
    return '';
  }
}

function buildInjectedSource(isIde = false) {
  if (!fs.existsSync(BUNDLE_PATH)) {
    if (!missingBundleLogged) {
      log(`Bundle not built yet (${BUNDLE_PATH}). Run: npm run build`);
      missingBundleLogged = true;
    }
    return null;
  }
  missingBundleLogged = false;

  const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const cfg = readConfig();
  const userMedia = scanUserMedia();
  const mediaBase = mediaPort ? `http://127.0.0.1:${mediaPort}` : '';

  // VS Code / Antigravity IDE (vscode-file://) CSP blocks http://127.0.0.1 for img/media,
  // but allows data: URIs -> inline active image (and .webm video <= 25MB) for IDE targets.
  let inlineImage = '';
  let inlineVideo = '';
  if (isIde) {
    if (cfg.activeImage) {
      inlineImage = resolveLocalMediaAsDataUri(cfg.activeImage, 15 * 1024 * 1024);
    }
    if (cfg.activeVideo && /\.webm$/i.test(String(cfg.activeVideo))) {
      inlineVideo = resolveLocalMediaAsDataUri(cfg.activeVideo, 25 * 1024 * 1024);
    }
  }

  return [
    `window.__ATS_MEDIA_BASE__ = ${JSON.stringify(mediaBase)};`,
    `window.__ATS_INIT_CONFIG__ = ${JSON.stringify(cfg)};`,
    `window.__ATS_USER_MEDIA__ = ${JSON.stringify(userMedia)};`,
    `window.__ATS_INLINE_IMAGE__ = ${JSON.stringify(inlineImage)};`,
    `window.__ATS_INLINE_VIDEO__ = ${JSON.stringify(inlineVideo)};`,
    bundle,
  ].join('\n');
}

function isAntigravityTarget(t) {
  if (!t || !t.webSocketDebuggerUrl) return false;
  const url = String(t.url || '');
  if (!url) return false;
  const isExtIframe = t.type === 'iframe' && url.includes('extensionView=true');
  if (t.type !== 'page' && !isExtIframe) return false;
  if (
    url.startsWith('devtools://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('data:') ||
    url.startsWith('about:')
  ) {
    return false;
  }
  return (
    url.includes('127.0.0.1') ||
    url.includes('workbench') ||
    url.includes('launchpad') ||
    url.startsWith('vscode-file://')
  );
}

function extractWorkspaceHint(urlStr) {
  try {
    const u = new URL(String(urlStr || ''));
    let wsUri = u.searchParams.get('workspaceUri') || '';
    if (!wsUri) return '';
    try { wsUri = decodeURIComponent(wsUri); } catch (_) {}
    try { wsUri = decodeURIComponent(wsUri); } catch (_) {}
    const clean = wsUri.replace(/[\\/]+$/, '');
    const parts = clean.split(/[\\/]/).filter(Boolean);
    return (parts[parts.length - 1] || '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function getMatchingRectForExt(portPrefix, workspaceHint) {
  const ideSessions = Array.from(sessions.values()).filter(
    (s) => s.portPrefix === portPrefix && s.isIdeTarget && s.lastRect
  );
  if (workspaceHint && ideSessions.length > 1) {
    const matched = ideSessions.find((s) => (s.lastTitle || '').includes(workspaceHint));
    if (matched) return matched.lastRect;
  }
  if (ideSessions.length === 1) return ideSessions[0].lastRect;
  return portWebviewRects.get(portPrefix) || null;
}

function attachTarget(sessionKey, target) {
  const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  let newDocScriptId = null;
  let newDocRefreshTimer = null;
  const session = { id: sessionKey, ws, target };
  sessions.set(sessionKey, session);

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== 1) return reject(new Error('WebSocket closed'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  async function registerNewDocScript(src) {
    if (newDocScriptId) {
      try {
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: newDocScriptId });
      } catch (_) {}
      newDocScriptId = null;
    }
    try {
      const res = await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
      if (res && res.identifier) newDocScriptId = res.identifier;
    } catch (_) {}
  }

  const isIdeTarget = String(target.url || '').startsWith('vscode-file://');
  const isExtTarget = String(target.url || '').includes('extensionView=true');
  const portPrefix = String(sessionKey).split(':')[0];
  const workspaceHint = isExtTarget ? extractWorkspaceHint(target.url) : '';
  session.send = send;
  session.isIdeTarget = isIdeTarget;
  session.isExtTarget = isExtTarget;
  session.portPrefix = portPrefix;
  session.workspaceHint = workspaceHint;
  session.lastTitle = String(target.title || '').toLowerCase();
  session.lastRect = null;
  session.lastInlineImageKey = null;
  session.lastInlineVideoKey = null;

  const pushRectToExt = async () => {
    if (!isExtTarget) return;
    const rect = getMatchingRectForExt(portPrefix, workspaceHint);
    if (rect) {
      try {
        await send('Runtime.evaluate', {
          expression: `window.__ATS_APPLY_EXT_RECT__&&window.__ATS_APPLY_EXT_RECT__(${JSON.stringify(rect)});`,
          awaitPromise: false,
        });
      } catch (_) {}
    }
    for (const other of sessions.values()) {
      if (other.portPrefix === portPrefix && other.isIdeTarget) {
        other.send('Runtime.evaluate', {
          expression: 'window.__ATS_ENGINE__&&window.__ATS_ENGINE__.syncRect&&window.__ATS_ENGINE__.syncRect(true);',
          awaitPromise: false,
        }).catch(() => {});
      }
    }
  };

  session.reinject = async (updateNewDoc = true) => {
    const src = buildInjectedSource(isIdeTarget);
    if (!src) return;
    const cfg = readConfig();
    session.lastInlineImageKey = isIdeTarget ? String(cfg.activeImage || '') : null;
    session.lastInlineVideoKey = isIdeTarget ? String(cfg.activeVideo || '') : null;
    if (updateNewDoc) {
      await registerNewDocScript(src);
    }
    try {
      await send('Runtime.evaluate', { expression: src, awaitPromise: false });
      await pushRectToExt();
    } catch (_) {}
  };

  session.applyConfigUpdate = async (saved) => {
    try {
      const parts = [];
      if (isIdeTarget) {
        const imgKey = String(saved.activeImage || '');
        const vidKey = String(saved.activeVideo || '');
        if (session.lastInlineImageKey !== imgKey) {
          session.lastInlineImageKey = imgKey;
          const inImg = imgKey ? resolveLocalMediaAsDataUri(imgKey, 15 * 1024 * 1024) : '';
          parts.push(`window.__ATS_INLINE_IMAGE__=${JSON.stringify(inImg)};`);
        }
        if (session.lastInlineVideoKey !== vidKey) {
          session.lastInlineVideoKey = vidKey;
          const inVid = (vidKey && /\.webm$/i.test(vidKey))
            ? resolveLocalMediaAsDataUri(vidKey, 25 * 1024 * 1024)
            : '';
          parts.push(`window.__ATS_INLINE_VIDEO__=${JSON.stringify(inVid)};`);
        }
      }
      parts.push(`window.__ATS_ENGINE__&&window.__ATS_ENGINE__.updateConfig?window.__ATS_ENGINE__.updateConfig(${JSON.stringify(saved)}):(window.__ATS_ENGINE__&&window.__ATS_ENGINE__.reapply());`);
      await send('Runtime.evaluate', { expression: parts.join(''), awaitPromise: false });
    } catch (_) {}

    clearTimeout(newDocRefreshTimer);
    newDocRefreshTimer = setTimeout(() => {
      if (ws.readyState !== 1) return;
      const src = buildInjectedSource(isIdeTarget);
      if (src) registerNewDocScript(src).catch(() => {});
    }, 600);
  };

  ws.addEventListener('open', async () => {
    log(`Attached to Antigravity target: ${target.title || target.id} (${target.url})`);
    try {
      await send('Page.enable');
      await send('Runtime.enable');
      try {
        await send('Page.setBypassCSP', { enabled: true });
      } catch (_) {}
      try {
        await send('Runtime.addBinding', { name: 'atsSaveConfig' });
        await send('Runtime.addBinding', { name: 'atsReportWebviewRect' });
        await send('Runtime.addBinding', { name: 'atsOpenStudio' });
      } catch (_) {}

      const src = buildInjectedSource(isIdeTarget);
      if (src) {
        const cfg = readConfig();
        session.lastInlineImageKey = isIdeTarget ? String(cfg.activeImage || '') : null;
        session.lastInlineVideoKey = isIdeTarget ? String(cfg.activeVideo || '') : null;
        await registerNewDocScript(src);
        await send('Runtime.evaluate', { expression: src, awaitPromise: false });
        await pushRectToExt();
      }
    } catch (err) {
      log(`Injection error (${target.id}): ${err.message}`);
    }
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch (_) {
      return;
    }

    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === 'atsSaveConfig') {
      try {
        const nextCfg = JSON.parse(msg.params.payload || '{}');
        const saved = saveConfig(nextCfg) || nextCfg;
        if (isIdeTarget) {
          const imgKey = String(saved.activeImage || '');
          const vidKey = String(saved.activeVideo || '');
          const parts = [];
          if (session.lastInlineImageKey !== imgKey) {
            session.lastInlineImageKey = imgKey;
            const inImg = imgKey ? resolveLocalMediaAsDataUri(imgKey, 15 * 1024 * 1024) : '';
            parts.push(`window.__ATS_INLINE_IMAGE__=${JSON.stringify(inImg)};`);
          }
          if (session.lastInlineVideoKey !== vidKey) {
            session.lastInlineVideoKey = vidKey;
            const inVid = (vidKey && /\.webm$/i.test(vidKey))
              ? resolveLocalMediaAsDataUri(vidKey, 25 * 1024 * 1024)
              : '';
            parts.push(`window.__ATS_INLINE_VIDEO__=${JSON.stringify(inVid)};`);
          }
          if (parts.length > 0) {
            parts.push('window.__ATS_ENGINE__&&window.__ATS_ENGINE__.reapply();');
            send('Runtime.evaluate', { expression: parts.join(''), awaitPromise: false }).catch(() => {});
          }
          clearTimeout(newDocRefreshTimer);
          newDocRefreshTimer = setTimeout(() => {
            if (ws.readyState !== 1) return;
            const src = buildInjectedSource(true);
            if (src) registerNewDocScript(src).catch(() => {});
          }, 600);
        }
        for (const other of sessions.values()) {
          if (other.id !== sessionKey) {
            other.applyConfigUpdate(saved);
          }
        }
      } catch (err) {
        log(`Save config binding error: ${err.message}`);
      }
    } else if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === 'atsReportWebviewRect') {
      try {
        const rect = JSON.parse(msg.params.payload || '{}');
        if (rect && Number.isFinite(rect.wbW) && Number.isFinite(rect.wbH)) {
          const rectTitle = String(rect.title || target.title || '').toLowerCase();
          session.lastRect = rect;
          if (rectTitle) session.lastTitle = rectTitle;
          portWebviewRects.set(portPrefix, rect);

          const ideCountOnPort = Array.from(sessions.values()).filter(
            (s) => s.portPrefix === portPrefix && s.isIdeTarget
          ).length;

          for (const other of sessions.values()) {
            if (other.portPrefix === portPrefix && other.isExtTarget) {
              if (ideCountOnPort > 1 && other.workspaceHint && rectTitle && !rectTitle.includes(other.workspaceHint)) {
                continue;
              }
              other.send('Runtime.evaluate', {
                expression: `window.__ATS_APPLY_EXT_RECT__&&window.__ATS_APPLY_EXT_RECT__(${JSON.stringify(rect)});`,
                awaitPromise: false,
              }).catch(() => {});
            }
          }
        }
      } catch (_) {}
    } else if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === 'atsOpenStudio') {
      const ideCandidates = Array.from(sessions.values()).filter(
        (s) => s.portPrefix === portPrefix && s.isIdeTarget
      );
      const matched = (workspaceHint && ideCandidates.length > 1)
        ? (ideCandidates.find((s) => (s.lastTitle || '').includes(workspaceHint)) || ideCandidates[0])
        : ideCandidates[0];
      if (matched) {
        matched.send('Runtime.evaluate', {
          expression: 'window.__ATS_ENGINE__&&window.__ATS_ENGINE__.openStudio&&window.__ATS_ENGINE__.openStudio();',
          awaitPromise: false,
        }).catch(() => {});
      }
    } else if (msg.method === 'Page.frameNavigated' && msg.params?.frame && !msg.params.frame.parentId) {
      // Only re-evaluate if addScriptToEvaluateOnNewDocument didn't already run or to refresh media base
      await session.reinject(false);
    }
  });

  const cleanup = () => {
    clearTimeout(newDocRefreshTimer);
    for (const p of pending.values()) {
      p.reject(new Error('WebSocket closed'));
    }
    pending.clear();
    if (sessions.has(sessionKey)) {
      sessions.delete(sessionKey);
      log(`Detached from target: ${sessionKey}`);
    }
  };

  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
}

async function pollCdp() {
  if (pollingCdp) return;
  pollingCdp = true;
  try {
    const ports = resolveCdpPorts();
    const liveKeys = new Set();

    const results = await Promise.all(
      ports.map(async (port) => {
        try {
          const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
          return { port, targets: Array.isArray(targets) ? targets : [] };
        } catch (_) {
          return { port, targets: [] };
        }
      })
    );

    for (const { port, targets } of results) {
      const pages = targets.filter(isAntigravityTarget);
      for (const page of pages) {
        const key = `${port}:${page.id}`;
        liveKeys.add(key);
        if (!sessions.has(key)) {
          attachTarget(key, page);
        }
      }
    }

    for (const [key, session] of sessions.entries()) {
      if (!liveKeys.has(key)) {
        try { session.ws.close(); } catch (_) {}
        sessions.delete(key);
      }
    }
  } finally {
    pollingCdp = false;
  }
}

function watchHotReload() {
  try {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    let timer = null;
    fs.watch(DIST_DIR, (_, filename) => {
      if (filename && filename !== 'bundle.js') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        log('dist/bundle.js updated -> Hot-reloading all attached Antigravity windows...');
        for (const s of sessions.values()) {
          s.reinject(true);
        }
      }, 220);
    });
  } catch (err) {
    log(`fs.watch skipped: ${err.message}`);
  }
}

function shutdown(signal) {
  log(`Shutting down on ${signal}.`);
  if (mediaServer) {
    try { mediaServer.close(); } catch (_) {}
  }
  for (const s of sessions.values()) {
    try { s.ws.close(); } catch (_) {}
  }
  sessions.clear();
  removePidLock();
  process.exit(0);
}

function cleanupOrphanTempUploads() {
  try {
    if (!fs.existsSync(USER_MEDIA_DIR)) return;
    for (const entry of fs.readdirSync(USER_MEDIA_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('.upload_') && entry.name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(USER_MEDIA_DIR, entry.name)); } catch (_) {}
      }
    }
  } catch (_) {}
}

async function main() {
  acquirePidLock();
  cleanupOrphanTempUploads();
  process.on('exit', removePidLock);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await startMediaServer();
  watchHotReload();
  await pollCdp();
  setInterval(pollCdp, 1800);
  log(`Antigravity Theme Studio Daemon running (PID ${process.pid}, platform=${process.platform}).`);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
