# Cover Stüdyo

iPad Safari'de çalışan, tarayıcı tabanlı cover video düzenleyici. Videolar cihazdan hiç çıkmaz; tüm işlem iPad'in kendi donanımında yapılır.

- Otomatik kurgu: şarkının bölümleri, yüz takibi, sanal kamera açıları (geniş/orta/yakın), otomatik renk düzeltme
- Vokal netleştirme (EQ, kompresör, ses seviyesi) ve reverb (Oda, Plate, Salon)
- Şarkı sözlerini yapay zekâyla çıkarma (Whisper) ve altyazı stilleri (Sade, Kelime kelime, Büyük)
- "Anlat, düzenlesin": yazılı isteği kurgu ayarlarına çevirme (Claude API anahtarıyla serbest anlatım, anahtarsız basit mod)
- Yüksek kalite: 16 Mbps çıktı, keskinleştirme, kaynağa göre sınırlı zoom
- CapCut tarzı efektler: kamera sarsıntısı, RGB kayması, parlama, ışık sızıntısı, VHS, sinema bantları, cilt yumuşatma; zoom/kaydırma/glitch/flaş geçişleri; Pop altyazı
- Referans videoyu taklit etme: kesme ritmi, flaşlar, kamera hareketi, sinema bantları ve renk eşleme
- Renk profilleri: Doğal, Alternatif Rock, Sinematik
- Otomatik tempo ve vuruş tespiti, vuruşa göre zoom, ölçü başında ışık flaşı
- 1080×1920 Instagram Reels çıktısı (H.264 + AAC)
- Sohbete göndermek için 30 MB altı küçük kopya

Video işleme için [Mediabunny](https://github.com/Vanilagy/mediabunny) kullanılır (MPL-2.0, `vendor/MEDIABUNNY-LICENSE.txt`).
Yüz algılama için [MediaPipe](https://github.com/google-ai-edge/mediapipe) Face Detector kullanılır (Apache-2.0, `vendor/mediapipe/`).
Şarkı sözü tanıma için [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0, `vendor/transformers/`) ve Whisper modelleri kullanılır; modeller ilk kullanımda Hugging Face'ten indirilir.
Claude API bağlantısı için [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (MIT, `vendor/anthropic/`) kullanılır.
