/* ==========================================================================
   Rita Bastos — playground.js
   An endless wall of loose images: drag, scroll or swipe in any direction.
   Images sit on three depth layers that move at slightly different speeds.
   Clicking one opens it as large as the screen allows, over a white veil.
   ========================================================================== */
(() => {
  'use strict';

  const root = document.querySelector('.pg');
  if (!root) return;
  const stage = root.querySelector('.pg__stage');
  const list = root.querySelector('.pg__items');
  const hint = root.querySelector('.pg__hint');
  const lb = root.querySelector('.pg-lb');
  const templates = Array.from(list.children);
  if (!templates.length) return;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gutter = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) || 20;

  // Unique items (data for the lightbox)
  const data = templates.map(li => {
    const btn = li.querySelector('.pg__btn');
    const img = li.querySelector('.pg__img');
    return {
      w: +img.getAttribute('width') || 4, h: +img.getAttribute('height') || 5,
      full: btn.dataset.full,
      title: li.querySelector('.pg__title').textContent,
      lines: Array.from(li.querySelectorAll('.pg__line'), n => n.textContent),
      color: li.dataset.color,
    };
  });

  /* ---------- seeded random, so the layout is the same on every visit ---- */
  const rand = seed => () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  /* ---------- layout ----------------------------------------------------- */
  // Each image gets its own cell with breathing room around it, so images don't
  // pile on top of each other. Every image appears once before any repeats, and
  // repeats are placed as far as possible from their twin (the wall wraps around).
  let cells = [];                 // { el, img, x, y, w, h, layer, idx }
  let TW = 0, TH = 0, VW = 0, VH = 0;
  // depth layers: size, and how loosely they follow the movement (felt while
  // moving; at rest all layers line up again, so spacing is preserved)
  const LAYERS = [{ s: 0.86, ease: 0.06 }, { s: 1, ease: 0.085 }, { s: 1.1, ease: 0.11 }];

  function build() {
    VW = innerWidth; VH = innerHeight;
    const portrait = VW < 760 || VH > VW;
    const cellW = portrait ? Math.max(VW * 0.58, 190) : Math.min(Math.max(VW * 0.24, 260), 470);
    const cellH = cellW * (portrait ? 1.25 : 1.12);
    const n = templates.length;
    // the wall must be wider/taller than the screen, so a repeat is never in view twice
    let cols = Math.max(3, Math.ceil(VW / cellW) + 2);
    let rows = Math.max(3, Math.ceil(VH / cellH) + 2);
    while (cols * rows < n) { if (cols * cellW <= rows * cellH) cols++; else rows++; }
    TW = cols * cellW; TH = rows * cellH;

    list.textContent = '';
    cells = [];
    const r = rand(1234);

    // fill cells in a shuffled order: least-used image first, then the one
    // farthest from its other copies (distance measured around the wrap)
    const slots = [];
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) slots.push({ col, row });
    for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    const uses = Array.from({ length: n }, () => []);
    const wrapDist = (a, b) => {
      const dx = Math.min(Math.abs(a.col - b.col), cols - Math.abs(a.col - b.col)) * cellW;
      const dy = Math.min(Math.abs(a.row - b.row), rows - Math.abs(a.row - b.row)) * cellH;
      return Math.hypot(dx, dy);
    };
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const slot of slots) {
      let best = -1, bestKey = null;
      for (const i of order) {
        const near = uses[i].length ? Math.min(...uses[i].map(u => wrapDist(u, slot))) : Infinity;
        const key = [-uses[i].length, near];
        if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = i; bestKey = key; }
      }
      uses[best].push(slot);
      slot.idx = best;
    }
    slots.sort((a, b) => a.row - b.row || a.col - b.col);

    const pad = cellW * 0.09;                       // minimum half-gap around each image
    const capRoom = 84;                             // captions are always shown: room for four lines
    for (const { col, row, idx } of slots) {
      const d = data[idx];
      const layer = Math.floor(r() * LAYERS.length);
      const ar = d.w / d.h;
      // landscape a bit wider, portrait narrower; then fit inside the cell
      let w = cellW * (ar >= 1 ? 0.62 + r() * 0.16 : 0.42 + r() * 0.14) * LAYERS[layer].s;
      let h = w / ar;
      const maxW = cellW - pad * 2, maxH = cellH - pad * 2 - capRoom;
      if (w > maxW) { w = maxW; h = w / ar; }
      if (h > maxH) { h = maxH; w = h * ar; }
      // stagger alternate columns, then place randomly inside the free space
      const shift = (col % 2) * cellH * 0.35;
      const x = col * cellW + pad + r() * (cellW - pad * 2 - w);
      const y = row * cellH + shift + pad + r() * (cellH - pad * 2 - capRoom - h);

      const el = templates[idx].cloneNode(true);
      el.dataset.n = idx;
      el.style.setProperty('--w', `${w.toFixed(1)}px`);
      el.style.setProperty('--ar', `${d.w} / ${d.h}`);
      el.style.setProperty('--ph', d.color || '#f2f2f2');
      el.style.zIndex = String(layer + 1);
      const img = el.querySelector('.pg__img');
      const done = () => img.classList.add('is-loaded');
      if (img.complete && img.naturalWidth) done(); else img.addEventListener('load', done, { once: true });
      list.appendChild(el);
      cells.push({ el, img, x, y, w, h: h + 70, layer, idx });
    }
    // staggered entrance
    cells.forEach((c, i) => setTimeout(() => c.el.classList.add('is-in'), reduceMotion ? 0 : 60 + (i % 12) * 45));
  }

  /* ---------- motion ----------------------------------------------------- */
  const target = { x: 0, y: 0 };
  const lpos = LAYERS.map(() => ({ x: 0, y: 0 }));   // each layer trails the target at its own pace
  const mod = (a, b) => ((a % b) + b) % b;
  let running = false, locked = false;

  function render() {
    let moving = false;
    lpos.forEach((p, i) => {
      const ease = reduceMotion ? 1 : LAYERS[i].ease;
      p.x += (target.x - p.x) * ease;
      p.y += (target.y - p.y) * ease;
      if (Math.abs(target.x - p.x) > 0.1 || Math.abs(target.y - p.y) > 0.1) moving = true;
      else { p.x = target.x; p.y = target.y; }
    });
    for (const c of cells) {
      const p = lpos[c.layer];
      const px = mod(c.x + p.x + c.w, TW) - c.w;
      const py = mod(c.y + p.y + c.h, TH) - c.h;
      c.px = px; c.py = py;
      c.el.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
      if (!reduceMotion) {        // subtle parallax inside each frame
        const cx = (px + c.w / 2 - VW / 2) / VW, cy = (py + c.h / 2 - VH / 2) / VH;
        c.img.style.setProperty('--px', `${(-cx * 4).toFixed(2)}%`);
        c.img.style.setProperty('--py', `${(-cy * 4).toFixed(2)}%`);
      }
    }
    if (moving) requestAnimationFrame(render);
    else running = false;
  }
  const kick = () => { if (!running) { running = true; requestAnimationFrame(render); } };
  const move = (dx, dy) => {
    if (locked) return;
    target.x += dx; target.y += dy; kick();
    if (hint && !hint.classList.contains('is-hidden')) hint.classList.add('is-hidden');
  };

  // wheel / trackpad
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 32 : 1;
    move(-e.deltaX * k, -e.deltaY * k);
  }, { passive: false });

  // drag with inertia (mouse, pen and touch)
  let drag = null;
  stage.addEventListener('pointerdown', e => {
    if (locked || e.button > 0) return;
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), vx: 0, vy: 0, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    const now = performance.now(), dt = Math.max(now - drag.t, 1);
    drag.vx = dx / dt; drag.vy = dy / dt;
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) { drag.moved = true; stage.classList.add('is-dragging'); }
    move(dx, dy);
  });
  const endDrag = e => {
    if (!drag) return;
    const d = drag; drag = null;
    stage.classList.remove('is-dragging');
    if (d.moved) {
      if (!reduceMotion) move(d.vx * 220, d.vy * 220);     // throw
    }
    suppressClick = d.moved;
  };
  let suppressClick = false;
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // keyboard: Enter/Space on a focused image opens it; arrows pan
  // open on click (mouse, touch or keyboard), but not at the end of a drag
  stage.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const btn = e.target.closest('.pg__btn')
      || document.elementsFromPoint(e.clientX, e.clientY).find(n => n.classList && n.classList.contains('pg__btn'));
    if (btn) { e.preventDefault(); openedBy = e.detail === 0 ? 'key' : 'pointer'; open(btn.closest('.pg__item')); }
  });
  let openedBy = 'pointer';
  let lastX = innerWidth / 2;
  addEventListener('mousemove', e => { lastX = e.clientX; }, { passive: true });
  addEventListener('keydown', e => {
    if (lbState) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      return;
    }
    const k = { ArrowLeft: [120, 0], ArrowRight: [-120, 0], ArrowUp: [0, 120], ArrowDown: [0, -120] }[e.key];
    if (k && !(e.target.closest && e.target.closest('input, textarea'))) { e.preventDefault(); move(k[0], k[1]); }
  });

  /* ---------- lightbox ---------------------------------------------------- */
  let lbState = null;   // { idx, img, source }
  const figure = lb.querySelector('.pg-lb__figure');
  const cap = lb.querySelector('.pg-lb__cap');
  const count = lb.querySelector('.pg-lb__count');
  const DUR = reduceMotion ? 0 : 750;
  const EASE = 'cubic-bezier(.77, 0, .18, 1)';

  function fitRect(d) {
    const g = gutter();
    const top = 70, bottom = VW < 760 || VH > VW ? 156 : 100;   // keep clear of menu and caption bar
    const aw = VW - g * 2, ah = VH - top - bottom;
    const s = Math.min(aw / d.w, ah / d.h);
    const w = d.w * s, h = d.h * s;
    return { x: (VW - w) / 2, y: top + (ah - h) / 2, w, h };
  }
  const place = (el, r) => {
    el.style.width = `${r.w}px`; el.style.height = `${r.h}px`;
    el.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
  };
  function flip(el, from, to, dur) {
    place(el, to);
    if (!dur) return Promise.resolve();
    const sx = from.w / to.w, sy = from.h / to.h;
    const a = el.animate([
      { transform: `translate3d(${from.x}px, ${from.y}px, 0) scale(${sx}, ${sy})` },
      { transform: `translate3d(${to.x}px, ${to.y}px, 0) scale(1, 1)` },
    ], { duration: dur, easing: EASE });
    return a.finished.catch(() => {});
  }
  const rectOf = el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const visibleCellFor = idx => cells.find(c => c.idx === idx && c.px > -c.w && c.px < VW && c.py > -c.h && c.py < VH);

  function fill(idx) {
    const d = data[idx];
    cap.textContent = '';
    [d.title, ...d.lines].forEach((txt, i) => {
      const s = document.createElement('span');
      s.className = i ? 'pg__line' : 'pg__title';
      s.textContent = txt;
      cap.append(s);
    });
    count.textContent = `${String(idx + 1).padStart(2, '0')} / ${String(data.length).padStart(2, '0')}`;
  }
  function makeImg(idx, startSrc) {
    const img = new Image();
    img.className = 'pg-lb__img';
    img.alt = data[idx].title;
    img.draggable = false;
    img.src = startSrc || data[idx].full;
    if (startSrc && startSrc !== data[idx].full) {          // upgrade to the sharpest file
      const hi = new Image(); hi.onload = () => { if (img.isConnected) img.src = hi.src; }; hi.src = data[idx].full;
    }
    return img;
  }

  async function open(item) {
    if (lbState || !item) return;
    locked = true;
    const idx = +item.dataset.n;
    const frame = item.querySelector('.pg__frame');
    const thumb = item.querySelector('.pg__img');
    const from = rectOf(frame);
    item.classList.add('is-source');
    lb.hidden = false;
    lb.dataset.cursor = ZONE_LABEL[zoneAt(lastX)];
    void lb.offsetWidth;                       // let the veil fade in
    root.classList.add('is-open');
    document.dispatchEvent(new Event('cursor:refresh'));
    fill(idx);
    const img = makeImg(idx, thumb.currentSrc || thumb.src);
    figure.prepend(img);
    lbState = { idx, img, t: performance.now() };
    await flip(img, from, fitRect(data[idx]), DUR);
    lb.classList.add('is-ready');
  }

  async function step(dir) {
    if (!lbState || lbState.busy) return;
    lbState.busy = true;
    const idx = mod(lbState.idx + dir, data.length);
    const old = lbState.img;
    const img = makeImg(idx);
    img.style.opacity = '0';
    place(img, fitRect(data[idx]));
    figure.prepend(img);
    fill(idx);
    const fade = (el, a, b) => el.animate([{ opacity: a }, { opacity: b }], { duration: reduceMotion ? 0 : 380, easing: 'ease', fill: 'forwards' }).finished.catch(() => {});
    await fade(old, 1, 0); old.remove();
    await new Promise(res => (img.complete ? res() : (img.onload = img.onerror = res)));
    img.style.opacity = '';
    await fade(img, 0, 1);
    lbState = { idx, img, t: 0 };
  }

  async function close() {
    if (!lbState || lbState.closing) return;
    lbState.closing = true;
    const { idx, img } = lbState;
    lb.classList.remove('is-ready');
    const cell = visibleCellFor(idx);
    root.classList.remove('is-open');
    if (cell && DUR) {
      await flip(img, rectOf(img), rectOf(cell.el.querySelector('.pg__frame')), DUR * 0.85);
    } else if (DUR) {
      await img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: 'forwards' }).finished.catch(() => {});
    }
    img.remove();
    root.querySelectorAll('.is-source').forEach(n => n.classList.remove('is-source'));
    lb.hidden = true;
    lbState = null;
    locked = false;
    document.dispatchEvent(new Event('cursor:refresh'));
    if (openedBy !== 'key' && document.activeElement) document.activeElement.blur();
  }

  // with a mouse, the screen is split in three: left = Previous, middle = Close, right = Next
  // (the cursor label follows the zone); on touch screens a tap closes and a swipe changes image
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const zoneAt = x => (!finePointer.matches ? 'close' : x < VW * 0.3 ? 'prev' : x > VW * 0.7 ? 'next' : 'close');
  const ZONE_LABEL = { prev: 'Previous', next: 'Next', close: 'Close' };
  lb.addEventListener('mousemove', e => { lb.dataset.cursor = ZONE_LABEL[zoneAt(e.clientX)]; });
  lb.addEventListener('click', e => {
    if (lbState && performance.now() - (lbState.t || 0) < 350) return;   // the click that opened it
    const a = e.target.closest('[data-lb]');
    const zone = a ? a.dataset.lb : e.target.closest('.pg-lb__bar, .pg-lb__cap') ? null : zoneAt(e.clientX);
    if (!zone) return;
    e.stopPropagation();
    zone === 'close' ? close() : step(zone === 'next' ? 1 : -1);
  });
  // swipe between images on touch screens
  let sw = null;
  lb.addEventListener('touchstart', e => { sw = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', e => {
    if (sw == null) return;
    const dx = e.changedTouches[0].clientX - sw; sw = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });

  /* ---------- start ------------------------------------------------------ */
  // centre the first view on the middle of the wall
  build();
  target.x = -(TW - VW) / 2 * 0.5;
  target.y = -(TH - VH) / 2 * 0.5;
  lpos.forEach(p => { p.x = target.x; p.y = target.y; });
  render();
  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (!lbState) { build(); render(); } else if (lbState) place(lbState.img, fitRect(data[lbState.idx])); }, 150);
  });
})();
