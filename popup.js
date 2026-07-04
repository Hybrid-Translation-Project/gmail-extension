"use strict";

// =============================================================
// Gmail Yardımcısı - Popup Mantığı
// Açık olan Gmail mailini işler: özet, akıllı etiket, yanıt.
// Tüm dış URL'ler config.json'dan / chrome.storage'dan okunur.
// =============================================================

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

let runtimeConfig = null;
let currentMail = null;        // { threadId, messageId, rfcMessageId, from, fromEmail, subject, date, body, backendMail }
let cachedUserLabels = [];     // Kullanıcının kendi oluşturduğu Gmail etiketleri
let linkedAccountsCache = null; // GET /api/v1/accounts/ sonucu (küçük harf email listesi olarak)
let replyContextMailId = null;  // Senkron yanıt modunda backend Mail._id (writer/* için)

// ----------------------- Yardımcı: Toast & Durum ---------------

function showToast(text, ms = 2200) {
  const toast = document.getElementById("toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), ms);
}

function setStatus(elementId, text, kind = "") {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text;
  el.className = "status-text" + (kind ? " " + kind : "");
}

function showState(stateName) {
  ["state-no-mail", "state-loading", "state-mail-loaded"].forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== stateName);
  });
}

// ----------------------- Konfigürasyon -------------------------

async function loadConfig() {
  const stored = await chrome.storage.local.get("user_config");
  if (stored.user_config) {
    runtimeConfig = stored.user_config;
    return runtimeConfig;
  }
  const url = chrome.runtime.getURL("config.json");
  const res = await fetch(url);
  runtimeConfig = await res.json();
  return runtimeConfig;
}

async function saveConfig(cfg) {
  await chrome.storage.local.set({ user_config: cfg });
  runtimeConfig = cfg;
}

async function resetConfigToFile() {
  await chrome.storage.local.remove("user_config");
  await loadConfig();
}

// ----------------------- OAuth / Kimlik ------------------------

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(
          new Error(
            chrome.runtime.lastError
              ? chrome.runtime.lastError.message
              : "Token alınamadı."
          )
        );
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function logout() {
  try {
    const token = await getAuthToken(false).catch(() => null);
    if (token) {
      await removeCachedToken(token);
      try {
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
      } catch (_) { /* yoksay */ }
    }
  } finally {
    await chrome.storage.local.remove("logged_in");
    updateAuthUI(false);
    showToast("Çıkış yapıldı");
  }
}

function updateAuthUI(loggedIn) {
  document.getElementById("btn-login").classList.toggle("hidden", loggedIn);
  document.getElementById("btn-logout").classList.toggle("hidden", !loggedIn);
}

// ----------------------- Backend Oturum Kapısı -----------------

function showBackendLoginGate() {
  document.getElementById("backend-login").classList.remove("hidden");
  document.getElementById("backend-login-form").classList.remove("hidden");
  document.getElementById("backend-pwd-notice").classList.add("hidden");
  document.getElementById("main-tabs").classList.add("hidden");
  document.getElementById("backend-auth-area").classList.add("hidden");
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
}

function showBackendPasswordChangeGate() {
  document.getElementById("backend-login").classList.remove("hidden");
  document.getElementById("backend-login-form").classList.add("hidden");
  document.getElementById("backend-pwd-notice").classList.remove("hidden");
  document.getElementById("main-tabs").classList.add("hidden");
  document.getElementById("backend-auth-area").classList.add("hidden");
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
}

function enterBackendApp(session) {
  document.getElementById("backend-login").classList.add("hidden");
  document.getElementById("main-tabs").classList.remove("hidden");
  document.getElementById("backend-auth-area").classList.remove("hidden");

  const chip = document.getElementById("backend-user-chip");
  const username = (session && (session.username || (session.user && session.user.username))) || "";
  chip.textContent = username;

  const activeTabBtn = document.querySelector(".tab-btn.active") || document.querySelector(".tab-btn");
  if (activeTabBtn) {
    document.getElementById(activeTabBtn.dataset.tab).classList.add("active");
  }
}

async function onBackendLoginSubmit(e) {
  e.preventDefault();
  const username = document.getElementById("backend-username").value.trim();
  const password = document.getElementById("backend-password").value;
  setStatus("backend-login-status", "Giriş yapılıyor...");

  try {
    const { mustChangePassword } = await backendLogin(username, password);
    if (mustChangePassword) {
      showBackendPasswordChangeGate();
      return;
    }
    setStatus("backend-login-status", "");
    const session = await checkBackendSession();
    enterBackendApp(session);
    showToast("Giriş başarılı");

    // Gmail bağlamı zaten yüklüyse tekrar dene
    let loggedInGoogle = false;
    try {
      await getAuthToken(false);
      loggedInGoogle = true;
    } catch (_) {
      loggedInGoogle = false;
    }
    updateAuthUI(loggedInGoogle);
    if (loggedInGoogle) {
      loadCurrentMail();
    } else {
      showState("state-no-mail");
    }
  } catch (err) {
    setStatus("backend-login-status", err.message || "Giriş başarısız.", "error");
  }
}

async function onBackendLogoutClick() {
  await backendLogout();
  showBackendLoginGate();
  showToast("Çıkış yapıldı");
}

// Oturum ortasında token geçersiz kalırsa (refresh de başarısızsa) login ekranına döner.
// true dönerse çağıran yerel hata mesajı göstermemeli (kullanıcı zaten login formuna yönlendirildi).
function handleBackendActionError(err) {
  if (err && err.name === "BackendAuthError" && err.kind === "login_required") {
    showBackendLoginGate();
    setStatus("backend-login-status", err.message, "error");
    return true;
  }
  return false;
}

// ----------------------- Gmail API -----------------------------

async function gmailFetch(path, options = {}) {
  const token = await getAuthToken(true);
  const doFetch = (t) => fetch(GMAIL_API + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + t,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  let res = await doFetch(token);
  if (res.status === 401) {
    await removeCachedToken(token);
    const token2 = await getAuthToken(true);
    res = await doFetch(token2);
  }
  if (!res.ok) {
    throw new Error(`Gmail API hatası (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// ----------------------- Aktif Sekmeden Mail Bağlamı -----------

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function getCurrentMailContextFromGmailTab() {
  const tab = await getActiveTabId();
  if (!tab || !tab.url || !tab.url.includes("mail.google.com")) {
    return null;
  }
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_MAIL" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        resolve(null);
        return;
      }
      resolve(res);
    });
  });
}

// ----------------------- Mail Yükleme --------------------------

function decodeBase64Url(data) {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch (_) {
    return atob(b64);
  }
}

function extractBody(payload) {
  if (!payload) return "";
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        const html = decodeBase64Url(part.body.data);
        return html.replace(/<style[\s\S]*?<\/style>/gi, " ")
                   .replace(/<[^>]+>/g, " ")
                   .replace(/\s+/g, " ")
                   .trim();
      }
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

function parseFromHeader(value) {
  // "Ali Veli <ali@example.com>" → { name: "Ali Veli", email: "ali@example.com" }
  if (!value) return { name: "", email: "" };
  const match = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: match[1].replace(/^"(.*)"$/, "$1").trim(), email: match[2].trim() };
  }
  return { name: value, email: value };
}

async function fetchUserLabels() {
  try {
    const data = await gmailFetch("/labels");
    cachedUserLabels = (data.labels || []).filter((l) => l.type === "user");
  } catch (_) {
    cachedUserLabels = [];
  }
}

function normalizeMessageId(raw) {
  if (!raw) return null;
  return raw.trim().replace(/^<|>$/g, "").trim() || null;
}

async function fetchLinkedAccounts(force = false) {
  if (linkedAccountsCache && !force) return linkedAccountsCache;
  try {
    const data = await backendFetch("/api/v1/accounts/", { method: "GET" });
    const list = Array.isArray(data) ? data : data.accounts || [];
    linkedAccountsCache = list.map((a) => (a.email || "").toLowerCase());
  } catch (_) {
    linkedAccountsCache = [];
  }
  return linkedAccountsCache;
}

async function checkAccountLinked(accountEmail) {
  if (!accountEmail) return true; // tespit edilemediyse engelleme
  const accounts = await fetchLinkedAccounts();
  return accounts.includes(accountEmail.toLowerCase());
}

function renderAccountWarning(accountEmail, linked) {
  const banner = document.getElementById("account-warning");
  if (linked || !accountEmail) {
    banner.classList.add("hidden");
    return;
  }
  document.getElementById("account-warning-email").textContent = accountEmail;
  banner.classList.remove("hidden");
}

async function onLinkAccountClick() {
  if (!currentMail || !currentMail.accountEmail) return;
  try {
    const data = await backendFetch(
      `/api/v1/accounts/oauth/google/url?email=${encodeURIComponent(currentMail.accountEmail)}`,
      { method: "GET" }
    );
    const url = data.url || data.auth_url;
    if (url) {
      chrome.tabs.create({ url });
    } else {
      showToast("Bağlantı adresi alınamadı.");
    }
  } catch (err) {
    showToast("Hata: " + err.message);
  }
}

async function loadCurrentMail() {
  showState("state-loading");

  const mailCtx = await getCurrentMailContextFromGmailTab();
  if (!mailCtx || !mailCtx.threadId) {
    showState("state-no-mail");
    return;
  }
  const { threadId, accountEmail } = mailCtx;

  try {
    const thread = await gmailFetch(`/threads/${threadId}?format=full`);
    const messages = thread.messages || [];
    if (messages.length === 0) {
      showState("state-no-mail");
      return;
    }
    // Threaddeki son mesajı al
    const msg = messages[messages.length - 1];
    const headers = msg.payload?.headers || [];
    const fromHdr = headers.find((h) => h.name.toLowerCase() === "from")?.value || "";
    const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value || "(Konu yok)";
    const date = headers.find((h) => h.name.toLowerCase() === "date")?.value || "";
    const rfcMessageId = normalizeMessageId(
      headers.find((h) => h.name.toLowerCase() === "message-id")?.value
    );
    const { name, email } = parseFromHeader(fromHdr);

    const body = extractBody(msg.payload);

    currentMail = {
      threadId,
      messageId: msg.id,
      rfcMessageId,
      accountEmail,
      from: name || email,
      fromEmail: email,
      subject,
      date,
      body,
      labelIds: msg.labelIds || [],
      backendMail: null,
    };

    renderMailContext();
    // Yanıt bağlamını compose sekmesine doldur
    fillReplyContext();

    // Etiketleri arka planda yükle (akıllı etiketleme için lazım)
    fetchUserLabels();

    showState("state-mail-loaded");

    // Hesap bağlantısı ve backend senkron durumu (arka planda, popup akışını bloklamadan)
    checkAccountLinked(accountEmail).then((linked) => renderAccountWarning(accountEmail, linked));
    if (rfcMessageId) {
      backendFetch(`/api/v1/assist/mail-by-message-id/${encodeURIComponent(rfcMessageId)}`, { method: "GET" })
        .then((res) => {
          if (currentMail && currentMail.rfcMessageId === rfcMessageId && res && res.found) {
            currentMail.backendMail = res.mail;
            renderSyncBadge(true);
            fillReplyContext();
          } else {
            renderSyncBadge(false);
          }
        })
        .catch(() => renderSyncBadge(false));
    } else {
      renderSyncBadge(false);
    }
  } catch (err) {
    showState("state-no-mail");
    showToast("Mail yüklenemedi: " + err.message);
  }
}

function renderSyncBadge(synced) {
  const badge = document.getElementById("sync-badge");
  badge.classList.remove("hidden", "synced", "unsynced");
  badge.classList.add(synced ? "synced" : "unsynced");
  badge.textContent = synced ? "Senkronize" : "Senkron değil";
}

// Çip renk paleti — etiket adına göre deterministik atanır (Tailwind'den)
const CHIP_PALETTE = [
  { bg: "#FEE2E2", color: "#B91C1C" },  // red
  { bg: "#E0E7FF", color: "#4338CA" },  // indigo
  { bg: "#DCFCE7", color: "#15803D" },  // green
  { bg: "#FEF3C7", color: "#A16207" },  // amber
  { bg: "#FCE7F3", color: "#BE185D" },  // pink
  { bg: "#EDE9FE", color: "#6D28D9" },  // violet
  { bg: "#CFFAFE", color: "#0E7490" },  // cyan
];

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function chipColorFor(name) {
  return CHIP_PALETTE[hashString(name) % CHIP_PALETTE.length];
}

function formatShortDate(rawDate) {
  if (!rawDate) return "";
  const d = new Date(rawDate);
  if (isNaN(d.getTime())) return rawDate;
  const months = ["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

function renderMailContext() {
  if (!currentMail) return;

  const displayName = currentMail.from || currentMail.fromEmail || "?";
  const initial = (displayName.charAt(0) || "?").toUpperCase();

  // Avatar: sabit blue-100/blue-600 (CSS'ten); sadece harf ve override'ları temizle
  const avatar = document.getElementById("ctx-avatar");
  avatar.textContent = initial;
  avatar.style.background = "";

  document.getElementById("ctx-from").textContent = displayName;
  document.getElementById("ctx-date").textContent = formatShortDate(currentMail.date);
  document.getElementById("ctx-subject").textContent = currentMail.subject;
  document.getElementById("ctx-body").textContent = currentMail.body || "(İçerik okunamadı)";

  renderLabelChips();

  // Sonuç alanlarını gizle
  document.getElementById("summary-area").classList.add("hidden");
  document.getElementById("label-area").classList.add("hidden");
}

// ----------------------- Mail Yazma / Yanıt --------------------

function fillReplyContext() {
  if (!currentMail) return;

  const banner = document.getElementById("reply-banner");
  const bannerName = document.getElementById("reply-banner-name");
  bannerName.textContent = currentMail.from || currentMail.fromEmail;
  banner.classList.remove("hidden");

  const toEl = document.getElementById("compose-to");
  const subjEl = document.getElementById("compose-subject");
  const bodyEl = document.getElementById("compose-body");
  const aiActions = document.getElementById("ai-reply-actions");

  // Sadece boşsa veya değerleri otomatik doldurulmuşsa ezme
  if (!toEl.dataset.userEdited) {
    toEl.value = currentMail.fromEmail;
  }
  if (!subjEl.dataset.userEdited) {
    const subj = currentMail.subject || "";
    const lower = subj.toLowerCase();
    if (lower.startsWith("ynt:") || lower.startsWith("re:")) {
      subjEl.value = subj;
    } else {
      subjEl.value = `YNT: ${subj}`;
    }
  }

  if (currentMail.backendMail) {
    // Senkronize yanıt modu: gönderim writer/* üzerinden gider (mail.from_email hedeflenir,
    // to/subject alanları writer tarafında yok sayılır — kafa karışıklığını önlemek için kilitle).
    replyContextMailId = currentMail.backendMail._id;
    toEl.disabled = true;
    subjEl.disabled = true;
    aiActions.classList.remove("hidden");
    if (currentMail.backendMail.reply_draft && !bodyEl.dataset.userEdited) {
      bodyEl.value = currentMail.backendMail.reply_draft;
    }
  } else {
    replyContextMailId = null;
    toEl.disabled = false;
    subjEl.disabled = false;
    aiActions.classList.add("hidden");
  }
}

function clearReplyContext() {
  document.getElementById("reply-banner").classList.add("hidden");
  document.getElementById("ai-reply-actions").classList.add("hidden");
  document.getElementById("compose-form").reset();
  ["compose-to", "compose-subject", "compose-body"].forEach((id) => {
    const el = document.getElementById(id);
    delete el.dataset.userEdited;
    el.disabled = false;
  });
  replyContextMailId = null;
  setStatus("compose-status", "");
}

async function onAiGenerateReplyClick() {
  if (!replyContextMailId) return;
  const bodyEl = document.getElementById("compose-body");
  setStatus("compose-status", "AI yanıt üretiyor...");
  try {
    const data = await backendFetch("/api/v1/writer/generate", {
      method: "POST",
      body: JSON.stringify({ mail_id: replyContextMailId, action: "neutral" }),
    });
    bodyEl.value = data.content || "";
    bodyEl.dataset.userEdited = "1";
    setStatus("compose-status", "AI yanıtı üretildi", "success");
  } catch (err) {
    if (handleBackendActionError(err)) return;
    setStatus("compose-status", "Hata: " + err.message, "error");
  }
}

async function onSaveDraftClick() {
  if (!replyContextMailId) return;
  const content = document.getElementById("compose-body").value;
  setStatus("compose-status", "Taslak kaydediliyor...");
  try {
    await backendFetch("/api/v1/writer/save", {
      method: "POST",
      body: JSON.stringify({ mail_id: replyContextMailId, content }),
    });
    setStatus("compose-status", "Taslak kaydedildi", "success");
    showToast("Taslak kaydedildi");
  } catch (err) {
    if (handleBackendActionError(err)) return;
    setStatus("compose-status", "Hata: " + err.message, "error");
  }
}

async function sendReplyViaWriter(mailId, content) {
  setStatus("compose-status", "Gönderiliyor...");
  try {
    await backendFetch("/api/v1/writer/send", {
      method: "POST",
      body: JSON.stringify({ mail_id: mailId, content }),
    });
    setStatus("compose-status", "Mail başarıyla gönderildi", "success");
    showToast("Mail gönderildi");
    clearReplyContext();
  } catch (err) {
    if (handleBackendActionError(err)) return;
    setStatus("compose-status", "Hata: " + err.message, "error");
  }
}

function utf8ToBase64Url(str) {
  const utf8 = new TextEncoder().encode(str);
  let binary = "";
  utf8.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRawMessage(to, subject, body) {
  const subjectEncoded =
    "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(subject))) + "?=";
  const headers = [
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  const message = headers.join("\r\n") + "\r\n\r\n" + body;
  return utf8ToBase64Url(message);
}

async function sendMail(to, subject, body) {
  setStatus("compose-status", "Gönderiliyor...");
  try {
    const raw = buildRawMessage(to, subject, body);
    await gmailFetch("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    setStatus("compose-status", "Mail başarıyla gönderildi", "success");
    showToast("Mail gönderildi");
    clearReplyContext();
  } catch (err) {
    setStatus("compose-status", "Hata: " + err.message, "error");
  }
}

// ----------------------- Özetleme ------------------------------

function renderSummaryBullets(text) {
  // Modelin döndürdüğü metni madde işaretli liste varsa <ul> olarak göster
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => /^[-•*·]\s+/.test(l) || /^\d+[.)]\s+/.test(l));
  if (bulletLines.length >= 2 && bulletLines.length === lines.length) {
    const items = bulletLines
      .map((l) => l.replace(/^[-•*·]\s+|^\d+[.)]\s+/, ""))
      .map((l) => `<li>${escapeHtml(l)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  return escapeHtml(text);
}

async function onSummarizeClick() {
  if (!currentMail || !currentMail.body) {
    showToast("Önce bir mail açın.");
    return;
  }
  const area = document.getElementById("summary-area");
  const content = document.getElementById("summary-content");
  area.classList.remove("hidden");
  content.innerHTML = '<span class="spinner"></span> Sunucudan özet isteniyor...';

  try {
    const data = await backendFetch("/api/v1/assist/summarize", {
      method: "POST",
      body: JSON.stringify({
        subject: currentMail.subject,
        body: currentMail.body,
        message_id: currentMail.rfcMessageId,
      }),
    });
    const badge = data.source === "cache" ? "Kayıtlı özet" : "AI özeti";
    content.innerHTML = data.summary
      ? `<div style="font-size:10px; font-weight:600; color:var(--slate-400); margin-bottom:4px;">${badge}</div>` + renderSummaryBullets(data.summary)
      : "(Boş cevap)";
  } catch (err) {
    if (handleBackendActionError(err)) return;
    content.innerHTML = `<span style="color:#DC2626">Hata: ${escapeHtml(err.message)}</span>`;
  }
}

// ----------------------- Akıllı Etiketleme ---------------------

function normalizeLabelName(s) {
  return String(s || "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function suggestLabelFromAI(mailBody, subject, existingLabels) {
  const data = await backendFetch("/api/v1/assist/suggest-label", {
    method: "POST",
    body: JSON.stringify({
      subject: subject || "",
      body: mailBody || "",
      existing_labels: existingLabels.map((l) => l.name),
    }),
  });
  if (!data.label) throw new Error("Sunucu boş cevap döndürdü.");
  return data.label;
}

async function createLabel(name) {
  return gmailFetch("/labels", {
    method: "POST",
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
}

async function applyLabelToMessage(messageId, labelId) {
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

async function onSmartLabelClick() {
  if (!currentMail) {
    showToast("Önce bir mail açın.");
    return;
  }

  const area = document.getElementById("label-area");
  const content = document.getElementById("label-content");
  const titleEl = area.querySelector(".result-success-title");
  area.classList.remove("hidden");
  if (titleEl) titleEl.textContent = "İşleniyor...";
  content.innerHTML = '<span class="spinner"></span> Yapay zeka analiz ediyor...';

  try {
    await fetchUserLabels();

    const suggested = await suggestLabelFromAI(
      currentMail.body,
      currentMail.subject,
      cachedUserLabels
    );

    const norm = normalizeLabelName(suggested);
    let target = cachedUserLabels.find((l) => normalizeLabelName(l.name) === norm);
    let createdNew = false;

    if (!target) {
      target = await createLabel(suggested);
      createdNew = true;
      cachedUserLabels.push(target);
    }

    await applyLabelToMessage(currentMail.messageId, target.id);

    if (!currentMail.labelIds.includes(target.id)) {
      currentMail.labelIds.push(target.id);
    }

    if (titleEl) titleEl.textContent = "Başarıyla Uygulandı";
    const prefix = createdNew ? "Yeni Etiket" : "Mevcut Etiket";
    content.textContent = `${prefix}: "${target.name}"`;
    showToast(`Etiket ${createdNew ? "oluşturuldu ve uygulandı" : "uygulandı"}: ${target.name}`);

    renderLabelChips();
  } catch (err) {
    if (handleBackendActionError(err)) return;
    if (titleEl) titleEl.textContent = "Hata";
    content.innerHTML = `<span style="color:#DC2626">${escapeHtml(err.message)}</span>`;
  }
}

function renderLabelChips() {
  if (!currentMail) return;
  const chips = document.getElementById("ctx-labels");
  chips.innerHTML = "";
  currentMail.labelIds.forEach((id) => {
    const meta = cachedUserLabels.find((l) => l.id === id);
    if (!meta) return;
    const colors = chipColorFor(meta.name);
    const chip = document.createElement("span");
    chip.className = "label-chip";
    chip.style.background = colors.bg;
    chip.style.color = colors.color;
    chip.textContent = meta.name;
    chips.appendChild(chip);
  });
}

// ----------------------- Ayarlar -------------------------------

function fillSettingsForm() {
  document.getElementById("cfg-backend-url").value = runtimeConfig.backend_url || "";

  const cid = runtimeConfig.google_client_id || "";
  document.getElementById("cfg-client-id").value = cid;
  // Görünen kısa form: ilk 7 karakter + "...apps.googleusercontent.com"
  const display = document.getElementById("cfg-client-id-display");
  if (display) {
    if (cid.length > 20) {
      display.textContent = cid.slice(0, 7) + "...apps.googleusercontent.com";
    } else {
      display.textContent = cid || "(yapılandırılmadı)";
    }
  }
}

async function onSaveSettings() {
  const newCfg = {
    ...runtimeConfig,
    backend_url: document.getElementById("cfg-backend-url").value.trim(),
  };
  await saveConfig(newCfg);
  fillSettingsForm();
  setStatus("settings-status", "Ayarlar kaydedildi", "success");
  showToast("Ayarlar kaydedildi");
}

async function onResetSettings() {
  await resetConfigToFile();
  fillSettingsForm();
  setStatus("settings-status", "config.json'daki değerlere döndürüldü", "success");
  showToast("Ayarlar sıfırlandı");
}

// ----------------------- HTML Escape ---------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ----------------------- Sekme Geçişi --------------------------

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(target).classList.add("active");
    });
  });
}

// ----------------------- Olay Bağlantıları ---------------------

function bindEvents() {
  document.getElementById("btn-login").addEventListener("click", async () => {
    try {
      await getAuthToken(true);
      await chrome.storage.local.set({ logged_in: true });
      updateAuthUI(true);
      showToast("Giriş başarılı");
      loadCurrentMail();
    } catch (err) {
      showToast("Giriş başarısız: " + err.message);
    }
  });

  document.getElementById("btn-logout").addEventListener("click", logout);

  document.getElementById("btn-summarize").addEventListener("click", onSummarizeClick);
  document.getElementById("btn-smart-label").addEventListener("click", onSmartLabelClick);

  document.getElementById("compose-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = document.getElementById("compose-body").value;
    if (replyContextMailId) {
      sendReplyViaWriter(replyContextMailId, body);
      return;
    }
    const to = document.getElementById("compose-to").value.trim();
    const subject = document.getElementById("compose-subject").value.trim();
    sendMail(to, subject, body);
  });

  document.getElementById("btn-ai-generate-reply").addEventListener("click", onAiGenerateReplyClick);
  document.getElementById("btn-save-draft").addEventListener("click", onSaveDraftClick);

  document.getElementById("btn-clear-compose").addEventListener("click", clearReplyContext);
  document.getElementById("btn-clear-reply").addEventListener("click", clearReplyContext);
  document.getElementById("btn-link-account").addEventListener("click", onLinkAccountClick);

  // Kullanıcı manuel düzenlerse otomatik doldurmayı durdur
  ["compose-to", "compose-subject", "compose-body"].forEach((id) => {
    document.getElementById(id).addEventListener("input", (e) => {
      e.target.dataset.userEdited = "1";
    });
  });

  document.getElementById("btn-save-settings").addEventListener("click", onSaveSettings);
  document.getElementById("btn-reset-settings").addEventListener("click", onResetSettings);

  document.getElementById("backend-login-form").addEventListener("submit", onBackendLoginSubmit);
  document.getElementById("btn-backend-logout").addEventListener("click", onBackendLogoutClick);
}

// ----------------------- Başlangıç -----------------------------

async function init() {
  setupTabs();
  bindEvents();

  await loadConfig();
  fillSettingsForm();

  const session = await checkBackendSession();
  if (!session) {
    showBackendLoginGate();
    return;
  }
  if (session.must_change_password) {
    showBackendPasswordChangeGate();
    return;
  }
  enterBackendApp(session);

  // Sessiz token denemesi (Gmail/Google tarafı)
  let loggedIn = false;
  try {
    await getAuthToken(false);
    loggedIn = true;
  } catch (_) {
    loggedIn = false;
  }
  updateAuthUI(loggedIn);

  if (loggedIn) {
    loadCurrentMail();
  } else {
    showState("state-no-mail");
  }
}

document.addEventListener("DOMContentLoaded", init);
