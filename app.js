import {
  Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS,
  AudioBufferSink, QUALITY_HIGH, canEncodeAudio, getFirstEncodableVideoCodec,
  CanvasSource, AudioBufferSource, VideoSampleSink,
} from './vendor/mediabunny.min.mjs';
import { analyzePicture, buildEdit, editAt } from './auto.js';
import { decodeFull, enhance, swapSample, SyncPlayer, mixAudio, joinRanges } from './audio.js';
import { transcribe, drawLyrics } from './lyrics.js';
import { askClaude, parseLocal, getKey, setKey } from './prompt.js';
import { analyzeReference, styleToSettings } from './refstyle.js';
import { initTimeline, drawTexts, keepRanges, skipAt, FONTS } from './timeline.js';

const $ = (id) => document.getElementById(id);
const S = {
  file: null, dur: 0, look: 1, amt: 0.8,
  zoomOn: true, every: 2, power: 0.45, flashOn: true, flash: 0.4,
  beats: [], period: 0, phase: 0, barOff: 0, fps: 0, onset: null, energy: null,
  sel: [], bars: [], result: null, conv: null, playing: false,
  autoOn: true, edl: null, correct: null, vtrack: null,
  raw: null, proc: null, clarity: true, reverb: 'oda', wet: 0.25, origAB: false,
  lyrics: [], lyrOn: true, lyrStyle: 'minimal',
  sharpen: 0.4, pace: 'normal', close: 'normal', trim0: null, trim1: null, fadeIn: 0.45, fadeOut: 1.2,
  fx: { shake: false, rgb: false, glow: false, leak: false, vhs: false, letterbox: false, beauty: false }, fxPower: 0.5, trans: 'kesme',
  ref: null, refOn: false, refAmt: 0.8, targetShot: null,
  skips: [], texts: [], audioFx: { vol: 1, bass: 0, treble: 0, fin: 0, fout: 0 }, mixed: null,
};

/* ---------- GPU renderer: colour grade, zoom, flash ---------- */
const VS = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D T; uniform vec2 C, R, P; uniform float Z, F, A, TM, D; uniform int L;
uniform vec3 CG, LV; uniform vec2 TX; uniform float SH;
// CapCut-style effects
uniform vec2 SO; uniform float SR, RGB, GL, GLOD, LK, LKT, VH, LB, BEA; uniform int TR; uniform float TA; uniform vec2 TD;
// reference colour transfer
uniform vec3 XM, XS, UM, US; uniform float XA; uniform int ROT;
float h(vec2 q){ return fract(sin(dot(q, vec2(12.9898,78.233)))*43758.5453); }
float lum(vec3 c){ return dot(c, vec3(.2126,.7152,.0722)); }
vec2 rq(vec2 q){ return ROT==90 ? vec2(q.y,1.-q.x) : ROT==180 ? 1.-q : ROT==270 ? vec2(1.-q.y,q.x) : q; }   // frame rotation
vec3 tap(vec2 q){ return texture(T,rq(q)).rgb; }
void main(){
  vec2 of = (v-.5)*C/Z;
  float cs = cos(SR), sn = sin(SR); of = vec2(cs*of.x - sn*of.y, sn*of.x + cs*of.y);   // shake rotation
  vec2 q = vec2(P.x+of.x, P.y-of.y) + SO;
  if (TR==1) q = P + (q-P)/(1.+.35*TA);                                                 // zoom transition push
  vec3 c;
  if (TR>=1 && TR<=2 && TA>.01) {                                                       // zoom / whip motion blur
    vec2 dir = TR==1 ? (q-P)*.18*TA : TD*.22*TA; c = vec3(0.);
    for (int i=0;i<10;i++){ c += tap(clamp(q + dir*(float(i)/9.-.5), 0., 1.)); } c /= 10.;
  } else {
    c = tap(q);
    vec3 bl = (tap(q+vec2(TX.x,0.))+tap(q-vec2(TX.x,0.))+tap(q+vec2(0.,TX.y))+tap(q-vec2(0.,TX.y)))*.25;
    c = clamp(c + SH*(c-bl), 0., 1.);                                                   // unsharp mask
  }
  float rgb = RGB + (TR==3 ? .02*TA : 0.);
  if (TR==3 && TA>.01) { float band = floor(v.y*18.+TM); if (h(vec2(band,TM))>.6) q.x += (h(vec2(TM,band))-.5)*.08*TA; }
  if (rgb>0.) { c.r = tap(q+vec2(rgb,0.)).r; c.b = tap(q-vec2(rgb,0.)).b; }
  if (BEA>0.) {                                                                          // skin smoothing
    float cb = -.169*c.r-.331*c.g+.5*c.b, cr = .5*c.r-.419*c.g-.081*c.b;
    float skin = smoothstep(.02,.06,cr)*(1.-smoothstep(.17,.22,cr))*(1.-smoothstep(-.02,.04,cb));
    c = mix(c, textureLod(T,rq(q),1.6).rgb, BEA*skin);
  }
  if (XA>0.) c = mix(c, clamp((c-UM)/max(US,vec3(.02))*XS+XM, 0., 1.), XA);             // match reference colours
  else c = pow(clamp((c-LV.x)/(LV.y-LV.x),0.,1.), vec3(LV.z)) * CG;                     // automatic exposure / white balance
  vec3 g = c;
  float vig = 0., grain = 0.;
  if (L==1) {            // Alternatif Rock
    g = mix(vec3(lum(c)), c, .6);
    g = (g-.5)*1.28+.5;
    g = clamp((g-.045)/.955, 0., 1.);
    float lg = lum(g);
    g += (1.-smoothstep(0.,.55,lg))*vec3(-.03,.025,.045);
    g += smoothstep(.55,1.,lg)*vec3(.035,.02,-.015);
    vig = .55; grain = .07;
  } else if (L==2) {     // Sinematik
    g = mix(g, g*g*(3.-2.*g), .45);
    g = g*.93+.035;
    float lg = lum(g);
    g += (1.-smoothstep(0.,.6,lg))*vec3(-.05,.015,.07);
    g += smoothstep(.35,1.,lg)*vec3(.07,.025,-.05);
    g = mix(vec3(lum(g)), g, 1.08);
    vig = .35; grain = .025;
  }
  vec2 d = (v-.5)*vec2(1.,1.25);
  g *= 1.-vig*smoothstep(.25,.85,length(d));
  g += (h(floor(v*R)+TM)-.5)*grain;
  g = mix(c, g, A);
  if (GL>0.) { vec3 bb = textureLod(T,rq(q),GLOD).rgb; g += max(bb-.55,0.)*GL*2.2; }         // glow / bloom
  if (LK>0.) {                                                                           // drifting light leak
    vec2 lp = vec2(.15+.25*sin(LKT*.37), .2+.3*sin(LKT*.23+1.));
    float k1 = exp(-6.*dot(v-lp,v-lp)), k2 = exp(-9.*dot(v-vec2(.9,.85+.1*sin(LKT*.5)),v-vec2(.9,.85+.1*sin(LKT*.5))));
    g = 1.-(1.-g)*(1.-LK*(k1*vec3(1.,.45,.15)+k2*vec3(1.,.2,.35)));
  }
  if (VH>0.) {                                                                           // VHS
    g = mix(g, vec3(lum(g))*vec3(1.05,1.,.92)+.03, .25*VH);
    g *= 1.-.12*VH*(.5+.5*sin(v.y*R.y*3.1416));
    g += (h(vec2(floor(v.y*R.y*.5),TM))-.5)*.05*VH;
  }
  g += F*vec3(1.,.93,.85)*.45 + (TR==4 ? TA*.8 : 0.);
  if (LB>0. && abs(v.y-.5)>.5-LB) g = vec3(0.);                                          // cinema bars
  o = vec4(clamp(g,0.,1.)*D,1.);
}`;

class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 kullanılamıyor');
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const pr = this.pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.u = {}; for (const n of ['C', 'R', 'P', 'Z', 'F', 'A', 'TM', 'D', 'L', 'T', 'CG', 'LV', 'TX', 'SH', 'SO', 'SR', 'RGB', 'GL', 'GLOD', 'LK', 'LKT', 'VH', 'LB', 'BEA', 'TR', 'TA', 'TD', 'XM', 'XS', 'UM', 'US', 'XA', 'ROT']) this.u[n] = gl.getUniformLocation(pr, n);
  }
  draw(src, sw, sh, fx, t, rot = 0) {
    const { gl, u, cv } = this; const W = cv.width, H = cv.height;
    gl.viewport(0, 0, W, H);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);   // clean downscaling of 4K sources
    gl.uniform2f(u.TX, 1 / sw, 1 / sh); gl.uniform1f(u.SH, S.sharpen * (0.6 + 0.5 * (fx.z - 1)) * Math.min(1, W / 1080 + 0.3));
    const as = sw / sh, ad = W / H, cx = as > ad ? ad / as : 1, cy = as > ad ? 1 : as / ad;
    gl.uniform2f(u.C, cx, cy);
    const hx = 0.5 * cx / fx.z, hy = 0.5 * cy / fx.z, cl = (x, h) => Math.min(1 - h, Math.max(h, x));
    gl.uniform2f(u.P, cl(fx.cx ?? 0.5, hx), cl(fx.cy ?? 0.5, hy));
    gl.uniform1f(u.D, fx.fade ?? 1);
    const k = S.correct; gl.uniform3f(u.CG, ...(k ? k.gain : [1, 1, 1])); gl.uniform3f(u.LV, k ? k.bp : 0, k ? k.wp : 1, k ? k.gamma : 1);
    gl.uniform2f(u.R, W / 2, H / 2);
    gl.uniform1f(u.Z, fx.z); gl.uniform1f(u.F, fx.f); gl.uniform1f(u.A, (fx.look ?? S.look) ? S.amt : 0); gl.uniform1i(u.ROT, rot);
    gl.uniform1f(u.TM, Math.floor(t * 24) % 97); gl.uniform1i(u.L, fx.look ?? S.look); gl.uniform1i(u.T, 0);
    const e = fx.e || {}, X = S.ref && S.refOn && pic ? S.ref.color : null, Ux = pic?.stats;
    gl.uniform2f(u.SO, e.sx || 0, e.sy || 0); gl.uniform1f(u.SR, e.sr || 0); gl.uniform1f(u.RGB, e.rgb || 0);
    gl.uniform1f(u.GL, e.glow || 0); gl.uniform1f(u.GLOD, Math.log2(Math.max(sw, sh) / 48)); gl.uniform1f(u.LK, e.leak || 0); gl.uniform1f(u.LKT, t);
    gl.uniform1f(u.VH, e.vhs || 0); gl.uniform1f(u.LB, e.lb || 0); gl.uniform1f(u.BEA, e.beauty || 0);
    gl.uniform1i(u.TR, e.tr || 0); gl.uniform1f(u.TA, e.ta || 0); gl.uniform2f(u.TD, e.td || 0, 0);
    gl.uniform1f(u.XA, X && Ux ? S.refAmt : 0);
    if (X && Ux) { gl.uniform3f(u.XM, ...X.mu); gl.uniform3f(u.XS, ...X.sd); gl.uniform3f(u.UM, ...Ux.mu); gl.uniform3f(u.US, ...Ux.sd); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/* ---------- beat-driven effects ---------- */
const lastLE = (a, t) => { let lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const energyAt = (t) => S.energy ? S.energy[Math.min(S.energy.length - 1, Math.max(0, Math.round(t * S.fps)))] : 0.7;
const punch = (dt, decay) => dt < 0.025 ? dt / 0.025 : Math.exp(-(dt - 0.025) / decay);
const TRANS = { kesme: 0, zoom: 1, kaydir: 2, glitch: 3, flas: 4 };
const noise = (x) => Math.sin(x * 12.9898) * 0.5 + Math.sin(x * 7.233 + 1.7) * 0.3 + Math.sin(x * 3.11 + 4.2) * 0.2;
function fxAt(t) {
  const base = baseFx(t), sh = S.autoOn && S.edl && base.idx != null ? S.edl.shots[base.idx] : null;
  const F = sh?.fx || S.fx, k = S.fxPower, pe = base.pe || 0, e = {};
  if (sh?.look != null) base.look = sh.look;
  const trans = (base.dir > 0 ? S.edl?.shots[base.idx + 1]?.trans : sh?.trans) ?? S.trans;
  if (F.shake) { const a = (0.0025 + 0.012 * pe) * k * 1.6; e.sx = a * noise(t * 31); e.sy = a * noise(t * 29 + 5); e.sr = a * 0.6 * noise(t * 23 + 9); }
  if (F.rgb) e.rgb = (0.0015 + 0.006 * pe) * k * 1.6;
  if (F.glow) e.glow = 0.5 * k + 0.2;
  if (F.leak) e.leak = 0.35 * k + 0.15;
  if (F.vhs) e.vhs = 0.6 * k + 0.4;
  if (F.letterbox) e.lb = 0.1;
  if (F.beauty) e.beauty = 0.35 + 0.4 * k;
  if (base.ta > 0 && trans !== 'kesme') { e.tr = TRANS[trans]; e.ta = base.ta * (0.6 + 0.6 * k); e.td = base.dir || 1; }
  base.e = e; return base;
}
function baseFx(t) {
  if (S.autoOn && S.edl) return editAt(S.edl, t, S.zoomOn ? S.power : 0, S.flashOn ? S.flash : 0, win());
  let z = 1 + 0.025 * (S.dur ? Math.min(1, t / S.dur) : 0), f = 0, pe = 0;
  if (S.zoomOn && S.sel.length) {
    const i = lastLE(S.sel, t);
    if (i >= 0) { pe = punch(t - S.sel[i], 0.16) * (0.45 + 0.55 * energyAt(S.sel[i])); z += S.power * 0.14 * pe; }
  }
  if (S.flashOn && S.bars.length) {
    const i = lastLE(S.bars, t);
    if (i >= 0) { const e = energyAt(S.bars[i]); f = S.flash * punch(t - S.bars[i], 0.09) * e * e; }
  }
  return { z, f, pe };
}
// Mediabunny hands `process` timestamps relative to the trimmed output; add trim start back for effects.
const TS_SHIFT = 1;
const win = () => { const r = keepRanges(S); return { t0: r[0]?.[0] ?? 0, t1: r.at(-1)?.[1] ?? S.dur, fi: S.fadeIn, fo: S.fadeOut }; };
function rebuildSel() {
  const { beats, barOff } = S;
  S.bars = beats.filter((_, i) => ((i - barOff) % 4 + 4) % 4 === 0);
  S.sel = S.every === 4 ? S.bars : S.every === 2 ? beats.filter((_, i) => ((i - barOff) % 2 + 2) % 2 === 0) : beats;
}

/* ---------- audio analysis: onset envelope, tempo, beats, energy ---------- */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
async function analyzeAudio(track) {
  const sink = new AudioBufferSink(track);
  const parts = []; let ds = 0, fs = 0, acc = 0, cnt = 0, total = 0;
  for await (const { buffer } of sink.buffers()) {
    if (!ds) { ds = Math.max(1, Math.round(buffer.sampleRate / 11025)); fs = buffer.sampleRate / ds; }
    const n = buffer.length, a = buffer.getChannelData(0), b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a;
    const out = new Float32Array(Math.ceil(n / ds) + 1); let k = 0;
    for (let i = 0; i < n; i++) { acc += a[i] + b[i]; if (++cnt === ds) { out[k++] = acc / (2 * ds); acc = 0; cnt = 0; } }
    parts.push(out.subarray(0, k)); total += k;
  }
  if (!total) return null;
  const x = new Float32Array(total); let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
  const N = 512, hop = 128, frames = Math.max(0, Math.floor((total - N) / hop));
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const flux = new Float32Array(frames), rms = new Float32Array(frames);
  let prev = new Float32Array(N / 2), re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    let e = 0; for (let i = 0; i < N; i++) { const s = x[f * hop + i]; re[i] = s * win[i]; im[i] = 0; e += s * s; }
    rms[f] = Math.sqrt(e / N); fft(re, im);
    let fl = 0; for (let k = 1; k < N / 2; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); const d = m - prev[k]; if (d > 0) fl += d; prev[k] = m; }
    flux[f] = fl;
    if (f % 2000 === 0) await new Promise((r) => setTimeout(r));
  }
  const fps = fs / hop;
  const W = Math.round(fps * 0.5), onset = new Float32Array(frames); let sum = 0;
  for (let i = 0; i < frames; i++) { sum += flux[i]; if (i >= W) sum -= flux[i - W]; onset[i] = Math.max(0, flux[i] - sum / Math.min(i + 1, W)); }
  // centred 2 s moving average, so section changes are not detected late
  const E = Math.round(fps), energy = new Float32Array(frames), pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) pre[i + 1] = pre[i] + rms[i];
  for (let i = 0; i < frames; i++) { const a = Math.max(0, i - E), b = Math.min(frames, i + E + 1); energy[i] = (pre[b] - pre[a]) / (b - a); }
  const sorted = Array.from(energy).sort((p, q) => p - q), hi = sorted[Math.floor(sorted.length * 0.95)] || 1, lo = sorted[Math.floor(sorted.length * 0.1)] || 0;
  for (let i = 0; i < frames; i++) energy[i] = Math.min(1, Math.max(0, (energy[i] - lo) / (hi - lo || 1)));
  return { fps, onset, energy };
}
function findTempo(onset, fps, prefer = 110) {
  const n = onset.length, minL = Math.floor(fps * 60 / 190), maxL = Math.ceil(fps * 60 / 60);
  const ac = new Float32Array(maxL + 2);
  for (let L = minL - 1; L <= maxL + 1; L++) { let s = 0; for (let i = 0; i + L < n; i++) s += onset[i] * onset[i + L]; ac[L] = s / (n - L); }
  let best = minL, bs = -1;
  for (let L = minL; L <= maxL; L++) { const bpm = 60 * fps / L, w = Math.exp(-0.5 * (Math.log2(bpm / prefer) / 0.7) ** 2), s = ac[L] * w; if (s > bs) { bs = s; best = L; } }
  const a = ac[best - 1], b = ac[best], c = ac[best + 1], den = a - 2 * b + c;
  return best + (den ? 0.5 * (a - c) / den : 0);
}
function placeBeats(period) {
  const { onset, fps } = S; const n = onset.length;
  const val = (i) => { const r = Math.round(i); return r >= 0 && r < n ? Math.max(onset[r], onset[r - 1] || 0, onset[r + 1] || 0) : 0; };
  let ph = 0, bs = -1;
  for (let p = 0; p < period; p += 0.5) { let s = 0; for (let i = p; i < n; i += period) s += val(i); if (s > bs) { bs = s; ph = p; } }
  const beats = []; for (let i = ph; i < n; i += period) beats.push(i / fps);
  let off = 0, os = -1;
  for (let k = 0; k < 4; k++) { let s = 0; for (let j = k; j < beats.length; j += 4) s += val(beats[j] * fps) * (0.5 + S.energy[Math.min(n - 1, Math.round(beats[j] * fps))]); if (s > os) { os = s; off = k; } }
  Object.assign(S, { period, beats, barOff: off });
  rebuildSel(); showTempo(); drawStrip();
}
function showTempo() {
  const bpm = 60 * S.fps / S.period;
  $('bpm').textContent = Math.round(bpm) + ' BPM';
  $('bpmTxt').textContent = S.beats.length + ' vuruş bulundu. Zoom yanlış yere düşüyorsa yarı/çift tempoyu dene.';
  $('half').disabled = $('dbl').disabled = false;
}

/* ---------- timeline strip ---------- */
const strip = $('strip');
function drawStrip() {
  if (strip.hidden) return;
  const dpr = devicePixelRatio || 1, W = strip.clientWidth * dpr, H = strip.clientHeight * dpr;
  if (strip.width !== W || strip.height !== H) { strip.width = W; strip.height = H; }
  const c = strip.getContext('2d'); c.clearRect(0, 0, W, H);
  const d = S.dur || 1;
  if (S.energy) { c.fillStyle = '#3a2f33'; c.beginPath(); c.moveTo(0, H);
    const n = S.energy.length; for (let x = 0; x <= W; x += 2) { const e = S.energy[Math.min(n - 1, Math.floor(x / W * n))]; c.lineTo(x, H - 6 - e * (H - 14)); }
    c.lineTo(W, H); c.fill(); }
  if (S.autoOn && S.edl) {
    const col = { W: '#5d6d7e', M: '#2fc2b5', C: '#e0475e' };
    for (const s of S.edl.shots) { c.fillStyle = col[s.kind]; c.fillRect(s.a / d * W + dpr, 0, Math.max(dpr, (s.b - s.a) / d * W - 2 * dpr), H * 0.16); }
  }
  c.fillStyle = '#8a7c81'; for (const t of S.sel) c.fillRect(t / d * W, H * 0.55, dpr, H * 0.45);
  c.fillStyle = '#e0475e'; for (const t of S.bars) c.fillRect(t / d * W - dpr / 2, H * 0.2, 2 * dpr, H * 0.8);
  c.fillStyle = 'rgba(0,0,0,.6)'; if (S.trim0) c.fillRect(0, 0, S.trim0 / d * W, H); if (S.trim1 != null) c.fillRect(S.trim1 / d * W, 0, W, H);
  const v = $('src'); c.fillStyle = '#fff'; c.fillRect(v.currentTime / d * W - dpr, 0, 2 * dpr, H);
}
new ResizeObserver(drawStrip).observe(strip);
strip.addEventListener('pointerdown', (e) => { const seek = (ev) => { const r = strip.getBoundingClientRect(); $('src').currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * S.dur; };
  seek(e); strip.setPointerCapture(e.pointerId); strip.onpointermove = seek; strip.onpointerup = () => { strip.onpointermove = null; }; });

/* ---------- preview ---------- */
const view = $('view'), src = $('src'); let preview = null;
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const lyr = $('lyr'), lctx = lyr.getContext('2d');
const fitRO = new ResizeObserver(() => { const w = Math.min(1080, Math.round(view.clientWidth * (devicePixelRatio || 1))); if (w > 0 && w !== view.width) { view.width = lyr.width = w; view.height = lyr.height = Math.round(w * 16 / 9); renderPreview(); } });
fitRO.observe($('screen')); fitRO.observe(view);
function renderPreview() {
  if (!preview || src.readyState < 2) return;
  preview.draw(src, src.videoWidth, src.videoHeight, fxAt(src.currentTime), src.currentTime);
  lctx.clearRect(0, 0, lyr.width, lyr.height);
  if (S.lyrOn && S.lyrics.length) drawLyrics(lctx, src.currentTime, lyr.width, lyr.height, S.lyrics, S.lyrStyle);
  if (S.texts.length) drawTexts(lctx, src.currentTime, lyr.width, lyr.height, S.texts, S.playing ? null : tl?.selectedText());
  tl?.playhead();
  $('tnow').textContent = fmt(src.currentTime); drawStrip();
}
const player = new SyncPlayer(src);
function loop() { const k = skipAt(S, src.currentTime); if (k && S.playing) src.currentTime = k.b; renderPreview(); if (S.playing) requestAnimationFrame(loop); }
$('play').onclick = () => { src.play(); };
src.ontimeupdate = () => { if (S.playing && S.trim1 != null && src.currentTime >= S.trim1) { src.pause(); src.currentTime = S.trim0 ?? 0; } };
src.onplay = () => { if (S.trim0 != null && (src.currentTime < S.trim0 - 0.1 || (S.trim1 != null && src.currentTime >= S.trim1))) src.currentTime = S.trim0; S.playing = true; $('play').hidden = true; player.start(); loop(); };
src.onpause = src.onended = () => { S.playing = false; $('play').hidden = false; player.stop(); renderPreview(); };
src.onseeked = () => { if (S.playing) player.start(); renderPreview(); };
src.onloadeddata = renderPreview;

/* ---------- load a file ---------- */
async function loadFile(file) {
  if (!file) return;
  resetResult(); S.file = file; S.beats = S.sel = S.bars = []; S.energy = null; S.edl = null; S.correct = null; $('autoOut').innerHTML = '';
  S.trim0 = S.trim1 = null; S.raw = S.proc = S.mixed = null; S.lyrics = []; S.skips = []; S.texts = []; player.set(null, false); renderLyricList(); $('lyrGo').disabled = true; $('audioStatus').textContent = ''; $('err').hidden = true;
  $('empty').hidden = true; view.hidden = false; strip.hidden = false; $('timebar').hidden = false; $('play').hidden = false; $('pInfo').hidden = false;
  if (src.src) URL.revokeObjectURL(src.src);
  src.src = URL.createObjectURL(file); src.load();
  if (!preview) preview = new Renderer(view);
  $('bpm').textContent = '…'; $('bpmTxt').textContent = 'Ritim analiz ediliyor…'; $('go').disabled = $('small').disabled = true;
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const [vt, at] = [await input.getPrimaryVideoTrack(), await input.getPrimaryAudioTrack()];
    if (!vt) throw new Error('Bu dosyada video bulunamadı');
    S.vtrack = vt;
    S.dur = await input.computeDuration(); $('tdur').textContent = fmt(S.dur);
    const vw = vt.displayWidth, vh = vt.displayHeight;
    const info = { Dosya: file.name, Boyut: (file.size / 1e6).toFixed(0) + ' MB', Çözünürlük: `${vw}×${vh}`, Süre: fmt(S.dur), Codec: (vt.codec || '?').toUpperCase(), Ses: at ? 'Var' : 'Yok' };
    if (vw > vh) info.Not = 'Yatay video: ortadan 9:16 kırpılacak';
    $('info').innerHTML = ''; for (const [k, v] of Object.entries(info)) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; $('info').append(dt, dd); }
    $('go').disabled = $('small').disabled = false; drawStrip();
    S.atrack = at;
    if (at) {
      const r = await analyzeAudio(at);
      if (S.file !== file) return;
      if (r && r.onset.length > r.fps * 4) { Object.assign(S, r); placeBeats(findTempo(r.onset, r.fps)); }
      else { $('bpm').textContent = '–'; $('bpmTxt').textContent = 'Video çok kısa, ritim bulunamadı'; }
    } else { $('bpm').textContent = '–'; $('bpmTxt').textContent = 'Videoda ses yok'; }
    renderPreview();
    if (S.autoOn && S.file === file) await runAuto();
    if (at && S.file === file) {
      $('audioStatus').textContent = 'Ses hazırlanıyor…';
      S.raw = await decodeFull(at, S.dur);
      if (S.file !== file) return;
      $('lyrGo').disabled = false; await applyAudio();
    }
  } catch (e) { showErr('Video okunamadı: ' + e.message); }
}
$('file').onchange = (e) => loadFile(e.target.files[0]);
$('file2').onchange = (e) => loadFile(e.target.files[0]);

/* ---------- controls ---------- */
const pressGroup = (box, attr, key, cast = Number) => box.addEventListener('click', (e) => { const b = e.target.closest('[' + attr + ']'); if (!b) return;
  for (const x of box.querySelectorAll('[' + attr + ']')) x.setAttribute('aria-pressed', String(x === b)); S[key] = cast(b.getAttribute(attr)); rebuildSel(); drawStrip(); renderPreview(); });
pressGroup($('looks'), 'data-look', 'look'); pressGroup($('every'), 'data-every', 'every');
for (const [id, key] of [['amt', 'amt'], ['power', 'power'], ['flash', 'flash']]) $(id).oninput = (e) => { S[key] = e.target.value / 100; $(id + 'V').textContent = e.target.value; renderPreview(); };
$('zoomOn').onchange = (e) => { S.zoomOn = e.target.checked; renderPreview(); };
$('flashOn').onchange = (e) => { S.flashOn = e.target.checked; renderPreview(); };
$('half').onclick = async () => { placeBeats(S.period * 2); if (S.autoOn) await runAuto(true); };
$('dbl').onclick = async () => { placeBeats(S.period / 2); if (S.autoOn) await runAuto(true); };

/* ---------- automatic edit ---------- */
let pic = null, autoBusy = false;
const fmtS = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
function setLook(l) { S.look = l; for (const x of $('looks').querySelectorAll('[data-look]')) x.setAttribute('aria-pressed', String(+x.dataset.look === l)); }
async function runAuto(musicOnly = false) {
  if (!S.file || autoBusy) return; autoBusy = true;
  const file = S.file, st = $('autoStatus'); $('autoGo').disabled = true; $('go').disabled = true;
  try {
    if (!musicOnly || !pic) {
      st.textContent = 'Görüntü analiz ediliyor: yüz, ışık, renk…'; pic = null;
      pic = await analyzePicture(S.vtrack, S.dur, (p) => { st.textContent = `Görüntü analiz ediliyor… %${Math.round(p * 100)}`; });
      if (S.file !== file) return;
    }
    st.textContent = 'Kurgu planı hazırlanıyor…';
    const audio = S.energy ? { energy: S.energy, fps: S.fps } : { energy: new Float32Array(Math.ceil(S.dur * 10)).fill(0.6), fps: 10 };
    const bpm = S.period ? 60 * S.fps / S.period : 0;
    S.correct = pic.correct;
    S.edl = buildEdit({ dur: S.dur, beats: S.beats, barOff: S.barOff, audio, pic, bpm, pace: S.pace, close: S.close, srcH: S.vtrack.displayHeight, targetShot: S.refOn ? S.targetShot : null });
    if (!musicOnly) setLook(S.edl.look);
    showAuto(); drawStrip(); tl.reset();
    if (src.currentTime < 0.6) src.currentTime = Math.min(1.5, S.dur / 3); else renderPreview();   // skip the fade-in black
    st.textContent = 'Otomatik kurgu hazır. Önizlemeyi oynat ya da doğrudan Reels videosunu oluştur.';
  } catch (e) { st.textContent = 'Otomatik kurgu yapılamadı: ' + e.message; }
  finally { autoBusy = false; $('autoGo').disabled = false; $('go').disabled = !S.file; }
}
function showAuto() {
  const E = S.edl, box = $('autoOut'); box.innerHTML = '';
  const cnt = { W: 0, M: 0, C: 0 }; E.shots.forEach((s) => cnt[s.kind]++);
  const rows = [
    ['Bölümler', E.secs.map((s) => `${s.name} ${fmtS(s.a)}`).join(' · ')],
    ['Kamera açıları', `${E.shots.length} plan: ${cnt.W} geniş, ${cnt.M} orta, ${cnt.C} yakın`],
    ['Yüz takibi', E.hasFace ? `Yüz bulundu (%${Math.round(pic.faceRate * 100)} karede)` : 'Yüz bulunamadı, kadraj ortada'],
    ['Renk düzeltme', `Pozlama ve beyaz dengesi ayarlandı`],
    ['Görünüm', E.look === 1 ? 'Alternatif Rock (enerjik şarkı)' : 'Sinematik (sakin şarkı)'],
  ];
  for (const [k, v] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; box.append(dt, dd); }
}
$('autoGo').onclick = () => runAuto();
$('autoOn').onchange = (e) => { S.autoOn = e.target.checked; $('every').style.opacity = S.autoOn ? 0.4 : 1; if (S.autoOn && !S.edl) runAuto(); drawStrip(); renderPreview(); };

/* ---------- export ---------- */
function showErr(m) { $('err').textContent = m; $('err').hidden = false; }
function resetResult() {
  if (S.result) URL.revokeObjectURL($('out').src);
  S.result = null; $('done').hidden = true; $('out').hidden = true; $('out').removeAttribute('src');
  if (S.file) { view.hidden = false; $('play').hidden = S.playing; }
}
$('go').onclick = () => exportFull();
$('goTop').onclick = () => { $('go').scrollIntoView({ behavior: 'smooth', block: 'center' }); exportFull(); };
$('small').onclick = () => runExport(true);
async function runExport(small) {
  if (!S.file) return;
  src.pause(); $('err').hidden = true; resetResult();
  $('go').disabled = $('small').disabled = true; $('progBox').hidden = false; $('progI').style.width = '0%'; $('progT').textContent = 'Hazırlanıyor…';
  let lock = null; try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  const t0 = performance.now();
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(S.file) });
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1920;
    const rr = new Renderer(cv);
    const withLyr = !small && S.lyrOn && S.lyrics.length > 0;
    const comp = document.createElement('canvas'); comp.width = 1080; comp.height = 1920; const cctx = comp.getContext('2d');
    if (withLyr) { try { await Promise.all(['800 92px Archivo', '700 64px Inter', '600 54px Inter'].map((f) => document.fonts.load(f))); } catch {} }
    const outCanvas = (t) => { if (!withLyr) return cv; cctx.drawImage(cv, 0, 0); drawLyrics(cctx, t, 1080, 1920, S.lyrics, S.lyrStyle); return comp; };
    const proc = !small && S.proc ? S.proc : null;
    const trim = !small && (S.trim0 != null || S.trim1 != null) ? { start: S.trim0 ?? 0, end: S.trim1 ?? S.dur } : null;
    const tOff = trim ? TS_SHIFT * trim.start : 0;
    const vcodec = (await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: 1080, height: 1920 })) || 'avc';
    const aac = await canEncodeAudio('aac');
    // Small copy: plain re-encode at 540x960, bitrate chosen so the file stays near 25 MB (under the 30 MB chat limit).
    const smallBits = Math.round(Math.min(3e6, Math.max(4e5, 25e6 * 8 / Math.max(1, S.dur) - 128000)));
    const video = small
      ? { width: 540, height: 960, fit: 'contain', frameRate: 30, codec: vcodec, bitrate: smallBits, forceTranscode: true }
      : { frameRate: 30, codec: vcodec, bitrate: 16e6, forceTranscode: true, allowTransformationMetadata: false,
          processedWidth: 1080, processedHeight: 1920,
          process: (s) => { const t = s.timestamp + tOff; const vf = s.toVideoFrame(); try { rr.draw(vf, vf.displayWidth, vf.displayHeight, fxAt(t), t); } finally { vf.close(); } return outCanvas(t); } };
    const conv = S.conv = await Conversion.init({
      input, output, video, ...(trim ? { trim } : {}),
      audio: { ...(aac ? { codec: 'aac', bitrate: small ? 128000 : 256000 } : {}), ...(proc ? { forceTranscode: true, process: (a) => swapSample(a, proc, tOff) } : {}) },
    });
    if (!conv.isValid) throw new Error('Bu video dönüştürülemiyor (' + conv.discardedTracks.map((d) => d.reason).join(', ') + ')');
    conv.onProgress = (p) => { const el = (performance.now() - t0) / 1000, eta = p > 0.03 ? el / p - el : 0;
      $('progI').style.width = (p * 100).toFixed(1) + '%';
      $('progT').textContent = `%${Math.round(p * 100)}` + (eta ? ` · yaklaşık ${Math.ceil(eta)} sn kaldı` : ''); };
    await conv.execute();
    const name = S.file.name.replace(/\.[^.]+$/, '') + (small ? '-kucuk.mp4' : '-reels.mp4');
    S.result = new File([target.buffer], name, { type: 'video/mp4' });
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    $('doneT').textContent = `Hazır: ${(S.result.size / 1e6).toFixed(1)} MB, ${secs} saniyede oluşturuldu.` + (aac ? '' : ' (Uyarı: AAC ses kodlanamadı)') + (vcodec !== 'avc' ? ` (Video: ${vcodec})` : '');
    $('done').hidden = false; view.hidden = true; $('play').hidden = true;
    const out = $('out'); out.src = URL.createObjectURL(S.result); out.hidden = false;
  } catch (e) {
    if (e?.name === 'ConversionCanceledError' || /cancel/i.test(e?.message || '')) showErr('Render iptal edildi.');
    else showErr('Render başarısız: ' + (e?.message || e));
  } finally {
    S.conv = null; $('progBox').hidden = true; $('go').disabled = $('small').disabled = false; try { await lock?.release(); } catch {}
  }
}
$('cancel').onclick = () => S.conv?.cancel();
$('back').onclick = () => { resetResult(); renderPreview(); };
$('dl').onclick = () => { if (!S.result) return; const a = document.createElement('a'); a.href = URL.createObjectURL(S.result); a.download = S.result.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
$('share').onclick = async () => {
  if (!S.result) return;
  if (navigator.canShare?.({ files: [S.result] })) { try { await navigator.share({ files: [S.result] }); } catch (e) { if (e.name !== 'AbortError') showErr('Paylaşım açılamadı: ' + e.message); } }
  else $('dl').click();
};
document.addEventListener('visibilitychange', () => { if (document.hidden && S.conv) $('progT').textContent += ' · Safari arka planda, render yavaşlayabilir'; });

/* ---------- vocal sound ---------- */
let audioTimer = 0, audioJob = 0;
async function applyAudio() {
  if (!S.raw) return;
  const job = ++audioJob, st = $('audioStatus');
  const active = S.clarity || (S.reverb !== 'yok' && S.wet > 0);
  const A = S.audioFx, eq = A.bass || A.treble;
  if (!active && !eq) { S.proc = null; remix(); st.textContent = 'Orijinal ses kullanılıyor.'; return; }
  st.textContent = 'Ses işleniyor…';
  const out = await enhance(S.raw, { clarity: S.clarity, reverb: S.reverb, wet: S.wet, bass: A.bass, treble: A.treble });
  if (job !== audioJob) return;
  S.proc = out; remix();
  st.textContent = (S.clarity ? 'Vokal netleştirildi' : 'Netleştirme kapalı') + (S.reverb !== 'yok' && S.wet > 0 ? `, ${$('rev').querySelector('[aria-pressed=true]').textContent} reverb eklendi.` : '.') + ' Oynatarak dinle.';
}
const queueAudio = () => { clearTimeout(audioTimer); audioTimer = setTimeout(applyAudio, 350); };
$('clarity').onchange = (e) => { S.clarity = e.target.checked; queueAudio(); };
$('rev').addEventListener('click', (e) => { const b = e.target.closest('[data-rev]'); if (!b) return;
  for (const x of $('rev').querySelectorAll('[data-rev]')) x.setAttribute('aria-pressed', String(x === b)); S.reverb = b.dataset.rev; queueAudio(); });
$('wet').oninput = (e) => { S.wet = e.target.value / 100; $('wetV').textContent = e.target.value; queueAudio(); };
$('ab').onclick = () => { S.origAB = !S.origAB; $('ab').textContent = S.origAB ? 'İşlenmiş sesi dinle' : 'Orijinali dinle'; remix(); };

/* ---------- lyrics ---------- */
function renderLyricList() {
  const box = $('lyrList'); box.innerHTML = '';
  S.lyrics.forEach((l, i) => {
    const row = document.createElement('div'); row.className = 'lrow';
    const tm = document.createElement('button'); tm.className = 'ghost small'; tm.textContent = fmt(l.a); tm.title = 'Bu satıra git';
    tm.onclick = () => { src.currentTime = l.a + 0.05; };
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = l.text; inp.id = 'lyr-' + i;
    inp.oninput = () => { l.text = inp.value; renderPreview(); };
    const del = document.createElement('button'); del.className = 'ghost small'; del.textContent = 'Sil';
    del.onclick = () => { S.lyrics.splice(i, 1); renderLyricList(); renderPreview(); };
    row.append(tm, inp, del); box.append(row);
  });
  $('lyrOpts').hidden = !S.lyrics.length;
}
$('lyrGo').onclick = async () => {
  if (!S.raw) return; const st = $('lyrStatus'), b = $('lyrGo'); b.disabled = true;
  try {
    const lines = await transcribe(S.raw, { lang: $('lang').value || null, big: $('bigModel').checked }, (m) => { st.textContent = m; });
    S.lyrics = lines; renderLyricList(); renderPreview();
    st.textContent = lines.length ? `${lines.length} satır bulundu. Yanlış kelimeleri kutulardan düzeltebilirsin.` : 'Söz bulunamadı. Vokal müzikten zayıf olabilir; büyük modeli dene.';
  } catch (e) { st.textContent = 'Sözler çıkarılamadı: ' + (e?.message || e); }
  b.disabled = false;
};
$('lyrOn').onchange = (e) => { S.lyrOn = e.target.checked; renderPreview(); };
$('lyrStyle').addEventListener('click', (e) => { const b = e.target.closest('[data-style]'); if (!b) return;
  for (const x of $('lyrStyle').querySelectorAll('[data-style]')) x.setAttribute('aria-pressed', String(x === b)); S.lyrStyle = b.dataset.style; renderPreview(); });

/* ---------- sharpness ---------- */
$('sharp').oninput = (e) => { S.sharpen = e.target.value / 100; $('sharpV').textContent = e.target.value; renderPreview(); };

/* ---------- "Anlat, düzenlesin" ---------- */
const lookName = ['dogal', 'rock', 'sinematik'];
function currentSettings() {
  return {
    duration: +S.dur.toFixed(2), look: lookName[S.look], colorIntensity: Math.round(S.amt * 100), sharpen: Math.round(S.sharpen * 100),
    cutSpeed: S.pace, closeups: S.close, zoomOn: S.zoomOn, zoomPower: Math.round(S.power * 100), flashOn: S.flashOn, flashPower: Math.round(S.flash * 100),
    clarity: S.clarity, reverb: S.reverb, reverbAmount: Math.round(S.wet * 100), lyricsOn: S.lyrOn, lyricsStyle: S.lyrStyle,
    trimStart: S.trim0, trimEnd: S.trim1, fadeIn: S.fadeIn, fadeOut: S.fadeOut, fxPower: Math.round(S.fxPower * 100),
  };
}
function analysisContext() {
  return {
    ayarlar: currentSettings(),
    tempoBPM: S.period ? Math.round(60 * S.fps / S.period) : null,
    bolumler: S.edl ? S.edl.secs.map((s) => ({ ad: s.name, bas: +s.a.toFixed(1), son: +s.b.toFixed(1) })) : [],
    yuzBulundu: S.edl ? S.edl.hasFace : null,
    sarkiSozleri: S.lyrics.slice(0, 80).map((l) => ({ bas: l.a, son: l.b, metin: l.text })),
  };
}
const clamp01 = (v) => Math.max(0, Math.min(100, Number(v))) / 100;
function pressIn(box, attr, val) { for (const x of $(box).querySelectorAll('[' + attr + ']')) x.setAttribute('aria-pressed', String(x.getAttribute(attr) === String(val))); }
function setRange(id, v100) { $(id).value = Math.round(v100); $(id + 'V').textContent = Math.round(v100); }
async function applyPlan(p) {
  const changed = []; let reEdit = false, reAudio = false;
  const has = (k) => p[k] !== null && p[k] !== undefined;
  if (has('look')) { setLook(lookName.indexOf(p.look)); changed.push('görünüm'); }
  if (has('colorIntensity')) { S.amt = clamp01(p.colorIntensity); setRange('amt', S.amt * 100); changed.push('renk yoğunluğu'); }
  if (has('sharpen')) { S.sharpen = clamp01(p.sharpen); setRange('sharp', S.sharpen * 100); changed.push('netlik'); }
  if (has('cutSpeed')) { S.pace = p.cutSpeed; reEdit = true; changed.push('kesme hızı'); }
  if (has('closeups')) { S.close = p.closeups; reEdit = true; changed.push('yakın planlar'); }
  if (has('zoomOn')) { S.zoomOn = !!p.zoomOn; $('zoomOn').checked = S.zoomOn; changed.push('zoom'); }
  if (has('zoomPower')) { S.power = clamp01(p.zoomPower); setRange('power', S.power * 100); }
  if (has('flashOn')) { S.flashOn = !!p.flashOn; $('flashOn').checked = S.flashOn; changed.push('flaş'); }
  if (has('flashPower')) { S.flash = clamp01(p.flashPower); setRange('flash', S.flash * 100); }
  if (has('clarity')) { S.clarity = !!p.clarity; $('clarity').checked = S.clarity; reAudio = true; changed.push('vokal netliği'); }
  if (has('reverb')) { S.reverb = p.reverb; pressIn('rev', 'data-rev', p.reverb); reAudio = true; changed.push('reverb'); }
  if (has('reverbAmount')) { S.wet = clamp01(p.reverbAmount); setRange('wet', S.wet * 100); reAudio = true; changed.push('reverb miktarı'); }
  if (has('lyricsOn')) { S.lyrOn = !!p.lyricsOn; $('lyrOn').checked = S.lyrOn; }
  if (has('lyricsStyle')) { S.lyrStyle = p.lyricsStyle; pressIn('lyrStyle', 'data-style', p.lyricsStyle); changed.push('altyazı stili'); }
  if (has('fx')) { for (const [k, v] of Object.entries(p.fx)) { S.fx[k] = !!v; $('fxChips').querySelector(`[data-fx=${k}]`)?.setAttribute('aria-pressed', String(!!v)); } changed.push('efektler'); }
  if (has('trans')) { S.trans = p.trans; pressIn('transChips', 'data-trans', p.trans); changed.push('geçiş'); }
  if (has('fxPower')) { S.fxPower = clamp01(p.fxPower); setRange('fxPower', S.fxPower * 100); }
  if (has('trimStart')) { S.trim0 = Math.max(0, Math.min(S.dur - 1, +p.trimStart)) || null; changed.push('başlangıç'); }
  if (has('trimEnd')) { const e = Math.max(1, Math.min(S.dur, +p.trimEnd)); S.trim1 = e >= S.dur - 0.05 ? null : e; changed.push('bitiş'); }
  if (S.trim0 != null && S.trim1 != null && S.trim1 <= S.trim0 + 1) S.trim1 = null;
  if (has('fadeIn')) S.fadeIn = Math.max(0, Math.min(5, +p.fadeIn));
  if (has('fadeOut')) S.fadeOut = Math.max(0, Math.min(8, +p.fadeOut));
  $('trimInfo').textContent = S.trim0 != null || S.trim1 != null ? `Kesit: ${fmt(S.trim0 ?? 0)} – ${fmt(S.trim1 ?? S.dur)}` : '';
  if (reEdit && S.autoOn) await runAuto(true);
  if (reAudio) await applyAudio();
  if (S.trim0 != null && (src.currentTime < S.trim0 || (S.trim1 != null && src.currentTime > S.trim1))) src.currentTime = S.trim0;
  drawStrip(); renderPreview();
  return changed;
}
function addMsg(who, text) { const d = document.createElement('div'); d.className = 'msg ' + who; d.textContent = text; $('chat').append(d); $('chat').scrollTop = 1e9; }
async function sendPrompt() {
  const text = $('ask').value.trim(); if (!text || !S.file) return;
  $('ask').value = ''; addMsg('me', text); $('askGo').disabled = true;
  const wait = document.createElement('div'); wait.className = 'msg bot muted'; wait.textContent = getKey() ? 'Claude düşünüyor…' : 'Yorumlanıyor…'; $('chat').append(wait);
  try {
    let plan;
    if (getKey()) {
      try { plan = await askClaude(text, analysisContext()); }
      catch (e) { plan = parseLocal(text, currentSettings(), analysisContext()); plan.reply = `Claude'a ulaşılamadı (${e.message}), ücretsiz modla yaptım. ` + plan.reply; }
    } else plan = parseLocal(text, currentSettings(), analysisContext());
    const changed = await applyPlan(plan);
    wait.remove(); addMsg('bot', (plan.reply || '') + (changed.length ? `\nDeğişenler: ${changed.join(', ')}.` : ''));
  } catch (e) { wait.remove(); addMsg('bot', 'Bir hata oldu: ' + e.message); }
  $('askGo').disabled = false;
}
$('askGo').onclick = sendPrompt;
$('quick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (!b || !S.file) return; $('ask').value = b.dataset.q; sendPrompt(); });
$('ask').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); } });
$('resetTrim').onclick = () => { S.trim0 = S.trim1 = null; $('trimInfo').textContent = ''; drawStrip(); renderPreview(); };
function showKeyState() { const k = getKey(); $('keyState').textContent = k ? 'Claude bağlı ✓' : 'kapalı (ücretsiz mod kullanılıyor)'; $('keyIn').value = ''; $('keyDel').hidden = !k; }
$('keySave').onclick = () => { const v = $('keyIn').value.trim(); if (v) { setKey(v); showKeyState(); } };
$('keyDel').onclick = () => { setKey(''); showKeyState(); };
showKeyState();

/* ---------- effects ---------- */
$('fxChips').addEventListener('click', (e) => { const b = e.target.closest('[data-fx]'); if (!b) return;
  const k = b.dataset.fx; S.fx[k] = !S.fx[k]; b.setAttribute('aria-pressed', String(S.fx[k])); renderPreview(); });
$('transChips').addEventListener('click', (e) => { const b = e.target.closest('[data-trans]'); if (!b) return;
  S.trans = b.dataset.trans; pressIn('transChips', 'data-trans', S.trans); renderPreview(); });
$('fxPower').oninput = (e) => { S.fxPower = e.target.value / 100; $('fxPowerV').textContent = e.target.value; renderPreview(); };

/* ---------- reference video ---------- */
async function applyRef() {
  if (!S.ref) return;
  if (S.refOn) {
    const p = S.ref.p; S.targetShot = p.targetShot;
    S.flashOn = p.flashOn; $('flashOn').checked = p.flashOn; if (p.flash != null) { S.flash = p.flash; setRange('flash', p.flash * 100); }
    S.power = p.zoomPower; setRange('power', p.zoomPower * 100); S.fxPower = p.fxPower; setRange('fxPower', p.fxPower * 100);
    S.fx.shake = p.shake; S.fx.letterbox = p.letterbox;
    for (const k of ['shake', 'letterbox']) $('fxChips').querySelector(`[data-fx=${k}]`).setAttribute('aria-pressed', String(S.fx[k]));
    setLook(0);
  } else S.targetShot = null;
  if (S.file && S.autoOn) await runAuto(true); else renderPreview();
}
$('refFile').onchange = (e) => { const f = e.target.files[0]; if (f) useReference(f); };
/* reference by link: direct video links are downloaded; social links get step-by-step help */
const SOCIAL = [
  [/instagram\.com\/(reel|reels|p|tv)\//i, 'Instagram', "Instagram'da aç ↗", ['Aşağıdaki bağlantıyla Reels\'i Instagram\'da aç.', 'Paylaş (✈) düğmesine dokun, menüde <b>İndir</b> seçeneği varsa ona bas; video Fotoğraflar\'a kaydedilir. İndir yoksa Denetim Merkezi\'nden <b>ekran kaydı</b> al.', 'Cover Stüdyo\'ya dön ve <b>Referans video seç</b> ile o videoyu seç.']],
  [/tiktok\.com\//i, 'TikTok', "TikTok'ta aç ↗", ['Videoyu TikTok\'ta aç.', 'Paylaş → <b>Videoyu kaydet</b> ile Fotoğraflar\'a kaydet (ya da ekran kaydı al).', '<b>Referans video seç</b> ile o videoyu seç.']],
  [/(youtube\.com|youtu\.be)\//i, 'YouTube', "YouTube'da aç ↗", ['Videoyu YouTube\'da aç.', 'Denetim Merkezi\'nden <b>ekran kaydı</b> al (YouTube indirmeye izin vermiyor).', '<b>Referans video seç</b> ile kaydı seç.']],
];
$('refGo').onclick = async () => {
  const raw = $('refUrl').value.trim(), help = $('refHelp'), st = $('refStatus'); help.hidden = true;
  if (!raw) return;
  let url; try { url = new URL(raw.startsWith('http') ? raw : 'https://' + raw); } catch { st.textContent = 'Bu bir bağlantıya benzemiyor.'; return; }
  const soc = SOCIAL.find(([re]) => re.test(url.href));
  const showHelp = (label, steps, why) => {
    const a = document.createElement('a'); a.href = url.href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label;
    help.innerHTML = `<b>${why}</b><ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol>`; help.append(a); help.hidden = false; st.textContent = '';
  };
  if (soc) return showHelp(soc[2], soc[3], `${soc[1]} videoları bağlantıdan doğrudan alınamıyor (${soc[1]} izin vermiyor). En hızlı yol:`);
  st.textContent = 'Video indiriliyor…';
  try {
    const res = await fetch(url.href); if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!/video|octet-stream|mp4|quicktime/.test(type)) throw new Error('bağlantı bir video dosyası değil');
    const blob = await res.blob();
    await useReference(new File([blob], url.pathname.split('/').pop() || 'referans.mp4', { type: type.split(';')[0] }));
  } catch (er) {
    showHelp('Bağlantıyı aç ↗', ['Bağlantıyı aç ve videoyu iPad\'e kaydet (ya da ekran kaydı al).', '<b>Referans video seç</b> ile o videoyu seç.'], `Bu bağlantıdan video alınamadı (${er.message === 'Failed to fetch' || er.name === 'TypeError' ? 'site dışarıdan indirmeye izin vermiyor' : er.message}).`);
  }
};
$('refUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('refGo').click(); } });
async function useReference(f) {
  const st = $('refStatus'); $('refHelp').hidden = true;
  st.textContent = 'Referans video inceleniyor…';
  try {
    const r = await analyzeReference(f, (x) => { st.textContent = `Referans video inceleniyor… %${Math.round(x * 100)}`; });
    const { p, summary } = styleToSettings(r);
    S.ref = { r, p, color: r.color }; S.refOn = true; $('refOn').checked = true; $('refOpts').hidden = false;
    st.textContent = 'Referanstan öğrenilenler: ' + summary + '.' + (S.file ? '' : ' Şimdi kendi videonu seç, bu stil uygulanacak.');
    await applyRef();
  } catch (er) { st.textContent = 'Referans incelenemedi: ' + er.message; }
}
$('refOn').onchange = async (e) => { S.refOn = e.target.checked; await applyRef(); };
$('refAmt').oninput = (e) => { S.refAmt = e.target.value / 100; $('refAmtV').textContent = e.target.value; renderPreview(); };

/* ---------- audio mix: volume, per-shot gain, fades ---------- */
function remix() {
  const base = S.proc || S.raw; if (!base) return;
  const A = S.audioFx, gains = (S.edl?.shots || []).filter((s) => s.gain != null && s.gain !== 1).map((s) => ({ a: s.a, b: s.b, gain: s.gain }));
  const w = win(), plain = !S.proc && A.vol === 1 && !gains.length && !A.fin && !A.fout;
  S.mixed = plain ? null : mixAudio(base, { vol: A.vol, gains, fin: A.fin, fout: A.fout, t0: w.t0, t1: w.t1 });
  player.set(S.origAB ? null : S.mixed, !S.origAB && !!S.mixed);
}
let remixTimer = 0;
const queueRemix = () => { clearTimeout(remixTimer); remixTimer = setTimeout(remix, 250); };
for (const [id, key, f] of [['vol', 'vol', (v) => v / 100], ['bass', 'bass', (v) => +v], ['treble', 'treble', (v) => +v], ['afin', 'fin', (v) => +v], ['afout', 'fout', (v) => +v]]) {
  $(id).oninput = (e) => { S.audioFx[key] = f(e.target.value); $(id + 'V').textContent = e.target.value; if (key === 'bass' || key === 'treble') queueAudio(); else queueRemix(); };
}

/* ---------- timeline ---------- */
const tl = initTimeline({
  S, $, fmt, render: () => renderPreview(), time: () => src.currentTime,
  seek: (t) => { src.currentTime = Math.max(0, Math.min(S.dur, t)); },
  togglePlay: () => { if (src.paused) src.play(); else src.pause(); },
  cover: () => { const as = (src.videoWidth || 9) / (src.videoHeight || 16), ad = 9 / 16; return [as > ad ? ad / as : 1, as > ad ? 1 : as / ad]; },
  framing: (kind, s) => {
    if (kind === 'W') return { kind, z: 1, cx: 0.5, cy: 0.5, drift: 0.03 };
    const f = pic?.faces?.length ? pic.faces.filter((p) => p.t >= s.a && p.t < s.b) : [];
    const fx = f.length ? f.reduce((a, p) => a + p.x, 0) / f.length : 0.5, fy = f.length ? f.reduce((a, p) => a + p.y, 0) / f.length : 0.38, fw = f.length ? f.reduce((a, p) => a + p.w, 0) / f.length : 0.22;
    const zMax = Math.max(1.3, Math.min(2.1, 1.55 * (S.vtrack?.displayHeight || 1920) / 1920));
    return kind === 'M' ? { kind, z: 1.28, cx: 0.5 + (fx - 0.5) * 0.7, cy: 0.5 + (fy + 0.04 - 0.5) * 0.7, drift: 0.02 }
      : { kind, z: Math.min(zMax, Math.max(1.3, 0.34 / fw)), cx: fx, cy: fy + 0.04, drift: 0.01 };
  },
  onEdit: (audio) => { drawStrip(); renderPreview(); if (audio) queueRemix(); },
});
src.addEventListener('loadedmetadata', () => tl.draw());
new ResizeObserver(() => tl.draw()).observe($('tl'));

/* ---------- full export: kept ranges, per-shot effects, texts, mixed audio ---------- */
async function exportFull() {
  if (!S.file || S.conv) return;
  src.pause(); $('err').hidden = true; resetResult();
  $('go').disabled = $('small').disabled = true; $('progBox').hidden = false; $('progI').style.width = '0%'; $('progT').textContent = 'Hazırlanıyor…';
  let lock = null; try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  const t0 = performance.now(); let cancelled = false; S.conv = { cancel: () => { cancelled = true; } };
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(S.file) });
    const vt = await input.getPrimaryVideoTrack();
    const ranges = keepRanges(S); if (!ranges.length) throw new Error('Videodan hiçbir parça kalmadı');
    const total = ranges.reduce((s, [a, b]) => s + b - a, 0);
    const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1920; const rr = new Renderer(cv);
    const comp = document.createElement('canvas'); comp.width = 1080; comp.height = 1920; const cctx = comp.getContext('2d');
    try { await Promise.all(['800 92px Archivo', '700 64px Inter', '600 54px Inter', ...FONTS.map(([f, w]) => `${w} 60px "${f}"`)].map((f) => document.fonts.load(f))); } catch {}
    const vcodec = (await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: 1080, height: 1920 })) || 'avc';
    const aac = await canEncodeAudio('aac');
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const vsrc = new CanvasSource(comp, { codec: vcodec, bitrate: 16e6, keyFrameInterval: 2 });
    output.addVideoTrack(vsrc, { frameRate: 30 });
    const abase = S.mixed || S.proc || S.raw;
    const audio = abase ? joinRanges(abase, ranges) : null;
    let asrc = null;
    if (audio) { asrc = new AudioBufferSource({ codec: aac ? 'aac' : 'opus', bitrate: 256000 }); output.addAudioTrack(asrc); }
    await output.start();
    const sr = audio?.sampleRate || 48000; let aPos = 0;
    const feedAudio = async (upTo) => {   // keep audio about a second ahead of the picture
      while (audio && aPos < audio.length && aPos / sr < upTo + 1) {
        const n = Math.min(sr, audio.length - aPos), chunk = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
        for (let c = 0; c < 2; c++) chunk.copyToChannel(audio.getChannelData(c).subarray(aPos, aPos + n), c);
        await asrc.add(chunk); aPos += n;
      }
    };
    const sink = new VideoSampleSink(vt); let outBase = 0, done = 0;
    for (const [a, b] of ranges) {
      let last = -1;
      for await (const s of sink.samples(a, b)) {
        if (cancelled) { s.close(); throw new Error('cancel'); }
        const t = s.timestamp;
        if (t < a - 0.001 || (last >= 0 && t - last < 1 / 30 - 0.004)) { s.close(); continue; }
        last = t;
        const rot = ((s.rotation || 0) % 360 + 360) % 360, vf = s.toVideoFrame();
        const dw = rot % 180 ? vf.displayHeight : vf.displayWidth, dh = rot % 180 ? vf.displayWidth : vf.displayHeight;
        try { rr.draw(vf, dw, dh, fxAt(t), t, rot); } finally { vf.close(); s.close(); }
        cctx.drawImage(cv, 0, 0);
        if (S.lyrOn && S.lyrics.length) drawLyrics(cctx, t, 1080, 1920, S.lyrics, S.lyrStyle);
        if (S.texts.length) drawTexts(cctx, t, 1080, 1920, S.texts, null);
        const ot = outBase + Math.max(0, t - a);
        await feedAudio(ot);
        await vsrc.add(ot, 1 / 30);
        done = ot;
        const p = done / total, el = (performance.now() - t0) / 1000, eta = p > 0.03 ? el / p - el : 0;
        $('progI').style.width = (p * 100).toFixed(1) + '%';
        $('progT').textContent = `%${Math.round(p * 100)}` + (eta ? ` · yaklaşık ${Math.ceil(eta)} sn kaldı` : '');
      }
      outBase += b - a;
    }
    await feedAudio(1e9);
    await output.finalize();
    const name = S.file.name.replace(/\.[^.]+$/, '') + '-reels.mp4';
    S.result = new File([target.buffer], name, { type: 'video/mp4' });
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    $('doneT').textContent = `Hazır: ${(S.result.size / 1e6).toFixed(1)} MB, ${Math.round(total)} sn video, ${secs} saniyede oluşturuldu.` + (aac ? '' : ' (Uyarı: AAC ses kodlanamadı)') + (vcodec !== 'avc' ? ` (Video: ${vcodec})` : '');
    $('done').hidden = false; view.hidden = true; $('play').hidden = true;
    const out = $('out'); out.src = URL.createObjectURL(S.result); out.hidden = false;
  } catch (e) {
    showErr(/cancel/i.test(e?.message || '') ? 'Render iptal edildi.' : 'Render başarısız: ' + (e?.message || e));
  } finally {
    S.conv = null; $('progBox').hidden = true; $('go').disabled = $('small').disabled = false; try { await lock?.release(); } catch {}
  }
}
