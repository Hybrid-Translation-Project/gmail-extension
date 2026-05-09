@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

REM =============================================================
REM   Gmail Yardımcısı - Otomatik Kurulum (Windows)
REM =============================================================

title Gmail Yardımcısı - Kurulum

echo.
echo ============================================================
echo            GMAIL YARDIMCISI - KURULUM
echo ============================================================
echo.

REM Bu .bat'ın bulunduğu klasor (extension klasoru)
set "EXT_DIR=%~dp0"
if "%EXT_DIR:~-1%"=="\" set "EXT_DIR=%EXT_DIR:~0,-1%"

echo [+] Eklenti klasoru: %EXT_DIR%
echo.

REM config.json kontrolu
if not exist "%EXT_DIR%\config.json" (
    echo [HATA] config.json bulunamadi!
    echo Lutfen config.json dosyasinin bu klasorde oldugundan emin olun.
    pause
    exit /b 1
)

REM manifest.json kontrolu
if not exist "%EXT_DIR%\manifest.json" (
    echo [HATA] manifest.json bulunamadi!
    pause
    exit /b 1
)

echo [+] Gerekli dosyalar mevcut.
echo.

REM Chrome yolunu bul
set "CHROME_PATH="

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
)

if not defined CHROME_PATH (
    if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
        set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    )
)

if not defined CHROME_PATH (
    if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
        set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    )
)

if not defined CHROME_PATH (
    echo [HATA] Google Chrome bulunamadi!
    echo Lutfen once Chrome'u yukleyin: https://www.google.com/chrome/
    pause
    exit /b 1
)

echo [+] Chrome bulundu: %CHROME_PATH%
echo.

echo ------------------------------------------------------------
echo  KURULUM ADIMLARI
echo ------------------------------------------------------------
echo.
echo  1) Chrome birazdan acilacak ve "chrome://extensions" sayfasi
echo     gosterilecek.
echo.
echo  2) Sag ust kosedeki "Gelistirici modu" anahtarini ACIK
echo     konuma getirin.
echo.
echo  3) "Paketlenmemis ogeyi yukle" dugmesine tiklayin.
echo.
echo  4) Acilan pencerede SU klasoru secin:
echo.
echo        %EXT_DIR%
echo.
echo  5) Eklenti yuklendikten sonra, Chrome arac cubugundaki
echo     bulmaca parcasi simgesinden "Gmail Yardimcisi"ni
echo     sabitleyebilirsiniz.
echo.
echo ------------------------------------------------------------
echo.

REM Klasor yolunu panoya kopyala
echo %EXT_DIR%| clip
echo [+] Eklenti klasor yolu PANOYA kopyalandi.
echo     Acilacak pencerede sadece Ctrl+V ile yapistirip Enter'a basabilirsiniz.
echo.

pause

REM Chrome'u extensions sayfasi ile birlikte ac
echo.
echo [+] Chrome aciliyor...
start "" "%CHROME_PATH%" "chrome://extensions"

timeout /t 2 /nobreak >nul

echo.
echo ============================================================
echo  Kurulum tamamlandi sayilir!
echo  Chrome ekranindaki adimlari takip ederek eklentiyi yukleyin.
echo ============================================================
echo.
pause
endlocal
