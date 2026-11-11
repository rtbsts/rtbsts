/* ==========================================================================
   Rita Bastos — main.js  (no dependencies apart from Lenis)
   ========================================================================== */
(() => {
  'use strict';

  const root = document.documentElement;
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 0a. Touch screens: scroll effects run in CSS -----------------
     Phones scroll outside JavaScript, so effects updated from JS lag a frame
     behind and the images seem to shake. Where the browser supports
     scroll-driven animations, parallax and the side-margin bleed are done
     in CSS instead (class "sdt"), in step with the scroll. */
  const touch = matchMedia('(hover: none), (pointer: coarse)').matches;
  const sdt = touch && window.CSS && CSS.supports('animation-timeline: view()') && CSS.supports('animation-range: cover 5vh cover 55vh');
  if (sdt) root.classList.add('sdt');

  /* ---------- 0. Smooth scrolling (Lenis), mouse/trackpad only ----------- */
  let lenis = null;
  if (!reduceMotion && window.Lenis && matchMedia('(hover: hover) and (pointer: fine)').matches
      && !document.body.classList.contains('page-playground')) {
    lenis = new window.Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 1 });
    const raf = t => { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    if (root.classList.contains('is-loading')) lenis.stop();
  }

  /* ---------- 0b. New pages always open at the top ----------------- */
  // (when going "back", the browser still restores the previous position)
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.type === 'navigate' && !location.hash) {
      const toTop = () => { scrollTo(0, 0); if (lenis) lenis.scrollTo(0, { immediate: true, force: true }); };
      toTop();
      addEventListener('load', () => { toTop(); setTimeout(toTop, 60); }, { once: true });
    }
  } catch (e) {}

  /* ---------- 1. Variables from data-* (the CSP does not allow style="") --- */
  $$('[data-i]').forEach(el => el.style.setProperty('--i', el.dataset.i));
  $$('[data-color]').forEach(el => el.style.setProperty('--ph', el.dataset.color));

  /* ---------- 2. Images: fade/blur in once loaded ------------------------ */
  const markLoaded = el => el.classList.add('is-loaded');
  $$('img.media__el').forEach(img => {
    if (img.complete && img.naturalWidth) markLoaded(img);
    else {
      img.addEventListener('load', () => markLoaded(img), { once: true });
      img.addEventListener('error', () => markLoaded(img), { once: true });
    }
  });

  /* ---------- 3. Videos (converted GIFs and self-hosted videos) ---------- */
  const videos = $$('video.media__el');
  const videoIO = new IntersectionObserver(entries => {
    entries.forEach(({ target: v, isIntersecting }) => {
      if (isIntersecting) {
        if (!v.src) {
          v.src = v.dataset.src;
          v.addEventListener('loadeddata', () => markLoaded(v), { once: true });
        }
        v.play().catch(() => {});
      } else if (!v.paused) v.pause();
    });
  }, { rootMargin: '200px 0px' });
  videos.forEach(v => {
    // the poster shows straight away
    v.addEventListener('loadedmetadata', () => markLoaded(v), { once: true });
    if (v.poster) { const p = new Image(); p.onload = () => markLoaded(v); p.src = v.poster; }
    videoIO.observe(v);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) videos.forEach(v => v.pause());
  });

  /* ---------- 4. Reveal on scroll ---------------------------------------- */
  const startReveals = () => {
    const targets = $$('[data-reveal]');
    if (reduceMotion) { targets.forEach(t => t.classList.add('is-in')); return; }
    const io = new IntersectionObserver(entries => {
      // slight stagger between elements that enter at the same time
      entries.filter(e => e.isIntersecting).forEach((e, i) => {
        e.target.style.setProperty('--d', `${Math.min(i, 4) * 90}ms`);
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
    targets.forEach(t => io.observe(t));
  };

  /* ---------- 5. Loader (first visit of the session only) --------------- */
  const loaderEl = document.querySelector('.loader');
  const runLoader = () => {
    // "important" images: the first visible ones
    const critical = $$('img.media__el, .pg__img').slice(0, 3);
    let done = 0, finished = false;
    // only animate the name once the font is ready (avoids a typeface "jump")
    const fontsReady = () => loaderEl.classList.add('fonts-ready');
    (document.fonts ? document.fonts.load('1em "Neue Montreal"') : Promise.resolve())
      .then(fontsReady, fontsReady);
    setTimeout(fontsReady, 800);
    const start = performance.now();
    const MIN = 1400, MAX = 6000;     // let the name land; never wait forever

    const check = () => {
      if (finished) return;
      const elapsed = performance.now() - start;
      if ((done >= critical.length && elapsed >= MIN) || elapsed >= MAX) { finished = true; leave(); }
      else setTimeout(check, 100);
    };
    critical.forEach(img => {
      img.loading = 'eager';
      if (img.complete && img.naturalWidth) done++;
      else {
        img.addEventListener('load', () => done++, { once: true });
        img.addEventListener('error', () => done++, { once: true });
      }
    });
    check();

    function leave() {
      try { sessionStorage.setItem('rb-intro', '1'); } catch (e) {}
      loaderEl.classList.add('is-leaving');
      root.classList.remove('is-loading');
      if (lenis) lenis.start();
      startReveals();
      setTimeout(() => loaderEl.classList.remove('is-leaving'), 1100);
    }
  };

  if (root.classList.contains('is-loading') && loaderEl) runLoader();
  else startReveals();

  // never show the loader when going back (browser cache)
  addEventListener('pageshow', e => { if (e.persisted) root.classList.remove('is-loading'); });

  /* ---------- 6. "View" cursor over projects ----------------------------- */
  const cursor = document.querySelector('.cursor');
  if (cursor && matchMedia('(hover: hover) and (pointer: fine)').matches && !reduceMotion) {
    const label = cursor.querySelector('.cursor__label');
    let x = -200, y = -200, cx = x, cy = y, raf = 0;
    const loop = () => {
      cx += (x - cx) * 0.2; cy += (y - cy) * 0.2;
      cursor.style.setProperty('--x', `${cx.toFixed(1)}px`);
      cursor.style.setProperty('--y', `${cy.toFixed(1)}px`);
      raf = Math.abs(x - cx) + Math.abs(y - cy) > 0.3 ? requestAnimationFrame(loop) : 0;
    };
    addEventListener('mousemove', e => {
      x = e.clientX; y = e.clientY;
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    const update = node => {
      const t = node && node.closest && node.closest('[data-cursor], [data-cursor-off]');
      if (t && t.dataset.cursor) { label.textContent = t.dataset.cursor; cursor.classList.add('is-active'); }
      else cursor.classList.remove('is-active');
    };
    document.addEventListener('mouseover', e => update(e.target));
    // labels can change while moving inside one element (e.g. Previous / Close / Next zones)
    addEventListener('mousemove', e => { if (cursor.classList.contains('is-active')) update(e.target); }, { passive: true });
    // pages can ask for a re-check when something appears under a still mouse (e.g. a lightbox)
    document.addEventListener('cursor:refresh', () => update(document.elementFromPoint(x, y)));
    document.addEventListener('mouseleave', () => cursor.classList.remove('is-active'));
  }

  /* ---------- 7. Gentle parallax on the home banners --------------------- */
  const banners = $$('.media--banner');
  if (banners.length && !reduceMotion && !sdt) {
    let ticking = false;
    const update = () => {
      const vh = innerHeight;
      banners.forEach(b => {
        const r = b.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) return;
        const progress = (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2); // -1..1
        const img = b.querySelector('.media__el');
        if (img) img.style.setProperty('--py', `${(progress * -5).toFixed(2)}%`);
      });
      ticking = false;
    };
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  /* ---------- 7b. Images lose their side margins on scroll
     Home: all together, as soon as you start scrolling.
     Projects: each row of images opens to full width as it moves up the screen. */
  const gutter = () => parseFloat(getComputedStyle(root).getPropertyValue('--gutter')) || 20;
  const bleedHome = $$('.home .project__link');
  const bleedRows = $$('.project-page .row');
  if ((bleedHome.length || bleedRows.length) && !sdt) {
    const ease = t => 1 - Math.pow(1 - t, 3);                 // easeOutCubic
    const clamp01 = v => Math.min(Math.max(v, 0), 1);
    const set = (el, t) => {
      const v = reduceMotion ? (t > 0.5 ? 1 : 0) : ease(t);
      el.style.clipPath = `inset(0px ${(gutter() * (1 - v)).toFixed(2)}px)`;
    };
    let pending = false;
    const update = () => {
      pending = false;
      if (bleedHome.length) {
        const t = clamp01(scrollY / 260);
        bleedHome.forEach(el => set(el, t));
      }
      if (bleedRows.length) {
        const vh = innerHeight;
        bleedRows.forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.bottom < -50 || r.top > vh + 50) return;
          // 0 when the row enters at the bottom, 1 when its top reaches ~45% of the screen
          set(el, clamp01((vh * 0.95 - r.top) / (vh * 0.5)));
        });
      }
    };
    const queue = () => { if (!pending) { pending = true; requestAnimationFrame(update); } };
    addEventListener('scroll', queue, { passive: true });
    addEventListener('resize', queue);
    if (lenis) lenis.on('scroll', queue);
    update();
  }

  /* ---------- 8. Back to top -------------------------------------------- */
  $$('.to-top').forEach(b => b.addEventListener('click', () =>
    (lenis ? lenis.scrollTo(0, { duration: 1.4 }) : scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }))));

  /* ---------- 9. Contact details protected from bots -------------------- */
  const decode = s => { try { return atob(s).split('').reverse().join(''); } catch (e) { return ''; } };
  $$('.js-protected').forEach(a => {
    const value = decode(a.dataset.p);
    if (!value) return;
    a.textContent = value;
    a.href = a.dataset.kind === 'mailto' ? `mailto:${value}` : decode(a.dataset.h);
  });

  /* ---------- 10. Image protection -------------------------------------- */
  // Discourages "save image as…" and dragging. (No website can fully
  // prevent a screenshot — this stops casual copying.)
  const isMedia = t => t instanceof Element && t.closest('.media, .embed');
  document.addEventListener('contextmenu', e => { if (isMedia(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', e => { if (isMedia(e.target)) e.preventDefault(); });
})();
