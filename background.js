// Gmail Yardımcısı - Service Worker (Manifest V3)
// Kurulum bildirimi ve OAuth/storage temizliği için arka plan görevleri.

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // İlk kurulumda config.json'u storage'a kopyalama opsiyonel.
    try {
      const res = await fetch(chrome.runtime.getURL("config.json"));
      const cfg = await res.json();
      // user_config sadece kullanıcı değiştirdiğinde yazılır,
      // burada yalnızca son okunan kopyayı arşivliyoruz.
      await chrome.storage.local.set({ default_config: cfg });
    } catch (err) {
      console.error("config.json okunamadı:", err);
    }
  }
});

// Popup ile background arasında mesaj köprüsü.
// Şu an popup tüm işleri kendi yapıyor; ileride genişletilebilir.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "ping") {
    sendResponse({ ok: true, time: Date.now() });
    return true;
  }
  return false;
});
