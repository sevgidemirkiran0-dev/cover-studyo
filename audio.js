// Vocal enhancement and reverb, rendered offline with the Web Audio API.
import { AudioBufferSink, AudioSample } from './vendor/mediabunny.min.mjs';

// Decode the whole audio track into one AudioBuffer, placed by timestamp so it stays in sync with the picture.
export async function decodeFull(track, dur) {
  const sink = new AudioBufferSink(track);
  let out = null, sr = 0, ch = 0;
  for await (const { buffer, timestamp } of sink.buffers()) {
    if (!out) {
      sr = buffer.sampleRate; ch = Math.min(2, buffer.numberOfChannels);
      out = new AudioBuffer({ length: Math.ceil((dur + 1) * sr), numberOfChannels: 2, sampleRate: sr });
    }
    const at = Math.max(0, Math.round(timestamp * sr)), n = Math.min(buffer.length, out.length - at);
    if (n <= 0) continue;
    for (let c = 0; c < 2; c++) out.getChannelData(c).set(buffer.getChannelData(Math.min(c, ch - 1)).subarray(0, n), at);
  }
  return out;
}

export const REVERBS = {
  oda:   { len: 0.9, decay: 5.0, pre: 0.008, tone: 0.35 },
  salon: { len: 2.8, decay: 2.4, pre: 0.025, tone: 0.25 },
  plate: { len: 1.8, decay: 3.2, pre: 0.004, tone: 0.6 },
};

function impulse(ctx, p) {
  const sr = ctx.sampleRate, n = Math.round(p.len * sr), pre = Math.round(p.pre * sr);
  const ir = ctx.createBuffer(2, n + pre, sr);
  let seed = 12345; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647 * 2 - 1;
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n, a = p.tone + (1 - p.tone) * (1 - t) * 0.5;   // highs die faster than lows
      lp += a * (rnd() - lp);
      d[pre + i] = lp * Math.exp(-p.decay * t * 3) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
    }
  }
  return ir;
}

// opts: { clarity: bool, reverb: 'yok'|'oda'|'salon'|'plate', wet: 0..1 }
export async function enhance(buf, opts) {
  const ctx = new OfflineAudioContext(2, buf.length, buf.sampleRate);
  const src = ctx.createBufferSource(); src.buffer = buf;
  let node = src;
  const chain = (n) => { node.connect(n); node = n; return n; };
  if (opts.clarity) {
    const f = (type, freq, gain, Q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; if (gain != null) b.gain.value = gain; if (Q) b.Q.value = Q; return b; };
    chain(f('highpass', 85, null, 0.7));       // rumble, handling noise
    chain(f('peaking', 280, -2.5, 1.0));       // mud
    chain(f('peaking', 3400, 3.0, 0.9));       // presence: words become clear
    chain(f('highshelf', 10000, 2.5));         // air
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.006; comp.release.value = 0.16;
    chain(comp);
  }
  const mix = ctx.createGain(); node.connect(mix);
  if (opts.reverb && opts.reverb !== 'yok' && opts.wet > 0) {
    const conv = ctx.createConvolver(); conv.normalize = true; conv.buffer = impulse(ctx, REVERBS[opts.reverb]);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
    const wet = ctx.createGain(); wet.gain.value = opts.wet * 0.7;
    node.connect(hp); hp.connect(conv); conv.connect(wet); wet.connect(mix);
  }
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.08;
  mix.connect(lim); lim.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  if (opts.clarity) normalize(out);
  return out;
}

// Bring loudness to about -15 dBFS RMS (social-media level) with a soft ceiling below 0 dBFS.
function normalize(b) {
  let s = 0, n = 0; const ch = [b.getChannelData(0), b.getChannelData(1)];
  for (const d of ch) for (let i = 0; i < d.length; i += 4) { const v = d[i] * d[i]; if (v > 1e-6) { s += v; n++; } }
  if (!n) return;
  const g = Math.min(4, Math.max(0.5, 0.178 / Math.sqrt(s / n)));
  for (const d of ch) for (let i = 0; i < d.length; i++) {
    let x = d[i] * g; const a = Math.abs(x);
    if (a > 0.8) x = Math.sign(x) * (0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19));
    d[i] = x;
  }
}

// Replace an incoming encoder sample with the processed audio at the same timestamp.
export function swapSample(sample, buf) {
  const n = sample.numberOfFrames, ch = sample.numberOfChannels, sr = sample.sampleRate, r = buf.sampleRate / sr;
  const data = new Float32Array(n * ch), start = sample.timestamp * buf.sampleRate;
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(Math.min(c, 1)), o = c * n;
    for (let i = 0; i < n; i++) { const k = Math.round(start + i * r); data[o + i] = k >= 0 && k < d.length ? d[k] : 0; }
  }
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: sample.timestamp });
}

// Plays the processed audio in step with the (muted) preview video.
export class SyncPlayer {
  constructor(video) { this.v = video; this.ctx = null; this.src = null; this.buf = null; this.on = false; }
  set(buf, on) { this.buf = buf; this.on = on && !!buf; this.v.muted = this.on; if (!this.v.paused) this.start(); }
  start() {
    this.stop(); if (!this.on || !this.buf) return;
    if (!this.ctx) this.ctx = new AudioContext();
    this.ctx.resume?.();
    const s = this.ctx.createBufferSource(); s.buffer = this.buf; s.connect(this.ctx.destination);
    s.start(0, Math.max(0, this.v.currentTime)); this.src = s;
  }
  stop() { try { this.src?.stop(); } catch {} this.src = null; }
}
