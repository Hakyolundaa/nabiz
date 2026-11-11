# Nabız

Windows için ücretsiz, sade bir müzik uygulaması. Şarkıları YouTube'un resmi gömülü oynatıcısıyla çalar; zamanlı şarkı sözleri, masaüstü adası, akıllı öneriler ve daha fazlasını tek pencerede toplar.

**[⬇️ Son sürümü indir](https://github.com/Hakyolundaa/nabiz/releases/latest)**: `Nabiz-Setup.zip` dosyasını indir, içindeki `Nabiz-Setup.exe`'yi çalıştır.

## Özellikler

- **Akış ve Keşfet:** dinledikçe seni tanır, sevdiğin sanatçılara yakın yeni şarkılar önerir
- **Büyük ekran:** şarkı, videosu ve sözleriyle birlikte tüm ekranda
- **Zamanlı şarkı sözleri:** karaoke modu, paylaşılabilir söz kartı (Instagram / WhatsApp), sözü olmayan şarkıya kendi sözlerini ekleyip zamanlama
- **Nabız adası:** çalan şarkı ve sözler ekranın tepesinde; oyunda bile (pencereli / çerçevesiz modda)
- **Müzikli alarm**, ruh haline ve havaya göre karışımlar, günün sözü, yıllık özet ve rozetler
- **Çalma listesi aktarma:** başka uygulamalardaki listeni getir

## Gizlilik

Beğendiklerin, çalma listelerin ve dinleme geçmişin **sadece senin bilgisayarında** (`%APPDATA%\Nabız`) tutulur. Hiçbir sunucuya gönderilmez.

Nabız günde bir kez isimsiz bir "açığım" sinyali gönderir (rastgele bir numara, sürüm, Windows sürümü). Bu sinyal yalnızca kaç kişinin kullandığını görmek içindir; Ayarlar'dan kapatılabilir. Sorun bildirimi ve geri bildirim sadece sen gönderirsen gider.

## Kurulum notları

- Yönetici izni gerekmez; Nabız `%LOCALAPPDATA%\Nabiz` klasörüne kurulur.
- Kurulum, uygulama motorunu (castLabs Electron) resmi GitHub sürümlerinden indirir.
- Kurulum dosyası kod imzalı olmadığı için Windows "Bilinmeyen yayıncı" uyarısı gösterebilir: **Ek bilgi → Yine de çalıştır**.
- Bazı antivirüslerin yapay zekâ tabanlı motorları imzasız yeni programları yanlışlıkla şüpheli sayabilir. Her sürümün VirusTotal sonucu ve SHA-256 özeti [Sürümler](https://github.com/Hakyolundaa/nabiz/releases) sayfasında yazar. Kaynak kodun tamamı bu depodadır.
- Nabız kendini sessizce günceller.

## Kaynak kod

| Klasör | İçerik |
|---|---|
| `src/app` | Uygulama (Electron): `main.js` (pencereler, ada, güncelleme), `server.js` (yerel sunucu, arama, sözler), `index.html` (arayüz), `island.html` (masaüstü adası) |
| `src/setup` | Kurulum programı (Go, bağımlılıksız): `main.go`, `winapi.go`, simge/sürüm bilgisi üreticisi `mksyso.py` |
| `index.html` | Söz kartı paylaşım sayfası (GitHub Pages) |
| `version.json` | Güncelleme bilgisi |

Kurulum dosyasını derlemek için:

```sh
cd src/setup
cp -r ../app app
python3 mksyso.py app/icon.ico setup.manifest rsrc_windows_amd64.syso <sürüm>
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui" -o Nabiz-Setup.exe .
```

## Sorun ve öneriler

Uygulamanın içinden: **Ayarlar → Uygulama → Sorun bildir** ya da **★ Puanla**.
