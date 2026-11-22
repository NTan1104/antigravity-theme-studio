(() => {
  'use strict';

  const PRESETS = /* __ATS_PRESETS__ */ {};
  const STATIC_CSS = /* __ATS_CSS__ */ '';
  const PRESET_KEYS = Object.keys(PRESETS);
  const DEFAULT_PRESET_KEY = PRESET_KEYS[0] || 'Dark Glass Live';
  const STORAGE_KEY = 'ats_theme_state_v2';
  const BOOT_PLAYED_FLAG = '__atsBootHudPlayed';

  const DEFAULT_GREETINGS = [
    'Chào mừng trở lại! Hôm nay mình build gì đây?',
    'Hệ thống đã sẵn sàng — bắt đầu vibe code thôi!',
    'Dark Glass Studio trực tuyến. Sẵn sàng nhận lệnh!',
    'Một ngày mới, một dự án đỉnh cao mới.'
  ];

  const GREETING_RX = /^(?:Hey\s+[^,]{1,40},\s+what\s+should\s+we\s+build\s+today\??|Good\s+to\s+see\s+you|What\s+(?:should|are)\s+we\s+build(?:ing)?\s+today\??|What\s+can\s+I\s+help\s+you\s+with|How\s+can\s+I\s+help\s+you|Welcome\s+back|Where\s+should\s+we\s+pick\s+up|Ready\s+(?:to\s+build|when\s+you\s+are))/i;

  const INPUT_STYLES = {
    sync: 'Synced Theme Frame (Mặc định)',
    double_gold: 'Amber Gold Double Border',
    glass: 'Translucent Crystal Glass',
    minimal: 'Minimal Clean'
  };

  const DEFAULT_STATE = {
    preset: DEFAULT_PRESET_KEY,
    bubblePreset: DEFAULT_PRESET_KEY,
    inputStyle: 'sync',
    wpEnabled: true,
    mode: 'video', // 'video' | 'image' | 'gradient'
    activeVideo: 'assets/wallpaper.mp4',
    activeImage: '',
    dimOpacity: 0.45,
    glassBlur: 3,
    primaryOverride: '',
    userAvatar: '',
    agentAvatar: '',
    avatarSize: 32,
    avatarRadius: 50,
    taskSoundEnabled: true,
    taskSoundVolume: 0.75,
    activeAudio: '', // '' = random from uploaded audios or built-in Web Audio chime
    customGreetingEnabled: true,
    customGreetings: DEFAULT_GREETINGS.slice(),
    bootHudEnabled: true,
    bootHudTitle: 'ANTIGRAVITY STUDIO',
    bootHudSub: 'DARK GLASS ENGINE // READY',
    bootSoundEnabled: true,
    bootSoundVolume: 0.75,
    bootAudio: '', // '' = built-in Sci-Fi Synth boot sound
    showFloatingBtn: true,
    bgPosition: '' // '' = preset default, or 'center top' | 'center 25%' | 'center center' | 'center 75%' | 'center bottom'
  };

  // --------------------------------------------------------------------------
  // 0. Helpers & State Management
  // --------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setHtml(el, html) {
    if (!el) return;
    try {
      if (window.trustedTypes) {
        if (!window.__ATS_TT_POLICY__ && typeof window.trustedTypes.createPolicy === 'function') {
          try {
            window.__ATS_TT_POLICY__ = window.trustedTypes.createPolicy('ats-theme-studio', {
              createHTML: (s) => s
            });
          } catch (_) {}
        }
        const pol = window.__ATS_TT_POLICY__ || window.trustedTypes.defaultPolicy;
        if (pol && typeof pol.createHTML === 'function') {
          el.innerHTML = pol.createHTML(html);
          return;
        }
      }
      el.innerHTML = html;
    } catch (_) {
      el.textContent = '';
    }
  }

  function sanitizeCssUrl(u) {
    return String(u || '').replace(/["\\()\r\n]/g, (ch) => encodeURIComponent(ch));
  }

  function getMediaBase() {
    return String(window.__ATS_MEDIA_BASE__ || '').replace(/\/+$/, '');
  }

  function resolveMediaUrl(relPath) {
    if (!relPath) return '';
    const s = String(relPath).trim();
    if (!s) return '';
    const base = getMediaBase();
    const localMatch = s.match(/^https?:\/\/127\.0\.0\.1:\d+\/((?:assets|user_media)\/.+)$/i);
    if (localMatch) {
      return base ? `${base}/${localMatch[1]}` : s;
    }
    if (/^(?:https?:|data:|blob:|file:)/i.test(s)) return s;
    const clean = s.replace(/^\.\//, '').replace(/^\/+/, '');
    return base ? `${base}/${clean}` : clean;
  }

  function canonicalMediaKey(urlStr) {
    if (!urlStr) return '';
    const s = String(urlStr).trim();
    const match = s.match(/(?:^|\/)(user_media\/[^?#]+)/i);
    if (match) {
      try {
        return 'user_media/' + decodeURIComponent(match[1].slice('user_media/'.length));
      } catch (_) {
        return match[1];
      }
    }
    return s;
  }

  function isSameMediaUrl(a, b) {
    const ka = canonicalMediaKey(a);
    const kb = canonicalMediaKey(b);
    return Boolean(ka && kb && ka === kb);
  }

  function loadState() {
    let fromLocal = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) fromLocal = JSON.parse(raw) || {};
    } catch (_) {}

    const fromDaemon = (window.__ATS_INIT_CONFIG__ && typeof window.__ATS_INIT_CONFIG__ === 'object')
      ? window.__ATS_INIT_CONFIG__
      : {};

    const merged = { ...DEFAULT_STATE, ...fromLocal, ...fromDaemon };
    if (!PRESETS[merged.preset]) merged.preset = DEFAULT_PRESET_KEY;
    if (!PRESETS[merged.bubblePreset]) merged.bubblePreset = merged.preset;
    if (!INPUT_STYLES[merged.inputStyle]) merged.inputStyle = 'sync';
    if (!['video', 'image', 'gradient'].includes(merged.mode)) merged.mode = 'video';
    if (!Array.isArray(merged.customGreetings) || merged.customGreetings.length === 0) {
      merged.customGreetings = DEFAULT_GREETINGS.slice();
    }
    return merged;
  }

  let state = loadState();
  let mediaLibrary = (window.__ATS_USER_MEDIA__ && typeof window.__ATS_USER_MEDIA__ === 'object')
    ? {
        videos: Array.isArray(window.__ATS_USER_MEDIA__.videos) ? window.__ATS_USER_MEDIA__.videos : [],
        images: Array.isArray(window.__ATS_USER_MEDIA__.images) ? window.__ATS_USER_MEDIA__.images : [],
        audios: Array.isArray(window.__ATS_USER_MEDIA__.audios) ? window.__ATS_USER_MEDIA__.audios : []
      }
    : { videos: [], images: [], audios: [] };

  let bgStatusText = '';
  let bgStatusError = false;
  let lookStatusText = '';
  let lookStatusError = false;
  let audioStatusText = '';
  let audioStatusError = false;
  let hudStatusText = '';
  let hudStatusError = false;

  let saveConfigTimer = null;

  function flushSaveConfig() {
    try {
      if (typeof window.atsSaveConfig === 'function') {
        window.atsSaveConfig(JSON.stringify(state));
      }
    } catch (_) {}
  }

  function saveState(patch = {}, immediate = false) {
    state = { ...state, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
    clearTimeout(saveConfigTimer);
    if (immediate) {
      flushSaveConfig();
    } else {
      saveConfigTimer = setTimeout(flushSaveConfig, 250);
    }
  }

  function findActiveShell() {
    const all = Array.from(document.querySelectorAll('.agy-shell'));
    if (all.length <= 1) return all[0] || null;
    let best = all[0];
    let bestArea = 0;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function compressAvatarFile(file, callback) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const size = 192;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          const natW = img.naturalWidth || size;
          const natH = img.naturalHeight || size;
          const side = Math.min(natW, natH);
          const sx = Math.max(0, Math.floor((natW - side) / 2));
          const sy = Math.max(0, Math.floor((natH - side) / 2));
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          const out = canvas.toDataURL('image/webp', 0.88);
          callback(out && out.startsWith('data:image/webp') ? out : canvas.toDataURL('image/png'));
        } catch (_) {
          callback(String(reader.result || ''));
        }
      };
      img.onerror = () => callback(String(reader.result || ''));
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  }

  // --------------------------------------------------------------------------
  // 1. Pre-baked L-shaped Unified Glass (Zero Live Backdrop Blur = 60/120 FPS)
  // --------------------------------------------------------------------------
  function syncPrebakedGlass(wpUrl, overlayRgb, overlayAlpha, tintBg, blurPx) {
    const shell = findActiveShell();
    if (!wpUrl) {
      if (shell) shell.style.removeProperty('--ats-l-glass-bg');
      return;
    }
    const key = `${wpUrl.slice(0, 64)}|${wpUrl.length}|${overlayRgb}|${overlayAlpha.toFixed(3)}|${tintBg}|${blurPx}`;
    window.__ATS_BLUR_CACHE__ = window.__ATS_BLUR_CACHE__ || {};
    const cached = window.__ATS_BLUR_CACHE__[key];
    if (cached) {
      if (shell) shell.style.setProperty('--ats-l-glass-bg', `url("${cached}")`);
      return;
    }

    const img = new Image();
    if (!/^(?:data|blob|file):/i.test(wpUrl)) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      try {
        const w = 640;
        const h = Math.max(180, Math.round((img.naturalHeight || 1440) * (w / Math.max(1, img.naturalWidth || 2560))));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const scaledBlur = Math.max(0, Math.min(16, Math.round((Number(blurPx) || 0) * 0.75)));
        ctx.filter = scaledBlur > 0 ? `blur(${scaledBlur}px)` : 'none';
        ctx.drawImage(img, -12, -12, w + 24, h + 24);
        ctx.filter = 'none';
        ctx.fillStyle = `rgba(${overlayRgb}, ${overlayAlpha})`;
        ctx.fillRect(0, 0, w, h);
        if (tintBg) {
          ctx.fillStyle = tintBg;
          ctx.fillRect(0, 0, w, h);
        }
        const baked = canvas.toDataURL('image/webp', 0.85);
        canvas.width = 0;
        canvas.height = 0;

        const cache = window.__ATS_BLUR_CACHE__;
        cache[key] = baked;
        const keys = Object.keys(cache);
        while (keys.length > 4) delete cache[keys.shift()];
        const curShell = findActiveShell();
        if (curShell) curShell.style.setProperty('--ats-l-glass-bg', `url("${baked}")`);
      } catch (_) {}
    };
    img.src = wpUrl;
  }

  // --------------------------------------------------------------------------
  // 2. Live Background Layer (<ats-live-bg> inside .agy-shell)
  // --------------------------------------------------------------------------
  function releaseVideoDecoder(videoEl) {
    if (!videoEl) return;
    try {
      videoEl.pause();
      videoEl.style.opacity = '0';
      videoEl.style.display = 'none';
      if (videoEl.getAttribute('src') || videoEl.getAttribute('data-src')) {
        videoEl.removeAttribute('src');
        videoEl.removeAttribute('data-src');
        videoEl.load();
      }
    } catch (_) {}
  }

  function isIdeHost() {
    return Boolean(!document.querySelector('.agy-shell') && document.querySelector('.monaco-workbench'));
  }

  function isExtensionWebview() {
    return /[?&]extensionView=true\b/i.test(location.search || '');
  }

  function syncBackgroundLayer(mainTheme, overlayRgb, overlayAlpha) {
    const ideMode = isIdeHost();
    const mountHost = ideMode ? document.body : findActiveShell();
    if (!mountHost) return;

    let layer = document.getElementById('ats-live-bg-layer');
    if (layer && (layer.tagName !== 'ATS-LIVE-BG' || layer.parentElement !== mountHost)) {
      releaseVideoDecoder(layer.querySelector('video'));
      layer.remove();
      layer = null;
    }

    if (!state.wpEnabled || state.mode === 'gradient') {
      if (layer) {
        releaseVideoDecoder(layer.querySelector('video'));
        layer.classList.add('ats-bg-hidden');
      }
      return;
    }

    if (!layer) {
      layer = document.createElement('ats-live-bg');
      layer.id = 'ats-live-bg-layer';
      const v = document.createElement('video');
      v.id = 'ats-live-bg-video';
      v.autoplay = true;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      const im = document.createElement('img');
      im.id = 'ats-live-bg-img';
      im.alt = '';
      const sc = document.createElement('div');
      sc.id = 'ats-live-scrim';
      layer.append(v, im, sc);
      mountHost.insertBefore(layer, mountHost.firstChild);
    }

    const videoEl = layer.querySelector('#ats-live-bg-video');
    const imgEl = layer.querySelector('#ats-live-bg-img');
    const scrimEl = layer.querySelector('#ats-live-scrim');
    const bgPos = state.bgPosition || mainTheme.bgPosition || 'center center';

    if (scrimEl) {
      scrimEl.style.background = `linear-gradient(180deg, rgba(${overlayRgb}, ${overlayAlpha}) 0%, rgba(${overlayRgb}, ${overlayAlpha}) 100%)`;
    }
    if (videoEl) videoEl.style.objectPosition = bgPos;
    if (imgEl) imgEl.style.objectPosition = bgPos;

    const rawVideo = state.activeVideo || mainTheme.wallpaperVideo || '';
    const rawImage = state.activeImage || mainTheme.wallpaper || '';
    const videoUrl = (ideMode && window.__ATS_INLINE_VIDEO__) ? window.__ATS_INLINE_VIDEO__ : resolveMediaUrl(rawVideo);
    const imageUrl = (ideMode && window.__ATS_INLINE_IMAGE__) ? window.__ATS_INLINE_IMAGE__ : resolveMediaUrl(rawImage);

    if (state.mode === 'video' && videoUrl) {
      layer.classList.remove('ats-bg-hidden');
      if (imgEl) {
        imgEl.style.display = 'none';
        imgEl.removeAttribute('src');
        imgEl.removeAttribute('data-src');
      }
      if (videoEl) {
        videoEl.style.display = 'block';
        if (!/^(?:data|blob|file):/i.test(videoUrl)) videoEl.crossOrigin = 'anonymous';
        else videoEl.removeAttribute('crossorigin');

        const markReady = () => {
          videoEl.style.opacity = '1';
          if (scrimEl) scrimEl.style.opacity = '1';
        };
        if (videoEl.readyState >= 2) markReady();

        if (videoEl.getAttribute('data-src') !== videoUrl) {
          videoEl.style.opacity = '0';
          if (scrimEl) scrimEl.style.opacity = '0';
          videoEl.setAttribute('data-src', videoUrl);
          videoEl.onloadeddata = () => {
            markReady();
            try {
              const c = document.createElement('canvas');
              c.width = 480;
              c.height = Math.max(240, Math.round(480 * ((videoEl.videoHeight || 1080) / Math.max(1, videoEl.videoWidth || 1920))));
              const gctx = c.getContext('2d');
              if (gctx) {
                gctx.drawImage(videoEl, 0, 0, c.width, c.height);
                syncPrebakedGlass(c.toDataURL('image/webp', 0.82), overlayRgb, overlayAlpha, mainTheme.headerBg || '', state.glassBlur);
              }
            } catch (_) {}
          };
          videoEl.onplaying = markReady;
          videoEl.onerror = () => {
            videoEl.style.opacity = '0';
            if (isIdeHost()) {
              bgStatusError = true;
              bgStatusText = 'Antigravity IDE không hỗ trợ codec H.264 (.mp4). Hãy dùng video .webm hoặc Ảnh tĩnh (.png/.jpg/.webp) cho bản IDE.';
            }
            // Graceful fallback: show activeImage if available, otherwise hide layer so pureBg gradient shines through
            if (imageUrl && imgEl) {
              imgEl.style.display = 'block';
              if (imgEl.getAttribute('data-src') !== imageUrl) {
                imgEl.setAttribute('data-src', imageUrl);
                imgEl.src = imageUrl;
              }
              if (scrimEl) scrimEl.style.opacity = '1';
            } else {
              if (scrimEl) scrimEl.style.opacity = '0';
              layer.classList.add('ats-bg-hidden');
            }
          };
          videoEl.src = videoUrl;
          videoEl.load();
          videoEl.play().catch(() => {});
        } else if (videoEl.paused) {
          videoEl.play().catch(() => {});
        }
      }
    } else if (state.mode === 'image' && imageUrl) {
      releaseVideoDecoder(videoEl);
      layer.classList.remove('ats-bg-hidden');
      if (scrimEl) scrimEl.style.opacity = '1';
      if (imgEl) {
        imgEl.style.display = 'block';
        if (imgEl.getAttribute('data-src') !== imageUrl) {
          imgEl.setAttribute('data-src', imageUrl);
          imgEl.src = imageUrl;
        }
      }
    } else {
      releaseVideoDecoder(videoEl);
      if (imgEl) imgEl.style.display = 'none';
      layer.classList.add('ats-bg-hidden');
    }
  }

  // --------------------------------------------------------------------------
  // 3. Dynamic Theme Stylesheet & Electron Titlebar Overlay
  // --------------------------------------------------------------------------
  function syncTitleBarOverlay() {
    const mainTheme = PRESETS[state.preset] || PRESETS[DEFAULT_PRESET_KEY] || {};
    if (window.electronNative && typeof window.electronNative.setTitleBarOverlay === 'function') {
      try {
        window.electronNative.setTitleBarOverlay({
          color: state.wpEnabled ? '#00000000' : '#111114',
          symbolColor: (state.wpEnabled && mainTheme.isLight) ? '#0f172a' : '#f8fafc'
        });
      } catch (_) {}
    }
  }

  function clearTitleBarTimers() {
    if (Array.isArray(window.__ATS_TBO_TIMERS__)) {
      window.__ATS_TBO_TIMERS__.forEach((id) => clearTimeout(id));
    }
    window.__ATS_TBO_TIMERS__ = [];
  }

  function scheduleTitleBarSync() {
    clearTitleBarTimers();
    syncTitleBarOverlay();
    [300, 900, 2000, 4500].forEach((ms) => {
      window.__ATS_TBO_TIMERS__.push(setTimeout(syncTitleBarOverlay, ms));
    });
  }

  function injectStaticStyles() {
    let el = document.getElementById('ats-static-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'ats-static-style';
      document.head.appendChild(el);
    }
    el.textContent = STATIC_CSS;
  }

  function applyTheme() {
    injectStaticStyles();

    const mainTheme = PRESETS[state.preset] || PRESETS[DEFAULT_PRESET_KEY] || {};
    const bubbleTheme = PRESETS[state.bubblePreset] || mainTheme;
    const primary = state.primaryOverride || mainTheme.primary || '#38bdf8';
    const secondary = mainTheme.secondary || '#818cf8';
    const glow = mainTheme.glow || 'rgba(56, 189, 248, 0.28)';
    const borderColor = mainTheme.borderColor || 'rgba(56, 189, 248, 0.36)';
    const overlayRgb = mainTheme.overlayRgb || '6, 10, 18';
    const overlayAlpha = Math.min(0.92, Math.max(0, Number(state.dimOpacity ?? mainTheme.dimOpacity ?? 0.45)));
    const bgPosition = state.bgPosition || mainTheme.bgPosition || 'center center';
    const isLight = Boolean(mainTheme.isLight);

    const ideHost = isIdeHost();
    const wpImageUrl = (ideHost && window.__ATS_INLINE_IMAGE__)
      ? window.__ATS_INLINE_IMAGE__
      : resolveMediaUrl(state.activeImage || mainTheme.wallpaper || '');
    const wpVideoUrl = (ideHost && window.__ATS_INLINE_VIDEO__)
      ? window.__ATS_INLINE_VIDEO__
      : resolveMediaUrl(state.activeVideo || mainTheme.wallpaperVideo || '');
    const isVideoMode = Boolean(state.wpEnabled && state.mode === 'video' && wpVideoUrl);
    const isImageMode = Boolean(state.wpEnabled && state.mode === 'image' && wpImageUrl);

    const root = document.documentElement;
    root.style.setProperty('--ats-primary', primary);
    root.style.setProperty('--ats-secondary', secondary);
    root.style.setProperty('--ats-glow', glow);
    root.style.setProperty('--ats-border-color', borderColor);
    root.style.setProperty('--ats-modal-bg', mainTheme.modalBg || 'rgba(9, 13, 24, 0.96)');
    root.style.setProperty('--ats-modal-header-bg', mainTheme.modalHeaderBg || 'rgba(14, 21, 38, 0.88)');
    root.style.setProperty('--ats-card-bg', mainTheme.cardBg || 'rgba(13, 19, 34, 0.82)');
    root.style.setProperty('--ats-card-selected-bg', mainTheme.cardSelectedBg || 'rgba(22, 38, 66, 0.78)');

    const uiInk = isLight ? '#0f172a' : 'rgba(248, 250, 252, 0.96)';
    const uiMutedInk = isLight ? '#334155' : 'rgba(226, 232, 240, 0.86)';
    const uiShadow = isLight ? 'none' : '0 1px 4px rgba(0, 0, 0, 0.88)';
    const pillBg = isLight ? 'rgba(255, 255, 255, 0.82)' : 'rgba(8, 13, 28, 0.78)';
    const pillHoverBg = isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(14, 23, 46, 0.92)';
    const pillText = isLight ? '#0f172a' : '#f8fafc';
    const pillBorder = isLight ? 'rgba(15, 23, 42, 0.16)' : 'rgba(255, 255, 255, 0.16)';
    const preCodeBg = isLight ? `rgba(${overlayRgb}, 0.78)` : `rgba(${overlayRgb}, 0.56)`;

    const extWebview = isExtensionWebview();
    if (extWebview) {
      const exact = window.__ATS_EXT_RECT__;
      if (exact && Number.isFinite(exact.wbW) && Number.isFinite(exact.wbH)) {
        root.style.setProperty('--ats-ext-parent-w', `${exact.wbW}px`);
        root.style.setProperty('--ats-ext-parent-h', `${exact.wbH}px`);
        root.style.setProperty('--ats-ext-top', `${-exact.top}px`);
        root.style.setProperty('--ats-ext-left', `${-exact.left}px`);
        root.style.setProperty('--ats-ext-right', 'auto');
      } else {
        const pw = Math.max(window.innerWidth, window.outerWidth || 0);
        const ph = Math.max(window.innerHeight + 57, window.outerHeight || 0);
        const isVscodeExt = (ph - window.innerHeight) > 80 || /Visual\+Studio\+Code/i.test(location.search || '');
        root.style.setProperty('--ats-ext-parent-w', `${pw}px`);
        root.style.setProperty('--ats-ext-parent-h', `${ph}px`);
        root.style.setProperty('--ats-ext-top', isVscodeExt ? '-68px' : '-35px');
        root.style.setProperty('--ats-ext-left', 'auto');
        root.style.setProperty('--ats-ext-right', isVscodeExt ? '-6px' : '0px');
      }
    }
    const pureBg = mainTheme.pureBg || 'radial-gradient(circle at 20% 20%, #0f172a 0%, #020617 70%)';
    const bgLayers = extWebview
      ? 'none'
      : (isImageMode
          ? `linear-gradient(180deg, rgba(${overlayRgb}, ${overlayAlpha}) 0%, rgba(${overlayRgb}, ${overlayAlpha}) 100%), url("${sanitizeCssUrl(wpImageUrl)}")`
          : pureBg);

    const useUnifiedGlass = Boolean(state.wpEnabled && mainTheme.unifiedGlass && (isVideoMode || isImageMode));
    if (useUnifiedGlass && isImageMode) {
      syncPrebakedGlass(wpImageUrl, overlayRgb, overlayAlpha, mainTheme.headerBg || '', state.glassBlur);
    } else if (!isVideoMode) {
      syncPrebakedGlass(null);
    }

    syncBackgroundLayer(mainTheme, overlayRgb, overlayAlpha);
    syncShellMetrics();

    const inputCardBg = state.inputStyle === 'glass'
      ? (bubbleTheme.inputGlassBg || 'rgba(10, 15, 28, 0.56)')
      : state.inputStyle === 'double_gold'
        ? 'linear-gradient(145deg, rgba(44, 28, 20, 0.90) 0%, rgba(24, 15, 12, 0.92) 100%)'
        : (bubbleTheme.inputCardBg || 'rgba(12, 18, 32, 0.88)');

    const inputOuterBorder = state.inputStyle === 'double_gold'
      ? 'linear-gradient(135deg, #f59e0b 0%, rgba(217, 119, 6, 0.35) 50%, #fbbf24 100%)'
      : state.inputStyle === 'minimal'
        ? 'rgba(148, 163, 184, 0.24)'
        : (state.primaryOverride
            ? `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`
            : (bubbleTheme.frameBg || `linear-gradient(135deg, ${primary}, ${secondary})`));

    const bubbleFrameBg = state.primaryOverride
      ? `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`
      : (bubbleTheme.frameBg || `linear-gradient(135deg, ${primary}, ${secondary})`);

    const avSize = Math.min(52, Math.max(22, Number(state.avatarSize) || 32));
    const avAgentSize = Math.max(22, avSize - 2);
    const avRadius = Math.min(50, Math.max(0, Number.isFinite(Number(state.avatarRadius)) ? Number(state.avatarRadius) : 50));

    const avatarCss = `
      ${state.userAvatar ? `
      .agy-shell [data-testid="user-message"] {
        position: relative !important;
        padding-right: ${avSize + 10}px !important;
      }
      .agy-shell [data-testid="user-message"]::after {
        content: "";
        position: absolute;
        right: 0;
        bottom: 6px;
        width: ${avSize}px;
        height: ${avSize}px;
        border-radius: ${avRadius}%;
        background-image: url("${sanitizeCssUrl(state.userAvatar)}");
        background-size: cover;
        background-position: center;
        border: 1.5px solid ${primary};
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4), 0 0 8px ${glow};
        pointer-events: none;
      }` : ''}
      ${state.agentAvatar ? `
      .agy-shell [data-testid="agent-response"] {
        position: relative !important;
        padding-left: ${avAgentSize + 22}px !important;
        min-height: ${avAgentSize + 20}px !important;
      }
      .agy-shell [data-testid="agent-response"]::before {
        content: "";
        position: absolute;
        top: 12px;
        left: 12px;
        width: ${avAgentSize}px;
        height: ${avAgentSize}px;
        border-radius: ${avRadius}%;
        background-image: url("${sanitizeCssUrl(state.agentAvatar)}");
        background-size: cover;
        background-position: center;
        border: 1.5px solid ${secondary};
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4), 0 0 8px ${glow};
        pointer-events: none;
      }` : ''}
    `;

    let styleEl = document.getElementById('ats-active-theme');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'ats-active-theme';
      document.head.appendChild(styleEl);
    }

    styleEl.textContent = `
      ${state.wpEnabled ? `
      .agy-shell {
        position: relative !important;
        background-image: ${bgLayers} !important;
        background-size: cover !important;
        background-position: ${bgPosition} !important;
        background-repeat: no-repeat !important;
      }
      .agy-shell > :not(#ats-live-bg-layer):not([data-has-browser-hole="true"]) {
        position: relative;
        z-index: 2;
      }
      .agy-shell > div:first-of-type {
        position: relative !important;
        z-index: 3 !important;
      }
      .agy-shell .overflow-y-auto {
        will-change: scroll-position;
        backdrop-filter: none !important;
      }
      .agy-sheet,
      .agy-inset-shell,
      .browser-hole-opaque,
      [data-main-content-body="true"],
      [data-side-panel-body="true"],
      [class*="agy-inset-shell"],
      [class*="--shell-canvas"],
      .agy-shell div.absolute.bottom-0.pointer-events-none,
      .agy-shell [class*="z-50"] .pointer-events-none.right-full,
      .agy-shell .bg-background:not(.settings-modal-container):not(.settings-modal-container *):not(#ats-modal-backdrop *) {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
      }
      /* Split-browser hole cutout so live BrowserView & its close/URL bar are never covered */
      body[data-has-browser-hole="true"] .agy-shell[data-ats-hole-active="1"] {
        background: transparent !important;
        background-image: none !important;
      }
      ${isVideoMode ? '' : `
      body[data-has-browser-hole="true"] .agy-shell[data-ats-hole-active="1"]::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background-image: ${bgLayers};
        background-size: cover;
        background-position: ${bgPosition};
        background-repeat: no-repeat;
        clip-path: var(--ats-hole-clip, none);
        will-change: transform;
      }`}
      body[data-has-browser-hole="true"] .agy-shell[data-ats-hole-active="1"] > #ats-live-bg-layer {
        clip-path: var(--ats-hole-clip, none) !important;
      }
      body[data-has-browser-hole="true"] .agy-shell[data-ats-hole-active="1"] > :not([data-has-browser-hole="true"]):not([data-browser-hole]:not([data-browser-hole="false"])):not(.settings-modal-container),
      body[data-has-browser-hole="true"] .agy-shell[data-ats-hole-active="1"] .browser-hole-opaque:not([data-has-browser-hole="true"]),
      body[data-has-browser-hole="true"] .agy-shell[data-ats-hole-active="1"] [data-pane-id]:not([data-has-browser-hole="true"]),
      body[data-has-browser-hole="true"] .agy-shell[data-ats-hole-active="1"] [data-tiling-pane]:not([data-has-browser-hole="true"]) {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
      }
      /* Keep browser/side-panel header bar (URL + Close button) always visible & clickable above background layers */
      .agy-shell [data-side-panel-strip],
      .agy-shell [data-main-content-header] {
        position: relative !important;
        z-index: 20 !important;
      }
      body[data-has-browser-hole="true"] .agy-shell [data-side-panel-strip],
      body[data-has-browser-hole="true"] .agy-shell [data-main-content-header] {
        background: ${mainTheme.headerBg || 'rgba(8, 12, 22, 0.72)'} !important;
        color: ${uiInk} !important;
      }
      .agy-shell [data-side-panel-strip] button,
      .agy-shell [data-side-panel-strip] svg {
        color: ${uiInk} !important;
        opacity: 1 !important;
      }
      ` : `
      .agy-shell {
        background: #111113 !important;
      }`}

      /* Live Background Layer */
      .agy-shell > #ats-live-bg-layer,
      #ats-live-bg-layer {
        display: block !important;
        position: ${extWebview ? 'fixed' : 'absolute'} !important;
        ${extWebview ? `
        top: var(--ats-ext-top, -35px) !important;
        left: var(--ats-ext-left, auto) !important;
        right: var(--ats-ext-right, 0px) !important;
        bottom: auto !important;
        width: var(--ats-ext-parent-w, 100vw) !important;
        height: var(--ats-ext-parent-h, 100vh) !important;
        ` : `
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
        `}
        z-index: 0 !important;
        pointer-events: none !important;
        overflow: hidden !important;
      }
      #ats-live-bg-layer.ats-bg-hidden {
        display: none !important;
      }
      #ats-live-bg-video,
      #ats-live-bg-img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: none;
        transform: translateZ(0);
      }
      #ats-live-bg-video {
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      #ats-live-scrim {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 2;
        opacity: 0;
        transition: opacity 0.25s ease;
      }

      /* Unified L-shaped Glass for Header + Sidebar (Zero live backdrop-filter) */
      ${useUnifiedGlass ? `
      .agy-shell::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        background-color: ${isVideoMode ? (mainTheme.sidebarBg || 'rgba(8, 12, 22, 0.32)') : (mainTheme.headerBg || 'rgba(8, 12, 22, 0.30)')};
        background-image: ${isVideoMode ? 'none' : 'var(--ats-l-glass-bg, none)'};
        background-size: cover;
        background-position: ${bgPosition};
        background-repeat: no-repeat;
        backdrop-filter: none !important;
        will-change: transform;
        clip-path: polygon(
          0 0,
          100% 0,
          100% var(--ats-hdr-h, 75px),
          var(--ats-sidebar-w, 256px) var(--ats-hdr-h, 75px),
          var(--ats-sidebar-w, 256px) 100%,
          0 100%
        );
      }
      .agy-shell[data-ats-side-glass="1"]::before {
        clip-path: polygon(
          evenodd,
          0 0,
          100% 0,
          100% var(--ats-hdr-h, 75px),
          var(--ats-sidebar-w, 256px) var(--ats-hdr-h, 75px),
          var(--ats-sidebar-w, 256px) 100%,
          0 100%,
          0 0,
          var(--ats-side-l, 100%) var(--ats-side-t, 75px),
          var(--ats-side-r, 100%) var(--ats-side-t, 75px),
          var(--ats-side-r, 100%) var(--ats-side-b, 100%),
          var(--ats-side-l, 100%) var(--ats-side-b, 100%),
          var(--ats-side-l, 100%) var(--ats-side-t, 75px)
        ) !important;
      }
      .agy-shell [class*="@container/titlebar"],
      .agy-shell aside,
      .agy-shell [data-sidebar="true"],
      .agy-shell .bg-sidebar {
        background: transparent !important;
        backdrop-filter: none !important;
      }
      ` : `
      .agy-shell [class*="@container/titlebar"] {
        background: ${mainTheme.headerBg || 'rgba(8, 12, 22, 0.55)'} !important;
        backdrop-filter: none !important;
      }
      .agy-shell aside,
      .agy-shell [data-sidebar="true"],
      .agy-shell .bg-sidebar {
        background: ${mainTheme.sidebarBg || 'rgba(8, 12, 22, 0.62)'} !important;
        backdrop-filter: none !important;
      }
      `}

      .agy-shell [class*="@container/titlebar"] {
        border-bottom: 1px solid ${mainTheme.headerBorder || 'rgba(56, 189, 248, 0.14)'} !important;
      }
      .agy-shell [class*="@container/titlebar"] [data-testid="breadcrumb-segment"],
      .agy-shell [class*="@container/titlebar"] [data-testid="pane-titlebar-toolbar"] button,
      .agy-shell [class*="@container/titlebar"] [data-testid="pane-titlebar-toolbar"] span {
        color: ${uiInk} !important;
        text-shadow: ${uiShadow};
      }
      .agy-shell .bg-sidebar .bg-sidebar,
      .agy-shell [data-sidebar="true"] .bg-sidebar,
      .agy-shell .bg-sidebar [class*="group/headerbtn"],
      .agy-shell .bg-sidebar [class*="group/section-header"] {
        background: transparent !important;
        backdrop-filter: none !important;
      }
      .agy-shell .bg-sidebar [class*="group/headerbtn"]:hover,
      .agy-shell .bg-sidebar a:hover {
        background: ${mainTheme.sidebarHoverBg || 'rgba(56, 189, 248, 0.14)'} !important;
      }
      ${(mainTheme.sidebarEnhanceText || isLight) ? `
      .agy-shell .bg-sidebar a,
      .agy-shell .bg-sidebar span,
      .agy-shell .bg-sidebar button {
        color: ${isLight ? uiInk : 'inherit'};
        text-shadow: ${isLight ? 'none' : '0 1px 3px rgba(0, 0, 0, 0.85)'};
      }
      .agy-shell .bg-sidebar .text-muted-foreground,
      .agy-shell .bg-sidebar .text-secondary-foreground {
        color: ${uiMutedInk} !important;
      }` : ''}

      /* Agent Response Reading Card + Markdown Table Scroll Safety */
      .agy-shell [data-testid="agent-response"] {
        background: ${mainTheme.aiCardBg || 'rgba(9, 14, 26, 0.70)'} !important;
        ${isLight ? `color: ${uiInk} !important;` : ''}
        backdrop-filter: none !important;
        border: 1px solid ${mainTheme.aiCardBorder || 'rgba(148, 163, 184, 0.18)'} !important;
        border-radius: 14px !important;
        padding: 12px 16px !important;
        box-shadow: ${isLight ? '0 4px 14px rgba(15, 23, 42, 0.08)' : '0 4px 16px rgba(0, 0, 0, 0.32)'} !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
      }
      ${isLight ? `
      .agy-shell [data-main-content-body="true"],
      .agy-shell [data-testid="agent-response"] :is(p, li, span, code, h1, h2, h3, h4, strong, td, th) {
        color: ${uiInk};
      }` : ''}
      .agy-shell [data-testid="agent-response"] .md-table-bleed,
      .agy-shell [data-testid="agent-response"] .md-table-host {
        width: 100% !important;
        max-width: 100% !important;
        margin-inline: 0 !important;
        transform: none !important;
      }
      .agy-shell [data-testid="agent-response"] .md-table-scroll,
      .agy-shell [data-testid="agent-response"] :has(> table):not(.md-table-frame) {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
      }

      /* Right-side Artifact / Diff Panel */
      body:not([data-has-browser-hole="true"]) .agy-shell [data-side-panel-body="true"]:not([data-has-browser-hole="true"]):not(:has([data-browser-hole]:not([data-browser-hole="false"]))) {
        background: ${mainTheme.aiCardBg || `rgba(${overlayRgb}, 0.72)`} !important;
        ${isLight ? `color: ${uiInk} !important;` : ''}
        backdrop-filter: none !important;
        border-left: 1px solid ${mainTheme.aiCardBorder || 'rgba(148, 163, 184, 0.16)'} !important;
      }
      body:not([data-has-browser-hole="true"]) .agy-shell [data-side-panel-body="true"] pre {
        background: ${preCodeBg} !important;
        border-radius: 10px !important;
      }

      /* User Chat Bubble Double-Border Frame */
      .agy-user-bubble-frame {
        background: ${bubbleFrameBg} !important;
        border-radius: 14px !important;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.42), 0 0 12px ${bubbleTheme.glow || glow} !important;
        padding: 1.2px !important;
      }
      .agy-user-bubble {
        background: ${bubbleTheme.bg || 'rgba(10, 16, 30, 0.86)'} !important;
        border-radius: 13px !important;
        padding: 8px 16px !important;
        color: ${bubbleTheme.textColor || '#f8fafc'} !important;
        border: ${bubbleTheme.innerBorder || '1px solid rgba(255, 255, 255, 0.08)'} !important;
      }
      .agy-user-bubble * {
        color: ${bubbleTheme.textColor || '#f8fafc'} !important;
      }

      /* Composer Double-Border Frame */
      .surface-composer {
        background: ${inputOuterBorder} !important;
        border-radius: 16px !important;
        padding: 1.5px !important;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45), 0 0 14px ${glow} !important;
      }
      .surface-composer-card {
        background: ${inputCardBg} !important;
        backdrop-filter: none !important;
        border-radius: 14.5px !important;
        border: ${bubbleTheme.innerBorder || '1px solid rgba(255, 255, 255, 0.08)'} !important;
      }

      /* High-Contrast Composer Pills (Adaptive Light / Dark) */
      .surface-composer [data-testid="project-selector-trigger"],
      .surface-composer [data-testid="branch-pill-trigger"],
      .surface-composer [aria-label="Select Environment"],
      .surface-composer > :not(.surface-composer-card) [data-testid="input-box-bottom-toolbar"] button,
      .surface-composer > :not(.surface-composer-card) [data-testid="input-box-bottom-toolbar"] [role="button"] {
        background: ${pillBg} !important;
        color: ${pillText} !important;
        border: 1px solid ${pillBorder} !important;
        border-radius: 9999px !important;
        font-weight: 500 !important;
        box-shadow: 0 1px 6px rgba(0, 0, 0, 0.22) !important;
      }
      .surface-composer [data-testid="project-selector-trigger"]:hover,
      .surface-composer [data-testid="branch-pill-trigger"]:hover,
      .surface-composer [aria-label="Select Environment"]:hover {
        background: ${pillHoverBg} !important;
        border-color: ${borderColor} !important;
      }
      .surface-composer [data-testid="project-selector-trigger"] *,
      .surface-composer [data-testid="branch-pill-trigger"] *,
      .surface-composer [aria-label="Select Environment"] * {
        color: ${pillText} !important;
      }

      /* Settings Modal & Sidebar Studio Button Accent */
      .settings-modal-container {
        background: ${mainTheme.modalBg || 'rgba(9, 13, 24, 0.96)'} !important;
        border: 1px solid ${borderColor} !important;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.72), 0 0 24px ${glow} !important;
        backdrop-filter: none !important;
      }
      #ats-sidebar-btn svg {
        color: ${primary} !important;
      }

      /* Non-destructive Custom Greeting via CSS ::after */
      .agy-shell [data-ats-greeting] {
        font-size: 0 !important;
        line-height: 0 !important;
        color: transparent !important;
        text-shadow: none !important;
      }
      .agy-shell [data-ats-greeting]::after {
        content: attr(data-ats-greeting);
        font-size: clamp(22px, 2.1vw, 28px) !important;
        line-height: 1.42 !important;
        font-weight: 600 !important;
        background: linear-gradient(90deg, ${isLight ? '#0f172a' : '#f8fafc'}, ${primary}, ${secondary});
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        display: block !important;
        text-align: center !important;
        max-width: 820px;
        margin: 0 auto;
        white-space: normal !important;
      }

      ${avatarCss}

      /* ==================================================================
         Antigravity IDE (.monaco-workbench) Dark Glass Engine (Zero Live Blur)
         ================================================================== */
      body.ats-ide-active {
        ${state.wpEnabled ? `
        background-image: ${bgLayers} !important;
        background-size: cover !important;
        background-position: ${bgPosition} !important;
        background-repeat: no-repeat !important;
        ` : 'background: #111113 !important;'}
      }
      body.ats-ide-active > #ats-live-bg-layer {
        position: fixed !important;
        inset: 0 !important;
        z-index: 0 !important;
      }
      body.ats-ide-active .monaco-workbench {
        background: transparent !important;
        background-color: transparent !important;
        z-index: 1 !important;
        --vscode-editor-background: transparent !important;
        --vscode-editorGroup-emptyBackground: transparent !important;
        --vscode-sideBar-background: rgba(8, 12, 22, 0.32) !important;
        --vscode-sideBarSectionHeader-background: rgba(8, 12, 22, 0.24) !important;
        --vscode-activityBar-background: rgba(8, 12, 22, 0.42) !important;
        --vscode-panel-background: rgba(9, 14, 26, 0.68) !important;
        --vscode-statusBar-background: rgba(8, 12, 22, 0.58) !important;
        --vscode-statusBar-noFolderBackground: rgba(8, 12, 22, 0.58) !important;
        --vscode-titleBar-activeBackground: rgba(8, 12, 22, 0.52) !important;
        --vscode-titleBar-inactiveBackground: rgba(8, 12, 22, 0.62) !important;
        --vscode-editorGroupHeader-tabsBackground: rgba(8, 12, 22, 0.38) !important;
      }
      ${state.wpEnabled ? `
      body.ats-ide-active .monaco-workbench .monaco-grid-view,
      body.ats-ide-active .monaco-workbench .monaco-grid-branch-node,
      body.ats-ide-active .monaco-workbench .split-view-container,
      body.ats-ide-active .monaco-workbench .split-view-view,
      body.ats-ide-active .monaco-workbench .part.editor,
      body.ats-ide-active .monaco-workbench .part.editor > .content,
      body.ats-ide-active .monaco-workbench .editor-group-container,
      body.ats-ide-active .monaco-workbench .editor-container,
      body.ats-ide-active .monaco-workbench .editor-group-container.empty,
      body.ats-ide-active .monaco-workbench .editor-group-watermark,
      body.ats-ide-active .monaco-workbench .gettingStartedContainer,
      body.ats-ide-active .monaco-workbench .getting-started-category,
      body.ats-ide-active .monaco-workbench .part.sidebar > .content,
      body.ats-ide-active .monaco-workbench .part.sidebar .pane-body,
      body.ats-ide-active .monaco-workbench .part.sidebar .monaco-list,
      body.ats-ide-active .monaco-workbench .part.sidebar .monaco-list-rows,
      body.ats-ide-active .monaco-workbench .part.auxiliarybar > .content,
      body.ats-ide-active .monaco-workbench .part.auxiliarybar .pane-body,
      body.ats-ide-active .monaco-workbench .part.auxiliarybar .monaco-list,
      body.ats-ide-active .monaco-workbench .part.auxiliarybar .monaco-list-rows {
        background-color: transparent !important;
        background: transparent !important;
      }
      body.ats-ide-active .monaco-workbench .monaco-editor,
      body.ats-ide-active .monaco-workbench .monaco-editor-background,
      body.ats-ide-active .monaco-workbench .monaco-editor .margin,
      body.ats-ide-active .monaco-workbench .monaco-editor .inputarea.ime-input {
        background-color: ${mainTheme.aiCardBg || 'rgba(9, 14, 26, 0.72)'} !important;
        backdrop-filter: none !important;
      }
      body.ats-ide-active .monaco-workbench .part.titlebar {
        background-color: ${mainTheme.headerBg || 'rgba(8, 12, 22, 0.56)'} !important;
        border-bottom: 1px solid ${mainTheme.headerBorder || 'rgba(56, 189, 248, 0.14)'} !important;
        backdrop-filter: none !important;
      }
      body.ats-ide-active .monaco-workbench .part.activitybar {
        background-color: ${mainTheme.headerBg || 'rgba(8, 12, 22, 0.52)'} !important;
        border-right: 1px solid ${mainTheme.headerBorder || 'rgba(56, 189, 248, 0.12)'} !important;
        backdrop-filter: none !important;
      }
      body.ats-ide-active .monaco-workbench .part.sidebar,
      body.ats-ide-active .monaco-workbench .part.auxiliarybar {
        background-color: ${mainTheme.sidebarBg || 'rgba(8, 12, 22, 0.62)'} !important;
        backdrop-filter: none !important;
      }
      body.ats-ide-active .monaco-workbench .part.sidebar .monaco-list-rows,
      body.ats-ide-active .monaco-workbench .part.auxiliarybar .monaco-list-rows {
        background: transparent !important;
      }
      body.ats-ide-active .monaco-workbench .part.panel,
      body.ats-ide-active .monaco-workbench .part.panel .terminal-outer-container,
      body.ats-ide-active .monaco-workbench .part.panel .xterm-viewport {
        background-color: ${mainTheme.aiCardBg || 'rgba(9, 14, 26, 0.74)'} !important;
        backdrop-filter: none !important;
      }
      body.ats-ide-active .monaco-workbench .part.statusbar {
        background-color: ${mainTheme.headerBg || 'rgba(8, 12, 22, 0.68)'} !important;
        border-top: 1px solid ${mainTheme.headerBorder || 'rgba(56, 189, 248, 0.18)'} !important;
        backdrop-filter: none !important;
      }
      body.ats-ide-active .monaco-workbench .tabs-and-actions-container {
        background-color: ${mainTheme.headerBg || 'rgba(8, 12, 22, 0.48)'} !important;
      }
      body.ats-ide-active .monaco-workbench .tabs-container > .tab {
        background-color: transparent !important;
      }
      body.ats-ide-active .monaco-workbench .tabs-container > .tab.active {
        background-color: ${mainTheme.aiCardBg || 'rgba(9, 14, 26, 0.72)'} !important;
        box-shadow: inset 0 -2px 0 ${primary} !important;
      }
      body.ats-ide-active .monaco-workbench .quick-input-widget,
      body.ats-ide-active .monaco-workbench .suggest-widget,
      body.ats-ide-active .monaco-workbench .monaco-hover,
      body.ats-ide-active .monaco-workbench .notifications-toasts .notification-toast {
        background-color: ${mainTheme.modalBg || 'rgba(9, 13, 24, 0.96)'} !important;
        border: 1px solid ${borderColor} !important;
      }
      ` : ''}
    `;

    document.body.classList.add('ats-active');
    document.body.classList.toggle('ats-ide-active', isIdeHost());
    syncTitleBarOverlay();
    scheduleTitleBarSync();
    syncEmptyGreeting();
  }

  // --------------------------------------------------------------------------
  // 4. Shell Metrics & Split-Browser Hole Cutout
  // --------------------------------------------------------------------------
  window.__ATS_APPLY_EXT_RECT__ = (rect) => {
    if (!rect || !Number.isFinite(rect.wbW) || !Number.isFinite(rect.wbH)) return;
    window.__ATS_EXT_RECT__ = rect;
    const root = document.documentElement;
    root.style.setProperty('--ats-ext-parent-w', `${rect.wbW}px`);
    root.style.setProperty('--ats-ext-parent-h', `${rect.wbH}px`);
    root.style.setProperty('--ats-ext-top', `${-rect.top}px`);
    root.style.setProperty('--ats-ext-left', `${-rect.left}px`);
    root.style.setProperty('--ats-ext-right', 'auto');
  };

  function syncShellMetrics() {
    if (isExtensionWebview()) {
      if (window.__ATS_EXT_RECT__) {
        window.__ATS_APPLY_EXT_RECT__(window.__ATS_EXT_RECT__);
      } else {
        const pw = Math.max(window.innerWidth, window.outerWidth || 0);
        const ph = Math.max(window.innerHeight + 57, window.outerHeight || 0);
        const isVscodeExt = (ph - window.innerHeight) > 80 || /Visual\+Studio\+Code/i.test(location.search || '');
        document.documentElement.style.setProperty('--ats-ext-parent-w', `${pw}px`);
        document.documentElement.style.setProperty('--ats-ext-parent-h', `${ph}px`);
        document.documentElement.style.setProperty('--ats-ext-top', isVscodeExt ? '-68px' : '-35px');
        document.documentElement.style.setProperty('--ats-ext-left', 'auto');
        document.documentElement.style.setProperty('--ats-ext-right', isVscodeExt ? '-6px' : '0px');
      }
      return;
    }
    if (isIdeHost()) {
      const wv = document.querySelector('iframe.webview');
      if (wv && typeof window.atsReportWebviewRect === 'function') {
        const r = wv.getBoundingClientRect();
        if (r.width > 20 && r.height > 20) {
          const rect = {
            left: Math.round(r.left),
            top: Math.round(r.top),
            wbW: Math.round(window.innerWidth),
            wbH: Math.round(window.innerHeight)
          };
          const sig = `${rect.left}|${rect.top}|${rect.wbW}|${rect.wbH}`;
          if (window.__ATS_LAST_RECT_SIG__ !== sig) {
            window.__ATS_LAST_RECT_SIG__ = sig;
            try { window.atsReportWebviewRect(JSON.stringify(rect)); } catch (_) {}
          }
        }
      }
      return;
    }
    const shell = findActiveShell();
    if (!shell) return;
    const split = shell.querySelector('[data-testid="sidebar-split"]');
    const sidebarPane = split ? split.firstElementChild : null;
    const titleBar = shell.querySelector('[class*="@container/titlebar"]');
    const sw = sidebarPane ? Math.round(sidebarPane.getBoundingClientRect().width) : 0;
    const shellRect = shell.getBoundingClientRect();
    const hdrBottom = titleBar ? Math.round(titleBar.getBoundingClientRect().bottom - shellRect.top) : 35;

    shell.style.setProperty('--ats-sidebar-w', `${sw}px`);
    shell.style.setProperty('--ats-hdr-h', `${hdrBottom}px`);

    const hasHoleAttr = document.body.getAttribute('data-has-browser-hole') === 'true';
    const holeEl = hasHoleAttr ? shell.querySelector('[data-browser-hole]:not([data-browser-hole="false"])') : null;
    if (holeEl) {
      if (window.__ATS_SHELL_RO__ && window.__ATS_HOLE_EL__ !== holeEl) {
        try { window.__ATS_SHELL_RO__.observe(holeEl); } catch (_) {}
        window.__ATS_HOLE_EL__ = holeEl;
      }
      const hRect = holeEl.getBoundingClientRect();
      if (hRect.width > 1 && hRect.height > 1) {
        const l = Math.max(0, Math.round(hRect.left - shellRect.left));
        const t = Math.max(0, Math.round(hRect.top - shellRect.top));
        const r = Math.max(l, Math.round(hRect.right - shellRect.left));
        const b = Math.max(t, Math.round(hRect.bottom - shellRect.top));
        shell.style.setProperty(
          '--ats-hole-clip',
          `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px, ${l}px ${t}px)`
        );
        shell.dataset.atsHoleActive = '1';
        delete shell.dataset.atsSideGlass;
        return;
      }
    }
    window.__ATS_HOLE_EL__ = null;
    delete shell.dataset.atsHoleActive;
    shell.style.removeProperty('--ats-hole-clip');

    const sideBody = shell.querySelector('[data-side-panel-body="true"]');
    if (sideBody) {
      if (window.__ATS_SHELL_RO__ && window.__ATS_SIDE_EL__ !== sideBody) {
        try { window.__ATS_SHELL_RO__.observe(sideBody); } catch (_) {}
        window.__ATS_SIDE_EL__ = sideBody;
      }
      const sRect = sideBody.getBoundingClientRect();
      if (sideBody.children.length > 0 && sRect.width > 24 && sRect.height > 24) {
        const sl = Math.max(sw, Math.round(sRect.left - shellRect.left));
        const st = Math.max(hdrBottom, Math.round(sRect.top - shellRect.top));
        const sr = Math.min(Math.round(shellRect.width), Math.max(sl, Math.round(sRect.right - shellRect.left)));
        const sb = Math.min(Math.round(shellRect.height), Math.max(st, Math.round(sRect.bottom - shellRect.top)));
        if (sr - sl > 20 && sb - st > 20) {
          shell.style.setProperty('--ats-side-l', `${sl}px`);
          shell.style.setProperty('--ats-side-t', `${st}px`);
          shell.style.setProperty('--ats-side-r', `${sr}px`);
          shell.style.setProperty('--ats-side-b', `${sb}px`);
          shell.dataset.atsSideGlass = '1';
          return;
        }
      }
    }
    delete shell.dataset.atsSideGlass;
  }

  function hookShellMetrics() {
    const shell = findActiveShell();
    if (!shell) return;
    if (!window.__ATS_SHELL_RO__ && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(syncShellMetrics);
      ro.observe(shell);
      const sidebarPane = shell.querySelector('[data-testid="sidebar-split"]')?.firstElementChild;
      if (sidebarPane) ro.observe(sidebarPane);
      window.__ATS_SHELL_RO__ = ro;
    }
    syncShellMetrics();
  }

  // --------------------------------------------------------------------------
  // 5. Task Completion Audio Engine (Random Custom Voices + Built-in Chime)
  // --------------------------------------------------------------------------
  const taskAudioState = window.__ATS_TASK_AUDIO_STATE__ || (window.__ATS_TASK_AUDIO_STATE__ = {
    wasRunning: false,
    startedRunningAt: 0,
    lastCompletedAt: 0,
    lastUrl: location.href,
    urlChangedAt: 0,
    userCancelledAt: 0,
    lastPlayedUrl: ''
  });

  function stopTaskAudio() {
    const audio = window.__ATS_TASK_AUDIO__;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (_) {}
      window.__ATS_TASK_AUDIO__ = null;
    }
  }

  function playBuiltInChime(volume = 0.75) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.075);
        gain.gain.setValueAtTime(0.0001, now + idx * 0.075);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.01, volume * 0.22), now + idx * 0.075 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.075 + 0.38);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.075);
        osc.stop(now + idx * 0.075 + 0.42);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch (_) {}
  }

  function playTaskSound(force = false) {
    if (!force && !state.taskSoundEnabled) return;
    const vol = Math.min(1, Math.max(0, Number(state.taskSoundVolume ?? 0.75)));

    let targetUrl = state.activeAudio;
    if (!targetUrl && Array.isArray(mediaLibrary.audios) && mediaLibrary.audios.length > 0) {
      const pool = mediaLibrary.audios;
      const choices = pool.length > 1
        ? pool.filter((a) => !isSameMediaUrl(a.url, taskAudioState.lastPlayedUrl))
        : pool;
      const picked = choices[Math.floor(Math.random() * choices.length)] || pool[0];
      if (picked && picked.url) {
        targetUrl = picked.url;
        taskAudioState.lastPlayedUrl = targetUrl;
      }
    }

    if (targetUrl) {
      stopTaskAudio();
      try {
        const audio = new Audio(resolveMediaUrl(targetUrl));
        audio.volume = vol;
        window.__ATS_TASK_AUDIO__ = audio;
        const cleanupAudio = () => {
          try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
          } catch (_) {}
          if (window.__ATS_TASK_AUDIO__ === audio) window.__ATS_TASK_AUDIO__ = null;
        };
        audio.addEventListener('ended', cleanupAudio, { once: true });
        audio.addEventListener('error', () => {
          cleanupAudio();
          playBuiltInChime(vol);
        }, { once: true });
        audio.play().catch(() => {
          cleanupAudio();
          playBuiltInChime(vol);
        });
        return;
      } catch (_) {}
    }

    playBuiltInChime(vol);
  }

  function syncTaskCompletionVoice() {
    if (isIdeHost()) return;
    if (location.href !== taskAudioState.lastUrl) {
      taskAudioState.lastUrl = location.href;
      taskAudioState.urlChangedAt = Date.now();
      taskAudioState.wasRunning = false;
      taskAudioState.startedRunningAt = 0;
      if (window.__ATS_TASK_TIMER__) {
        clearTimeout(window.__ATS_TASK_TIMER__);
        window.__ATS_TASK_TIMER__ = null;
      }
      return;
    }

    const shell = findActiveShell();
    if (!shell) return;
    const isRunning = Boolean(shell.querySelector('[data-testid="input-cancel-button"]'));
    if (isRunning) {
      if (window.__ATS_TASK_TIMER__) {
        clearTimeout(window.__ATS_TASK_TIMER__);
        window.__ATS_TASK_TIMER__ = null;
      }
      if (!taskAudioState.wasRunning) {
        taskAudioState.wasRunning = true;
        taskAudioState.startedRunningAt = Date.now();
      }
      return;
    }
    if (!taskAudioState.wasRunning || window.__ATS_TASK_TIMER__) return;

    window.__ATS_TASK_TIMER__ = setTimeout(() => {
      window.__ATS_TASK_TIMER__ = null;
      const curShell = findActiveShell();
      if (!curShell || curShell.querySelector('[data-testid="input-cancel-button"]')) return;
      const runDuration = Date.now() - (taskAudioState.startedRunningAt || 0);
      taskAudioState.wasRunning = false;
      taskAudioState.startedRunningAt = 0;
      const now = Date.now();
      if (runDuration < 600) return;
      if (location.href !== taskAudioState.lastUrl) return;
      if (now - taskAudioState.urlChangedAt < 1500) return;
      if (now - taskAudioState.userCancelledAt < 2200) return;
      if (now - (taskAudioState.lastCompletedAt || 0) < 3000) return;
      if (!curShell.querySelector('[data-testid="agent-response"]')) return;
      taskAudioState.lastCompletedAt = now;
      const base = getMediaBase();
      if (base) {
        fetch(`${base}/api/claim-sound`, { method: 'POST' })
          .then((r) => r.json())
          .then((d) => {
            if (!d || d.allowed !== false) playTaskSound(false);
          })
          .catch(() => playTaskSound(false));
      } else {
        playTaskSound(false);
      }
    }, 900);
  }

  // --------------------------------------------------------------------------
  // 6. Non-Destructive Custom Greeting (CSS attr() so React never conflicts)
  // --------------------------------------------------------------------------
  function pickGreeting() {
    const pool = Array.isArray(state.customGreetings) && state.customGreetings.length
      ? state.customGreetings
      : DEFAULT_GREETINGS;
    const prev = window.__ATS_LAST_GREETING__;
    const choices = pool.length > 1 ? pool.filter((g) => g !== prev) : pool;
    const picked = choices[Math.floor(Math.random() * choices.length)] || pool[0];
    window.__ATS_LAST_GREETING__ = picked;
    return picked;
  }

  function syncEmptyGreeting() {
    const shell = findActiveShell();
    if (!shell) return;
    if (!state.customGreetingEnabled) {
      shell.querySelectorAll('[data-ats-greeting]').forEach((el) => {
        el.removeAttribute('data-ats-greeting');
        delete el.dataset.atsGreetingOrig;
      });
      return;
    }
    const root = shell.querySelector('[data-main-content-body="true"]') || shell;
    if (root.querySelector('[data-testid="agent-response"], .agy-user-bubble-frame')) {
      window.__ATS_GREETING_FRESH__ = true;
      return;
    }
    const candidates = root.querySelectorAll('h1, h2, h3, p, div, span');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.children.length > 0) continue;
      if (el.closest('.surface-composer, [data-testid="agent-response"], .agy-user-bubble-frame, .settings-modal-container, #ats-modal-backdrop, .bg-sidebar, [class*="@container/titlebar"], pre, code, button, input, textarea')) {
        continue;
      }
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 90) continue;
      if (!GREETING_RX.test(txt)) continue;
      if (!el.hasAttribute('data-ats-greeting') || window.__ATS_GREETING_FRESH__ || el.dataset.atsGreetingOrig !== txt) {
        el.dataset.atsGreetingOrig = txt;
        el.setAttribute('data-ats-greeting', pickGreeting());
        window.__ATS_GREETING_FRESH__ = false;
      }
      break;
    }
  }

  // --------------------------------------------------------------------------
  // 7. Boot HUD Sequence + Boot Audio Engine (Built-in Sci-Fi Synth & Custom MP3)
  // --------------------------------------------------------------------------
  function stopBootAudio() {
    const audio = window.__ATS_BOOT_AUDIO__;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (_) {}
      window.__ATS_BOOT_AUDIO__ = null;
    }
    const ctx = window.__ATS_BOOT_CTX__;
    if (ctx) {
      try { ctx.close().catch(() => {}); } catch (_) {}
      window.__ATS_BOOT_CTX__ = null;
    }
  }

  function playBuiltInBootSound(volume = 0.75) {
    stopBootAudio();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      window.__ATS_BOOT_CTX__ = ctx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(Math.max(0.01, Math.min(1, volume) * 0.28), now);
      master.connect(ctx.destination);

      // Warm sub-pad sweep (C3 -> G3)
      const pad = ctx.createOscillator();
      const padGain = ctx.createGain();
      pad.type = 'triangle';
      pad.frequency.setValueAtTime(130.81, now);
      pad.frequency.exponentialRampToValueAtTime(196.0, now + 0.55);
      padGain.gain.setValueAtTime(0.0001, now);
      padGain.gain.exponentialRampToValueAtTime(0.55, now + 0.14);
      padGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
      pad.connect(padGain);
      padGain.connect(master);
      pad.start(now);
      pad.stop(now + 1.4);

      // Futuristic glass arpeggio (C5 - E5 - G5 - B5 - D6)
      const notes = [523.25, 659.25, 783.99, 987.77, 1174.66];
      notes.forEach((freq, idx) => {
        const t = now + 0.08 + idx * 0.11;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.42, t + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);
        osc.connect(gain);
        gain.connect(master);
        osc.start(t);
        osc.stop(t + 0.56);
      });

      setTimeout(() => {
        if (window.__ATS_BOOT_CTX__ === ctx) {
          ctx.close().catch(() => {});
          window.__ATS_BOOT_CTX__ = null;
        }
      }, 1700);
    } catch (_) {}
  }

  function playBootAudio(force = false) {
    if (!force && !state.bootSoundEnabled) return;
    const vol = Math.min(1, Math.max(0, Number(state.bootSoundVolume ?? 0.75)));

    if (state.bootAudio) {
      stopBootAudio();
      try {
        const audio = new Audio(resolveMediaUrl(state.bootAudio));
        audio.volume = vol;
        window.__ATS_BOOT_AUDIO__ = audio;
        const release = () => {
          try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
          } catch (_) {}
          if (window.__ATS_BOOT_AUDIO__ === audio) window.__ATS_BOOT_AUDIO__ = null;
        };
        audio.addEventListener('ended', release, { once: true });
        audio.addEventListener('error', () => {
          release();
          playBuiltInBootSound(vol);
        }, { once: true });
        audio.play().catch(() => {
          release();
          playBuiltInBootSound(vol);
        });
        return;
      } catch (_) {}
    }

    playBuiltInBootSound(vol);
  }

  function playBootHud(force = false) {
    if (isExtensionWebview()) return;
    let alreadyPlayedSession = Boolean(window[BOOT_PLAYED_FLAG]);
    try {
      if (sessionStorage.getItem('ats_boot_played_v1') === '1') alreadyPlayedSession = true;
    } catch (_) {}
    if (!force && (!state.bootHudEnabled || alreadyPlayedSession)) return;
    window[BOOT_PLAYED_FLAG] = true;
    try {
      sessionStorage.setItem('ats_boot_played_v1', '1');
    } catch (_) {}

    const existing = document.getElementById('ats-boot-hud');
    if (existing) existing.remove();

    const hud = document.createElement('div');
    hud.id = 'ats-boot-hud';
    const ring = document.createElement('div');
    ring.className = 'ats-hud-ring';
    const titleEl = document.createElement('div');
    titleEl.className = 'ats-hud-title';
    titleEl.textContent = state.bootHudTitle || 'ANTIGRAVITY STUDIO';
    const subEl = document.createElement('div');
    subEl.className = 'ats-hud-sub';
    subEl.textContent = state.bootHudSub || 'DARK GLASS ENGINE // READY';
    const bar = document.createElement('div');
    bar.className = 'ats-hud-bar';
    const fill = document.createElement('div');
    fill.className = 'ats-hud-bar-fill';
    bar.appendChild(fill);
    const skipBtn = document.createElement('button');
    skipBtn.className = 'ats-hud-skip';
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip (Esc)';
    hud.append(ring, titleEl, subEl, bar, skipBtn);
    document.body.appendChild(hud);

    // Only play boot sound if forced (replay button) or the window is visible & focused
    if (state.bootSoundEnabled && (force || (!document.hidden && document.hasFocus()))) {
      playBootAudio(false);
    }

    const dismiss = (stopSound = false) => {
      if (stopSound) stopBootAudio();
      if (!hud.isConnected) return;
      hud.classList.add('ats-boot-hide');
      setTimeout(() => hud.remove(), 560);
    };

    skipBtn.addEventListener('click', () => dismiss(true));
    requestAnimationFrame(() => {
      fill.style.width = '100%';
    });
    setTimeout(() => dismiss(false), 1550);
  }

  // --------------------------------------------------------------------------
  // 8. Media Server API Helpers
  // --------------------------------------------------------------------------
  async function fetchMediaLibrary() {
    const base = getMediaBase();
    if (!base) return mediaLibrary;
    try {
      const res = await fetch(`${base}/api/media`);
      if (res.ok) {
        const data = await res.json();
        mediaLibrary = {
          videos: Array.isArray(data.videos) ? data.videos : [],
          images: Array.isArray(data.images) ? data.images : [],
          audios: Array.isArray(data.audios) ? data.audios : []
        };
        window.__ATS_USER_MEDIA__ = mediaLibrary;
      }
    } catch (_) {}
    return mediaLibrary;
  }

  async function uploadMediaFile(file) {
    const base = getMediaBase();
    if (!base) throw new Error('Media server chưa kết nối');
    const res = await fetch(`${base}/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Upload thất bại');
    await fetchMediaLibrary();
    return data;
  }

  async function deleteMediaFile(fileName, url) {
    const base = getMediaBase();
    if (!base) return;
    const res = await fetch(`${base}/api/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, url })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.media) {
      mediaLibrary = data.media;
      window.__ATS_USER_MEDIA__ = mediaLibrary;
    } else {
      await fetchMediaLibrary();
    }

    const patch = {};
    if (url && isSameMediaUrl(state.activeVideo, url)) {
      patch.activeVideo = 'assets/wallpaper.mp4';
    }
    if (url && isSameMediaUrl(state.activeImage, url)) {
      patch.activeImage = '';
      if (state.mode === 'image') patch.mode = 'gradient';
    }
    if (url && isSameMediaUrl(state.activeAudio, url)) {
      patch.activeAudio = '';
    }
    if (url && isSameMediaUrl(state.bootAudio, url)) {
      patch.bootAudio = '';
    }
    if (Object.keys(patch).length > 0) {
      saveState(patch);
      applyTheme();
    }
  }

  // --------------------------------------------------------------------------
  // 9. Native Sidebar Button, Settings Button & Fallback Floating Pill
  // --------------------------------------------------------------------------
  function ensureFallbackFab(show) {
    const existing = document.getElementById('ats-studio-fab');
    if (!show || state.showFloatingBtn === false || isExtensionWebview()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const fab = document.createElement('button');
    fab.id = 'ats-studio-fab';
    fab.type = 'button';
    fab.title = 'Mở Antigravity Theme Studio (Ctrl+Shift+T)';
    const dot = document.createElement('span');
    dot.className = 'ats-dot';
    const label = document.createElement('span');
    label.textContent = 'Theme Studio';
    fab.append(dot, label);
    fab.addEventListener('click', openStudioModal);
    document.body.appendChild(fab);
  }

  function injectSidebarButton() {
    const existingBtn = document.getElementById('ats-sidebar-btn');

    // Antigravity IDE (.monaco-workbench): mount cleanly inside the Status Bar (zero innerHTML for TrustedTypes)
    if (isIdeHost()) {
      if (existingBtn && existingBtn.isConnected) {
        ensureFallbackFab(false);
        return;
      }
      const statusHost =
        document.querySelector('.monaco-workbench .part.statusbar .right-items') ||
        document.querySelector('.monaco-workbench .part.statusbar .left-items');
      if (!statusHost) {
        ensureFallbackFab(true);
        return;
      }
      const btn = document.createElement('button');
      btn.id = 'ats-sidebar-btn';
      btn.type = 'button';
      btn.title = 'Mở Antigravity Theme Studio (Ctrl+Shift+T)';
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:0 8px;height:100%;background:transparent;border:none;color:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;';
      btn.textContent = '✦ Theme Studio';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openStudioModal();
      });
      statusHost.prepend(btn);
      ensureFallbackFab(false);
      return;
    }

    const splitPane = document.querySelector('[data-testid="sidebar-split"]')?.firstElementChild || null;
    const sidebarCandidates = [
      splitPane,
      ...Array.from(document.querySelectorAll('aside, [data-sidebar="true"], .bg-sidebar'))
    ].filter((el) => el && el.getBoundingClientRect().height > 150 && el.getBoundingClientRect().width > 60);

    const sidebar = sidebarCandidates[0] || null;
    const sidebarVisible = Boolean(sidebar);
    if (existingBtn) {
      if (!sidebarVisible || !existingBtn.isConnected) {
        ensureFallbackFab(true);
      } else {
        ensureFallbackFab(false);
      }
      return;
    }

    if (!sidebarVisible) {
      ensureFallbackFab(true);
      return;
    }

    const anchors = ['customizations', 'automations', 'plugins', 'skills', 'settings', 'mcp'];
    const nodes = Array.from(sidebar.querySelectorAll('span, a, button'));
    const anchor = nodes.find((n) => anchors.includes((n.textContent || '').trim().toLowerCase()));

    const btn = document.createElement('button');
    btn.id = 'ats-sidebar-btn';
    btn.type = 'button';
    btn.className = 'w-full flex items-center gap-2.5 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg transition-colors cursor-pointer select-none';
    btn.style.cssText = 'text-align:left;';
    setHtml(btn, `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Theme Studio</span>
    `);

    const row = anchor ? (anchor.closest('a, button, div[role="button"], .group\\/headerbtn') || anchor.parentElement) : null;
    if (row && row.parentNode) {
      row.parentNode.insertBefore(btn, row.nextSibling);
    } else {
      btn.style.cssText = 'text-align:left;margin:6px 8px;width:calc(100% - 16px);';
      sidebar.appendChild(btn);
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openStudioModal();
    });
    ensureFallbackFab(false);
  }

  function injectSettingsButton() {
    const modal = document.querySelector('.settings-modal-container');
    if (!modal || document.getElementById('ats-settings-btn')) return;

    const headers = Array.from(modal.querySelectorAll('h2, h3'));
    const appearanceHeader = headers.find((h) => h.textContent?.trim() === 'Appearance');
    if (!appearanceHeader) return;

    let targetContainer = appearanceHeader.parentElement;
    while (targetContainer && !String(targetContainer.className || '').includes('justify-between') && targetContainer !== modal) {
      targetContainer = targetContainer.parentElement;
    }
    if (!targetContainer || !targetContainer.parentNode) return;

    const btn = document.createElement('button');
    btn.id = 'ats-settings-btn';
    btn.type = 'button';
    btn.className = 'select-none rounded px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer text-white';
    btn.style.cssText = 'background:linear-gradient(135deg,#0284c7 0%,#6366f1 100%);border:1px solid rgba(56,189,248,0.45);box-shadow:0 2px 10px rgba(56,189,248,0.28);margin:8px 0;display:inline-flex;align-items:center;gap:6px;';
    setHtml(btn, `
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
      <span>Open Theme Studio</span>
    `);
    targetContainer.parentNode.insertBefore(btn, targetContainer.nextSibling);
    btn.addEventListener('click', openStudioModal);
  }

  // --------------------------------------------------------------------------
  // 10. In-App Theme Studio Modal
  // --------------------------------------------------------------------------
  function closeStudioModal() {
    const backdrop = document.getElementById('ats-modal-backdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  async function openStudioModal() {
    await fetchMediaLibrary();
    let backdrop = document.getElementById('ats-modal-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'ats-modal-backdrop';
      setHtml(backdrop, `
        <div id="ats-modal" role="dialog" aria-label="Antigravity Theme Studio">
          <div class="ats-modal-header">
            <div class="ats-modal-title">
              <span>Antigravity Theme Studio</span>
              <span class="ats-badge">Dark Glass Engine</span>
            </div>
            <button class="ats-close-btn" type="button" title="Đóng">&times;</button>
          </div>
          <div class="ats-tabs">
            <button class="ats-tab-btn active" data-tab="bg" type="button">Hình nền & Preset</button>
            <button class="ats-tab-btn" data-tab="look" type="button">Giao diện & Chat</button>
            <button class="ats-tab-btn" data-tab="audio" type="button">Âm thanh & Lời chào</button>
            <button class="ats-tab-btn" data-tab="hud" type="button">Boot HUD</button>
          </div>
          <div class="ats-modal-body">
            <div class="ats-panel active" data-panel="bg"></div>
            <div class="ats-panel" data-panel="look"></div>
            <div class="ats-panel" data-panel="audio"></div>
            <div class="ats-panel" data-panel="hud"></div>
          </div>
        </div>
      `);
      document.body.appendChild(backdrop);

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeStudioModal();
      });
      backdrop.querySelector('.ats-close-btn').addEventListener('click', closeStudioModal);
      backdrop.querySelectorAll('.ats-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          backdrop.querySelectorAll('.ats-tab-btn').forEach((b) => b.classList.remove('active'));
          backdrop.querySelectorAll('.ats-panel').forEach((p) => p.classList.remove('active'));
          btn.classList.add('active');
          const panel = backdrop.querySelector(`.ats-panel[data-panel="${btn.dataset.tab}"]`);
          if (panel) panel.classList.add('active');
        });
      });
    }

    renderStudioPanels(backdrop);
    backdrop.classList.add('open');
  }

  function renderStudioPanels(backdrop) {
    renderBgPanel(backdrop.querySelector('.ats-panel[data-panel="bg"]'), backdrop);
    renderLookPanel(backdrop.querySelector('.ats-panel[data-panel="look"]'));
    renderAudioPanel(backdrop.querySelector('.ats-panel[data-panel="audio"]'));
    renderHudPanel(backdrop.querySelector('.ats-panel[data-panel="hud"]'));
  }

  function renderBgPanel(panel, backdrop) {
    const presetCards = Object.entries(PRESETS).map(([name, p]) => `
      <button type="button" class="ats-preset-card ${state.preset === name ? 'selected' : ''}" data-preset="${escapeHtml(name)}">
        <div class="ats-preset-swatch">
          <span style="background:${escapeHtml(p.primary)}"></span>
          <span style="background:${escapeHtml(p.secondary)}"></span>
        </div>
        <div class="ats-preset-name">${escapeHtml(name)}</div>
        <div class="ats-preset-desc">${escapeHtml(p.concept || '')}</div>
      </button>
    `).join('');

    const allVideos = [
      { name: 'wallpaper.mp4 (Mặc định)', url: 'assets/wallpaper.mp4', builtIn: true },
      ...(mediaLibrary.videos || [])
    ];
    const allImages = [...(mediaLibrary.images || [])];

    const listItems = state.mode === 'video'
      ? allVideos.map((v) => `
          <div class="ats-media-item ${isSameMediaUrl(state.activeVideo, v.url) ? 'active' : ''}">
            <video class="ats-media-thumb" muted playsinline preload="metadata" src="${escapeHtml(resolveMediaUrl(v.url))}"></video>
            <span class="ats-media-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
            <button type="button" class="ats-btn" data-select-video="${escapeHtml(v.url)}">Chọn</button>
            ${v.builtIn ? '' : `<button type="button" class="ats-btn ats-btn-danger" data-del-file="${escapeHtml(v.fileName)}" data-del-url="${escapeHtml(v.url)}">Xóa</button>`}
          </div>
        `).join('')
      : state.mode === 'image'
        ? (allImages.length ? allImages.map((img) => `
            <div class="ats-media-item ${isSameMediaUrl(state.activeImage, img.url) ? 'active' : ''}">
              <img class="ats-media-thumb" loading="lazy" alt="" src="${escapeHtml(resolveMediaUrl(img.url))}" />
              <span class="ats-media-name" title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</span>
              <button type="button" class="ats-btn" data-select-image="${escapeHtml(img.url)}">Chọn</button>
              <button type="button" class="ats-btn ats-btn-danger" data-del-file="${escapeHtml(img.fileName)}" data-del-url="${escapeHtml(img.url)}">Xóa</button>
            </div>
          `).join('') : '<div class="ats-row-sub">Chưa có ảnh nào. Bấm nút "+ Tải tệp lên" để thêm ảnh nền!</div>')
        : '<div class="ats-row-sub">Đang dùng nền Gradient thuần CSS (tiết kiệm tối đa GPU/RAM).</div>';

    setHtml(panel, `
      <div>
        <div class="ats-section-label">Preset giao diện</div>
        <div class="ats-preset-grid">${presetCards}</div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Bật giao diện nền tùy biến</div>
          <div class="ats-row-sub">Tắt để trở về nền tối phẳng mặc định mà vẫn giữ khung chat</div>
        </div>
        <input type="checkbox" id="ats-wp-toggle" ${state.wpEnabled ? 'checked' : ''} />
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Chế độ hình nền</div>
          <div class="ats-row-sub">Video động 60FPS, Ảnh tĩnh hoặc Gradient thuần CSS</div>
        </div>
        <div class="ats-mode-group">
          <button type="button" class="ats-btn ${state.mode === 'video' ? '' : 'ats-btn-ghost'}" data-mode="video">Video</button>
          <button type="button" class="ats-btn ${state.mode === 'image' ? '' : 'ats-btn-ghost'}" data-mode="image">Ảnh tĩnh</button>
          <button type="button" class="ats-btn ${state.mode === 'gradient' ? '' : 'ats-btn-ghost'}" data-mode="gradient">Gradient</button>
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Tải lên Video / Ảnh nền mới</div>
          <div class="ats-row-sub">Hỗ trợ .mp4, .webm, .png, .jpg, .webp (tối đa 150MB, chống trùng MD5)</div>
        </div>
        <div>
          <input type="file" id="ats-bg-upload" accept="video/*,image/*" style="display:none" />
          <button type="button" class="ats-btn" id="ats-bg-upload-btn">+ Tải tệp lên</button>
        </div>
      </div>
      <div class="ats-status ${bgStatusError ? 'error' : ''}" id="ats-bg-status">${escapeHtml(bgStatusText)}</div>

      <div>
        <div class="ats-section-label">Thư viện ${state.mode === 'video' ? 'Video' : state.mode === 'image' ? 'Ảnh tĩnh' : 'Nền'}</div>
        <div class="ats-media-list">${listItems}</div>
      </div>
    `);

    panel.querySelector('#ats-wp-toggle').addEventListener('change', (e) => {
      saveState({ wpEnabled: e.target.checked });
      applyTheme();
    });

    panel.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.preset;
        const p = PRESETS[name];
        if (!p) return;
        saveState({
          preset: name,
          bubblePreset: name,
          mode: p.mode || state.mode,
          activeVideo: p.wallpaperVideo || state.activeVideo,
          dimOpacity: p.dimOpacity ?? state.dimOpacity,
          primaryOverride: ''
        });
        applyTheme();
        renderStudioPanels(backdrop);
      });
    });

    panel.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveState({ mode: btn.dataset.mode });
        applyTheme();
        renderBgPanel(panel, backdrop);
      });
    });

    const uploadInput = panel.querySelector('#ats-bg-upload');
    const statusEl = panel.querySelector('#ats-bg-status');
    panel.querySelector('#ats-bg-upload-btn').addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async () => {
      const file = uploadInput.files && uploadInput.files[0];
      if (!file) return;
      bgStatusError = false;
      bgStatusText = `Đang tải lên ${file.name}...`;
      statusEl.className = 'ats-status';
      statusEl.textContent = bgStatusText;
      try {
        const uploaded = await uploadMediaFile(file);
        if (uploaded.kind === 'video') {
          saveState({ wpEnabled: true, mode: 'video', activeVideo: uploaded.url });
        } else {
          saveState({ wpEnabled: true, mode: 'image', activeImage: uploaded.url });
        }
        bgStatusError = false;
        bgStatusText = uploaded.duplicate
          ? `Tệp đã tồn tại — đã áp dụng: ${uploaded.name}`
          : `Đã tải lên & áp dụng: ${uploaded.name}`;
        applyTheme();
        renderBgPanel(panel, backdrop);
      } catch (err) {
        bgStatusError = true;
        bgStatusText = `Lỗi: ${err.message}`;
        statusEl.className = 'ats-status error';
        statusEl.textContent = bgStatusText;
      }
    });

    panel.querySelectorAll('[data-select-video]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveState({ wpEnabled: true, mode: 'video', activeVideo: btn.dataset.selectVideo });
        applyTheme();
        renderBgPanel(panel, backdrop);
      });
    });

    panel.querySelectorAll('[data-select-image]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveState({ wpEnabled: true, mode: 'image', activeImage: btn.dataset.selectImage });
        applyTheme();
        renderBgPanel(panel, backdrop);
      });
    });

    panel.querySelectorAll('[data-del-file]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await deleteMediaFile(btn.dataset.delFile, btn.dataset.delUrl);
        bgStatusError = false;
        bgStatusText = 'Đã xóa tệp khỏi ổ đĩa.';
        renderBgPanel(panel, backdrop);
      });
    });
  }

  function renderLookPanel(panel) {
    const preset = PRESETS[state.preset] || {};
    const currentDim = Math.round((state.dimOpacity ?? 0.45) * 100);
    const currentBlur = Number(state.glassBlur ?? 3);
    const currentPrimary = state.primaryOverride || preset.primary || '#38bdf8';

    const bubbleOptions = PRESET_KEYS.map((k) =>
      `<option value="${escapeHtml(k)}" ${state.bubblePreset === k ? 'selected' : ''}>${escapeHtml(k)}</option>`
    ).join('');

    const inputOptions = Object.entries(INPUT_STYLES).map(([k, label]) =>
      `<option value="${escapeHtml(k)}" ${state.inputStyle === k ? 'selected' : ''}>${escapeHtml(label)}</option>`
    ).join('');

    setHtml(panel, `
      <div class="ats-row">
        <div>
          <div class="ats-row-title">Hiện nút nổi Theme Studio (góc phải dưới)</div>
          <div class="ats-row-sub">Tắt nếu thấy vướng — vẫn mở được bằng Ctrl + Shift + T hoặc Settings → Appearance</div>
        </div>
        <input type="checkbox" id="ats-fab-toggle" ${state.showFloatingBtn !== false ? 'checked' : ''} />
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Độ tối lớp phủ nền (Dim Overlay)</div>
          <div class="ats-row-sub">Tăng độ tối giúp chữ và code nổi bật hơn trên video/ảnh sáng</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" class="ats-slider" id="ats-dim-slider" min="0" max="90" value="${currentDim}" />
          <span id="ats-dim-val" style="min-width:34px;text-align:right;font-size:12px">${currentDim}%</span>
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Độ mờ kính Pre-baked (Sidebar & Header)</div>
          <div class="ats-row-sub">Dựng sẵn một lần trên Canvas — giữ mượt 60-120 FPS</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" class="ats-slider" id="ats-blur-slider" min="0" max="14" value="${currentBlur}" />
          <span id="ats-blur-val" style="min-width:34px;text-align:right;font-size:12px">${currentBlur}px</span>
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Màu nhấn chủ đạo (Accent Override)</div>
          <div class="ats-row-sub">Ghi đè màu viền khung chat, composer và điểm nhấn</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="color" id="ats-primary-picker" value="${escapeHtml(currentPrimary)}" style="width:36px;height:30px;border:none;background:transparent;cursor:pointer" />
          <button type="button" class="ats-btn ats-btn-ghost" id="ats-reset-accent">Mặc định</button>
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Phong cách bong bóng tin nhắn (User Bubble)</div>
        </div>
        <select class="ats-select" id="ats-bubble-select">${bubbleOptions}</select>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Kiểu khung nhập liệu (Composer Frame)</div>
        </div>
        <select class="ats-select" id="ats-input-select">${inputOptions}</select>
      </div>

      <div class="ats-row">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="ats-avatar-preview" style="${state.userAvatar ? `background-image:url('${sanitizeCssUrl(state.userAvatar)}')` : ''}"></div>
          <div>
            <div class="ats-row-title">Ảnh đại diện User</div>
            <div class="ats-row-sub">Tự động nén 192×192 WebP siêu nhẹ</div>
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <input type="file" id="ats-user-av-input" accept="image/*" style="display:none" />
          <button type="button" class="ats-btn" id="ats-user-av-btn">Chọn ảnh</button>
          ${state.userAvatar ? '<button type="button" class="ats-btn ats-btn-ghost" id="ats-user-av-clear">Xóa</button>' : ''}
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Căn khung hình nền (Object Position)</div>
          <div class="ats-row-sub">Điều chỉnh vùng hiển thị để không cắt mất phần đẹp của video/ảnh</div>
        </div>
        <select class="ats-select" id="ats-bgpos-select">
          <option value="" ${!state.bgPosition ? 'selected' : ''}>Mặc định theo Preset</option>
          <option value="center top" ${state.bgPosition === 'center top' ? 'selected' : ''}>Căn trên (Top)</option>
          <option value="center 25%" ${state.bgPosition === 'center 25%' ? 'selected' : ''}>Trên vừa (25%)</option>
          <option value="center center" ${state.bgPosition === 'center center' ? 'selected' : ''}>Chính giữa (Center)</option>
          <option value="center 75%" ${state.bgPosition === 'center 75%' ? 'selected' : ''}>Dưới vừa (75%)</option>
          <option value="center bottom" ${state.bgPosition === 'center bottom' ? 'selected' : ''}>Căn dưới (Bottom)</option>
        </select>
      </div>

      <div class="ats-row">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="ats-avatar-preview" style="${state.agentAvatar ? `background-image:url('${sanitizeCssUrl(state.agentAvatar)}')` : ''}"></div>
          <div>
            <div class="ats-row-title">Ảnh đại diện Agent</div>
            <div class="ats-row-sub">Hiển thị ở góc trên bên trái thẻ trả lời của AI</div>
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <input type="file" id="ats-agent-av-input" accept="image/*" style="display:none" />
          <button type="button" class="ats-btn" id="ats-agent-av-btn">Chọn ảnh</button>
          ${state.agentAvatar ? '<button type="button" class="ats-btn ats-btn-ghost" id="ats-agent-av-clear">Xóa</button>' : ''}
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Sao lưu & Khôi phục cấu hình</div>
          <div class="ats-row-sub">Xuất/nhập tệp JSON cấu hình hoặc đặt lại về mặc định</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="ats-btn ats-btn-ghost" id="ats-export-cfg">Xuất JSON</button>
          <input type="file" id="ats-import-cfg-input" accept="application/json,.json" style="display:none" />
          <button type="button" class="ats-btn ats-btn-ghost" id="ats-import-cfg">Nhập JSON</button>
          <button type="button" class="ats-btn ats-btn-danger" id="ats-reset-cfg">Đặt lại mặc định</button>
        </div>
      </div>
      <div class="ats-status ${lookStatusError ? 'error' : ''}" id="ats-look-status">${escapeHtml(lookStatusText)}</div>
    `);

    panel.querySelector('#ats-fab-toggle').addEventListener('change', (e) => {
      saveState({ showFloatingBtn: e.target.checked });
      injectSidebarButton();
    });

    const dimSlider = panel.querySelector('#ats-dim-slider');
    const dimVal = panel.querySelector('#ats-dim-val');
    dimSlider.addEventListener('input', () => {
      const pct = Number(dimSlider.value);
      dimVal.textContent = `${pct}%`;
      saveState({ dimOpacity: pct / 100 });
      applyTheme();
    });

    const blurSlider = panel.querySelector('#ats-blur-slider');
    const blurVal = panel.querySelector('#ats-blur-val');
    blurSlider.addEventListener('input', () => {
      const px = Number(blurSlider.value);
      blurVal.textContent = `${px}px`;
      saveState({ glassBlur: px });
      applyTheme();
    });

    panel.querySelector('#ats-primary-picker').addEventListener('input', (e) => {
      saveState({ primaryOverride: e.target.value });
      applyTheme();
    });

    panel.querySelector('#ats-reset-accent').addEventListener('click', () => {
      saveState({ primaryOverride: '' });
      applyTheme();
      renderLookPanel(panel);
    });

    panel.querySelector('#ats-bubble-select').addEventListener('change', (e) => {
      saveState({ bubblePreset: e.target.value });
      applyTheme();
    });

    panel.querySelector('#ats-input-select').addEventListener('change', (e) => {
      saveState({ inputStyle: e.target.value });
      applyTheme();
    });

    panel.querySelector('#ats-bgpos-select').addEventListener('change', (e) => {
      saveState({ bgPosition: e.target.value });
      applyTheme();
    });

    const lookStatusEl = panel.querySelector('#ats-look-status');
    const setLookStatus = (msg, isErr = false) => {
      lookStatusText = msg;
      lookStatusError = isErr;
      if (lookStatusEl) {
        lookStatusEl.className = `ats-status ${isErr ? 'error' : ''}`;
        lookStatusEl.textContent = msg;
      }
    };

    panel.querySelector('#ats-export-cfg').addEventListener('click', () => {
      try {
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'antigravity-theme-config.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setLookStatus('Đã xuất tệp antigravity-theme-config.json.');
      } catch (err) {
        setLookStatus(`Lỗi xuất cấu hình: ${err.message}`, true);
      }
    });

    const importInput = panel.querySelector('#ats-import-cfg-input');
    panel.querySelector('#ats-import-cfg').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      const f = importInput.files && importInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ''));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Tệp JSON không phải đối tượng cấu hình hợp lệ.');
          }
          const allowedKeys = new Set(Object.keys(DEFAULT_STATE));
          const sanitized = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (allowedKeys.has(k)) sanitized[k] = v;
          }
          if (Object.keys(sanitized).length === 0) {
            throw new Error('Không tìm thấy trường cấu hình Theme Studio nào trong tệp.');
          }
          if (sanitized.preset && !PRESETS[sanitized.preset]) sanitized.preset = DEFAULT_PRESET_KEY;
          if (sanitized.bubblePreset && !PRESETS[sanitized.bubblePreset]) sanitized.bubblePreset = sanitized.preset || state.preset;
          if (sanitized.inputStyle && !INPUT_STYLES[sanitized.inputStyle]) sanitized.inputStyle = 'sync';
          if (sanitized.mode && !['video', 'image', 'gradient'].includes(sanitized.mode)) sanitized.mode = 'video';
          saveState(sanitized, true);
          applyTheme();
          injectSidebarButton();
          lookStatusError = false;
          lookStatusText = `Đã nhập thành công ${Object.keys(sanitized).length} thiết lập từ ${f.name}.`;
          const backdrop = document.getElementById('ats-modal-backdrop');
          if (backdrop) renderStudioPanels(backdrop);
        } catch (err) {
          setLookStatus(`Lỗi nhập JSON: ${err.message}`, true);
        }
      };
      reader.readAsText(f);
    });

    const resetBtn = panel.querySelector('#ats-reset-cfg');
    let resetConfirmTimer = null;
    resetBtn.addEventListener('click', () => {
      if (resetBtn.dataset.armed !== '1') {
        resetBtn.dataset.armed = '1';
        resetBtn.textContent = 'Bấm lại để xác nhận';
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = setTimeout(() => {
          delete resetBtn.dataset.armed;
          resetBtn.textContent = 'Đặt lại mặc định';
        }, 4000);
        return;
      }
      clearTimeout(resetConfirmTimer);
      delete resetBtn.dataset.armed;
      saveState({ ...DEFAULT_STATE, customGreetings: DEFAULT_GREETINGS.slice() }, true);
      applyTheme();
      injectSidebarButton();
      lookStatusError = false;
      lookStatusText = 'Đã khôi phục toàn bộ cấu hình về mặc định.';
      const backdrop = document.getElementById('ats-modal-backdrop');
      if (backdrop) renderStudioPanels(backdrop);
    });

    const userAvInput = panel.querySelector('#ats-user-av-input');
    panel.querySelector('#ats-user-av-btn').addEventListener('click', () => userAvInput.click());
    userAvInput.addEventListener('change', () => {
      const f = userAvInput.files && userAvInput.files[0];
      if (!f) return;
      compressAvatarFile(f, (dataUrl) => {
        saveState({ userAvatar: dataUrl });
        applyTheme();
        renderLookPanel(panel);
      });
    });
    const userAvClear = panel.querySelector('#ats-user-av-clear');
    if (userAvClear) {
      userAvClear.addEventListener('click', () => {
        saveState({ userAvatar: '' });
        applyTheme();
        renderLookPanel(panel);
      });
    }

    const agentAvInput = panel.querySelector('#ats-agent-av-input');
    panel.querySelector('#ats-agent-av-btn').addEventListener('click', () => agentAvInput.click());
    agentAvInput.addEventListener('change', () => {
      const f = agentAvInput.files && agentAvInput.files[0];
      if (!f) return;
      compressAvatarFile(f, (dataUrl) => {
        saveState({ agentAvatar: dataUrl });
        applyTheme();
        renderLookPanel(panel);
      });
    });
    const agentAvClear = panel.querySelector('#ats-agent-av-clear');
    if (agentAvClear) {
      agentAvClear.addEventListener('click', () => {
        saveState({ agentAvatar: '' });
        applyTheme();
        renderLookPanel(panel);
      });
    }
  }

  function renderAudioPanel(panel) {
    const volPct = Math.round((state.taskSoundVolume ?? 0.75) * 100);
    const allAudios = [
      {
        name: (mediaLibrary.audios && mediaLibrary.audios.length > 0)
          ? 'Phát ngẫu nhiên từ danh sách đã tải lên'
          : 'Chime Synth tích hợp sẵn (Mặc định)',
        url: '',
        builtIn: true
      },
      ...(mediaLibrary.audios || [])
    ];

    const audioListHtml = allAudios.map((a) => `
      <div class="ats-media-item ${(a.url === '' ? state.activeAudio === '' : isSameMediaUrl(state.activeAudio, a.url)) ? 'active' : ''}">
        <span class="ats-media-name" title="${escapeHtml(a.name)}">🔊 ${escapeHtml(a.name)}</span>
        <button type="button" class="ats-btn" data-select-audio="${escapeHtml(a.url)}">Chọn</button>
        ${a.builtIn ? '' : `<button type="button" class="ats-btn ats-btn-danger" data-del-audio-file="${escapeHtml(a.fileName)}" data-del-audio-url="${escapeHtml(a.url)}">Xóa</button>`}
      </div>
    `).join('');

    setHtml(panel, `
      <div class="ats-row">
        <div>
          <div class="ats-row-title">Âm thanh hoàn thành tác vụ (Task Complete Sound)</div>
          <div class="ats-row-sub">Phát thông báo khi Agent trả lời xong (tự bỏ qua nếu bạn bấm hủy)</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button type="button" class="ats-btn ats-btn-ghost" id="ats-test-sound">Nghe thử</button>
          <input type="checkbox" id="ats-sound-toggle" ${state.taskSoundEnabled ? 'checked' : ''} />
        </div>
      </div>

      <div class="ats-row">
        <div class="ats-row-title">Âm lượng thông báo</div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" class="ats-slider" id="ats-vol-slider" min="5" max="100" value="${volPct}" />
          <span id="ats-vol-val" style="min-width:34px;text-align:right;font-size:12px">${volPct}%</span>
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Tải âm thanh riêng (.mp3, .wav, .ogg, .m4a)</div>
        </div>
        <div>
          <input type="file" id="ats-audio-upload" accept="audio/*" style="display:none" />
          <button type="button" class="ats-btn" id="ats-audio-upload-btn">+ Tải âm thanh</button>
        </div>
      </div>
      <div class="ats-status ${audioStatusError ? 'error' : ''}" id="ats-audio-status">${escapeHtml(audioStatusText)}</div>
      <div class="ats-media-list">${audioListHtml}</div>

      <div class="ats-row" style="margin-top:6px">
        <div>
          <div class="ats-row-title">Câu chào tùy chỉnh (Custom Greeting)</div>
          <div class="ats-row-sub">Hiển thị ngẫu nhiên một dòng khi mở hội thoại mới</div>
        </div>
        <input type="checkbox" id="ats-greeting-toggle" ${state.customGreetingEnabled ? 'checked' : ''} />
      </div>
      <textarea class="ats-textarea" id="ats-greetings-input" placeholder="Mỗi dòng là một câu chào...">${escapeHtml((state.customGreetings || []).join('\n'))}</textarea>
      <div style="display:flex;justify-content:flex-end">
        <button type="button" class="ats-btn" id="ats-save-greetings">Lưu câu chào</button>
      </div>
    `);

    panel.querySelector('#ats-test-sound').addEventListener('click', () => playTaskSound(true));
    panel.querySelector('#ats-sound-toggle').addEventListener('change', (e) => {
      saveState({ taskSoundEnabled: e.target.checked });
    });

    const volSlider = panel.querySelector('#ats-vol-slider');
    const volVal = panel.querySelector('#ats-vol-val');
    volSlider.addEventListener('input', () => {
      volVal.textContent = `${volSlider.value}%`;
      saveState({ taskSoundVolume: Number(volSlider.value) / 100 });
    });

    const audioInput = panel.querySelector('#ats-audio-upload');
    const statusEl = panel.querySelector('#ats-audio-status');
    panel.querySelector('#ats-audio-upload-btn').addEventListener('click', () => audioInput.click());
    audioInput.addEventListener('change', async () => {
      const file = audioInput.files && audioInput.files[0];
      if (!file) return;
      audioStatusError = false;
      audioStatusText = `Đang tải lên ${file.name}...`;
      statusEl.className = 'ats-status';
      statusEl.textContent = audioStatusText;
      try {
        const uploaded = await uploadMediaFile(file);
        saveState({ activeAudio: uploaded.url });
        audioStatusError = false;
        audioStatusText = `Đã thêm âm thanh: ${uploaded.name}`;
        playTaskSound(true);
        renderAudioPanel(panel);
      } catch (err) {
        audioStatusError = true;
        audioStatusText = `Lỗi: ${err.message}`;
        statusEl.className = 'ats-status error';
        statusEl.textContent = audioStatusText;
      }
    });

    panel.querySelectorAll('[data-select-audio]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveState({ activeAudio: btn.dataset.selectAudio });
        playTaskSound(true);
        renderAudioPanel(panel);
      });
    });

    panel.querySelectorAll('[data-del-audio-file]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await deleteMediaFile(btn.dataset.delAudioFile, btn.dataset.delAudioUrl);
        audioStatusError = false;
        audioStatusText = 'Đã xóa âm thanh.';
        renderAudioPanel(panel);
      });
    });

    panel.querySelector('#ats-greeting-toggle').addEventListener('change', (e) => {
      saveState({ customGreetingEnabled: e.target.checked });
      syncEmptyGreeting();
    });

    panel.querySelector('#ats-save-greetings').addEventListener('click', () => {
      const lines = panel.querySelector('#ats-greetings-input').value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      saveState({ customGreetings: lines.length ? lines : DEFAULT_GREETINGS.slice() });
      window.__ATS_GREETING_FRESH__ = true;
      syncEmptyGreeting();
    });
  }

  function renderHudPanel(panel) {
    const bootVolPct = Math.round((state.bootSoundVolume ?? 0.75) * 100);
    const bootAudioOptions = [
      `<option value="" ${!state.bootAudio ? 'selected' : ''}>Sci-Fi Glass Synth (Tích hợp sẵn)</option>`,
      ...(mediaLibrary.audios || []).map((a) =>
        `<option value="${escapeHtml(a.url)}" ${isSameMediaUrl(state.bootAudio, a.url) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`
      )
    ].join('');

    setHtml(panel, `
      <div class="ats-row">
        <div>
          <div class="ats-row-title">Bật Boot HUD khi mở Antigravity</div>
          <div class="ats-row-sub">Hiệu ứng khởi động phong cách Dark Glass HUD</div>
        </div>
        <input type="checkbox" id="ats-hud-toggle" ${state.bootHudEnabled ? 'checked' : ''} />
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Âm thanh Boot HUD khi khởi động</div>
          <div class="ats-row-sub">Phát nhạc/hiệu ứng khởi động đi kèm màn hình Boot HUD</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button type="button" class="ats-btn ats-btn-ghost" id="ats-boot-test-sound">Nghe thử</button>
          <input type="checkbox" id="ats-boot-sound-toggle" ${state.bootSoundEnabled ? 'checked' : ''} />
        </div>
      </div>

      <div class="ats-row">
        <div class="ats-row-title">Âm lượng Boot HUD</div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" class="ats-slider" id="ats-boot-vol-slider" min="5" max="100" value="${bootVolPct}" />
          <span id="ats-boot-vol-val" style="min-width:34px;text-align:right;font-size:12px">${bootVolPct}%</span>
        </div>
      </div>

      <div class="ats-row">
        <div>
          <div class="ats-row-title">Chọn âm thanh khởi động</div>
          <div class="ats-row-sub">Dùng Sci-Fi Synth sẵn có hoặc tải giọng nói/âm thanh riêng (.mp3, .wav, .ogg)</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <select class="ats-select" id="ats-boot-audio-select" style="max-width:210px">${bootAudioOptions}</select>
          <input type="file" id="ats-boot-audio-upload" accept="audio/*" style="display:none" />
          <button type="button" class="ats-btn" id="ats-boot-audio-upload-btn">+ Tải lên</button>
        </div>
      </div>
      <div class="ats-status ${hudStatusError ? 'error' : ''}" id="ats-hud-status">${escapeHtml(hudStatusText)}</div>

      <div class="ats-row">
        <div class="ats-row-title">Tiêu đề chính</div>
        <input type="text" class="ats-input" id="ats-hud-title" value="${escapeHtml(state.bootHudTitle || '')}" style="width:280px" />
      </div>

      <div class="ats-row">
        <div class="ats-row-title">Dòng phụ (Subtitle)</div>
        <input type="text" class="ats-input" id="ats-hud-sub" value="${escapeHtml(state.bootHudSub || '')}" style="width:280px" />
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button type="button" class="ats-btn ats-btn-ghost" id="ats-hud-save">Lưu cấu hình</button>
        <button type="button" class="ats-btn" id="ats-hud-replay">▶ Phát lại Boot HUD</button>
      </div>
    `);

    panel.querySelector('#ats-hud-toggle').addEventListener('change', (e) => {
      saveState({ bootHudEnabled: e.target.checked });
    });

    panel.querySelector('#ats-boot-sound-toggle').addEventListener('change', (e) => {
      saveState({ bootSoundEnabled: e.target.checked });
    });

    panel.querySelector('#ats-boot-test-sound').addEventListener('click', () => {
      playBootAudio(true);
    });

    const bootVolSlider = panel.querySelector('#ats-boot-vol-slider');
    const bootVolVal = panel.querySelector('#ats-boot-vol-val');
    bootVolSlider.addEventListener('input', () => {
      bootVolVal.textContent = `${bootVolSlider.value}%`;
      saveState({ bootSoundVolume: Number(bootVolSlider.value) / 100 });
    });

    panel.querySelector('#ats-boot-audio-select').addEventListener('change', (e) => {
      saveState({ bootAudio: e.target.value });
      playBootAudio(true);
    });

    const bootUploadInput = panel.querySelector('#ats-boot-audio-upload');
    const hudStatusEl = panel.querySelector('#ats-hud-status');
    panel.querySelector('#ats-boot-audio-upload-btn').addEventListener('click', () => bootUploadInput.click());
    bootUploadInput.addEventListener('change', async () => {
      const file = bootUploadInput.files && bootUploadInput.files[0];
      if (!file) return;
      hudStatusError = false;
      hudStatusText = `Đang tải lên ${file.name}...`;
      hudStatusEl.className = 'ats-status';
      hudStatusEl.textContent = hudStatusText;
      try {
        const uploaded = await uploadMediaFile(file);
        saveState({ bootAudio: uploaded.url, bootSoundEnabled: true });
        hudStatusError = false;
        hudStatusText = `Đã chọn âm thanh Boot: ${uploaded.name}`;
        playBootAudio(true);
        renderHudPanel(panel);
      } catch (err) {
        hudStatusError = true;
        hudStatusText = `Lỗi: ${err.message}`;
        hudStatusEl.className = 'ats-status error';
        hudStatusEl.textContent = hudStatusText;
      }
    });

    const saveHud = () => {
      saveState({
        bootHudTitle: panel.querySelector('#ats-hud-title').value.trim() || 'ANTIGRAVITY STUDIO',
        bootHudSub: panel.querySelector('#ats-hud-sub').value.trim() || 'DARK GLASS ENGINE // READY'
      });
    };

    panel.querySelector('#ats-hud-save').addEventListener('click', saveHud);
    panel.querySelector('#ats-hud-replay').addEventListener('click', () => {
      saveHud();
      closeStudioModal();
      playBootHud(true);
    });
  }

  // --------------------------------------------------------------------------
  // 11. Lifecycle, rAF-Throttled Observer & Complete Cleanup
  // --------------------------------------------------------------------------
  function cleanup() {
    clearTitleBarTimers();
    stopBootAudio();
    stopTaskAudio();
    if (window.__ATS_TASK_TIMER__) {
      clearTimeout(window.__ATS_TASK_TIMER__);
      window.__ATS_TASK_TIMER__ = null;
    }
    if (window.__ATS_TICK_RAF__) {
      cancelAnimationFrame(window.__ATS_TICK_RAF__);
      window.__ATS_TICK_RAF__ = 0;
    }
    if (window.__ATS_MUTATION_OBSERVER__) {
      try { window.__ATS_MUTATION_OBSERVER__.disconnect(); } catch (_) {}
      window.__ATS_MUTATION_OBSERVER__ = null;
    }
    if (window.__ATS_SHELL_RO__) {
      try { window.__ATS_SHELL_RO__.disconnect(); } catch (_) {}
      window.__ATS_SHELL_RO__ = null;
    }
    if (window.__ATS_EVENT_AC__) {
      try { window.__ATS_EVENT_AC__.abort(); } catch (_) {}
      window.__ATS_EVENT_AC__ = null;
    }

    const liveBg = document.getElementById('ats-live-bg-layer');
    if (liveBg) {
      releaseVideoDecoder(liveBg.querySelector('video'));
      liveBg.remove();
    }
    ['ats-static-style', 'ats-active-theme', 'ats-sidebar-btn', 'ats-studio-fab', 'ats-settings-btn', 'ats-modal-backdrop', 'ats-boot-hud'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    document.body.classList.remove('ats-active', 'ats-ide-active');
    document.querySelectorAll('[data-ats-greeting]').forEach((el) => {
      el.removeAttribute('data-ats-greeting');
      delete el.dataset.atsGreetingOrig;
    });

    const shell = findActiveShell();
    if (shell) {
      delete shell.dataset.atsHoleActive;
      delete shell.dataset.atsSideGlass;
      shell.style.removeProperty('--ats-hole-clip');
      shell.style.removeProperty('--ats-l-glass-bg');
      shell.style.removeProperty('--ats-sidebar-w');
      shell.style.removeProperty('--ats-hdr-h');
    }

    if (window.electronNative && typeof window.electronNative.setTitleBarOverlay === 'function') {
      try {
        window.electronNative.setTitleBarOverlay({ color: '#111114', symbolColor: '#f8fafc' });
      } catch (_) {}
    }
  }

  function tick() {
    const expectedHost = isIdeHost() ? document.body : findActiveShell();
    if (expectedHost && state.wpEnabled && state.mode !== 'gradient') {
      const liveLayer = document.getElementById('ats-live-bg-layer');
      if (!liveLayer || liveLayer.tagName !== 'ATS-LIVE-BG' || liveLayer.parentElement !== expectedHost) {
        applyTheme();
      }
    }
    injectSidebarButton();
    injectSettingsButton();
    hookShellMetrics();
    syncEmptyGreeting();
    syncTaskCompletionVoice();
  }

  function scheduleTick() {
    if (window.__ATS_TICK_RAF__) return;
    window.__ATS_TICK_RAF__ = requestAnimationFrame(() => {
      window.__ATS_TICK_RAF__ = 0;
      tick();
    });
  }

  function boot() {
    // Clean up any previous hot-reloaded instance listeners & stale UI
    clearTitleBarTimers();
    if (window.__ATS_TICK_RAF__) {
      cancelAnimationFrame(window.__ATS_TICK_RAF__);
      window.__ATS_TICK_RAF__ = 0;
    }
    if (window.__ATS_MUTATION_OBSERVER__) {
      try { window.__ATS_MUTATION_OBSERVER__.disconnect(); } catch (_) {}
      window.__ATS_MUTATION_OBSERVER__ = null;
    }
    if (window.__ATS_SHELL_RO__) {
      try { window.__ATS_SHELL_RO__.disconnect(); } catch (_) {}
      window.__ATS_SHELL_RO__ = null;
    }
    if (window.__ATS_EVENT_AC__) {
      try { window.__ATS_EVENT_AC__.abort(); } catch (_) {}
    }
    ['ats-sidebar-btn', 'ats-studio-fab', 'ats-settings-btn', 'ats-modal-backdrop'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    const ac = new AbortController();
    window.__ATS_EVENT_AC__ = ac;

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && String(e.key || '').toLowerCase() === 't') {
        e.preventDefault();
        const backdrop = document.getElementById('ats-modal-backdrop');
        if (backdrop && backdrop.classList.contains('open')) closeStudioModal();
        else openStudioModal();
      } else if (e.key === 'Escape') {
        closeStudioModal();
        stopBootAudio();
        const hud = document.getElementById('ats-boot-hud');
        if (hud) hud.remove();
      } else if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'd') {
        taskAudioState.userCancelledAt = Date.now();
      }
    }, { capture: true, signal: ac.signal });

    document.addEventListener('click', (e) => {
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-testid="input-cancel-button"]')) {
        taskAudioState.userCancelledAt = Date.now();
      }
    }, { capture: true, signal: ac.signal });

    const syncVideoPlayback = () => {
      const bgVideo = document.getElementById('ats-live-bg-video');
      if (!bgVideo) return;
      if (document.hidden || !document.hasFocus()) {
        if (!bgVideo.paused) bgVideo.pause();
      } else if (state.wpEnabled && state.mode === 'video' && bgVideo.getAttribute('src')) {
        bgVideo.play().catch(() => {});
      }
    };

    window.addEventListener('resize', syncShellMetrics, { passive: true, signal: ac.signal });
    window.addEventListener('focus', () => {
      syncTitleBarOverlay();
      syncVideoPlayback();
    }, { signal: ac.signal });
    window.addEventListener('blur', syncVideoPlayback, { signal: ac.signal });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncTitleBarOverlay();
      syncVideoPlayback();
    }, { signal: ac.signal });

    applyTheme();
    playBootHud(false);

    window.__ATS_MUTATION_OBSERVER__ = new MutationObserver(scheduleTick);
    const observeRoot = document.body || document.documentElement;
    if (observeRoot) {
      window.__ATS_MUTATION_OBSERVER__.observe(observeRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-has-browser-hole', 'data-browser-hole']
      });
    }
    tick();
  }

  window.__ATS_ENGINE__ = {
    version: '2.0.0',
    reapply: applyTheme,
    openStudio: openStudioModal,
    playBootHud: () => playBootHud(true),
    testTaskSound: () => playTaskSound(true),
    cleanup
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
