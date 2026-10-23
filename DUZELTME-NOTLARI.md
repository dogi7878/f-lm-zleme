# Düzeltme notları

Bu sürümde:
- Oda sayfasının kaydırma konumu normalize edilmiş oranla diğer katılımcılara iletilir; farklı ekran boyutlarında ham piksel yerine sayfa ilerleme oranı kullanılır.
- Sunucu, oda kaydırma oranını saklar ve yeni katılanlara oda durumuyla gönderir.
- Harici Filmizlesene sayfası iframe içinde açılabilir; ancak başka alan adındaki iframe'in içindeki oynat/duraklat/ileri-sar kontrolleri, kaynak site kontrol edilebilir bir API veya postMessage arayüzü sunmadıkça uygulamamız tarafından kontrol edilemez. Bu bir tarayıcı güvenlik sınırıdır.
- Mevcut YouTube ve doğrudan HTML5 video senkronizasyon kodu korunmuştur.
- `node_modules` arşive eklenmemiştir.

Not: Bu ortamda gerçek telefon ve Filmizlesene kaynağıyla uçtan uca test yapılamadı. Değişiklikler iki cihazda test edilmelidir.
