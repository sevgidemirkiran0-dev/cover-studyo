// Reads an edit style from a reference video: cut rhythm, flashes, camera movement,
// cinema bars and colour. Everything runs on the device.
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from './vendor/mediabunny.min.mjs';

export async function analyzeReference(file, onProgress) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('Referans dosyada video yok');
  const dur = await input.computeDuration();
  const W = 48, H = 84, step = Math.max(0.1, dur / 900);
  const sink = new CanvasSink(vt, { width: W, height: H, fit: 'fill', poolSize: 2 });
  const times = []; for (let t = 0.02; t < dur; t += step) times.push(t);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d', { willReadFrequently: true });
  const F = []; let prev = null, i = 0, sr = 0, sg = 0, sb = 0, qr = 0, qg = 0, qb = 0, n = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    const t = times[i++]; if (i % 20 === 0) onProgress?.(i / times.length);
    if (!wc) continue;
    cx.drawImage(wc.canvas, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data, lumA = new Float32Array(W * H), hist = new Float32Array(48);
    let top = 0, bot = 0, mid = 0, nt = 0, nb = 0, nm = 0, L = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4, r = d[k] / 255, g = d[k + 1] / 255, b = d[k + 2] / 255, l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumA[y * W + x] = l; L += l;
      hist[Math.min(15, r * 16 | 0)]++; hist[16 + Math.min(15, g * 16 | 0)]++; hist[32 + Math.min(15, b * 16 | 0)]++;
      if (y < H * 0.08) { top += l; nt++; } else if (y >= H * 0.92) { bot += l; nb++; }
      else { mid += l; nm++; if (y > H * 0.15 && y < H * 0.85) { sr += r; sg += g; sb += b; qr += r * r; qg += g * g; qb += b * b; n++; } }
    }
    for (let k = 0; k < 48; k++) hist[k] /= W * H;
    let diff = 0, hd = 0;
    if (prev) { for (let k = 0; k < lumA.length; k++) diff += Math.abs(lumA[k] - prev.lum[k]); diff /= lumA.length; for (let k = 0; k < 48; k++) hd += Math.abs(hist[k] - prev.hist[k]); hd /= 3; }
    F.push({ t, lum: L / (W * H), diff, hd, bars: top / nt < 0.05 && bot / nb < 0.05 && mid / nm > 0.1 });
    prev = { lum: lumA, hist };
  }
  if (F.length < 10) throw new Error('Referans video çok kısa');
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
  // flashes: brief brightness spikes that return to the previous level
  const flashes = [];
  for (let k = 2; k < F.length - 3; k++) {
    const base = (F[k - 2].lum + F[Math.min(F.length - 1, k + 3)].lum) / 2;
    if (F[k].lum - base > 0.12 && F[k].lum >= F[k - 1].lum && F[k].lum >= F[k + 1].lum && (!flashes.length || F[k].t - flashes.at(-1) > 0.3)) flashes.push(F[k].t);
  }
  // cuts: large colour-histogram jumps that are not flashes
  const hdMed = med(F.map((f) => f.hd)), cuts = [];
  for (let k = 1; k < F.length; k++) {
    const nearFlash = flashes.some((ft) => Math.abs(ft - F[k].t) < 0.25);
    if (!nearFlash && F[k].hd > Math.max(0.28, hdMed * 5) && (!cuts.length || F[k].t - cuts.at(-1) > 0.25)) cuts.push(F[k].t);
  }
  const bounds = [0, ...cuts, dur], shots = bounds.slice(1).map((b, k) => b - bounds[k]).filter((x) => x > 0.15);
  const cutSet = new Set(cuts);
  const motion = med(F.filter((f, k) => k > 0 && !cutSet.has(f.t)).map((f) => f.diff)) / (step / 0.1);
  const mr = sr / n, mg = sg / n, mb = sb / n, sd = (q, m) => Math.sqrt(Math.max(1e-4, q / n - m * m));
  return {
    dur, cuts: cuts.length, shot: med(shots) || dur, flashesPerMin: flashes.length / (dur / 60),
    letterbox: F.filter((f) => f.bars).length / F.length > 0.6, motion,
    color: { mu: [mr, mg, mb], sd: [sd(qr, mr), sd(qg, mg), sd(qb, mb)] },
  };
}

// Translate the measured style into editor settings, with a Turkish summary.
export function styleToSettings(r) {
  const p = {}, notes = [];
  p.targetShot = Math.max(0.35, Math.min(8, r.shot));
  notes.push(r.cuts ? `ortalama ${r.shot.toFixed(1)} saniyede bir kesme (${r.cuts} kesme)` : 'kesmesiz, tek plan');
  if (r.flashesPerMin > 1.5) { p.flashOn = true; p.flash = Math.min(0.9, 0.25 + r.flashesPerMin / 40); notes.push(`dakikada ${Math.round(r.flashesPerMin)} flaş`); }
  else { p.flashOn = false; notes.push('flaş yok'); }
  const m = r.motion;
  p.shake = m > 0.035; p.zoomPower = Math.min(0.9, 0.2 + m * 6); p.fxPower = Math.min(1, 0.3 + m * 8);
  notes.push(m > 0.06 ? 'çok hareketli kamera' : m > 0.035 ? 'hareketli kamera' : 'sakin kamera');
  p.letterbox = r.letterbox; if (r.letterbox) notes.push('sinema bantları');
  const [R, G, B] = r.color.mu, warm = R - B, sat = Math.max(R, G, B) - Math.min(R, G, B), con = (r.color.sd[0] + r.color.sd[1] + r.color.sd[2]) / 3;
  notes.push((warm > 0.06 ? 'sıcak' : warm < -0.03 ? 'soğuk' : 'nötr') + ', ' + (sat < 0.06 ? 'soluk' : 'canlı') + ', ' + (con > 0.24 ? 'kontrastlı' : 'yumuşak') + ' renkler');
  return { p, summary: notes.join(' · ') };
}
