/* ==========================================================================
   Rita Bastos — edge.js
   "Ragged Edge" effect: images are drawn on a WebGL canvas over the page,
   and a full-screen distortion widens them horizontally near the bottom of
   the screen, so their edges curve as each image comes in.
   It is the same formula used on raggededge.com (CurveEffect, distance 34, strength 1):
       uv.x += (uv.x * 2 - 1) * (strength * -0.05) * pow(1 - uv.y, distance)
   Without WebGL (or with "reduce motion") the site shows the normal images.
   ========================================================================== */
(() => {
  'use strict';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Opened straight from the computer (file://): browsers block WebGL from reading
  // local images, so keep the normal images instead.
  if (location.protocol === 'file:') return;
  // Phones and tablets scroll outside JavaScript, so a canvas redrawn from JS
  // trails the page by a frame and the images shake: show the normal images there.
  if (matchMedia('(hover: none), (pointer: coarse)').matches) return;

  const STRENGTH = 1;
  const DISTANCE = 34;

  const canvas = document.createElement('canvas');
  canvas.className = 'gl-stage';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false })
          || canvas.getContext('experimental-webgl');
  if (!gl) return;

  /* ---------- shaders ---------------------------------------------------- */
  const VERT = `
    attribute vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FRAG = `
    precision highp float;
    uniform vec2  uRes;       // canvas size in device pixels
    uniform float uDpr;
    uniform vec4  uImg;       // rectangle of the drawn image (CSS px: x, y, w, h)
    uniform vec4  uClip;      // visible area (CSS px: x0, y0, x1, y1)
    uniform float uAlpha;
    uniform float uStrength;
    uniform float uDistance;
    uniform sampler2D uTex;
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;                  // 0..1, origin at the bottom
      float str = uStrength * -.05;
      uv.x += (uv.x * 2. - 1.) * str * pow(1. - uv.y, uDistance);
      vec2 css = vec2(uv.x, 1. - uv.y) * (uRes / uDpr);  // back to CSS px (origin at the top)
      if (css.x < uClip.x || css.x > uClip.z || css.y < uClip.y || css.y > uClip.w) discard;
      vec2 t = (css - uImg.xy) / uImg.zw;
      gl_FragColor = texture2D(uTex, t) * uAlpha;
    }`;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
  } catch (e) { return; }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const U = name => gl.getUniformLocation(prog, name);
  const u = { res: U('uRes'), dpr: U('uDpr'), img: U('uImg'), clip: U('uClip'), alpha: U('uAlpha'),
              str: U('uStrength'), dist: U('uDistance'), tex: U('uTex') };
  gl.uniform1i(u.tex, 0);
  gl.uniform1f(u.str, STRENGTH);
  gl.uniform1f(u.dist, DISTANCE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.SCISSOR_TEST);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  /* ---------- size ----------------------------------------------------- */
  let W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.dpr, dpr);
  };

  /* ---------- elements ------------------------------------------------ */
  const items = new Map();        // el -> { tex, src, w, h }
  const active = new Set();
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) active.add(e.target);
    else {
      active.delete(e.target);
      const it = items.get(e.target);
      if (it && it.tex) { gl.deleteTexture(it.tex); it.tex = null; it.src = ''; }   // free up memory
    }
  }), { rootMargin: '60% 0px' });

  const els = Array.from(document.querySelectorAll('img.media__el, video.media__el'));
  els.forEach(el => { items.set(el, { tex: null, src: '' }); io.observe(el); });

  const upload = (el, it) => {
    const isVideo = el.tagName === 'VIDEO';
    let source = el, w, h, src;
    if (isVideo) {
      if (el.readyState >= 2) { w = el.videoWidth; h = el.videoHeight; src = 'video'; }
      else if (el.poster) {                       // no video yet: use the poster
        if (!it.poster) { it.poster = new Image(); it.poster.src = el.poster; }
        if (!it.poster.complete || !it.poster.naturalWidth) return false;
        source = it.poster; w = source.naturalWidth; h = source.naturalHeight; src = 'poster';
      } else return false;
    } else {
      if (!el.complete || !el.naturalWidth) return false;
      w = el.naturalWidth; h = el.naturalHeight; src = el.currentSrc || el.src;
    }
    const needsNew = !it.tex;
    if (needsNew) {
      it.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, it.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else gl.bindTexture(gl.TEXTURE_2D, it.tex);
    if (needsNew || it.src !== src || src === 'video') {
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); }
      catch (e) { disable(); return false; }           // e.g. image from another origin: fall back
      it.src = src; it.w = w; it.h = h;
    }
    return true;
  };

  /* Visible area: intersection with the ancestors that clip
     (overflow hidden or clip-path: inset(...)), up to <main>. */
  const parseInset = (cp, r) => {
    const m = /^inset\(([^)]*)\)/.exec(cp);
    if (!m) return null;
    const v = m[1].split(' round')[0].trim().split(/\s+/);
    const [t, rr = t, b = t, l = rr] = v;
    const px = (s, size) => s.endsWith('%') ? parseFloat(s) / 100 * size : parseFloat(s) || 0;
    return { x0: r.left + px(l, r.width), y0: r.top + px(t, r.height),
             x1: r.right - px(rr, r.width), y1: r.bottom - px(b, r.height) };
  };
  const clipFor = el => {
    let c = { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 };
    let n = el.parentElement;
    while (n && n !== document.body && n.tagName !== 'MAIN') {
      const cs = getComputedStyle(n);
      let r = null;
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible') r = n.getBoundingClientRect();
      if (r) c = { x0: Math.max(c.x0, r.left), y0: Math.max(c.y0, r.top), x1: Math.min(c.x1, r.right), y1: Math.min(c.y1, r.bottom) };
      if (cs.clipPath && cs.clipPath !== 'none') {
        const q = parseInset(cs.clipPath, n.getBoundingClientRect());
        if (q) c = { x0: Math.max(c.x0, q.x0), y0: Math.max(c.y0, q.y0), x1: Math.min(c.x1, q.x1), y1: Math.min(c.y1, q.y1) };
      }
      n = n.parentElement;
    }
    return c;
  };

  /* ---------- drawing ---------------------------------------------------- */
  const flare = () => Math.abs(STRENGTH * 0.05) * W * 1.2;   // how far an image can "open out" sideways
  const frame = () => {
    if (stopped) return;
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (canvas.width !== Math.round(innerWidth * Math.min(devicePixelRatio || 1, 2)) || H !== innerHeight) resize();
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);

    active.forEach(el => {
      const it = items.get(el);
      if (!upload(el, it)) return;
      const cs = getComputedStyle(el);
      const alpha = parseFloat(cs.opacity);
      if (!(alpha > 0.01)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const clip = clipFor(el);
      const cx0 = Math.max(clip.x0, r.left), cy0 = Math.max(clip.y0, r.top);
      const cx1 = Math.min(clip.x1, r.right), cy1 = Math.min(clip.y1, r.bottom);
      if (cx1 <= cx0 || cy1 <= cy0 || cy1 < 0 || cy0 > H) return;

      // object-fit: cover (centred) — gives the same result for uncropped images
      const s = Math.max(r.width / it.w, r.height / it.h);
      const iw = it.w * s, ih = it.h * s;
      const ix = r.left + (r.width - iw) / 2, iy = r.top + (r.height - ih) / 2;

      // only draw where needed (with room for the widening near the bottom)
      const f = flare();
      const sx0 = Math.max(0, cx0 - f), sx1 = Math.min(W, cx1 + f);
      const sy0 = Math.max(0, cy0), sy1 = Math.min(H, cy1);
      if (sx1 <= sx0 || sy1 <= sy0) return;
      gl.scissor(Math.floor(sx0 * dpr), Math.floor((H - sy1) * dpr),
                 Math.ceil((sx1 - sx0) * dpr), Math.ceil((sy1 - sy0) * dpr));

      gl.bindTexture(gl.TEXTURE_2D, it.tex);
      gl.uniform4f(u.img, ix, iy, iw, ih);
      gl.uniform4f(u.clip, cx0, cy0, cx1, cy1);
      gl.uniform1f(u.alpha, alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
  };

  let stopped = false;
  function disable() {                                   // back to the normal HTML images
    stopped = true;
    document.documentElement.classList.remove('gl-on');
    canvas.remove();
  }

  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    document.documentElement.classList.remove('gl-on');   // fall back to the normal images
    canvas.remove();
  });

  document.body.appendChild(canvas);
  document.documentElement.classList.add('gl-on');
  resize();
  requestAnimationFrame(frame);
})();
