// "Anlat, düzenlesin": turns a spoken-style Turkish instruction into edit settings.
// With an API key it asks Claude (structured JSON output); without one it uses a small keyword parser.

const KEY_STORE = 'coverstudyo.apikey';
export const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
export const setKey = (k) => { try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch {} };

const n = (desc) => ({ anyOf: [{ type: 'number' }, { type: 'null' }], description: desc });
const b = (desc) => ({ anyOf: [{ type: 'boolean' }, { type: 'null' }], description: desc });
const e = (vals, desc) => ({ anyOf: [{ type: 'string', enum: vals }, { type: 'null' }], description: desc });
const FIELDS = {
  look: e(['dogal', 'rock', 'sinematik'], 'Renk görünümü'),
  colorIntensity: n('Renk efekti yoğunluğu 0-100'),
  sharpen: n('Netlik/keskinlik 0-100 (varsayılan 40)'),
  cutSpeed: e(['yavas', 'normal', 'hizli'], 'Kamera açıları arası kesme hızı'),
  closeups: e(['az', 'normal', 'cok'], 'Yüze yakın plan miktarı'),
  zoomOn: b('Vuruşta zoom açık mı'),
  zoomPower: n('Vuruş zoomu gücü 0-100 (varsayılan 45)'),
  flashOn: b('Işık flaşları açık mı'),
  flashPower: n('Flaş gücü 0-100 (varsayılan 40)'),
  clarity: b('Vokal netleştirme (EQ, kompresör, seviye) açık mı'),
  reverb: e(['yok', 'oda', 'plate', 'salon'], 'Reverb türü'),
  reverbAmount: n('Reverb miktarı 0-100 (varsayılan 25)'),
  lyricsOn: b('Şarkı sözü altyazısı gösterilsin mi'),
  lyricsStyle: e(['minimal', 'kelime', 'buyuk'], 'Altyazı stili: minimal=sade alt yazı, kelime=karaoke gibi kelime kelime, buyuk=ortada büyük harf'),
  trimStart: n('Videonun başlayacağı saniye (kaynak videoya göre)'),
  trimEnd: n('Videonun biteceği saniye (kaynak videoya göre)'),
  fadeIn: n('Siyahtan açılış süresi, saniye'),
  fadeOut: n('Siyaha kararma süresi, saniye'),
};
const SCHEMA = {
  type: 'object',
  properties: { ...FIELDS, reply: { type: 'string', description: 'Kullanıcıya kısa Türkçe açıklama: ne değişti, yapılamayan bir şey varsa nedeni' } },
  required: [...Object.keys(FIELDS), 'reply'],
  additionalProperties: false,
};
const SYSTEM = `Sen bir iPad cover video düzenleme uygulamasının kurgu asistanısın. Kullanıcı bir şan eğitmeni; tek çekim cover videolarını Instagram Reels (1080x1920) için düzenliyor.
Kullanıcının Türkçe isteğini, verilen JSON şemasındaki ayarlara çevir. Yalnızca kullanıcının değiştirmek istediği alanları doldur; değişmeyecek her alan null olsun.
Mevcut ayarlar ve videonun analizi (süre, tempo, şarkı bölümleri, şarkı sözleri) mesajda verilir. "Nakaratı al", "ikinci kıtadan başlat" gibi isteklerde bölüm ve söz zamanlarını kullanarak trimStart/trimEnd hesapla; saniyeleri kaynak videoya göre ver.
"Daha fazla", "biraz azalt" gibi göreli isteklerde mevcut değerden yola çık (biraz ≈ 15, çok ≈ 30 puan).
Uygulamanın yapamadığı bir şey istenirse (örneğin yeni çekim eklemek, yüzü güzelleştirmek) ilgili alanları null bırak ve reply içinde kibarca, kısaca açıkla.
reply en fazla iki kısa cümle, samimi ve Türkçe olsun.`;

export async function askClaude(text, context) {
  const key = getKey(); if (!key) throw new Error('API anahtarı yok');
  const { default: Anthropic } = await import('./vendor/anthropic/anthropic-sdk.mjs');
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Mevcut durum:\n${JSON.stringify(context)}\n\nKullanıcının isteği: ${text}` }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude bu isteği işleyemedi');
  const block = res.content.find((c) => c.type === 'text');
  if (!block) throw new Error('Boş yanıt');
  return JSON.parse(block.text);
}

// Free, offline understanding of Turkish edit requests (no API key needed).
// Splits the request into clauses and reads moods, song sections, durations and
// per-target "more / less / off" in each clause.
const MOODS = [
  { w: ['duygusal', 'hüzünlü', 'romantik', 'melankolik', 'dokunaklı', 'yumuşak', 'sakin', 'huzurlu', 'naif'], name: 'duygusal',
    p: { look: 'sinematik', colorIntensity: 70, cutSpeed: 'yavas', closeups: 'normal', zoomOn: true, zoomPower: 22, flashOn: false, reverb: 'salon', reverbAmount: 35, lyricsOn: true, lyricsStyle: 'minimal', fadeIn: 1.0, fadeOut: 2.0, fx: { shake: false, rgb: false, vhs: false, glow: true, leak: true }, trans: 'kesme' } },
  { w: ['enerjik', 'hareketli', 'coşkulu', 'agresif', 'sert', 'güçlü bir', 'patlayan', 'hızlı bir', 'canlı'], name: 'enerjik',
    p: { look: 'rock', colorIntensity: 85, cutSpeed: 'hizli', closeups: 'cok', zoomOn: true, zoomPower: 65, flashOn: true, flashPower: 60, reverb: 'plate', reverbAmount: 20, lyricsOn: true, lyricsStyle: 'buyuk', fadeIn: 0.3, fadeOut: 0.8, fx: { shake: true, rgb: true, leak: false }, trans: 'kaydir' } },
  { w: ['capcut', 'trend', 'viral', 'tiktok'], name: 'trend (CapCut tarzı)',
    p: { look: 'rock', colorIntensity: 80, cutSpeed: 'hizli', closeups: 'cok', zoomOn: true, zoomPower: 60, flashOn: true, flashPower: 55, lyricsOn: true, lyricsStyle: 'pop', fx: { shake: true, rgb: true, glow: true }, trans: 'zoom', fxPower: 60 } },
  { w: ['karanlık', 'dramatik', 'gizemli', 'kasvetli', 'loş'], name: 'karanlık ve dramatik',
    p: { look: 'sinematik', colorIntensity: 95, cutSpeed: 'normal', closeups: 'cok', zoomOn: true, zoomPower: 40, flashOn: true, flashPower: 30, reverb: 'salon', reverbAmount: 30, fadeIn: 1.2, fadeOut: 1.8, fx: { letterbox: true, glow: true }, trans: 'zoom' } },
  { w: ['doğal', 'sade', 'minimal', 'efektsiz', 'temiz', 'abartısız', 'gerçekçi'], name: 'doğal ve sade',
    p: { look: 'dogal', cutSpeed: 'yavas', closeups: 'az', zoomOn: false, flashOn: false, reverb: 'oda', reverbAmount: 15, lyricsStyle: 'minimal', fadeIn: 0.5, fadeOut: 1.0, fx: { shake: false, rgb: false, glow: false, leak: false, vhs: false, letterbox: false }, trans: 'kesme' } },
  { w: ['sinematik', 'film gibi', 'filmsel', 'klip gibi'], name: 'sinematik', p: { look: 'sinematik', colorIntensity: 85 } },
  { w: ['rock', 'rok', 'grunge', 'alternatif'], name: 'alternatif rock', p: { look: 'rock', colorIntensity: 85 } },
];
const ORD = { 'ilk': 1, 'birinci': 1, '1.': 1, 'ikinci': 2, '2.': 2, 'üçüncü': 3, '3.': 3, 'dördüncü': 4, '4.': 4, 'son': -1 };
const SEC_WORDS = { nakarat: 'Nakarat', kıta: 'Kıta', kita: 'Kıta', giriş: 'Giriş', çıkış: 'Çıkış', final: 'Çıkış' };
const num = (x) => parseFloat(String(x).replace(',', '.'));
const clampV = (v) => Math.max(0, Math.min(100, Math.round(v)));
const timeOf = (s) => { const m = s.match(/(\d+):(\d{1,2})/); return m ? +m[1] * 60 + +m[2] : null; };

export function parseLocal(text, cur, ctx = {}) {
  const all = text.toLocaleLowerCase('tr').replace(/[!?;]/g, ',');
  const secs = ctx.bolumler || [];
  const dur = cur.duration;
  const p = {}, said = [], missed = [];
  const clauses = all.split(/,|\.(?!\d)|\bve\b|\bama\b|\bayrıca\b|\bsonra\b|\bdaha sonra\b/).map((c) => c.trim()).filter(Boolean);
  const findSec = (name, ord) => { const list = secs.filter((s) => s.ad === name); if (!list.length) return null; return ord === -1 ? list.at(-1) : list[Math.min(list.length, ord || 1) - 1]; };

  for (const c0 of clauses) {
    const c = ' ' + c0.replace(/sadece/g, 'yalnızca') + ' ';   // "sadece" must not read as "sade"
    const has = (...w) => w.some((x) => c.includes(x));
    const verb = (...w) => w.some((x) => new RegExp('(^|\\s)' + x + '(\\s|$|ın|in|alım|elim|sin|sın)').test(c));
    const saidBefore = said.length, missedBefore = missed.length;
    // amount words
    const off = has('kapat', 'olmasın', 'istemiyorum', 'kaldır', ' hiç ', 'iptal', ' yok', 'gerek yok', 'gizle');
    const down = has('azalt', ' az ', 'düşür', 'hafif', 'yumuşat', ' kıs', 'zayıf', 'sadeleştir');
    const up = !down && has('artır', 'arttır', 'yükselt', 'fazla', 'güçlendir', 'güçlü', ' çok', 'abart', 'belirgin', 'ekle', ' koy', 'yoğun');
    const size = has('biraz', 'azıcık', 'hafifçe') ? 12 : has('çok', 'epey', 'oldukça', 'iyice', 'baya', 'bayağı') ? 32 : 20;
    const maxed = has('maksimum', 'en fazla', 'full', 'sonuna kadar'), mined = has('minimum', 'en az');
    const adj = (k) => { const v = p[k] ?? cur[k]; return maxed ? 100 : mined ? 5 : clampV(v + (down ? -size : size)); };

    // moods (presets)
    for (const m of MOODS) if (m.w.some((w) => c.includes(w)) && !(m.name === 'doğal ve sade' && has('renk'))) { Object.assign(p, m.p); said.push(`${m.name} bir hava`); break; }

    // song sections and time ranges
    const secKey = Object.keys(SEC_WORDS).find((k) => c.includes(k));
    const locative = secKey && new RegExp(secKey + "'?(da|ta|de|te)(ki)?(\\s|$)").test(c);   // "nakaratta ..." describes, doesn't cut
    if (secKey && !locative) {
      const ordW = Object.keys(ORD).find((o) => c.includes(o + ' ' + secKey) || c.includes(o + secKey));
      const sec = findSec(SEC_WORDS[secKey], ordW ? ORD[ordW] : 1);
      if (!sec) missed.push(`"${secKey}" bölümünü bu şarkıda bulamadım`);
      else if (has('yalnızca', 'bir tek') || verb('al', 'kullan')) { p.trimStart = sec.bas; p.trimEnd = sec.son; said.push(`sadece ${sec.ad.toLocaleLowerCase('tr')} (${fmtT(sec.bas)}–${fmtT(sec.son)})`); }
      else if (has('başla', 'aç')) { p.trimStart = Math.max(0, sec.bas - 0.3); said.push(`${sec.ad.toLocaleLowerCase('tr')} başından başlat`); }
      else if (has('bitir', 'son ver') || verb('bit')) { p.trimEnd = sec.son; said.push(`${sec.ad.toLocaleLowerCase('tr')} sonunda bitir`); }
      else if (verb('at', 'kes', 'çıkar', 'sil', 'kırp') || has('olmasın')) {
        if (sec.ad === 'Giriş' || sec.bas < 1) { p.trimStart = sec.son; said.push('girişi çıkar'); }
        else if (sec.son >= dur - 1) { p.trimEnd = sec.bas; said.push('sonu çıkar'); }
        else missed.push('ortadaki bir bölümü çıkarmak henüz mümkün değil, sadece baştan ve sondan kesebilirim');
      }
    }
    let m;
    if ((m = c.match(/(\d+(?:[.,]\d+)?)\s*(saniye|sn|dakika|dk)(?:lık|lik|luk|lük)/))) {
      const L = num(m[1]) * (m[2][0] === 'd' ? 60 : 1);
      const ch = findSec('Nakarat', 1); let a = ch ? Math.max(0, ch.bas - L * 0.3) : (cur.trimStart || 0);
      if (a + L > dur) a = Math.max(0, dur - L);
      p.trimStart = +a.toFixed(2); p.trimEnd = +Math.min(dur, a + L).toFixed(2); said.push(`${Math.round(L)} saniyelik kesit${ch ? ' (nakaratı içine alacak şekilde)' : ''}`);
    }
    if ((m = c.match(/(?:ilk|baştan|başından|baştaki)\s*(\d+(?:[.,]\d+)?)\s*(?:sn|saniye)/)) && verb('kes', 'at', 'sil', 'çıkar', 'kırp')) { p.trimStart = num(m[1]); said.push(`ilk ${m[1]} saniyeyi kes`); }
    if ((m = c.match(/(?:son|sondaki)\s*(\d+(?:[.,]\d+)?)\s*(?:sn|saniye)/)) && verb('kes', 'at', 'sil', 'çıkar', 'kırp')) { p.trimEnd = Math.max(1, dur - num(m[1])); said.push(`son ${m[1]} saniyeyi kes`); }
    if ((m = c.match(/(\d+(?:[.,]\d+)?|\d+:\d{1,2})\s*\.?\s*(?:saniye|sn)?(?:den|dan|ten|tan|'den|'dan|'ten|'tan)\s*(?:başla|aç)/))) { const v = timeOf(m[1]) ?? num(m[1]); p.trimStart = v; said.push(`${fmtT(v)}'dan başlat`); }
    if ((m = c.match(/(\d+(?:[.,]\d+)?|\d+:\d{1,2})\s*\.?\s*(?:saniye|sn)?(?:de|da|te|ta|'de|'da|'te|'ta)\s*bitir/))) { const v = timeOf(m[1]) ?? num(m[1]); p.trimEnd = v; said.push(`${fmtT(v)}'da bitir`); }
    if (has('tamamını', 'tüm video', 'bütün video', 'kesiti sıfırla', 'kesme olmasın', 'kırpma olmasın')) { p.trimStart = 0; p.trimEnd = dur; said.push('videonun tamamı'); }

    // CapCut-style effects and transitions
    const FXW = { shake: ['sarsıntı', 'titre', 'salla', 'shake', 'deprem'], rgb: ['rgb', 'renk kayma', 'kromatik'], glow: ['parlama', 'glow', 'parıltı', 'ışıltı', 'bloom', 'hale'],
      leak: ['ışık sızıntı', 'sızıntı', 'light leak', 'güneş ışığı'], vhs: ['vhs', 'retro', 'eski kamera', 'nostalji', 'kaset'], letterbox: ['sinema bant', 'siyah bant', 'letterbox', 'bantlar'], beauty: ['cilt', 'pürüzsüz', 'güzellik', 'beauty', 'rötuş'] };
    const fxName = { shake: 'kamera sarsıntısı', rgb: 'RGB kayması', glow: 'parlama', leak: 'ışık sızıntısı', vhs: 'VHS', letterbox: 'sinema bantları', beauty: 'cilt yumuşatma' };
    const isTrans = has('geçiş', 'gecis', 'transition');
    if (isTrans) {
      const tr = has('zoom', 'zum') ? 'zoom' : has('kaydır', 'kayma', 'whip', 'swipe', 'savrul') ? 'kaydir' : has('glitch', 'bozul') ? 'glitch' : has('flaş', 'flash', 'beyaz') ? 'flas' : has('düz', 'sade', 'yok', 'olmasın', 'kapat') ? 'kesme' : null;
      if (tr) { p.trans = tr; said.push({ zoom: 'zoom geçişler', kaydir: 'kaydırma geçişler', glitch: 'glitch geçişler', flas: 'flaş geçişler', kesme: 'düz kesme' }[tr]); }
    } else for (const [k, ws] of Object.entries(FXW)) if (ws.some((w) => c.includes(w)) || (k === 'rgb' && has('glitch'))) {
      p.fx = { ...(p.fx || {}), [k]: !(off && !up) }; said.push(fxName[k] + (p.fx[k] ? ' açık' : ' kapalı'));
      if (up || down) { p.fxPower = clampV((p.fxPower ?? cur.fxPower ?? 50) + (down ? -size : size)); }
    }
    if (has('efekt') && !has('zoom', 'zum', 'flaş', 'flash', 'renk', 'reng') && !Object.keys(FXW).some((k) => FXW[k].some((w) => c.includes(w))) && (up || down || off)) {
      if (off && !up) { p.fx = { shake: false, rgb: false, glow: false, leak: false, vhs: false, letterbox: false, beauty: false }; p.trans = 'kesme'; said.push('tüm efektler kapalı'); }
      else { p.fxPower = clampV((p.fxPower ?? cur.fxPower ?? 50) + (down ? -size : size)); said.push(`efekt gücü ${p.fxPower}`); }
    }

    // individual controls
    if (!isTrans && has('zoom', 'yakınlaş', 'zum')) {
      if (off && !up) { p.zoomOn = false; said.push('zoom kapalı'); } else { p.zoomOn = true; p.zoomPower = adj('zoomPower'); said.push(`zoom ${p.zoomPower}`); }
    }
    if (!isTrans && has('flaş', 'flash', 'ışık patla', 'ışıklar', 'patla') && !has('sızıntı')) {
      if (off && !up) { p.flashOn = false; said.push('flaş kapalı'); } else { p.flashOn = true; p.flashPower = adj('flashPower'); said.push(`flaş ${p.flashPower}`); }
    }
    if (has('reverb', 'yankı', 'eko', 'echo', 'hall')) {
      if (off && !up) { p.reverb = 'yok'; said.push('reverb kapalı'); }
      else {
        if (has('salon', 'konser', 'kilise', 'katedral', 'geniş', 'büyük')) p.reverb = 'salon';
        else if (has('plate', 'parlak', 'stüdyo')) p.reverb = 'plate';
        else if (has('oda', 'küçük', 'doğal')) p.reverb = 'oda';
        else if (cur.reverb === 'yok') p.reverb = 'oda';
        p.reverbAmount = adj('reverbAmount'); said.push(`reverb ${p.reverb || cur.reverb} ${p.reverbAmount}`);
      }
    }
    if (has('netleştir', 'vokal', 'sesim', 'sesi net', 'ses net', 'boğuk', 'uğultu')) { p.clarity = !(off && !up); said.push(p.clarity ? 'vokal netleştirme açık' : 'vokal netleştirme kapalı'); }
    if (has('renk', 'reng', 'filtre') && !has('ışık', 'renk kayma')) { if (off && !up) { p.look = 'dogal'; said.push('renk efekti kapalı'); } else { p.colorIntensity = adj('colorIntensity'); said.push(`renk yoğunluğu ${p.colorIntensity}`); } }
    if (has('keskin', 'netlik', 'netliğ', 'net görün', 'daha net', 'bulanık')) { p.sharpen = clampV((p.sharpen ?? cur.sharpen) + (down ? -size : size)); said.push(`netlik ${p.sharpen}`); }
    if (verb('kes', 'kesil') || has('kesme', 'geçiş', 'kurgu', 'açı', 'plan değiş', 'tempo')) {
      if (has('hızlı', 'sık', 'çabuk', 'tempolu', 'dinamik')) { p.cutSpeed = 'hizli'; said.push('hızlı kesmeler'); }
      else if (has('yavaş', 'seyrek', 'sakin', 'uzun')) { p.cutSpeed = 'yavas'; said.push('yavaş kesmeler'); }
    }
    if (has('yakın plan', 'yüzüme', 'yüzüm', 'yüze', 'close')) { p.closeups = (down || off) && !up ? 'az' : 'cok'; said.push(p.closeups === 'cok' ? 'daha çok yakın plan' : 'daha az yakın plan'); }
    if (has('geniş plan', 'uzak plan')) { p.closeups = 'az'; said.push('daha çok geniş plan'); }
    if (has('söz', 'altyazı', 'yazı')) {
      if (off && !up) { p.lyricsOn = false; said.push('sözler gizli'); }
      else {
        p.lyricsOn = true;
        if (has('pop', 'zıpla', 'capcut', 'tiktok')) p.lyricsStyle = 'pop'; else if (has('büyük', 'kalın', 'ortada', 'iri')) p.lyricsStyle = 'buyuk'; else if (has('karaoke', 'kelime')) p.lyricsStyle = 'kelime'; else if (has('sade', 'küçük', 'altta', 'ince')) p.lyricsStyle = 'minimal';
        said.push('sözler ' + ({ buyuk: 'büyük', kelime: 'kelime kelime', minimal: 'sade', pop: 'pop (kelime zıplar)' }[p.lyricsStyle] || 'açık'));
      }
    }
    if (has('kararma', 'karar', 'fade', 'siyahtan', 'siyaha', 'yavaşça aç', 'yavaşça bit')) {
      const v = (m = c.match(/(\d+(?:[.,]\d+)?)\s*(?:sn|saniye)/)) ? num(m[1]) : off ? 0 : 2;
      if (has('baş', 'açıl', 'siyahtan', 'giriş')) { p.fadeIn = v; said.push(`açılış ${v} sn`); } else { p.fadeOut = v; said.push(`kararma ${v} sn`); }
    }
    if (said.length === saidBefore && missed.length === missedBefore && c0.length > 2) missed.push(`"${c0}"`);
  }
  const uniq = [...new Set(said)];
  p.reply = uniq.length ? `Tamam: ${uniq.join(', ')}.` : 'Bu isteği anlayamadım.';
  if (missed.length) p.reply += ` Anlayamadığım kısım: ${missed.join(', ')}. Örnek: "duygusal olsun", "sadece nakaratı al", "zoomu biraz azalt", "reverbi artır".`;
  return p;
}
function fmtT(t) { return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`; }
