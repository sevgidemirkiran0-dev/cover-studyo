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

// Offline fallback: understands common phrases without an API key.
export function parseLocal(text, cur) {
  const t = text.toLocaleLowerCase('tr'), p = {}, has = (...w) => w.some((x) => t.includes(x));
  const more = has('daha fazla', 'artır', 'arttır', 'yükselt', 'güçlendir', 'daha çok', 'daha güçlü');
  const less = has('azalt', 'daha az', 'düşür', 'hafiflet', 'biraz az', 'yumuşat');
  const delta = (v) => Math.max(0, Math.min(100, v + (more ? 20 : less ? -20 : 0)));
  const off = has('kapat', 'olmasın', 'istemiyorum', 'kaldır', 'yok');
  if (has('sinematik')) p.look = 'sinematik';
  if (has('rock', 'rok')) p.look = 'rock';
  if (has('doğal', 'efektsiz renk', 'renk olmasın')) p.look = 'dogal';
  if (has('renk')) p.colorIntensity = delta(cur.colorIntensity);
  if (has('net', 'keskin')) p.sharpen = delta(cur.sharpen);
  if (has('hızlı kes', 'kesmeler hızlı', 'daha hızlı', 'tempolu')) p.cutSpeed = 'hizli';
  if (has('yavaş kes', 'kesmeler yavaş', 'daha yavaş', 'sakin kurgu')) p.cutSpeed = 'yavas';
  if (has('yakın plan', 'yüzüme', 'yüzü')) p.closeups = less ? 'az' : 'cok';
  if (has('zoom')) { if (off && !more) p.zoomOn = false; else { p.zoomOn = true; p.zoomPower = delta(cur.zoomPower); } }
  if (has('flaş', 'flash', 'ışık patla')) { if (off && !more) p.flashOn = false; else { p.flashOn = true; p.flashPower = delta(cur.flashPower); } }
  if (has('reverb', 'yankı', 'eko')) {
    if (off && !more) p.reverb = 'yok';
    else { p.reverbAmount = delta(cur.reverbAmount); if (has('salon', 'konser', 'geniş')) p.reverb = 'salon'; else if (has('plate', 'parlak')) p.reverb = 'plate'; else if (has('oda')) p.reverb = 'oda'; else if (cur.reverb === 'yok') p.reverb = 'oda'; }
  }
  if (has('netleştir', 'vokal', 'sesim')) p.clarity = !(off && !more);
  if (has('söz', 'altyazı')) {
    if (off && !more) p.lyricsOn = false; else p.lyricsOn = true;
    if (has('büyük')) p.lyricsStyle = 'buyuk'; else if (has('karaoke', 'kelime')) p.lyricsStyle = 'kelime'; else if (has('sade', 'küçük')) p.lyricsStyle = 'minimal';
  }
  const sec = t.match(/(?:ilk|baştan|başından)\s*(\d+(?:[.,]\d+)?)\s*(?:sn|saniye)/);
  if (sec && has('kes', 'at', 'sil', 'çıkar')) p.trimStart = parseFloat(sec[1].replace(',', '.'));
  const last = t.match(/son\s*(\d+(?:[.,]\d+)?)\s*(?:sn|saniye)/);
  if (last && has('kes', 'at', 'sil', 'çıkar')) p.trimEnd = Math.max(1, cur.duration - parseFloat(last[1].replace(',', '.')));
  const keys = Object.keys(p);
  p.reply = keys.length ? 'Anladığım kadarıyla ayarları değiştirdim. Daha karmaşık istekler için Claude API anahtarı ekleyebilirsin.' : 'Bu isteği anlayamadım. Örneğin "nakaratta daha fazla zoom" ya da "reverbi artır" diyebilirsin; daha serbest anlatım için Claude API anahtarı ekle.';
  return p;
}
