# Cover Stüdyo

iPad Safari'de çalışan, tarayıcı tabanlı cover video düzenleyici. Videolar cihazdan hiç çıkmaz; tüm işlem iPad'in kendi donanımında yapılır.

- Otomatik kurgu: şarkının bölümleri, yüz takibi, sanal kamera açıları (geniş/orta/yakın), otomatik renk düzeltme
- Vokal netleştirme (EQ, kompresör, ses seviyesi) ve reverb (Oda, Plate, Salon)
- Şarkı sözlerini yapay zekâyla çıkarma (Whisper) ve altyazı stilleri (Sade, Kelime kelime, Büyük)
- Renk profilleri: Doğal, Alternatif Rock, Sinematik
- Otomatik tempo ve vuruş tespiti, vuruşa göre zoom, ölçü başında ışık flaşı
- 1080×1920 Instagram Reels çıktısı (H.264 + AAC)
- Sohbete göndermek için 30 MB altı küçük kopya

Video işleme için [Mediabunny](https://github.com/Vanilagy/mediabunny) kullanılır (MPL-2.0, `vendor/MEDIABUNNY-LICENSE.txt`).
Yüz algılama için [MediaPipe](https://github.com/google-ai-edge/mediapipe) Face Detector kullanılır (Apache-2.0, `vendor/mediapipe/`).
Şarkı sözü tanıma için [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0, `vendor/transformers/`) ve Whisper modelleri kullanılır; modeller ilk kullanımda Hugging Face'ten indirilir.
