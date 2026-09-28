/* VirCast Direct: scroll-driven hero scene ("two PCs, then one link").
   Scroll progress k (0..1) through #top drives everything; the scene is a pure function of k,
   plus a clock for the small living details (cable wiggle, audio pulses, meters).
   Beats: 0 tangle of cables + hum, 1 unplug, 2 search finds STREAM-PC, 3 six lanes connect, 4 audio flows, 5 hand-off. */
(() => {
  const story = document.getElementById('top'), cv = document.getElementById('scene'), g = cv.getContext('2d');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LANES = [
    { n: 'Game audio', c: '#fa5252', tx: 1 }, { n: 'Microphone', c: '#228be6', tx: 0 }, { n: 'Discord', c: '#40c057', tx: 1 },
    { n: 'Music', c: '#fab005', tx: 1 }, { n: 'Alerts', c: '#be4bdb', tx: 1 }, { n: 'Browser', c: '#fd7e14', tx: 1 },
  ];
  const F = "'Schibsted Grotesk', 'Segoe UI', sans-serif";
  const LOGO = new Image(); LOGO.src = 'media/logo_sm.png';   // the app's cat-and-signal icon, shown in each screen's header
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v)), seg = (v, a, b) => clamp((v - a) / (b - a)), lerp = (a, b, t) => a + (b - a) * t;
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, out = t => 1 - Math.pow(1 - t, 3);
  const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  let W = 0, H = 0, DPR = 1;
  function size() { DPR = Math.min(devicePixelRatio || 1, 2); W = cv.clientWidth; H = cv.clientHeight; cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); }
  addEventListener('resize', size); size();

  // scene layout: two monitors low in the frame, copy lives in the space above
  function layout() {
    const portrait = W / H < .9;
    if (portrait) {   // phones: Gaming PC above Stream PC, lanes loop around the right-hand side
      const mw = W * .58, mh = mw * .66, x = W * .07, top = H * .34;
      return { mw, mh, A: { x, y: top }, B: { x, y: top + mh + Math.max(92, H * .12) }, portrait };
    }
    // keep the monitors below the headline area (nav + copy ~ 64px + 5vh + 210px), shrinking them on short screens
    const minTop = 64 + H * .05 + 210;
    let mw = Math.min(W * .26, 480), mh = mw * .66;
    const top = Math.max(H * .6 - mh / 2, minTop), room = H - top - 70;
    if (mh > room) { mh = Math.max(room, 90); mw = mh / .66; }
    const lx = W * .085, rx = W - lx - mw;
    return { mw, mh, A: { x: lx, y: top }, B: { x: rx, y: top }, portrait };
  }
  // screen rect inside a monitor and the y of lane row i
  const screen = (m, L) => ({ x: m.x + L.mw * .035, y: m.y + L.mw * .035, w: L.mw * .93, h: L.mh - L.mw * .07 });
  const rowY = (s, i) => s.y + s.h * (.25 + i * .125);

  function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function text(s, x, y, size, weight, color, align = 'left', alpha = 1) { g.save(); g.globalAlpha *= alpha; g.font = `${weight} ${size}px ${F}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); g.restore(); }

  function monitor(m, L, name, sub, live, time, found) {
    const s = screen(m, L);
    // stand + soft floor shadow
    g.save(); g.fillStyle = '#c9cdd4'; rr(m.x + L.mw * .44, m.y + L.mh - 2, L.mw * .12, L.mh * .16, 3); g.fill();
    g.fillStyle = '#b9bec6'; rr(m.x + L.mw * .32, m.y + L.mh * 1.14, L.mw * .36, L.mh * .045, L.mh * .02); g.fill(); g.restore();
    g.save(); g.shadowColor = 'rgba(22,24,29,.28)'; g.shadowBlur = 50; g.shadowOffsetY = 24; g.fillStyle = '#1a1b1e'; rr(m.x, m.y, L.mw, L.mh, L.mw * .03); g.fill(); g.restore();
    g.fillStyle = '#141517'; rr(s.x, s.y, s.w, s.h, L.mw * .012); g.fill();
    // mini VirCast UI: title, connection chip, six lane rows with meters
    const u = s.w / 100;
    const ty = s.y + s.h * .09, lh = u * 6.2, tx = s.x + u * 4 + (LOGO.complete && LOGO.naturalWidth ? lh * 1.45 : 0);
    if (LOGO.complete && LOGO.naturalWidth) g.drawImage(LOGO, s.x + u * 3.5, ty - lh / 2, lh * 1.4, lh);
    text('VirCast', tx, ty, u * 4.2, 800, '#ffffff');
    g.font = `800 ${u * 4.2}px ${F}`; const dx = tx + g.measureText('VirCast ').width, dw = g.measureText('Direct').width;
    const grad = g.createLinearGradient(dx, 0, dx + dw, 0); grad.addColorStop(0, '#b74dff'); grad.addColorStop(1, '#42c7ff');
    text('Direct', dx, ty, u * 4.2, 800, grad);
    const chipA = found; if (chipA > 0) { g.save(); g.globalAlpha = chipA; g.fillStyle = live > 0 ? 'rgba(32,201,151,.2)' : 'rgba(250,176,5,.18)'; rr(s.x + s.w - u * 34, s.y + s.h * .045, u * 30, s.h * .09, s.h * .045); g.fill();
      text(live > 0 ? 'Connected' : 'Found', s.x + s.w - u * 19, s.y + s.h * .09, u * 3.1, 700, live > 0 ? '#63e6be' : '#ffd43b', 'center'); g.restore(); }
    LANES.forEach((l, i) => {
      const y = rowY(s, i), h = s.h * .085;
      g.fillStyle = '#1f2024'; rr(s.x + u * 3, y - h / 2, s.w - u * 6, h, h * .25); g.fill();
      g.fillStyle = l.c; g.fillRect(s.x + u * 3, y - h / 2, u * .9, h);
      text(l.n, s.x + u * 6, y, u * 3.1, 600, '#c1c2c5');
      // meter: moves only once audio is live
      const mx = s.x + u * 38, mwid = u * 44; g.fillStyle = '#2c2e33'; rr(mx, y - h * .14, mwid, h * .28, h * .14); g.fill();
      if (live > 0) { const lv = .35 + .3 * Math.sin(time * (2 + i * .37) + i) + .2 * Math.sin(time * 5.3 + i * 2); g.fillStyle = l.c; rr(mx, y - h * .14, mwid * clamp(lv) * live, h * .28, h * .14); g.fill(); }
      const dot = live > 0 ? l.c : '#3a3d44'; g.fillStyle = dot; g.beginPath(); g.arc(s.x + s.w - u * 7, y, h * .16, 0, 7); g.fill();
    });
    text(name, m.x + L.mw / 2, m.y + L.mh * 1.3, Math.max(14, L.mw * .045), 800, '#16181d', 'center');
    text(sub, m.x + L.mw / 2, m.y + L.mh * 1.3 + Math.max(18, L.mw * .05), Math.max(12, L.mw * .032), 500, '#555a66', 'center');
  }
  // ports: where each lane row leaves the monitor's inner edge
  const portA = (L, i) => ({ x: L.A.x + L.mw, y: rowY(screen(L.A, L), i) });
  const portB = (L, i) => ({ x: L.portrait ? L.B.x + L.mw : L.B.x, y: rowY(screen(L.B, L), i) });
  // the path a lane cable takes: straight-ish across on desktop, a nested loop round the right side on phones
  function lanePath(L, i) {
    const a = portA(L, i), b = portB(L, i);
    if (L.portrait) { const room = W - a.x, dx = room * (.3 + (5 - i) * .11); return [a, { x: a.x + dx, y: a.y }, { x: b.x + dx, y: b.y }, b]; }
    const span = b.x - a.x, sag = L.mh * .05; return [a, { x: a.x + span * .3, y: a.y + sag }, { x: b.x - span * .3, y: b.y + sag }, b];
  }
  const bez = (p0, c0, c1, p1, t) => { const u = 1 - t; return { x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x, y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y }; };
  function strokeBez(p0, c0, c1, p1, from, to, color, width, alpha = 1) {
    if (to <= from) return; g.save(); g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.beginPath();
    const n = 48; for (let j = 0; j <= n; j++) { const t = lerp(from, to, j / n), p = bez(p0, c0, c1, p1, t); j ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); } g.stroke(); g.restore();
  }

  // where the "found" card goes: under the visible headline if it fits above the monitors,
  // otherwise between/over them. copyBottom is measured from the DOM every frame (screens of any shape).
  let copyBottom = 0;
  function cardY(L, ch) {
    if (L.portrait) return L.A.y + L.mh / 2 - ch / 2;
    const above = L.A.y - ch - L.mh * .12;
    if (above >= copyBottom + 12) return above;
    return L.A.y + L.mh / 2 - ch / 2;   // not enough room: sit in the middle, between the two monitors
  }
  function draw(k, time) {
    g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, W, H);
    const rise = ease(seg(k, .015, .09)); if (rise <= 0) return;
    g.globalAlpha = rise; g.translate(0, (1 - rise) * H * .25);
    const L = layout(), lw = Math.max(3, L.mw * .012);
    const found = seg(k, .38, .44), live = seg(k, .7, .76);

    // --- beat 0-1: the usual tangle, then it pulls back into the ports
    const tangleIn = seg(k, 0, .06), unplug = ease(seg(k, .24, .34)), tangle = tangleIn * (1 - unplug);
    if (tangle > 0) {
      for (let c = 0; c < 7; c++) {
        const i = c % 6, j = (c * 4 + 1) % 6, a = portA(L, i), b = portB(L, j), mid = (a.x + b.x) / 2, span = b.x - a.x;
        const w1 = Math.sin(time * .9 + c) * H * .03, w2 = Math.cos(time * .7 + c * 2) * H * .03;
        const c0 = L.portrait ? { x: a.x + (W - a.x) * (.4 + hash(c) * .9), y: a.y + (hash(c + 9) - .5) * H * .35 + w1 } : { x: a.x + span * (.2 + hash(c) * .5), y: a.y + (hash(c + 9) - .3) * H * .5 + w1 };
        const c1 = L.portrait ? { x: b.x + (W - b.x) * (.2 + hash(c + 3) * .9), y: b.y - (hash(c + 5) - .5) * H * .35 + w2 } : { x: b.x - span * (.2 + hash(c + 3) * .5), y: b.y - (hash(c + 5) - .6) * H * .5 + w2 };
        // unplugging: the cable retracts toward its left port
        strokeBez(a, c0, c1, b, 0, 1 - unplug, '#9aa0aa', lw * .8, tangleIn);
      }
      // hum between them: a jagged red waveform
      const hx0 = L.portrait ? L.A.x : lerp(portA(L, 0).x, portB(L, 0).x, .28), hx1 = L.portrait ? L.A.x + L.mw : lerp(portA(L, 0).x, portB(L, 0).x, .72);
      const hy = L.portrait ? L.A.y - 34 : L.A.y - L.mh * .28;
      g.save(); g.globalAlpha = tangle; g.strokeStyle = '#fa5252'; g.lineWidth = 2; g.beginPath();
      for (let x = hx0; x <= hx1; x += 3) { const t = (x - hx0) / (hx1 - hx0), y = hy + Math.sin(t * 60 + time * 30) * 8 * Math.sin(t * Math.PI) + (hash(Math.floor(x + time * 40)) - .5) * 10 * Math.sin(t * Math.PI); x === hx0 ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.stroke(); g.restore();
      text('60 Hz hum', (hx0 + hx1) / 2, hy - 26, Math.max(12, L.mw * .03), 700, '#e03131', 'center', tangle);
    }

    // --- beat 2: radar ripples from the gaming PC, then the found card
    const search = seg(k, .3, .46);
    if (search > 0 && search < 1) {
      const c = { x: L.A.x + L.mw / 2, y: L.A.y + L.mh / 2 };
      for (let r = 0; r < 3; r++) { const p = (search * 2.2 + r / 3) % 1, rad = lerp(L.mw * .3, W * .55, p);
        g.save(); g.globalAlpha = (1 - p) * .5 * Math.sin(search * Math.PI); g.strokeStyle = '#7950f2'; g.lineWidth = 2; g.beginPath(); g.arc(c.x, c.y, rad, 0, 7); g.stroke(); g.restore(); }
    }
    // --- beat 3: six lanes shoot across, one after another, and get their port numbers
    LANES.forEach((l, i) => {
      const p = ease(seg(k, .48 + i * .03, .56 + i * .03)); if (p <= 0) return;
      const [a, c0, c1, b] = lanePath(L, i);
      strokeBez(a, c0, c1, b, 0, p, l.c, lw);
      [a, b].forEach((q, s) => { if (s === 1 && p < 1) return; g.fillStyle = l.c; g.beginPath(); g.arc(q.x, q.y, lw * 1.35, 0, 7); g.fill(); });
      const tagA = seg(k, .56 + i * .03, .6 + i * .03) * (1 - seg(k, .9, .96));
      if (tagA > 0 && !L.portrait) text(':' + (4010 + i), b.x - 8, b.y - lw * 2.6, Math.max(11, L.mw * .026), 700, l.c, 'right', tagA);
      // --- beat 4: audio pulses along each lane, in the direction it sends
      if (live > 0) for (let q = 0; q < 3; q++) {
        let t = ((time * .45 + q / 3 + i * .13) % 1); if (!l.tx) t = 1 - t;
        const pt = bez(a, c0, c1, b, t); g.save(); g.globalAlpha = live * Math.sin(t * Math.PI); g.fillStyle = '#ffffff'; g.shadowColor = l.c; g.shadowBlur = 12;
        g.beginPath(); g.arc(pt.x, pt.y, lw * 1.1, 0, 7); g.fill(); g.restore();
      }
    });

    monitor(L.A, L, 'Gaming PC', '192.168.1.174', live, time, found);
    monitor(L.B, L, 'Stream PC', '192.168.1.42', live, time, found);

    // found card: drawn after the monitors so it sits on top of them
    const card = out(seg(k, .4, .47)) * (1 - seg(k, .5, .55));
    if (card > 0) {
      const cw = Math.min(330, W * .78), ch = 74, cx = L.portrait ? L.A.x + L.mw / 2 - cw / 2 + W * .06 : W / 2 - cw / 2, cyy = cardY(L, ch) + (1 - card) * 30;
      g.save(); g.globalAlpha = card; g.shadowColor = 'rgba(22,24,29,.2)'; g.shadowBlur = 36; g.shadowOffsetY = 14; g.fillStyle = '#ffffff'; rr(cx, cyy, cw, ch, 16); g.fill(); g.restore();
      g.save(); g.globalAlpha = card; g.fillStyle = '#7950f2'; g.beginPath(); g.arc(cx + 34, cyy + ch / 2, 14, 0, 7); g.fill(); g.restore();
      text('✓', cx + 34, cyy + ch / 2 + 1, 16, 800, '#fff', 'center', card);
      text('STREAM-PC', cx + 60, cyy + ch / 2 - 11, 18, 800, '#16181d', 'left', card);
      text('192.168.1.42, found by name', cx + 60, cyy + ch / 2 + 13, 13.5, 500, '#555a66', 'left', card);
    }

    // --- beat 4: latency readout between the monitors
    const lat = live * (1 - seg(k, .92, .98));
    if (lat > 0) {
      const x = L.portrait ? L.A.x + L.mw / 2 : W / 2, y = L.portrait ? L.B.y + L.mh * 1.3 + 58 : L.A.y + L.mh + L.mh * .28;
      g.save(); g.globalAlpha = lat; g.fillStyle = '#16181d'; rr(x - 86, y - 20, 172, 40, 20); g.fill(); g.restore();
      g.save(); g.globalAlpha = lat; g.fillStyle = '#20c997'; g.beginPath(); g.arc(x - 60, y, 5, 0, 7); g.fill(); g.restore();
      text('Live, 50 ms', x + 8, y, 15, 700, '#ffffff', 'center', lat);
    }
  }

  // copy beats (HTML overlay) and the scroll hint follow the same k
  const intro = document.getElementById('intro'), hint = document.getElementById('hint'), beats = [...document.querySelectorAll('.story .beat')];
  let kNow = 0;
  function progress() { const r = story.getBoundingClientRect(); return clamp(-r.top / (r.height - innerHeight)); }
  function frame(now) {
    const goal = progress(); kNow = REDUCED ? goal : kNow + (goal - kNow) * .12; if (Math.abs(goal - kNow) < .0005) kNow = goal;
    const r = story.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) {
      copyBottom = 0; for (const el of [intro, ...beats]) if (+getComputedStyle(el).opacity > .05) copyBottom = Math.max(copyBottom, el.getBoundingClientRect().bottom);
      draw(REDUCED ? Math.max(kNow, .8) : kNow, REDUCED ? 1 : now / 1000);
      const f = seg(kNow, .02, .09); intro.style.opacity = 1 - f; intro.style.transform = `translateY(${-24 * f}px)`; intro.style.pointerEvents = f > .5 ? 'none' : '';
      hint.style.opacity = 1 - seg(kNow, .01, .05);
      for (const b of beats) { const a = +b.dataset.a, e = +b.dataset.b; const o = Math.min(seg(kNow, a, a + .04), 1 - seg(kNow, e - .04, e)); b.style.opacity = o; b.style.transform = `translateY(${(1 - o) * 14}px)`; b.style.pointerEvents = o > .5 ? '' : 'none'; }
    }
    requestAnimationFrame(frame);
  }
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(frame));
  window.__vcHero = { draw: (k, t) => draw(k, t), progress };
})();
