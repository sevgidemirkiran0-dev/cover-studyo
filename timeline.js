// Manual editing: timeline (shots, texts, audio), shot/text inspector, undo/redo,
// direct manipulation on the preview, and text rendering shared with export.

export const FONTS = [
  ['Archivo', 800, 'Poster'], ['Bebas Neue', 400, 'Afiş'], ['Playfair Display', 700, 'Zarif'],
  ['Pacifico', 400, 'El yazısı'], ['Permanent Marker', 400, 'Rock'], ['Inter', 600, 'Sade'],
];
const COLORS = ['#ffffff', '#ffd23f', '#7dff4d', '#ff4d6d', '#4dd2ff', '#000000'];
const EMOJI = ['🎤', '🎶', '❤️', '🔥', '✨', '🎸', '🌙', '💫'];
const ANIMS = [['yok', 'Yok'], ['belir', 'Belir'], ['pop', 'Pop'], ['kay', 'Kay'], ['daktilo', 'Daktilo']];
const FXN = [['shake', 'Sarsıntı'], ['rgb', 'RGB'], ['glow', 'Parlama'], ['leak', 'Işık sızıntısı'], ['vhs', 'VHS'], ['letterbox', 'Bantlar'], ['beauty', 'Cilt']];
const TRN = [[null, 'Genel'], ['kesme', 'Düz'], ['zoom', 'Zoom'], ['kaydir', 'Kaydırma'], ['glitch', 'Glitch'], ['flas', 'Flaş']];
const LOOKS = [[null, 'Genel'], [0, 'Doğal'], [1, 'Rock'], [2, 'Sinematik']];

/* ---------- text drawing (preview + export) ---------- */
const ease = (x) => { x = Math.min(1, Math.max(0, x)); const c = 1.7; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
export function drawTexts(ctx, t, W, H, texts, selId) {
  for (const T of texts) {
    if (t < T.a || t > T.b) continue;
    const fw = (FONTS.find((f) => f[0] === T.font) || FONTS[0])[1];
    const size = T.size * W, inP = Math.min(1, (t - T.a) / 0.35), outA = Math.min(1, (T.b - t) / 0.25);
    let alpha = outA, scale = 1, dy = 0, text = T.text;
    if (T.anim === 'belir') alpha *= inP;
    else if (T.anim === 'pop') { scale = 0.5 + 0.5 * ease(inP); alpha *= Math.min(1, inP * 3); }
    else if (T.anim === 'kay') { dy = (1 - ease(inP)) * H * 0.04; alpha *= inP; }
    else if (T.anim === 'daktilo') text = text.slice(0, Math.max(1, Math.floor((t - T.a) / 0.06)));
    const lines = text.split('\n');
    ctx.save(); ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `${fw} ${size}px "${T.font}", Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.translate(T.x * W, T.y * H + dy); ctx.scale(scale, scale);
    const lh = size * 1.15, wMax = Math.max(...lines.map((l) => ctx.measureText(l).width)), hT = lh * lines.length;
    if (T.box) { ctx.fillStyle = 'rgba(0,0,0,.55)'; const pd = size * 0.3; ctx.beginPath(); ctx.roundRect(-wMax / 2 - pd, -hT / 2 - pd * 0.6, wMax + 2 * pd, hT + pd * 1.2, size * 0.25); ctx.fill(); }
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = size * 0.18; ctx.shadowOffsetY = size * 0.04;
    ctx.fillStyle = T.color;
    lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lh));
    if (T.id === selId) { ctx.shadowBlur = 0; ctx.setLineDash([8, 6]); ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.strokeRect(-wMax / 2 - 8, -hT / 2 - 6, wMax + 16, hT + 12); }
    ctx.restore();
  }
}

/* ---------- ranges ---------- */
export function keepRanges(S) {
  const a0 = S.trim0 ?? 0, b0 = S.trim1 ?? S.dur;
  let out = [[a0, b0]];
  for (const k of [...(S.skips || [])].sort((x, y) => x.a - y.a)) {
    const next = [];
    for (const [a, b] of out) { if (k.b <= a || k.a >= b) next.push([a, b]); else { if (k.a > a) next.push([a, k.a]); if (k.b < b) next.push([k.b, b]); } }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.05);
}
export const skipAt = (S, t) => (S.skips || []).find((k) => t >= k.a && t < k.b - 0.02);

/* ---------- timeline UI ---------- */
export function initTimeline(api) {
  const { S, $ } = api;
  let sel = null, pps = 40;            // selection {type:'shot'|'text', i|id}; pixels per second
  const hist = [], redo = [];
  const snap = () => JSON.stringify({ shots: S.edl?.shots, skips: S.skips, texts: S.texts, audioFx: S.audioFx });
  const restore = (j) => { const o = JSON.parse(j); if (S.edl && o.shots) S.edl.shots = o.shots; S.skips = o.skips; S.texts = o.texts; S.audioFx = o.audioFx; changed(true); };
  const push = () => { hist.push(snap()); if (hist.length > 60) hist.shift(); redo.length = 0; };
  function changed(audio) { draw(); inspector(); api.onEdit(audio); }
  const ensureEdl = () => { if (!S.edl) S.edl = { shots: [{ a: 0, b: S.dur, kind: 'W', z: 1, drift: 0, cx: 0.5, cy: 0.5 }], punches: [], flashes: [], secs: [], dur: S.dur, fadeIn: 0.45, fadeOut: 1.2, hasFace: false }; S.autoOn = true; };
  const shotIdx = (t) => { const sh = S.edl.shots; let i = 0; while (i < sh.length - 1 && sh[i + 1].a <= t) i++; return i; };

  const box = $('tl'), inner = $('tlIn'), head = $('tlHead'), insp = $('insp');
  function draw() {
    if (!S.dur) return;
    ensureEdl();
    inner.style.width = Math.max(box.clientWidth, S.dur * pps) + 'px';
    const col = { W: '#5d6d7e', M: '#1f9a90', C: '#c23a52', X: '#8e6cc4' };
    let h = '';
    S.edl.shots.forEach((s, i) => {
      const skip = (S.skips || []).some((k) => k.a <= s.a + 0.01 && k.b >= s.b - 0.01), on = sel?.type === 'shot' && sel.i === i;
      const tags = [s.look != null ? '🎨' : '', s.fx ? '✨' : '', s.trans ? '↔' : '', s.gain != null && s.gain !== 1 ? '🔊' : ''].join('');
      h += `<div class="tls${on ? ' on' : ''}${skip ? ' skip' : ''}" data-i="${i}" style="left:${s.a * pps}px;width:${Math.max(4, (s.b - s.a) * pps - 2)}px;background:${col[s.custom ? 'X' : s.kind] || col.W}">${(s.b - s.a) * pps > 34 ? { W: 'Geniş', M: 'Orta', C: 'Yakın' }[s.kind] || 'Özel' : ''} ${tags}</div>`;
    });
    (S.texts || []).forEach((x) => { const on = sel?.type === 'text' && sel.id === x.id;
      h += `<div class="tlt${on ? ' on' : ''}" data-id="${x.id}" style="left:${x.a * pps}px;width:${Math.max(8, (x.b - x.a) * pps - 2)}px">${escapeHtml(x.text.split('\n')[0]).slice(0, 24)}</div>`; });
    for (const k of S.skips || []) h += `<div class="tlx" style="left:${k.a * pps}px;width:${(k.b - k.a) * pps}px"></div>`;
    if (S.trim0) h += `<div class="tlx" style="left:0;width:${S.trim0 * pps}px"></div>`;
    if (S.trim1 != null) h += `<div class="tlx" style="left:${S.trim1 * pps}px;width:${(S.dur - S.trim1) * pps}px"></div>`;
    inner.querySelector('.lanes').innerHTML = h;
    drawWave(); playhead();
  }
  function drawWave() {
    const c = $('tlWave'), dpr = devicePixelRatio || 1, W = parseFloat(inner.style.width), H = 36;
    c.style.width = W + 'px'; c.width = Math.min(16000, W * dpr); c.height = H * dpr;
    const x = c.getContext('2d'), sx = c.width / W; x.scale(sx, dpr);
    if (S.energy) { x.fillStyle = '#4a3c41'; const n = S.energy.length; x.beginPath(); x.moveTo(0, H);
      for (let px = 0; px <= W; px += 3) { const e = S.energy[Math.min(n - 1, Math.floor(px / W * n))]; x.lineTo(px, H - 2 - e * (H - 6)); } x.lineTo(W, H); x.fill(); }
    x.fillStyle = '#8a7c81'; for (const t of S.beats || []) x.fillRect(t * pps, H - 8, 1, 8);
    (S.edl?.secs || []).forEach((s) => { x.fillStyle = '#d9cfd2'; x.font = '11px Inter'; x.fillText(s.name, s.a * pps + 3, 12); });
  }
  function playhead() { head.style.left = api.time() * pps + 'px'; }
  const ROW = (t, v) => `<div class="irow"><span class="muted">${t}</span><div class="chips">${v}</div></div>`;
  const chip = (attr, val, label, on) => `<button class="chip" ${attr}="${val}" aria-pressed="${on}">${label}</button>`;
  function inspector() {
    if (!sel) { insp.innerHTML = '<p class="muted">Zaman çizelgesinde bir plana ya da yazıya dokun. Yeni yazı için "+ Yazı" düğmesini kullan.</p>'; return; }
    if (sel.type === 'shot') {
      const s = S.edl.shots[sel.i]; if (!s) { sel = null; return inspector(); }
      const skip = (S.skips || []).some((k) => k.a <= s.a + 0.01 && k.b >= s.b - 0.01), F = s.fx || S.fx;
      insp.innerHTML = `<h3>Plan ${sel.i + 1} · ${api.fmt(s.a)}–${api.fmt(s.b)}</h3>
        <div class="row"><button class="ghost small" data-act="split">✂ Oynatma çizgisinden böl</button><button class="ghost small" data-act="merge" ${sel.i ? '' : 'disabled'}>Öncekiyle birleştir</button>
        <button class="ghost small" data-act="nudge-1" ${sel.i ? '' : 'disabled'}>◀ Kesme</button><button class="ghost small" data-act="nudge1" ${sel.i ? '' : 'disabled'}>Kesme ▶</button>
        <button class="small ${skip ? '' : 'ghost'}" data-act="del">${skip ? 'Parçayı geri getir' : '🗑 Parçayı videodan çıkar'}</button></div>
        ${ROW('Kadraj', chip('data-kind', 'W', 'Geniş', s.kind === 'W' && !s.custom) + chip('data-kind', 'M', 'Orta', s.kind === 'M' && !s.custom) + chip('data-kind', 'C', 'Yakın', s.kind === 'C' && !s.custom))}
        <label class="rng">Zoom<input type="range" id="iZoom" min="100" max="250" value="${Math.round(s.z * 100)}"><output>${(s.z).toFixed(2)}×</output></label>
        <p class="muted" style="margin:4px 0 8px">Önizlemede parmağınla sürükleyerek kadrajı kaydır, iki parmakla yakınlaştır.</p>
        ${ROW('Görünüm', LOOKS.map(([v, l]) => chip('data-look', v, l, (s.look ?? null) === v)).join(''))}
        ${ROW('Efektler', chip('data-fxreset', 1, 'Genel', !s.fx) + FXN.map(([k, l]) => chip('data-sfx', k, l, !!F[k] && !!s.fx)).join(''))}
        ${ROW('Girişte geçiş', TRN.map(([v, l]) => chip('data-strans', v, l, (s.trans ?? null) === v)).join(''))}
        <label class="rng">Bu parçanın sesi<input type="range" id="iGain" min="0" max="200" value="${Math.round((s.gain ?? 1) * 100)}"><output>%${Math.round((s.gain ?? 1) * 100)}</output></label>`;
    } else {
      const T = S.texts.find((x) => x.id === sel.id); if (!T) { sel = null; return inspector(); }
      insp.innerHTML = `<h3>Yazı · ${api.fmt(T.a)}–${api.fmt(T.b)}</h3>
        <textarea id="iText" rows="2">${escapeHtml(T.text)}</textarea>
        <div class="chips" style="margin:6px 0">${EMOJI.map((e) => `<button class="chip" data-emoji="${e}">${e}</button>`).join('')}</div>
        ${ROW('Yazı tipi', FONTS.map(([f, , l]) => `<button class="chip" data-font="${f}" aria-pressed="${T.font === f}" style="font-family:'${f}'">${l}</button>`).join(''))}
        ${ROW('Renk', COLORS.map((c) => `<button class="sw" data-color="${c}" aria-pressed="${T.color === c}" style="background:${c}" aria-label="${c}"></button>`).join('') + chip('data-box', 1, 'Arka kutu', !!T.box))}
        <label class="rng">Boyut<input type="range" id="iSize" min="3" max="20" value="${Math.round(T.size * 100)}"><output>${Math.round(T.size * 100)}</output></label>
        ${ROW('Animasyon', ANIMS.map(([v, l]) => chip('data-anim', v, l, T.anim === v)).join(''))}
        <div class="row"><button class="ghost small" data-act="tstart">Başlangıç: buraya</button><button class="ghost small" data-act="tend">Bitiş: buraya</button><button class="ghost small" data-act="tdel">🗑 Yazıyı sil</button></div>
        <p class="muted" style="margin-top:6px">Önizlemede sürükleyerek yazının yerini değiştir.</p>`;
    }
  }

  /* selection and timeline gestures */
  inner.addEventListener('click', (e) => {
    const sh = e.target.closest('.tls'), tx = e.target.closest('.tlt'), r = inner.getBoundingClientRect(), t = Math.max(0, Math.min(S.dur, (e.clientX - r.left) / pps));
    if (tx) sel = { type: 'text', id: +tx.dataset.id }; else if (sh) sel = { type: 'shot', i: +sh.dataset.i }; else sel = null;
    api.seek(sel?.type === 'text' ? Math.max(t, S.texts.find((x) => x.id === sel.id).a + 0.05) : t); draw(); inspector();
  });
  $('tlZoomIn').onclick = () => { pps = Math.min(240, pps * 1.5); draw(); };
  $('tlZoomOut').onclick = () => { pps = Math.max(8, pps / 1.5); draw(); };
  $('undo').onclick = () => { if (!hist.length) return; redo.push(snap()); restore(hist.pop()); };
  $('redo').onclick = () => { if (!redo.length) return; hist.push(snap()); restore(redo.pop()); };
  $('addText').onclick = () => {
    if (!S.dur) return; push(); const t = api.time(), id = Date.now();
    S.texts.push({ id, a: t, b: Math.min(S.dur, t + 3), text: 'Yazını buraya yaz', x: 0.5, y: 0.2, size: 0.075, color: '#ffffff', font: 'Archivo', anim: 'pop', box: false });
    sel = { type: 'text', id }; changed(); setTimeout(() => { const ta = $('iText'); ta?.focus(); ta?.select(); }, 50);
  };

  /* inspector actions */
  insp.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const s = sel?.type === 'shot' ? S.edl.shots[sel.i] : null, T = sel?.type === 'text' ? S.texts.find((x) => x.id === sel.id) : null;
    push(); let audio = false;
    const act = b.dataset.act;
    if (act === 'split') { const t = api.time(), i = shotIdx(t), x = S.edl.shots[i]; if (t - x.a > 0.2 && x.b - t > 0.2) { S.edl.shots.splice(i + 1, 0, { ...x, a: t, fx: x.fx ? { ...x.fx } : null }); x.b = t; sel = { type: 'shot', i: i + 1 }; } }
    else if (act === 'merge' && sel.i > 0) { const sh = S.edl.shots; sh[sel.i - 1].b = sh[sel.i].b; sh.splice(sel.i, 1); sel.i--; }
    else if (act?.startsWith('nudge') && sel.i > 0) {
      const dir = act === 'nudge1' ? 1 : -1, sh = S.edl.shots, cur = sh[sel.i].a, lo = sh[sel.i - 1].a + 0.2, hi = sh[sel.i].b - 0.2;
      const bts = (S.beats?.length ? S.beats : Array.from({ length: Math.ceil(S.dur * 2) }, (_, k) => k / 2)).filter((t) => t > lo && t < hi);
      const nt = dir > 0 ? bts.find((t) => t > cur + 0.02) : [...bts].reverse().find((t) => t < cur - 0.02);
      if (nt != null) { sh[sel.i].a = nt; sh[sel.i - 1].b = nt; }
    }
    else if (act === 'del' && s) { const k = (S.skips ||= []).findIndex((x) => x.a <= s.a + 0.01 && x.b >= s.b - 0.01); if (k >= 0) S.skips.splice(k, 1); else S.skips.push({ a: s.a, b: s.b }); audio = true; }
    else if (b.dataset.kind && s) { Object.assign(s, api.framing(b.dataset.kind, s)); s.custom = false; }
    else if (b.dataset.look !== undefined && s) s.look = b.dataset.look === 'null' ? null : +b.dataset.look;
    else if (b.dataset.fxreset && s) s.fx = null;
    else if (b.dataset.sfx && s) { s.fx ||= { ...S.fx }; s.fx[b.dataset.sfx] = !s.fx[b.dataset.sfx]; }
    else if (b.dataset.strans !== undefined && s) s.trans = b.dataset.strans === 'null' ? null : b.dataset.strans;
    else if (b.dataset.emoji && T) T.text += ' ' + b.dataset.emoji;
    else if (b.dataset.font && T) T.font = b.dataset.font;
    else if (b.dataset.color && T) T.color = b.dataset.color;
    else if (b.dataset.box && T) T.box = !T.box;
    else if (b.dataset.anim && T) T.anim = b.dataset.anim;
    else if (act === 'tstart' && T) { T.a = Math.min(api.time(), T.b - 0.3); }
    else if (act === 'tend' && T) { T.b = Math.max(api.time(), T.a + 0.3); }
    else if (act === 'tdel' && T) { S.texts.splice(S.texts.indexOf(T), 1); sel = null; }
    else { hist.pop(); return; }
    changed(audio);
  });
  let typing = false;
  insp.addEventListener('input', (e) => {
    const s = sel?.type === 'shot' ? S.edl.shots[sel.i] : null, T = sel?.type === 'text' ? S.texts.find((x) => x.id === sel.id) : null;
    if (!typing) { push(); typing = true; setTimeout(() => { typing = false; }, 800); }
    if (e.target.id === 'iZoom' && s) { s.z = e.target.value / 100; s.custom = true; s.drift = 0; e.target.nextElementSibling.textContent = s.z.toFixed(2) + '×'; api.render(); draw(); return; }
    if (e.target.id === 'iGain' && s) { s.gain = e.target.value / 100; e.target.nextElementSibling.textContent = '%' + e.target.value; api.onEdit(true); draw(); return; }
    if (e.target.id === 'iText' && T) { T.text = e.target.value; api.render(); draw(); return; }
    if (e.target.id === 'iSize' && T) { T.size = e.target.value / 100; e.target.nextElementSibling.textContent = e.target.value; api.render(); }
  });

  /* direct manipulation on the preview */
  const view = $('view'), pts = new Map(); let g = null;
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) g = { x0: e.clientX, y0: e.clientY, moved: false, pushed: false };
    if (pts.size === 2 && g) { const [p1, p2] = [...pts.values()]; g.d0 = Math.hypot(p1.x - p2.x, p1.y - p2.y); g.z0 = sel?.type === 'shot' ? S.edl.shots[sel.i].z : sel?.type === 'text' ? S.texts.find((x) => x.id === sel.id).size : 1; }
  });
  view.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    const prev = pts.get(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 6) g.moved = true;
    if (!g.moved || !sel) return;
    if (!g.pushed) { push(); g.pushed = true; }
    const W = view.clientWidth, H = view.clientHeight, dx = (e.clientX - prev.x) / W, dy = (e.clientY - prev.y) / H;
    if (sel.type === 'text') {
      const T = S.texts.find((x) => x.id === sel.id);
      if (pts.size === 2 && g.d0) { const [p1, p2] = [...pts.values()]; T.size = Math.max(0.02, Math.min(0.25, g.z0 * Math.hypot(p1.x - p2.x, p1.y - p2.y) / g.d0)); }
      else { T.x = Math.max(0.05, Math.min(0.95, T.x + dx)); T.y = Math.max(0.05, Math.min(0.95, T.y + dy)); }
    } else {
      const s = S.edl.shots[sel.i], cov = api.cover();
      if (pts.size === 2 && g.d0) { const [p1, p2] = [...pts.values()]; s.z = Math.max(1, Math.min(2.5, g.z0 * Math.hypot(p1.x - p2.x, p1.y - p2.y) / g.d0)); }
      else { s.cx = Math.max(0, Math.min(1, s.cx - dx * cov[0] / s.z)); s.cy = Math.max(0, Math.min(1, s.cy - dy * cov[1] / s.z)); }
      s.custom = true; s.drift = 0;
    }
    api.render();
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (!pts.size && g) { if (!g.moved) api.togglePlay(); else { draw(); inspector(); } g = null; }
  };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);

  return { draw, playhead, reset: () => { sel = null; hist.length = 0; redo.length = 0; draw(); inspector(); }, selectedText: () => (sel?.type === 'text' ? sel.id : null) };
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
