// Lyrics: on-device speech recognition (Whisper via transformers.js) and caption drawing.

let asr = null, asrKey = '';
const JUNK = /(altyaz[ıi]|m\.k\.|izledi[ğg]iniz i[çc]in|abone ol|thank(s| you) for watching|subtitles? by|amara\.org|www\.|\.com)/i;

async function toMono16k(buf) {
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination); s.start();
  return (await ctx.startRendering()).getChannelData(0);
}

// opts: { lang: 'turkish'|'english'|null, big: bool }, onStatus(text)
export async function transcribe(buf, opts, onStatus) {
  const { pipeline, env } = await import('./vendor/transformers/transformers.min.js');
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', import.meta.url).href;
  let gpu = false; try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch {}
  const model = opts.big ? 'onnx-community/whisper-small' : 'onnx-community/whisper-base';
  const load = async (useGpu) => {
    const files = {};
    return pipeline('automatic-speech-recognition', model, {
      device: useGpu ? 'webgpu' : 'wasm',
      dtype: useGpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files[p.file] = [p.loaded, p.total];
        const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
        onStatus(`Yapay zekâ modeli indiriliyor (yalnızca ilk sefer): ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`);
      },
    });
  };
  if (asrKey !== model + gpu) {
    try { asr = await load(gpu); }
    catch (e) { if (!gpu) throw e; console.warn('WebGPU olmadı, CPU deneniyor', e); gpu = false; asr = await load(false); }
    asrKey = model + gpu;
  }
  onStatus('Sözler dinleniyor… Bu, şarkının uzunluğuna göre 1–3 dakika sürebilir.');
  const pcm = await toMono16k(buf);
  const run = () => asr(pcm, { language: opts.lang || null, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
  let out;
  try { out = await run(); }
  catch (e) { if (!gpu) throw e; console.warn('WebGPU çalıştırma hatası, CPU deneniyor', e); asr = await load(false); asrKey = model + false; out = await run(); }
  return toLines(out.chunks || [], buf.duration);
}

// Clean recogniser output into short caption lines with start/end times.
export function toLines(chunks, dur) {
  const lines = [];
  for (const c of chunks) {
    let text = (c.text || '').replace(/[♪♫]/g, '').replace(/\s+/g, ' ').trim();
    if (!text || /^[\[\(].*[\]\)]$/.test(text) || JUNK.test(text)) continue;
    let [a, b] = c.timestamp || [0, null]; if (b == null) b = Math.min(dur, a + 4);
    if (b - a < 0.3) continue;
    const words = text.split(' '), parts = []; let cur = [];
    for (const w of words) { if (cur.length && (cur.join(' ') + ' ' + w).length > 34) { parts.push(cur.join(' ')); cur = []; } cur.push(w); }
    if (cur.length) parts.push(cur.join(' '));
    const total = parts.reduce((s, p) => s + p.length, 0); let t = a;
    for (const p of parts) { const d = (b - a) * p.length / total; lines.push({ a: +t.toFixed(2), b: +(t + d).toFixed(2), text: p }); t += d; }
  }
  return lines;
}

/* ---------- caption drawing (preview and export share this) ---------- */
function wrap(ctx, text, maxW) {
  const words = text.split(' '), out = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (cur && ctx.measureText(t).width > maxW) { out.push(cur); cur = w; } else cur = t; }
  if (cur) out.push(cur); return out;
}
// style: 'minimal' | 'kelime' | 'buyuk'
export function drawLyrics(ctx, t, W, H, lines, style) {
  const L = lines.find((l) => t >= l.a - 0.05 && t < l.b + 0.25);
  if (!L || !L.text.trim()) return;
  const k = W / 1080, inA = Math.min(1, (t - L.a + 0.05) / 0.18), outA = Math.min(1, (L.b + 0.25 - t) / 0.2), alpha = Math.max(0, Math.min(inA, outA));
  ctx.save(); ctx.globalAlpha = alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 18 * k; ctx.shadowOffsetY = 3 * k;
  if (style === 'buyuk') {
    const size = 92 * k, pop = 1 + 0.08 * Math.max(0, 1 - (t - L.a) / 0.25);
    ctx.font = `800 ${size}px Archivo, Inter, sans-serif`;
    const rows = wrap(ctx, L.text.toLocaleUpperCase('tr'), W * 0.84);
    ctx.translate(W / 2, H * 0.68); ctx.scale(pop, pop); ctx.fillStyle = '#fff';
    rows.forEach((r, i) => ctx.fillText(r, 0, (i - (rows.length - 1) / 2) * size * 1.05));
  } else if (style === 'kelime') {
    const size = 64 * k; ctx.font = `700 ${size}px Inter, sans-serif`;
    const words = L.text.split(' '), lens = words.map((w) => w.length + 1), tot = lens.reduce((a, b) => a + b, 0);
    const u = (t - L.a) / Math.max(0.3, L.b - L.a); let acc = 0, cur = -1;
    words.forEach((_, i) => { if (u * tot >= acc) cur = i; acc += lens[i]; });
    const rows = wrap(ctx, L.text, W * 0.82); let wi = 0;
    rows.forEach((r, ri) => {
      const ws = r.split(' '), full = ctx.measureText(r).width; let x = W / 2 - full / 2;
      const y = H * 0.76 + (ri - (rows.length - 1) / 2) * size * 1.25;
      ctx.textAlign = 'left';
      for (const w of ws) {
        const seen = wi <= cur; ctx.globalAlpha = alpha * (seen ? 1 : 0.35);
        ctx.fillStyle = wi === cur ? '#ffd23f' : '#fff'; ctx.fillText(w, x, y);
        x += ctx.measureText(w + ' ').width; wi++;
      }
    });
  } else {
    const size = 54 * k; ctx.font = `600 ${size}px Inter, sans-serif`; ctx.fillStyle = '#fff';
    const rows = wrap(ctx, L.text, W * 0.82);
    rows.forEach((r, i) => ctx.fillText(r, W / 2, H * 0.8 + (i - (rows.length - 1) / 2) * size * 1.3));
  }
  ctx.restore();
}
