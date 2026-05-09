#!/usr/bin/env bash
# =============================================================
#   Gmail Yardımcısı - Otomatik Kurulum (Linux / macOS)
# =============================================================

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

EXT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo
echo "============================================================"
echo "           GMAIL YARDIMCISI - KURULUM"
echo "============================================================"
echo

echo -e "${GREEN}[+]${NC} Eklenti klasörü: $EXT_DIR"
echo

# config.json kontrolü
if [ ! -f "$EXT_DIR/config.json" ]; then
    echo -e "${RED}[HATA]${NC} config.json bulunamadı!"
    echo "Lütfen config.json dosyasının bu klasörde olduğundan emin olun."
    exit 1
fi

# manifest.json kontrolü
if [ ! -f "$EXT_DIR/manifest.json" ]; then
    echo -e "${RED}[HATA]${NC} manifest.json bulunamadı!"
    exit 1
fi

echo -e "${GREEN}[+]${NC} Gerekli dosyalar mevcut."
echo

# Chrome'u tespit et
CHROME_BIN=""
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
    # macOS
    if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    fi
else
    # Linux
    for candidate in google-chrome google-chrome-stable chromium chromium-browser brave-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
            CHROME_BIN="$(command -v $candidate)"
            break
        fi
    done
fi

if [ -z "$CHROME_BIN" ]; then
    echo -e "${RED}[HATA]${NC} Google Chrome bulunamadı!"
    echo "Lütfen önce Chrome'u yükleyin: https://www.google.com/chrome/"
    exit 1
fi

echo -e "${GREEN}[+]${NC} Tarayıcı bulundu: $CHROME_BIN"
echo

echo "------------------------------------------------------------"
echo " KURULUM ADIMLARI"
echo "------------------------------------------------------------"
echo
echo "  1) Chrome birazdan açılacak ve \"chrome://extensions\" sayfası"
echo "     gösterilecek."
echo
echo "  2) Sağ üst köşedeki \"Geliştirici modu\" anahtarını AÇIK"
echo "     konuma getirin."
echo
echo "  3) \"Paketlenmemiş öğeyi yükle\" düğmesine tıklayın."
echo
echo "  4) Açılan pencerede ŞU klasörü seçin:"
echo
echo "        $EXT_DIR"
echo
echo "  5) Eklenti yüklendikten sonra Chrome araç çubuğundaki"
echo "     bulmaca parçası simgesinden \"Gmail Yardımcısı\"nı"
echo "     sabitleyebilirsiniz."
echo
echo "------------------------------------------------------------"
echo

# Klasör yolunu panoya kopyalamayı dene
if [ "$OS" = "Darwin" ] && command -v pbcopy >/dev/null 2>&1; then
    printf "%s" "$EXT_DIR" | pbcopy
    echo -e "${GREEN}[+]${NC} Eklenti klasör yolu PANOYA kopyalandı (pbcopy)."
elif command -v xclip >/dev/null 2>&1; then
    printf "%s" "$EXT_DIR" | xclip -selection clipboard
    echo -e "${GREEN}[+]${NC} Eklenti klasör yolu PANOYA kopyalandı (xclip)."
elif command -v xsel >/dev/null 2>&1; then
    printf "%s" "$EXT_DIR" | xsel --clipboard --input
    echo -e "${GREEN}[+]${NC} Eklenti klasör yolu PANOYA kopyalandı (xsel)."
elif command -v wl-copy >/dev/null 2>&1; then
    printf "%s" "$EXT_DIR" | wl-copy
    echo -e "${GREEN}[+]${NC} Eklenti klasör yolu PANOYA kopyalandı (wl-copy)."
else
    echo -e "${YELLOW}[!]${NC} Pano kopyalama aracı bulunamadı (xclip / xsel / wl-copy)."
    echo "    Klasör yolunu yukarıdan elle kopyalayabilirsiniz."
fi

echo
echo "Devam etmek için ENTER'a basın..."
read -r _

echo -e "${GREEN}[+]${NC} Chrome açılıyor..."
"$CHROME_BIN" "chrome://extensions" >/dev/null 2>&1 &

sleep 1

echo
echo "============================================================"
echo "  Kurulum tamamlandı sayılır!"
echo "  Chrome ekranındaki adımları takip ederek eklentiyi yükleyin."
echo "============================================================"
echo
