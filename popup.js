"use strict";

// =============================================================
// Gmail Yardımcısı - Popup Mantığı
// Açık olan Gmail mailini işler: özet, akıllı etiket, yanıt.
// Tüm dış URL'ler config.json'dan / chrome.storage'dan okunur.
// =============================================================

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

let runtimeConfig = null;
let currentMail = null;        // { threadId, messageId, from, fromEmail, subject, date, body }
let cachedUserLabels = [];     // Kullanıcının kendi oluşturduğu Gmail etiketleri

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

async function getCurrentThreadIdFromGmailTab() {
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
      resolve(res.threadId);
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

async function loadCurrentMail() {
  showState("state-loading");

  const threadId = await getCurrentThreadIdFromGmailTab();
  if (!threadId) {
    showState("state-no-mail");
    return;
  }

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
    const { name, email } = parseFromHeader(fromHdr);

    const body = extractBody(msg.payload);

    currentMail = {
      threadId,
      messageId: msg.id,
      from: name || email,
      fromEmail: email,
      subject,
      date,
      body,
      labelIds: msg.labelIds || [],
    };

    renderMailContext();
    // Yanıt bağlamını compose sekmesine doldur
    fillReplyContext();

    // Etiketleri arka planda yükle (akıllı etiketleme için lazım)
    fetchUserLabels();

    showState("state-mail-loaded");
  } catch (err) {
    showState("state-no-mail");
    showToast("Mail yüklenemedi: " + err.message);
  }
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
}

function clearReplyContext() {
  document.getElementById("reply-banner").classList.add("hidden");
  document.getElementById("compose-form").reset();
  ["compose-to", "compose-subject", "compose-body"].forEach((id) => {
    const el = document.getElementById(id);
    delete el.dataset.userEdited;
  });
  setStatus("compose-status", "");
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

// ----------------------- Yerel AI Çağrısı ----------------------

async function callLocalModel(prompt) {
  if (!runtimeConfig) await loadConfig();
  const url = runtimeConfig.local_model_url;
  const modelName = runtimeConfig.model_name;

  if (!url) {
    throw new Error("Yerel model adresi tanımlı değil (config.json).");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model: modelName }),
  });

  if (!res.ok) {
    throw new Error(`Yerel model hatası (${res.status})`);
  }

  const data = await res.json();
  return (data.response || "").trim();
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
  content.innerHTML = '<span class="spinner"></span> Yerel modele istek gönderiliyor...';

  const prompt =
    "Aşağıdaki e-postayı kısa ve öz bir şekilde Türkçe olarak özetle. " +
    "Önemli noktaları madde madde belirt:\n\n" +
    currentMail.body;

  try {
    const summary = await callLocalModel(prompt);
    content.innerHTML = summary ? renderSummaryBullets(summary) : "(Boş cevap)";
  } catch (err) {
    content.innerHTML = `<span style="color:#DC2626">Hata: ${escapeHtml(err.message)}</span><br><small>Yerel model adresinin doğru olduğundan emin olun (Ayarlar sekmesi).</small>`;
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
  const labelList = existingLabels.length
    ? existingLabels.map((l) => `- ${l.name}`).join("\n")
    : "(henüz hiç kullanıcı etiketi yok)";

  const prompt =
    "Sen bir e-posta sınıflandırma asistanısın. Görevin: aşağıdaki e-postayı en uygun şekilde kategorize edecek **kısa bir etiket adı** üretmek.\n\n" +
    "KURALLAR:\n" +
    "1. Etiket adı 1-2 kelime olmalı, Türkçe.\n" +
    "2. Eğer aşağıdaki MEVCUT ETİKETLER listesinden biri uygunsa, ONUN AYNISINI yaz.\n" +
    "3. Hiçbiri uygun değilse yeni bir etiket adı öner (Örnekler: Faturalar, İş, Eğitim, Bildirimler, Sosyal, Alışveriş, Banka, Yolculuk).\n" +
    "4. SADECE etiket adını döndür. Açıklama, tırnak, noktalama veya başka metin yazma.\n\n" +
    "MEVCUT ETİKETLER:\n" + labelList + "\n\n" +
    `KONU: ${subject || "(yok)"}\n\n` +
    "İÇERİK:\n" + (mailBody || "").slice(0, 1500) + "\n\n" +
    "Etiket adı:";

  const raw = await callLocalModel(prompt);
  // Modelin döndürdüğü cevapta birden fazla satır/karakter olabilir
  let suggested = raw.split(/\r?\n/)[0].trim();
  // Tırnak, nokta vb. kaldır
  suggested = suggested.replace(/^["'`]+|["'`.,;:!?]+$/g, "").trim();
  if (!suggested) throw new Error("Model boş cevap döndürdü.");
  return suggested;
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
  document.getElementById("cfg-model-url").value = runtimeConfig.local_model_url || "";
  document.getElementById("cfg-model-name").value = runtimeConfig.model_name || "";

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
    local_model_url: document.getElementById("cfg-model-url").value.trim(),
    model_name: document.getElementById("cfg-model-name").value.trim(),
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
    const to = document.getElementById("compose-to").value.trim();
    const subject = document.getElementById("compose-subject").value.trim();
    const body = document.getElementById("compose-body").value;
    sendMail(to, subject, body);
  });

  document.getElementById("btn-clear-compose").addEventListener("click", clearReplyContext);
  document.getElementById("btn-clear-reply").addEventListener("click", clearReplyContext);

  // Kullanıcı manuel düzenlerse otomatik doldurmayı durdur
  ["compose-to", "compose-subject", "compose-body"].forEach((id) => {
    document.getElementById(id).addEventListener("input", (e) => {
      e.target.dataset.userEdited = "1";
    });
  });

  document.getElementById("btn-save-settings").addEventListener("click", onSaveSettings);
  document.getElementById("btn-reset-settings").addEventListener("click", onResetSettings);
}

// ----------------------- Başlangıç -----------------------------

async function init() {
  setupTabs();
  bindEvents();

  await loadConfig();
  fillSettingsForm();

  // Sessiz token denemesi
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
