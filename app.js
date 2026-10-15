(() => {
  'use strict';

  const DATA = window.GALLERY;
  const canvas = document.getElementById('gallery');
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('hint');

  // Geometry lives in "world units": one tile pitch = 1.
  const GAP = 0.03;                                // gap between tiles, share of the pitch
  const SIDE = 0.7;                                // page margin at overview, in pitches
  const TITLE = { size: 1.15, base1: -2.05, base2: -0.9, top: -4 };
  const SPLIT = [Math.log(1.05), Math.log(1.8)];   // zoom range (relative to overview) where the wall splits into groups
  const TITLE_FADE = [Math.log(1.2), Math.log(1.7)];
  const STAGGER = 0.25;                            // later groups start splitting a bit later
  const LODS = [64, 128, 256, 512, 1024, 1600];
  const MAX_LOADS = 8;
  const FONT = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // ---------- data ----------

  const groups = DATA.groups.map(g => ({
    title: g.title,
    srcs: Array.isArray(g.photos) ? g.photos : Array.from({ length: g.photos }, () => null),
  }));
  const tiles = [];
  groups.forEach((g, gi) => {
    g.first = tiles.length;
    g.srcs.forEach((src, i) => tiles.push({ g: gi, i, src, seed: `linkphotos-${gi}-${i}`, x: 0, y: 0, x0: 0, y0: 0, shown: false }));
    g.last = tiles.length - 1;
  });

  // ---------- state ----------

  let W = 0, H = 0, dpr = 1;
  let C = 21, blockCols = 2, blockW = 6;
  let S0 = 1, zMin = 0, zMax = 1;
  let z = 0, zTarget = 0, S = 1;     // z = ln(scale), scale = px per world unit
  let camX = 0, camY = 0;            // world point at the top-left corner of the screen
  let titleX = 0, titleAlpha = 1;
  const bbox = { x0: 0, x1: 0, y0: 0, y1: 0 };
  let anchor = null;                 // zoom keeps this point of a tile under the same screen point
  let vel = null;                    // pan inertia, px/ms
  let tween = null;
  let colors = {};

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = name => cs.getPropertyValue(name).trim();
    colors = { bg: v('--bg'), fg: v('--fg'), tile: v('--tile'), muted: v('--muted'), pill: v('--pill') };
  }

  // ---------- layout ----------

  function configure() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);

    C = W >= 1000 ? 21 : W >= 640 ? 16 : 12;
    // Grouped layout is sized so it roughly fills the screen once the split is complete.
    [blockCols, blockW] = C === 21 ? [2, 6] : C === 16 ? [2, 4] : [1, 6];

    S0 = W / (C + 2 * SIDE);
    const wallRows = Math.ceil(tiles.length / C);
    const fitH = H / (wallRows + SIDE - TITLE.top);
    zMin = Math.log(Math.min(S0, fitH));
    zMax = Math.log(Math.max(S0 * 2, 0.92 * Math.min(W, H)));

    tiles.forEach((t, k) => { t.x0 = k % C; t.y0 = Math.floor(k / C); });

    // Masonry: each group goes to the currently shortest column.
    const h = new Array(blockCols).fill(0);
    groups.forEach(g => {
      g.rows = Math.ceil(g.srcs.length / blockW);
      let col = 0;
      for (let c = 1; c < blockCols; c++) if (h[c] < h[col]) col = c;
      g.col = col;
      h[col] += g.rows + 1;
    });
  }

  const headingPx = () => clamp(0.34 * S, 15, 28);

  function layout() {
    const zr = z - Math.log(S0);
    const s = clamp((zr - SPLIT[0]) / (SPLIT[1] - SPLIT[0]), 0, 1);
    // Heading room and block gaps stay roughly constant on screen, so they shrink in world units as we zoom.
    const head = (headingPx() * 2.1) / S;
    const gap = clamp(0.5 * S, 20, 64) / S;
    const w1 = blockCols * blockW + (blockCols - 1) * gap;
    const ox = (C - w1) / 2;
    const colY = new Array(blockCols).fill(0);
    groups.forEach((g, gi) => {
      const delay = (STAGGER * gi) / Math.max(1, groups.length - 1);
      g.e = ease(clamp((s - delay) / (1 - STAGGER), 0, 1));
      g.bx = ox + g.col * (blockW + gap);
      g.by = colY[g.col] + head;
      colY[g.col] = g.by + g.rows + gap;
    });

    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tiles) {
      const g = groups[t.g];
      t.x = lerp(t.x0, g.bx + (t.i % blockW), g.e);
      t.y = lerp(t.y0, g.by + Math.floor(t.i / blockW), g.e);
      if (t.x < minX) minX = t.x;
      if (t.x > maxX) maxX = t.x;
      if (t.y > maxY) maxY = t.y;
    }

    titleAlpha = 1 - smooth(TITLE_FADE[0], TITLE_FADE[1], zr);
    titleX = lerp(0, ox, ease(s));
    const pad = (SIDE * S0) / S;
    bbox.x0 = Math.min(minX, titleAlpha > 0 ? titleX : Infinity) - pad;
    bbox.x1 = maxX + 1 + pad;
    bbox.y0 = lerp(-pad, TITLE.top, titleAlpha);
    bbox.y1 = maxY + 1 + pad;
  }

  // ---------- camera ----------

  function setAnchor(sx, sy) {
    const px = camX + sx / S, py = camY + sy / S;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < tiles.length; k++) {
      const t = tiles[k];
      const dx = Math.max(t.x - px, 0, px - t.x - 1);
      const dy = Math.max(t.y - py, 0, py - t.y - 1);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = k; if (d === 0) break; }
    }
    anchor = { t: best, dx: px - tiles[best].x, dy: py - tiles[best].y, sx, sy };
  }

  function applyAnchor() {
    if (!anchor) return;
    const t = tiles[anchor.t];
    camX = t.x + anchor.dx - anchor.sx / S;
    camY = t.y + anchor.dy - anchor.sy / S;
  }

  function clampCam() {
    const vw = W / S, vh = H / S;
    const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
    camX = bw <= vw ? bbox.x0 - (vw - bw) / 2 : clamp(camX, bbox.x0, bbox.x1 - vw);
    camY = bh <= vh ? bbox.y0 : clamp(camY, bbox.y0, bbox.y1 - vh);
  }

  function setZoom(v) {
    z = v;
    S = Math.exp(z);
    layout();
    applyAnchor();
    clampCam();
  }

  function zoomTo(target, sx, sy) {
    tween = null;
    vel = null;
    setAnchor(sx, sy);
    zTarget = clamp(target, zMin, zMax);
    requestFrame();
  }

  // Discrete stops for clicks, buttons and keys: overview → groups → ×2 each step.
  function stepZoom(dir, sx, sy) {
    const base = Math.log(S0), groupsZ = base + SPLIT[1];
    let target;
    if (dir > 0) target = zTarget < groupsZ - 0.01 ? groupsZ : zTarget + Math.log(2);
    else if (zTarget > groupsZ + 0.01) target = Math.max(groupsZ, zTarget - Math.log(2));
    else if (zTarget > base + 0.01) target = base;
    else target = zMin;
    zoomTo(target, sx, sy);
  }

  // Never leave the wall half-split: finish the split in the direction the user was zooming.
  let snapTimer = 0, zoomDir = 1;
  function snapSoon() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      if (pinch || drag || tween) return;
      const base = Math.log(S0);
      const zr = zTarget - base;
      if (zr <= SPLIT[0] || zr >= SPLIT[1]) return;
      setAnchor(anchor ? anchor.sx : W / 2, anchor ? anchor.sy : H / 2);
      zTarget = zoomDir > 0 ? base + SPLIT[1] : Math.max(zMin, base);
      requestFrame();
    }, 200);
  }

  function resetView() {
    vel = null;
    anchor = null;
    zTarget = Math.log(S0);
    tween = { z, camX, camY, t0: performance.now(), dur: 650 };
    requestFrame();
  }

  // ---------- images ----------

  const cache = new Map();   // url -> { el, state: 0 loading | 1 ready | -1 failed, readyAt }
  const wanted = new Map();  // url -> { t, prio }, rebuilt every frame
  let loading = 0;

  const urlFor = (t, size) =>
    t.src ? t.src.replace('{size}', size) : `https://picsum.photos/seed/${t.seed}/${size}/${size}`;

  function lodIndex(px) {
    for (let i = 0; i < LODS.length; i++) if (LODS[i] >= px) return i;
    return LODS.length - 1;
  }

  function imageFor(t, li, prio) {
    const url = urlFor(t, LODS[li]);
    const e = cache.get(url);
    if (e && e.state === 1) return e;
    if (!e && !wanted.has(url)) wanted.set(url, { t, prio });
    for (let i = li - 1; i >= 0; i--) {
      const f = cache.get(urlFor(t, LODS[i]));
      if (f && f.state === 1) return f;
    }
    for (let i = li + 1; i < LODS.length; i++) {
      const f = cache.get(urlFor(t, LODS[i]));
      if (f && f.state === 1) return f;
    }
    return null;
  }

  function load(url, t) {
    const el = new Image();
    const e = { el, state: 0, readyAt: 0 };
    cache.set(url, e);
    loading++;
    el.decoding = 'async';
    el.onload = () => {
      const done = () => {
        e.state = 1;
        e.readyAt = t.shown ? 0 : performance.now();  // fade in only the first image of a tile
        t.shown = true;
        loading--;
        requestFrame();
      };
      el.decode ? el.decode().then(done, done) : done();
    };
    el.onerror = () => { e.state = -1; loading--; requestFrame(); };
    el.src = url;
  }

  function pump() {
    while (loading < MAX_LOADS && wanted.size) {
      let bestUrl = null, best = Infinity;
      for (const [url, w] of wanted) if (w.prio < best) { best = w.prio; bestUrl = url; }
      const w = wanted.get(bestUrl);
      wanted.delete(bestUrl);
      load(bestUrl, w.t);
    }
  }

  function drawCover(img, x, y, w, h) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    let sw = iw, sh = ih;
    if (iw / ih > w / h) sw = (ih * w) / h; else sh = (iw * h) / w;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }

  // ---------- drawing ----------

  function draw(now) {
    let animating = false;
    wanted.clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);

    if (titleAlpha > 0.01) {
      const fs = TITLE.size * S;
      const x = (titleX - camX) * S;
      ctx.globalAlpha = titleAlpha;
      ctx.fillStyle = colors.fg;
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.letterSpacing = `${(-0.03 * fs).toFixed(2)}px`;
      ctx.fillText(DATA.title[0], x, (TITLE.base1 - camY) * S);
      ctx.fillText(DATA.title[1], x, (TITLE.base2 - camY) * S);
      ctx.letterSpacing = '0px';
      ctx.globalAlpha = 1;
    }

    const gapPx = Math.max(1, GAP * S);
    const size = S - gapPx;
    const li = lodIndex(size * dpr);
    const r = v => Math.round(v * dpr) / dpr;
    for (const t of tiles) {
      const x = (t.x - camX) * S, y = (t.y - camY) * S;
      if (x > W || y > H || x + size < 0 || y + size < 0) continue;
      const x0 = r(x), y0 = r(y), w = r(x + size) - x0, h = r(y + size) - y0;
      const img = imageFor(t, li, Math.hypot(x + size / 2 - W / 2, y + size / 2 - H / 2));
      const a = img && img.readyAt ? clamp((now - img.readyAt) / 220, 0, 1) : 1;
      if (!img || a < 1) {
        ctx.fillStyle = colors.tile;
        ctx.fillRect(x0, y0, w, h);
      }
      if (img) {
        if (a < 1) { ctx.globalAlpha = a; animating = true; }
        drawCover(img.el, x0, y0, w, h);
        ctx.globalAlpha = 1;
      }
    }

    drawHeadings();
    return animating;
  }

  function drawHeadings() {
    const f = headingPx();
    const pinTop = f + 14;
    ctx.letterSpacing = `${(-0.01 * f).toFixed(2)}px`;
    for (const g of groups) {
      if (g.e < 0.4) continue;
      const first = tiles[g.first], last = tiles[g.last];
      const left = (first.x - camX) * S;
      const right = (first.x + blockW - camX) * S;
      const top = (first.y - camY) * S;
      const bottom = (last.y + 1 - camY) * S;
      if (bottom < 0 || top - 2 * f > H || right < 0 || left > W) continue;

      ctx.font = `600 ${f}px ${FONT}`;
      const tw = ctx.measureText(g.title).width;
      const count = String(g.srcs.length);
      ctx.font = `500 ${f}px ${FONT}`;
      const cw = ctx.measureText(count).width;
      const total = tw + f * 0.4 + cw;

      // Stick the heading to the top while its group fills the screen.
      let y = top - f * 0.6;
      const pinned = y < pinTop && g.e > 0.99;
      if (pinned) y = Math.min(pinTop, bottom - f * 0.5);
      // slide the heading in when its block is partly off the left edge
      const x = clamp(16, left, Math.max(left, right - total - 16));

      ctx.globalAlpha = smooth(0.4, 1, g.e);
      if (pinned) {
        const px = 12, h = f * 1.6;
        ctx.fillStyle = colors.pill;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x - px, y - f * 1.1, total + 2 * px, h, h / 2);
        else ctx.rect(x - px, y - f * 1.1, total + 2 * px, h);
        ctx.fill();
      }
      ctx.font = `600 ${f}px ${FONT}`;
      ctx.fillStyle = colors.fg;
      ctx.fillText(g.title, x, y);
      ctx.font = `500 ${f}px ${FONT}`;
      ctx.fillStyle = colors.muted;
      ctx.fillText(count, x + tw + f * 0.4, y);
    }
    ctx.globalAlpha = 1;
    ctx.letterSpacing = '0px';
  }

  // ---------- frame loop ----------

  let raf = 0, last = 0;

  function requestFrame() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(now - last, 50) : 16;
    last = now;
    let active = false;

    if (tween) {
      const p = ease(clamp((now - tween.t0) / tween.dur, 0, 1));
      z = lerp(tween.z, zTarget, p);
      S = Math.exp(z);
      layout();
      camX = lerp(tween.camX, -SIDE, p);
      camY = lerp(tween.camY, TITLE.top, p);
      clampCam();
      if (p < 1) active = true; else tween = null;
    } else if (Math.abs(zTarget - z) > 1e-4) {
      setZoom(z + (zTarget - z) * (1 - Math.exp(-dt / 70)));
      active = true;
    } else if (z !== zTarget) {
      setZoom(zTarget);
    }

    if (vel) {
      const bx = camX - (vel.x * dt) / S, by = camY - (vel.y * dt) / S;
      camX = bx; camY = by;
      clampCam();
      if (camX !== bx) vel.x = 0;
      if (camY !== by) vel.y = 0;
      const k = Math.exp(-dt / 325);
      vel.x *= k; vel.y *= k;
      if (Math.hypot(vel.x, vel.y) < 0.02) vel = null; else active = true;
    }

    if (draw(now)) active = true;
    pump();
    canvas.classList.toggle('max', z >= zMax - 0.01);
    if (active) requestFrame(); else last = 0;
  }

  // ---------- input ----------

  let hintHidden = false;
  function hideHint() {
    if (hintHidden) return;
    hintHidden = true;
    hint.classList.add('hidden');
  }

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const dx = clamp(e.deltaX * unit, -200, 200), dy = clamp(e.deltaY * unit, -200, 200);
    hideHint();
    if (e.ctrlKey) {
      // trackpad pinch in Chrome/Firefox
      zoomDir = -Math.sign(dy) || zoomDir;
      zoomTo(zTarget - dy * 0.01, e.clientX, e.clientY);
      snapSoon();
    } else if (Math.abs(dx) > Math.abs(dy)) {
      vel = null;
      camX += dx / S;
      clampCam();
      requestFrame();
    } else {
      // scrolling down moves "into" the gallery
      zoomDir = Math.sign(dy) || zoomDir;
      zoomTo(zTarget + dy * 0.0025, e.clientX, e.clientY);
      snapSoon();
    }
  }, { passive: false });

  const pointers = new Map();
  let drag = null, pinch = null;

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tween = null;
    vel = null;
    zTarget = z;
    anchor = null;
    hideHint();
    const now = performance.now();
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, t: now, lt: now, moved: 0, vx: 0, vy: 0 };
    } else if (pointers.size === 2) {
      drag = null;
      const p = pinchState();
      pinch = { d: p.d, z };
      setAnchor(p.x, p.y);
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const p = pinchState();
      anchor.sx = p.x;
      anchor.sy = p.y;
      const next = clamp(pinch.z + Math.log(p.d / pinch.d), zMin, zMax);
      if (next !== zTarget) zoomDir = Math.sign(next - zTarget);
      zTarget = next;
      setZoom(zTarget);
      requestFrame();
    } else if (drag) {
      const now = performance.now();
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      const dtm = Math.max(1, now - drag.lt);
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.lt = now;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.vx = 0.7 * (dx / dtm) + 0.3 * drag.vx;
      drag.vy = 0.7 * (dy / dtm) + 0.3 * drag.vy;
      camX -= dx / S;
      camY -= dy / S;
      clampCam();
      if (drag.moved > 6) canvas.classList.add('dragging');
      requestFrame();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        snapSoon();
        if (pointers.size === 1) {
          // keep panning with the remaining finger, but never treat it as a tap
          const [p] = pointers.values();
          const now = performance.now();
          drag = { x: p.x, y: p.y, t: 0, lt: now, moved: Infinity, vx: 0, vy: 0 };
        }
      }
      return;
    }
    if (!drag || pointers.size) return;
    canvas.classList.remove('dragging');
    const now = performance.now();
    if (e.type === 'pointerup' && drag.moved < 6 && now - drag.t < 350) {
      stepZoom(1, e.clientX, e.clientY);
    } else if (now - drag.lt < 80) {
      vel = { x: drag.vx, y: drag.vy };
      requestFrame();
    }
    drag = null;
    snapSoon();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Safari trackpad pinch (iOS pinch is handled by pointer events above).
  let gesture = null;
  document.addEventListener('gesturestart', e => {
    e.preventDefault();
    if (pointers.size >= 2) return;
    gesture = { z };
    tween = null;
    vel = null;
    setAnchor(e.clientX ?? W / 2, e.clientY ?? H / 2);
    hideHint();
  });
  document.addEventListener('gesturechange', e => {
    e.preventDefault();
    if (!gesture || pointers.size >= 2) return;
    if (e.clientX != null) { anchor.sx = e.clientX; anchor.sy = e.clientY; }
    const next = clamp(gesture.z + Math.log(e.scale), zMin, zMax);
    if (next !== zTarget) zoomDir = Math.sign(next - zTarget);
    zTarget = next;
    requestFrame();
  });
  document.addEventListener('gestureend', e => {
    e.preventDefault();
    if (gesture) snapSoon();
    gesture = null;
  });

  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (e.key === '+' || e.key === '=') stepZoom(1, W / 2, H / 2);
    else if (e.key === '-' || e.key === '_') stepZoom(-1, W / 2, H / 2);
    else if (e.key === '0') resetView();
    else if (step) { tween = null; vel = { x: -step[0] * 1.6, y: -step[1] * 1.6 }; requestFrame(); }
    else return;
    e.preventDefault();
    hideHint();
  });

  document.getElementById('zoomIn').addEventListener('click', () => { hideHint(); stepZoom(1, W / 2, H / 2); });
  document.getElementById('zoomOut').addEventListener('click', () => { hideHint(); stepZoom(-1, W / 2, H / 2); });
  document.getElementById('reset').addEventListener('click', () => { hideHint(); resetView(); });

  window.addEventListener('resize', () => {
    // keep whatever is in the middle of the screen in the middle
    setAnchor(W / 2, H / 2);
    const a = anchor;
    const rel = z - Math.log(S0);
    configure();
    tween = null;
    vel = null;
    anchor = { ...a, sx: W / 2, sy: H / 2 };
    zTarget = clamp(Math.log(S0) + rel, zMin, zMax);
    setZoom(zTarget);
    anchor = null;
    requestFrame();
  });

  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  (scheme.addEventListener ? scheme.addEventListener.bind(scheme, 'change') : scheme.addListener.bind(scheme))(() => {
    readColors();
    requestFrame();
  });

  // ---------- start ----------

  readColors();
  configure();
  z = zTarget = Math.log(S0);
  S = S0;
  layout();
  camX = -SIDE;
  camY = TITLE.top;
  clampCam();
  requestFrame();

  if (document.fonts) {
    document.fonts.load(`600 32px ${FONT}`, 'Что в галерее').then(requestFrame, () => {});
    document.fonts.load(`500 32px ${FONT}`, '0123456789').then(requestFrame, () => {});
  }
})();
