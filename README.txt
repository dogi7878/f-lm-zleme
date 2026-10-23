BIRLIKTE FILM IZLE - CIHAZDAN VIDEO SECME + ODA SENKRONIZASYONU

UYGULAMA
1. Once mevcut proje klasorunun yedegini al.
2. ZIP'i projenin ana klasorune (package.json dosyasinin bulundugu klasor) cikart.
3. Windows sorarsa dosyalarin ustune yazmayi onayla.
4. API terminalinde once kaynak kodunu derle:
   corepack pnpm --filter @workspace/api-server run build
5. Derleme basarili olursa API sunucusunu baslat:
   $env:NODE_ENV="development"; $env:PORT="3000"; corepack pnpm --filter @workspace/api-server run start
6. Vite ve Cloudflare terminallerini acik birak. Tarayicida Ctrl+F5 yap.

YENI OZELLIK
- Odada "Cihazimdan video sec" butonu gelir.
- MP4, WebM, Ogg ve M4V videolar parca parca API sunucusuna yuklenir.
- Yukleme tamamlaninca ayni video URL'si odaya gonderilir; diger katilimcilarin oynaticisi da ayni dosyayi acabilir.
- Oynat/duraklat/ileri-geri sarma mevcut Socket.IO playback durumu ile senkronize olur.
- Yuklenen videolar API sunucusunun calistigi bilgisayarda uploads/videos klasorunde saklanir.
- Dosya secme yuklemesi 2 GiB ile sinirlidir. Sunucuda bos disk alani olmalidir.

ONEMLI
- Dosya yuklenirken API terminali ve site/tunnel acik kalmali.
- Dosya secmek dosyayi sunucuya yukler; yukleme bitene kadar sayfayi kapatma.
- Video dosyalari sunucu diskinde kalir. Bu nedenle yalnizca paylasmaya hakkin olan videolari yukle. Yukleme URL'sini bilen kisiler dosyaya erisebilir.
- Tarayici otomatik sesli oynatmayi engellerse, her katilimcinin ilk kez Oynat'a dokunmasi gerekebilir. Sonrasinda play/pause/seek olaylari senkronize edilir.
- Yalnizca uzanti/format destegi garanti edilir; video codec'i tarayicida desteklenmiyorsa dosya acilmayabilir. MKV desteklenmez.
- Bu degisiklik burada kaynak koduna uygulandi; bagimliliklar kurulu olmadigi ve ag erisimi olmadigi icin bu ortamda tam pnpm build/typecheck calistirilamadi. Bu nedenle once API build komutunun basarili oldugunu kontrol et; hata gorursen terminaldeki hata metnini gonder.
