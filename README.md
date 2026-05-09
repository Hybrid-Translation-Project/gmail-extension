# Gmail Yardımcısı

> Gmail için etiketleme, hızlı mail yazma ve **yerel yapay zeka** ile özetleme Chrome eklentisi.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Gmail API](https://img.shields.io/badge/Gmail_API-OAuth2-EA4335?style=flat-square&logo=gmail&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22863a?style=flat-square)

---

## İçindekiler

- [Özellikler](#özellikler)
- [Ekran Görüntüleri](#ekran-görüntüleri)
- [Gereksinimler](#gereksinimler)
- [Kurulum](#kurulum)
- [Yapılandırma](#yapılandırma)
- [Google OAuth Kurulumu](#google-oauth-kurulumu)
- [Yerel AI Entegrasyonu](#yerel-ai-entegrasyonu)
- [Klasör Yapısı](#klasör-yapısı)
- [Sık Sorulan Sorular](#sık-sorulan-sorular)
- [Lisans](#lisans)

---

## Özellikler

Eklenti **Gmail içinde açık olan maili** işler. Ayrı bir gelen kutusu kopyalamaz — Gmail'i Gmail'den daha iyi yapmaya çalışmaz.

| Özellik | Açıklama |
|---|---|
| **Bağlam Algılama** | Gmail'de bir mail açıkken eklenti simgesine tıklayın, mail otomatik algılanır |
| **Yerel AI Özeti** | Açık olan maili kendi sunucunuzdaki modelle özetler (harici API yok) |
| **Akıllı Etiketleme** | AI mail içeriğine göre etiket önerir; Gmail'inizde varsa onu uygular, yoksa otomatik oluşturup uygular |
| **Hızlı Yanıt** | "Mail Yaz" sekmesinde alıcı ve konu, açık olan mailden otomatik doldurulur |
| **Ayarlar** | Tüm URL ve model bilgilerini arayüzden veya `config.json`'dan yönetme |

### Teknik Özellikler

- **Manifest V3** — Chrome'un modern eklenti standartı
- **OAuth2** — Gmail API erişimi için güvenli kimlik doğrulama
- **Sıfır harici bağımlılık** — AI özetleme dahil tüm işlemler ya Gmail API'ye ya da kendi sunucunuza gider
- **Tüm URL'ler yapılandırılabilir** — `config.json` içinde, kod içinde hardcoded URL yok

---

## Ekran Görüntüleri

> Eklentiyi Chrome'a yükledikten sonra araç çubuğundaki simgeye tıklayarak arayüzü görebilirsiniz.

```
┌─────────────────────────────────────────┐
│  ✉ Gmail Yardımcısı        [Giriş Yap] │
├──────────────┬──────────────┬───────────┤
│  ⚡ Özetle   │  ✏ Mail Yaz │ ⚙ Ayarlar │
├──────────────┴──────────────┴───────────┤
│  ┌───────────────────────────────────┐  │
│  │ A  Ali Veli <ali@firma.com>       │  │
│  │    9 May 2026, 14:32              │  │
│  │ Toplantı hatırlatması             │  │
│  └───────────────────────────────────┘  │
│  Yarınki toplantıyı unutmayın...        │
│                                         │
│  [⚡ Özetle]  [🏷 Akıllı Etiketle]     │
│  ┌───────────────────────────────────┐  │
│  │ ⚡ Yapay Zeka Özeti               │  │
│  │ • Toplantı yarın saat 10:00       │  │
│  │ • Salon B-203                     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## Gereksinimler

- **Google Chrome** 88+ (Manifest V3 desteği için)
- **Google hesabı** (Gmail API erişimi için)
- **Google Cloud Console projesi** — ücretsiz, bireysel Gmail hesabıyla oluşturulabilir
- *(Opsiyonel)* Yerel AI modeli — `local_model_url` üzerinden erişilebilen, REST API sunan herhangi bir model (Ollama, LM Studio vb.)

---

## Kurulum

### Hızlı Kurulum (Önerilen)

#### Windows

1. `gmail-extension` klasörünü herhangi bir konuma çıkarın.
2. `config.json` dosyasını kendi sunucu adreslerinize göre düzenleyin. (Bkz. [Yapılandırma](#yapılandırma))
3. `manifest.json` içindeki `client_id` alanını kendi Google Client ID'nizle değiştirin. (Bkz. [Google OAuth Kurulumu](#google-oauth-kurulumu))
4. **`kur.bat`** dosyasına çift tıklayın.
5. Ekrandaki adımları takip edin — klasör yolu panonuza otomatik kopyalanır.

#### Linux / macOS

```bash
cd gmail-extension
chmod +x kur.sh
./kur.sh
```

### Manuel Kurulum

1. Chrome'da `chrome://extensions` adresini açın.
2. Sağ üstten **Geliştirici Modu**'nu açın.
3. **"Paketlenmemiş öğeyi yükle"** butonuna tıklayın.
4. `gmail-extension` klasörünü seçin.

---

## Yapılandırma

Tüm ayarlar `config.json` dosyasında tutulur:

```json
{
  "backend_url": "http://localhost:8000",
  "local_model_url": "http://localhost:11434",
  "model_name": "local-model",
  "google_client_id": "BURAYA_GOOGLE_CLIENT_ID_YAZILACAK"
}
```

| Alan | Açıklama | Örnek |
|---|---|---|
| `backend_url` | Arka plan sunucusu (opsiyonel) | `http://192.168.1.10:8000` |
| `local_model_url` | Yerel AI modelinin adresi | `http://localhost:11434` |
| `model_name` | Modele gönderilecek model adı | `llama3`, `mistral` |
| `google_client_id` | Google Cloud Console'dan alınan Client ID | `12345-abc.apps.googleusercontent.com` |

> **Not:** `config.json` değiştirildiğinde Chrome'daki eklentinin yenilenmesi gerekir (`chrome://extensions` → ↻).  
> Arayüzden yapılan değişiklikler `chrome.storage.local`'a kaydedilir ve `config.json`'ı ezmez.

---

## Google OAuth Kurulumu

Eklentinin Gmail API'ye erişebilmesi için bir Google Cloud projesi ve OAuth Client ID gereklidir.  
Bu işlem **tamamen ücretsizdir** ve bireysel Gmail hesabıyla yapılabilir.

### Adımlar

**1. Google Cloud Console'da proje oluşturun**

[console.cloud.google.com](https://console.cloud.google.com) → **"Select a project" → "New Project"** → Proje adı girin → **Create**

**2. Gmail API'yi etkinleştirin**

**APIs & Services → Library** → "Gmail API" aratın → **Enable**

**3. OAuth Consent Screen yapılandırın**

**APIs & Services → OAuth consent screen**
- User Type: **External** → Create
- App name, support email doldurun
- **Test users** kısmına kendi Gmail adresinizi ekleyin

> Test users listesindeki hesaplar "app verification" olmadan giriş yapabilir. 100 kullanıcıya kadar ücretsiz ve süresiz çalışır.

**4. Chrome Extension ID'sini alın**

- Eklentiyi önce `manifest.json`'daki `client_id` placeholder ile Chrome'a yükleyin.
- `chrome://extensions` sayfasında "Gmail Yardımcısı" kartının altındaki **ID**'yi kopyalayın.

**5. OAuth Client ID oluşturun**

**APIs & Services → Credentials → Create Credentials → OAuth client ID**
- Application type: **Chrome Extension**
- Item ID: 4. adımda kopyaladığınız Extension ID'yi yapıştırın
- **Create** → Oluşturulan **Client ID**'yi kopyalayın

**6. `manifest.json`'ı güncelleyin**

```json
"oauth2": {
  "client_id": "BURAYA_KOPYALADIGINIZ_CLIENT_ID.apps.googleusercontent.com",
  ...
}
```

**7. Eklentiyi yenileyin**

`chrome://extensions` → Gmail Yardımcısı → **↻**

---

## Yerel AI Entegrasyonu

Mail özetleme özelliği, harici hiçbir API kullanmaz. `config.json` içindeki `local_model_url` adresine standart bir REST isteği gönderir.

### API Formatı

**İstek:**
```http
POST {local_model_url}
Content-Type: application/json

{
  "prompt": "Aşağıdaki e-postayı kısa ve öz özetle...\n\n{mail içeriği}",
  "model": "{model_name}"
}
```

**Beklenen Yanıt:**
```json
{
  "response": "Özetlenmiş metin burada yer alır."
}
```

### Desteklenen Araçlar

Bu formatı destekleyen yerelde çalışan popüler araçlar:

| Araç | `local_model_url` | Notlar |
|---|---|---|
| [Ollama](https://ollama.com) | `http://localhost:11434` | Varsayılan port |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | OpenAI uyumlu format |
| Özel sunucu | İstediğiniz adres | Yukarıdaki formatı karşılayan herhangi bir endpoint |

> Model henüz kurulu değilse "Özetle" butonu hata mesajı gösterir. Ayarlar sekmesinden `local_model_url` değiştirilebilir.

---

## Klasör Yapısı

```
gmail-extension/
├── manifest.json        # Chrome eklenti tanımı (Manifest V3)
├── popup.html           # Eklenti arayüzü (3 sekme: Özetle, Mail Yaz, Ayarlar)
├── popup.js             # Gmail API, OAuth, AI özet ve akıllı etiketleme
├── popup.css            # Stiller
├── content.js           # Gmail sekmesinde çalışır, açık olan mailin ID'sini popup'a iletir
├── background.js        # Service worker
├── config.json          # Tüm URL ve model ayarları — buradan yapılandırın
├── kur.bat              # Windows otomatik kurulum scripti
├── kur.sh               # Linux/macOS otomatik kurulum scripti
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── .gitignore
└── LICENSE
```

---

## Sık Sorulan Sorular

**`bad client id` hatası alıyorum.**  
`manifest.json` içindeki `client_id` değerinin doğru kopyalandığından emin olun. Değiştirdikten sonra `chrome://extensions`'tan eklentiyi yenileyin.

**`Access blocked: This app has not been verified` hatası alıyorum.**  
Google Cloud Console → OAuth consent screen → Test users kısmına kendi Gmail adresinizi ekleyin.

**`Token alınamadı` hatası alıyorum.**  
`chrome://extensions`'taki Extension ID'nin, Google Console'daki OAuth Client'ın "Item ID" alanıyla birebir aynı olduğundan emin olun.

**Yerel model çalışmıyor.**  
Eklenti popupında **Ayarlar** sekmesini açın, `Yerel Model Adresi` alanının doğru olduğunu kontrol edin. Modelin çalıştığını terminalden `curl -X POST http://localhost:11434 -d '{"prompt":"test","model":"llama3"}'` komutuyla doğrulayabilirsiniz.

**Eklenti "Gmail'de bir mail açın" diyor ama mail açıktı.**  
Bu, eklentinin yeni kurulduğunda veya güncellendiğinde olabilir — Gmail sekmesini bir kez yenileyin (F5). Bu işlem `content.js`'in mevcut Gmail sekmesine enjekte edilmesini sağlar.

**Türkçe karakterler bozuk gözüküyor.**  
Bu durum yaşanmamalıdır; mail gönderimi UTF-8/MIME B encoding ile yapılmaktadır. Yaşanırsa lütfen [issue açın](../../issues).

---

## Lisans

[MIT](LICENSE) © 2026 Hybrid-Translation-Project
