"use strict";

// =============================================================
// Gmail Yardımcısı - İçerik Betiği (Content Script)
// Gmail sekmesinde çalışır, popup'a o anki maili bildirir.
// =============================================================

function extractThreadIdFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;

  const parts = hash.split("/");
  const last = parts[parts.length - 1];

  // Gmail thread ID'leri hex string, en az 10 karakter
  if (parts.length >= 2 && /^[a-fA-F0-9]{10,}$/.test(last)) {
    return last;
  }
  return null;
}

// Gmail sekme başlığı genelde "... - kullanici@gmail.com - Gmail" şeklindedir.
// Çoklu hesap girişinde (u/0, u/1...) chrome.identity hesabından farklı olabilir.
function extractActiveAccountEmail() {
  const title = document.title || "";
  const match = title.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (match) return match[1];

  const accountBtn = document.querySelector('a[aria-label*="@"], [aria-label*="Google Hesabı"], [aria-label*="Google Account"]');
  if (accountBtn) {
    const label = accountBtn.getAttribute("aria-label") || "";
    const labelMatch = label.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (labelMatch) return labelMatch[1];
  }

  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "GET_CURRENT_MAIL") {
    sendResponse({
      threadId: extractThreadIdFromHash(),
      accountEmail: extractActiveAccountEmail(),
    });
    return true;
  }
});
