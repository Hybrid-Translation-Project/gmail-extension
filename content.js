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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "GET_CURRENT_MAIL") {
    sendResponse({ threadId: extractThreadIdFromHash() });
    return true;
  }
});
