// Automatic edit: analyses picture (faces, exposure, colour) and music (sections, bars)
// and builds an edit decision list of virtual camera shots, punches, flashes and fades.
import { CanvasSink } from './vendor/mediabunny.min.mjs';

/* ---------- face detector (loaded lazily, falls back to centre framing) ---------- */
let detectorP = null;
function getDetector() {
  if (!detectorP) detectorP = (async () => {
    try {
      const { FilesetResolver, FaceDetector } = await import('./vendor/mediapipe/vision_bundle.mjs');
      const base = new URL('./vendor/mediapipe/', import.meta.url).href;
      const fs = await FilesetResolver.forVisionTasks(base + 'wasm');
      return await FaceDetector.createFromOptions(fs, {
        baseOptions: { modelAssetPath: base + 'blaze_face_short_range.tflite', delegate: 'CPU' },
        runningMode: 'IMAGE', minDetectionConfidence: 0.45,
      });
    } catch (e) { console.warn('Yüz algılama yüklenemedi', e); return null; }
  })();
  return detectorP;
}

/* ---------- picture analysis ---------- */
export async function analyzePicture(track, dur, onProgress) {
  const det = await getDetector();
  const dw = track.displayWidth, dh = track.displayHeight;
  const tw = 360, th = Math.round(360 * dh / dw);
  const sink = new CanvasSink(track, { width: tw, height: th, fit: 'fill', poolSize: 2 });
  const step = Math.max(0.5, dur / 160), times = [];
  for (let t = 0.05; t < dur; t += step) times.push(t);
  const scratch = document.createElement('canvas'); scratch.width = 64; scratch.height = Math.max(1, Math.round(64 * th / tw));
  const sx = scratch.getContext('2d', { willReadFrequently: true });
  const samples = [], hist = new Float64Array(64); let sr = 0, sg = 0, sb = 0, n = 0, i = 0, qr = 0, qg = 0, qb = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    const t = times[i++]; onProgress?.(i / times.length);
    if (!wc) continue;
    sx.drawImage(wc.canvas, 0, 0, scratch.width, scratch.height);
    const px = sx.getImageData(0, 0, scratch.width, scratch.height).data;
    for (let k = 0; k < px.length; k += 4) { const r = px[k] / 255, g = px[k + 1] / 255, b = px[k + 2] / 255;
      sr += r; sg += g; sb += b; qr += r * r; qg += g * g; qb += b * b; n++; hist[Math.min(63, Math.floor((0.2126 * r + 0.7152 * g + 0.0722 * b) * 64))]++; }
    let face = null;
    if (det) {
      try {
        const res = det.detect(wc.canvas);
        for (const d of res.detections || []) { const bb = d.boundingBox, sc = d.categories?.[0]?.score ?? 0; if (!bb) continue;
          const f = { x: (bb.originX + bb.width / 2) / tw, y: (bb.originY + bb.height / 2) / th, w: bb.width / tw, s: sc * bb.width };
          if (!face || f.s > face.s) face = f; }
      } catch (e) { /* skip frame */ }
    }
    samples.push({ t, face });
  }
  // levels and white balance from the luminance histogram and grey-world averages
  const pct = (p) => { let acc = 0; const tot = hist.reduce((a, b) => a + b, 0); for (let k = 0; k < 64; k++) { acc += hist[k]; if (acc >= tot * p) return (k + 0.5) / 64; } return 1; };
  const mr = sr / n, mg = sg / n, mb = sb / n, ml = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb;
  const bp = Math.min(0.08, Math.max(0, pct(0.02) - 0.01)), wp = Math.max(0.82, Math.min(1, pct(0.985) + 0.01));
  const mid = (pct(0.5) - bp) / (wp - bp);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const correct = {
    bp, wp,
    gamma: clamp(Math.log(0.46) / Math.log(Math.max(0.05, mid)), 0.75, 1.35),
    gain: [clamp((ml / mr) ** 0.5, 0.92, 1.08), clamp((ml / mg) ** 0.5, 0.92, 1.08), clamp((ml / mb) ** 0.5, 0.92, 1.08)],
  };
  // face track: fill gaps, then smooth
  const found = samples.filter((s) => s.face);
  const faceRate = samples.length ? found.length / samples.length : 0;
  const def = { x: 0.5, y: 0.38, w: 0.22 };
  let last = found[0]?.face || def;
  const raw = samples.map((s) => (last = s.face || last));
  const W = 3, track2 = raw.map((_, k) => { let x = 0, y = 0, w = 0, c = 0;
    for (let j = Math.max(0, k - W); j <= Math.min(raw.length - 1, k + W); j++) { x += raw[j].x; y += raw[j].y; w += raw[j].w; c++; }
    return { t: samples[k].t, x: x / c, y: y / c, w: w / c }; });
  const sdv = (q, m) => Math.sqrt(Math.max(1e-4, q / n - m * m));
  const stats = { mu: [mr, mg, mb], sd: [sdv(qr, mr), sdv(qg, mg), sdv(qb, mb)] };
  return { faces: track2, faceRate, correct, stats, aspect: dw / dh };
}

/* ---------- music structure ---------- */
function bandEnergy(audio, a, b) {
  const { energy, fps } = audio; let s = 0, c = 0;
  for (let i = Math.floor(a * fps); i < Math.min(energy.length, b * fps); i++) { s += energy[i]; c++; }
  return c ? s / c : 0;
}
export function findSections(audio, beats, barOff, dur) {
  let bars = beats.filter((_, i) => ((i - barOff) % 4 + 4) % 4 === 0);
  if (bars.length < 3) { bars = []; for (let t = 0; t < dur; t += 2.4) bars.push(t); }
  if (bars[0] > 0.3) bars.unshift(0);
  const segs = bars.map((t, i) => ({ a: t, b: bars[i + 1] ?? dur }));
  const e = segs.map((s) => bandEnergy(audio, s.a, s.b));
  // levels relative to the song's own dynamic range: a two-part song gets two levels, not three
  const sorted = [...e].sort((p, q) => p - q), q = (p) => sorted[Math.floor((sorted.length - 1) * p)];
  const mn = q(0.05), mx = q(0.95), rg = mx - mn;
  let lv = e.map((x) => { if (rg < 0.15) return 1; const r = (x - mn) / rg; return r >= 0.62 ? 2 : r >= 0.3 ? 1 : 0; });
  lv = lv.map((_, i) => [lv[i - 1] ?? lv[i], lv[i], lv[i + 1] ?? lv[i]].sort()[1]);
  const secs = [];
  segs.forEach((s, i) => { const L = secs.at(-1); if (L && L.level === lv[i]) { L.b = s.b; L.bars.push(s.a); } else secs.push({ a: s.a, b: s.b, level: lv[i], bars: [s.a] }); });
  for (let k = 0; k < secs.length && secs.length > 1; k++) if (secs[k].bars.length < 2) {
    const tgt = k === 0 ? secs[1] : secs[k - 1];
    if (k === 0) { tgt.a = secs[0].a; tgt.bars.unshift(...secs[0].bars); } else { tgt.b = secs[k].b; tgt.bars.push(...secs[k].bars); }
    secs.splice(k--, 1); if (k < -1) k = -1; }
  for (let k = 1; k < secs.length; k++) if (secs[k].level === secs[k - 1].level) { secs[k - 1].b = secs[k].b; secs[k - 1].bars.push(...secs[k].bars); secs.splice(k--, 1); }
  const name = { 0: 'Sakin', 1: 'Kıta', 2: 'Nakarat' };
  secs.forEach((s, k) => { s.name = s.level === 0 && k === 0 ? 'Giriş' : s.level === 0 && k === secs.length - 1 ? 'Çıkış' : name[s.level]; });
  return { secs, bars };
}

/* ---------- edit decision list ---------- */
export function buildEdit({ dur, beats, barOff, audio, pic, bpm, pace = 'normal', close = 'normal', srcH = 1920, targetShot = null }) {
  let seed = 7; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const { secs } = findSections(audio, beats, barOff, dur);
  const faceAt = (t) => { const f = pic.faces; if (!f.length) return { x: 0.5, y: 0.38, w: 0.22 }; let k = 0; while (k < f.length - 1 && f[k + 1].t <= t) k++; return f[k]; };
  const avgFace = (a, b) => { const f = pic.faces.filter((p) => p.t >= a && p.t < b); if (!f.length) return faceAt(a);
    return { x: f.reduce((s, p) => s + p.x, 0) / f.length, y: f.reduce((s, p) => s + p.y, 0) / f.length, w: f.reduce((s, p) => s + p.w, 0) / f.length }; };
  const hasFace = pic.faceRate > 0.3;
  const barLen = secs.length && secs[0].bars.length > 1 ? secs[0].bars[1] - secs[0].bars[0] : 2.4;
  const shots = [], punches = [], flashes = [];
  let prev = '';
  secs.forEach((sec, si) => {
    let per = sec.level === 2 ? (barLen > 2.6 ? 1 : 2) : sec.level === 1 ? 2 : (barLen > 3 ? 2 : 4);
    if (pace === 'hizli') per = Math.max(1, per / 2); else if (pace === 'yavas') per *= 2;
    let cuts = sec.bars.filter((_, i) => i % per === 0);
    if (targetShot) {   // copy a reference video's cutting rhythm: cut every k beats, slower in quiet parts
      const beatLen = barLen / 4, mult = sec.level === 2 ? 1 : sec.level === 1 ? 1.4 : 2;
      const k = Math.max(1, Math.round(targetShot * mult / beatLen));
      const bts = beats.filter((t) => t >= sec.a - 0.01 && t < sec.b - 0.3);
      cuts = bts.length ? bts.filter((_, i) => i % k === 0) : cuts;
      if (!cuts.length || cuts[0] > sec.a + 0.05) cuts.unshift(sec.a);
    }
    cuts.forEach((a, ci) => {
      const b = cuts[ci + 1] ?? sec.b;
      if (b - a < (targetShot ? Math.min(1.2, targetShot * 0.6) : 1.2) && shots.length) { shots.at(-1).b = b; return; }
      let opts = sec.level === 2 ? ['C', 'M', 'C', 'W'] : sec.level === 1 ? ['M', 'W', 'C', 'M'] : ['W', 'M', 'W'];
      if (close === 'cok') opts = opts.map((o) => (o === 'W' ? 'C' : o)).concat(['C']);
      if (close === 'az') opts = opts.map((o) => (o === 'C' ? 'M' : o)).concat(['W']);
      if (!hasFace) opts = opts.map((o) => (o === 'C' ? 'M' : o));
      let kind = si === 0 && ci === 0 ? 'W' : ci === 0 && sec.level === 2 && hasFace ? 'C' : opts[Math.floor(rnd() * opts.length)];
      if (kind === prev) kind = opts.find((o) => o !== prev) || 'W';
      if (si === secs.length - 1 && ci === cuts.length - 1) kind = 'W';
      prev = kind;
      const f = avgFace(a, b);
      // close-up zoom limited by source resolution so the picture stays sharp (1080p: ~1.55x, 4K: up to 2.1x)
      const zMax = Math.max(1.3, Math.min(2.1, 1.55 * srcH / 1920));
      const zc = Math.min(zMax, Math.max(1.3, 0.34 / Math.max(0.05, f.w)));
      const z = kind === 'W' ? 1 : kind === 'M' ? Math.min(1.28, 1 + (zc - 1) * 0.55) : zc;
      const wgt = kind === 'W' ? 0 : kind === 'M' ? 0.7 : 1;
      const drift = sec.level === 0 ? 0.07 : sec.level === 1 ? 0.04 : 0.02;
      const last = si === secs.length - 1 && ci === cuts.length - 1;
      shots.push({ a, b, kind, z, drift: last ? -0.05 : drift, cx: 0.5 + (f.x - 0.5) * wgt, cy: 0.5 + (f.y + 0.04 - 0.5) * wgt, sec: si });
      if (sec.level === 2 && ci > 0) flashes.push({ t: a, s: 0.35 });
    });
    if (si > 0 && sec.level === 2) { flashes.push({ t: sec.a, s: 0.9 }); punches.push({ t: sec.a, s: 1.4 }); }
    const bi = beats.filter((t) => t >= sec.a && t < sec.b);
    if (sec.level === 2) bi.forEach((t, k) => k % 2 === 0 && punches.push({ t, s: 0.8 }));
    if (sec.level === 1) sec.bars.forEach((t) => punches.push({ t, s: 0.45 }));
  });
  shots.sort((p, q) => p.a - q.a); punches.sort((p, q) => p.t - q.t); flashes.sort((p, q) => p.t - q.t);
  const hiShare = secs.filter((s) => s.level === 2).reduce((a, s) => a + s.b - s.a, 0) / Math.max(1, dur);
  const look = bpm >= 105 && hiShare > 0.2 ? 1 : 2;
  return { secs, shots, punches, flashes, look, fadeIn: 0.45, fadeOut: 1.2, dur, hasFace };
}

const lastLE = (a, t, key) => { let lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m][key] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const env = (dt, decay) => dt < 0 ? 0 : dt < 0.025 ? dt / 0.025 : Math.exp(-(dt - 0.025) / decay);

// Effect state at time t for an edit; power and flash scale the beat effects (sliders), 0 disables.
export function editAt(E, t, power, flash, win = { t0: 0, t1: E.dur, fi: E.fadeIn, fo: E.fadeOut }) {
  const i = Math.max(0, lastLE(E.shots, t, 'a')), s = E.shots[i];
  const u = Math.min(1, Math.max(0, (t - s.a) / Math.max(0.1, s.b - s.a)));
  let z = s.z * (1 + s.drift * u);
  const pi = lastLE(E.punches, t, 't');
  const pe = pi >= 0 ? E.punches[pi].s * env(t - E.punches[pi].t, 0.15) : 0;
  if (power) z *= 1 + power * 0.13 * pe;
  // transition window around cuts (0..1, peaks at the cut); dir: which way a whip moves
  let ta = 0, dir = 1; const W = 0.2;
  if (i > 0 && t - s.a < W) { ta = 1 - (t - s.a) / W; dir = -1; }
  const nx = E.shots[i + 1]; if (nx && nx.a - t < W) { const a2 = 1 - (nx.a - t) / W; if (a2 > ta) { ta = a2; dir = 1; } }
  let f = 0; const fi = lastLE(E.flashes, t, 't');
  if (fi >= 0 && flash) f = flash * 1.6 * E.flashes[fi].s * env(t - E.flashes[fi].t, 0.1);
  const fade = Math.min(1, win.fi > 0 ? (t - win.t0) / win.fi : 1, win.fo > 0 ? (win.t1 - t) / win.fo : 1);
  return { z, f, cx: s.cx, cy: s.cy, fade: Math.max(0, fade), kind: s.kind, pe: Math.min(1, pe), ta, dir, idx: i };
}
