/* VirCast Direct site. Vanilla JS, no build step.
   1. Scales the live demo (the real VirCast UI, 1216x900) to fit its window frame.
   2. Ticks off the "try it" checklist by reading the demo engine's state (same-origin iframe).
   3. Draws the six-lane cable diagram; clicking a cable mutes it. */
const $ = id => document.getElementById(id);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

addEventListener('scroll', () => $('nav').classList.toggle('edge', scrollY > 8), { passive: true });

/* ---------- 1. live demo scaling ---------- */
const stage = $('stage'), frame = $('demo');
function fit() { if (!stage || !stage.offsetWidth) return; const k = stage.offsetWidth / 1216; frame.style.transform = `scale(${k})`; stage.style.height = 900 * k + 'px'; }
addEventListener('resize', fit); fit();

/* ---------- 2. checklist: watch what the visitor does in the demo ---------- */
const steps = { t1: s => s.pairing.state === 'confirmed', t2: s => s.lanes.filter(l => l.running).length >= 4, t3: s => s.lanes.some(l => l.muted) };
let fxSeen = false;
setInterval(() => {
  let s; try { s = frame.contentWindow.__vc && frame.contentWindow.__vc.S; } catch (e) { return; }
  if (!s) return;
  try { if (frame.contentDocument.body.textContent.includes('Microphone effects')) fxSeen = true; } catch (e) {}
  for (const [id, done] of Object.entries(steps)) { const ok = done(s) || (id === 't3' && fxSeen); $(id).classList.toggle('done', !!ok); if (ok) $(id).querySelector('i').textContent = '✓'; }
}, 300);

/* ---------- 3. the cable diagram ---------- */
const LANES = [
  { n: 'Game audio', c: '#fa5252', tx: true }, { n: 'Microphone', c: '#228be6', tx: false }, { n: 'Discord', c: '#40c057', tx: true },
  { n: 'Music', c: '#fab005', tx: true }, { n: 'Alerts', c: '#be4bdb', tx: true }, { n: 'Browser', c: '#fd7e14', tx: true },
];
function drawCables() {
  const host = $('cables'), narrow = host.offsetWidth < 640;
  // wide: PCs as tall panels either side. narrow (phones): slim panels with the PC name running up the side.
  const W = narrow ? 420 : 1000, H = narrow ? 470 : 440, bw = narrow ? 58 : 170, L = narrow ? 4 : 20, R = W - L - bw, by = 30, bh = H - 60;
  const top = narrow ? 58 : 70, gap = narrow ? 64 : 60, x0 = L + bw, x1 = R, fs = narrow ? 17 : 15, tw = narrow ? 232 : 236, th = narrow ? 38 : 34;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  const pc = (x, name, sub, side) => narrow
    ? `<rect class="pcbox" x="${x}" y="${by}" width="${bw}" height="${bh}" rx="14"/><text class="pclabel" font-size="17" transform="translate(${x + bw / 2 + 6} ${by + bh / 2}) rotate(-90)" text-anchor="middle">${name}</text>`
    : `<rect class="pcbox" x="${x}" y="${by}" width="${bw}" height="${bh}" rx="18"/><text class="pclabel" font-size="22" x="${x + 22}" y="${by + 46}">${name}</text><text class="pcsub" font-size="15" x="${x + 22}" y="${by + 70}">${sub}</text>`;
  svg += pc(L, 'Gaming PC', '192.168.1.174') + pc(R, 'Stream PC', '192.168.1.42');
  LANES.forEach((l, i) => {
    const y = top + 30 + i * gap, mid = W / 2, sag = narrow ? 10 : 16, ty = y + sag * .75;
    const d = `M${x0} ${y} C ${x0 + (x1 - x0) * .2} ${y + sag}, ${x1 - (x1 - x0) * .2} ${y + sag}, ${x1} ${y}`;
    const dir = l.tx ? 'sends →' : '← receives';
    svg += `<g class="cable ${l.tx ? 'tx' : 'rx'}" tabindex="0" role="button" aria-pressed="false" aria-label="${l.n} lane, ${l.tx ? 'gaming PC sends to stream PC' : 'stream PC sends to gaming PC'}. Press to mute." data-i="${i}">
      <path class="wire" d="${d}" stroke="${l.c}"/><path class="flow" d="${d}"/>
      <circle class="port" cx="${x0}" cy="${y}" r="8" fill="${l.c}"/><circle class="port" cx="${x1}" cy="${y}" r="8" fill="${l.c}"/>
      <g class="tag"><rect x="${mid - tw / 2}" y="${ty - th / 2}" width="${tw}" height="${th}" rx="${th / 2}" stroke="${l.c}"/>
      <text font-size="${fs}" x="${mid - tw / 2 + 18}" y="${ty + fs * .35}">${l.n}</text><text class="dir" font-size="${fs - 2}" x="${mid + tw / 2 - 18}" y="${ty + fs * .35}" text-anchor="end">${dir}</text></g></g>`;
  });
  svg += '</svg>';
  const muted = [...host.querySelectorAll('.cable.muted')].map(g => g.dataset.i);
  host.innerHTML = svg; host.dataset.narrow = narrow;
  host.querySelectorAll('.cable').forEach(g => {
    const toggle = () => { const m = g.classList.toggle('muted'); g.setAttribute('aria-pressed', m); const l = LANES[+g.dataset.i]; g.querySelector('.dir').textContent = m ? 'muted' : (l.tx ? 'sends →' : '← receives'); };
    if (muted.includes(g.dataset.i)) toggle();
    g.addEventListener('click', toggle); g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}
drawCables();
addEventListener('resize', () => { if (String($('cables').offsetWidth < 640) !== $('cables').dataset.narrow) drawCables(); });
{ const host = $('cables');
  // only animate the signal while the diagram is on screen
  new IntersectionObserver(es => es.forEach(e => host.classList.toggle('paused', !e.isIntersecting || REDUCED))).observe(host);
}
