"use strict";

// =============================================================
// Gmail Yardımcısı - Popup Mantığı
// Tüm dış URL'ler config.json'dan / chrome.storage'dan okunur.
// =============================================================

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

let runtimeConfig = null;
let cachedLabels = [];
let currentMessageId = null;
let currentMessageBody = "";

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

// ----------------------- Konfigürasyon -------------------------

async function loadConfig() {
  // 1) chrome.storage.local'da kullanıcı tarafından değiştirilmiş ayar varsa onu al
  const stored = await chrome.storage.local.get("user_config");
  if (stored.user_config) {
    runtimeConfig = stored.user_config;
    return runtimeConfig;
  }

  // 2) yoksa config.json'dan oku
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
        await fetch(
          `https://accounts.google.com/o/oauth2/revoke?token=${token}`
        );
      } catch (_) {
        /* yoksay */
      }
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

// ----------------------- Gmail API yardımcıları ----------------

async function gmailFetch(path, options = {}) {
  const token = await getAuthToken(true);
  const res = await fetch(GMAIL_API + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    // Token geçersiz olabilir - cache'den temizleyip tekrar dene
    await removeCachedToken(token);
    const token2 = await getAuthToken(true);
    const res2 = await fetch(GMAIL_API + path, {
      ...options,
      headers: {
        Authorization: "Bearer " + token2,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res2.ok) {
      throw new Error(`Gmail API hatası (${res2.status}): ${await res2.text()}`);
    }
    return res2.json();
  }

  if (!res.ok) {
    throw new Error(`Gmail API hatası (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// ----------------------- Maillerin Listelenmesi ----------------

async function loadMessages() {
  setStatus("messages-status", "Yükleniyor...");
  try {
    const data = await gmailFetch("/messages?maxResults=15&labelIds=INBOX");
    const list = document.getElementById("messages-list");
    list.innerHTML = "";

    if (!data.messages || data.messages.length === 0) {
      list.innerHTML = '<p class="empty-state">Gelen kutusu boş.</p>';
      setStatus("messages-status", "");
      return;
    }

    // Her mesaj için kısa metadata çek
    for (const m of data.messages) {
      const detail = await gmailFetch(
        `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const headers = detail.payload?.headers || [];
      const from = headers.find((h) => h.name === "From")?.value || "";
      const subject =
        headers.find((h) => h.name === "Subject")?.value || "(Konu yok)";

      const isUnread = (detail.labelIds || []).includes("UNREAD");

      const displayName = from.replace(/<[^>]+>/, "").trim() || from;
      const initial = displayName.charAt(0).toUpperCase() || "?";
      const avatarColors = ["#D93025","#1A73E8","#188038","#E37400","#7B1FA2","#0097A7"];
      const avatarBg = avatarColors[displayName.charCodeAt(0) % avatarColors.length];

      const item = document.createElement("div");
      item.className = "message-item" + (isUnread ? " unread" : "");
      item.dataset.id = m.id;
      item.innerHTML = `
        <div class="msg-avatar" style="background:${avatarBg}">${initial}</div>
        <div class="msg-body">
          <div class="message-from">${escapeHtml(displayName)}</div>
          <div class="message-subject">${escapeHtml(subject)}</div>
          <div class="message-snippet">${escapeHtml(detail.snippet || "")}</div>
        </div>
      `;
      item.addEventListener("click", () => openMessage(m.id));
      list.appendChild(item);
    }

    setStatus("messages-status", `${data.messages.length} mail listelendi`, "success");
  } catch (err) {
    setStatus("messages-status", "Hata: " + err.message, "error");
  }
}

// ----------------------- Mail Detayı ---------------------------

function decodeBase64Url(data) {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    // UTF-8 decode
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch (_) {
    return atob(b64);
  }
}

function extractBody(payload) {
  if (!payload) return "";

  // Doğrudan body
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Çok parçalı
  if (payload.parts && payload.parts.length) {
    // Önce text/plain bul
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // text/html'i HTML tag'lerinden ayıkla
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        const html = decodeBase64Url(part.body.data);
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    // İç içe parçalar
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

async function openMessage(id) {
  const list = document.getElementById("messages-list");
  const detail = document.getElementById("message-detail");

  list.classList.add("hidden");
  detail.classList.remove("hidden");
  setStatus("messages-status", "Mail yükleniyor...");

  try {
    const msg = await gmailFetch(`/messages/${id}?format=full`);
    const headers = msg.payload?.headers || [];
    const from = headers.find((h) => h.name === "From")?.value || "";
    const subject =
      headers.find((h) => h.name === "Subject")?.value || "(Konu yok)";
    const date = headers.find((h) => h.name === "Date")?.value || "";

    document.getElementById("detail-subject").textContent = subject;
    document.getElementById("detail-from").textContent = from;
    document.getElementById("detail-date").textContent = date;

    // Etiketler
    const chipsHost = document.getElementById("detail-labels");
    chipsHost.innerHTML = "";
    (msg.labelIds || []).forEach((labelId) => {
      const labelMeta = cachedLabels.find((l) => l.id === labelId);
      const chip = document.createElement("span");
      chip.className = "label-chip";
      chip.textContent = labelMeta ? labelMeta.name : labelId;
      chipsHost.appendChild(chip);
    });

    // Body
    const body = extractBody(msg.payload);
    currentMessageBody = body;
    currentMessageId = id;
    document.getElementById("detail-body").textContent =
      body || "(İçerik okunamadı)";

    // özetleme alanını gizle
    document.getElementById("summary-area").classList.add("hidden");
    document.getElementById("label-picker").classList.add("hidden");

    setStatus("messages-status", "");
  } catch (err) {
    setStatus("messages-status", "Hata: " + err.message, "error");
  }
}

function backToList() {
  document.getElementById("message-detail").classList.add("hidden");
  document.getElementById("messages-list").classList.remove("hidden");
  currentMessageId = null;
  currentMessageBody = "";
}

// ----------------------- Etiketler -----------------------------

async function loadLabels() {
  setStatus("label-status", "Yükleniyor...");
  try {
    const data = await gmailFetch("/labels");
    cachedLabels = data.labels || [];
    renderLabels();
    setStatus("label-status", `${cachedLabels.length} etiket yüklendi`, "success");
  } catch (err) {
    setStatus("label-status", "Hata: " + err.message, "error");
  }
}

function renderLabels() {
  const host = document.getElementById("labels-list");
  host.innerHTML = "";

  if (cachedLabels.length === 0) {
    host.innerHTML = '<p class="empty-state">Etiket bulunamadı.</p>';
    return;
  }

  // user etiketleri önce, sonra system
  const sorted = [...cachedLabels].sort((a, b) => {
    if (a.type !== b.type) return a.type === "user" ? -1 : 1;
    return a.name.localeCompare(b.name, "tr");
  });

  sorted.forEach((label) => {
    const item = document.createElement("div");
    item.className = "label-item";
    const typeClass = label.type === "user" ? "user" : "";
    item.innerHTML = `
      <span class="label-name">${escapeHtml(label.name)}</span>
      <span class="label-type ${typeClass}">${label.type === "user" ? "kullanıcı" : "sistem"}</span>
    `;
    host.appendChild(item);
  });
}

async function createLabel(name) {
  setStatus("label-status", "Etiket oluşturuluyor...");
  try {
    await gmailFetch("/labels", {
      method: "POST",
      body: JSON.stringify({
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    });
    setStatus("label-status", `"${name}" oluşturuldu`, "success");
    showToast(`Etiket oluşturuldu: ${name}`);
    await loadLabels();
  } catch (err) {
    setStatus("label-status", "Hata: " + err.message, "error");
  }
}

async function applyLabelToMessage(messageId, labelId) {
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

function showLabelPicker() {
  if (!currentMessageId) return;
  const picker = document.getElementById("label-picker");
  const list = document.getElementById("label-picker-list");

  list.innerHTML = "";
  if (cachedLabels.length === 0) {
    list.innerHTML =
      '<p class="empty-state">Önce "Etiketler" sekmesinden yenileyin.</p>';
  } else {
    const userLabels = cachedLabels.filter((l) => l.type === "user");
    const sys = cachedLabels.filter(
      (l) =>
        l.type === "system" &&
        ["IMPORTANT", "STARRED", "SPAM", "TRASH"].includes(l.id)
    );
    [...userLabels, ...sys].forEach((label) => {
      const item = document.createElement("div");
      item.className = "label-pick-item";
      item.textContent = label.name;
      item.addEventListener("click", async () => {
        try {
          await applyLabelToMessage(currentMessageId, label.id);
          showToast(`"${label.name}" etiketi uygulandı`);
          picker.classList.add("hidden");
          // Detayı yenile
          openMessage(currentMessageId);
        } catch (err) {
          showToast("Hata: " + err.message);
        }
      });
      list.appendChild(item);
    });
  }
  picker.classList.remove("hidden");
}

// ----------------------- Mail Gönderme -------------------------

function utf8ToBase64Url(str) {
  const utf8 = new TextEncoder().encode(str);
  let binary = "";
  utf8.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRawMessage(to, subject, body) {
  // RFC 2822, UTF-8 destekli
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
    document.getElementById("compose-form").reset();
  } catch (err) {
    setStatus("compose-status", "Hata: " + err.message, "error");
  }
}

// ----------------------- Yerel AI Özetleme ---------------------

async function summarizeText(text) {
  if (!runtimeConfig) await loadConfig();
  const url = runtimeConfig.local_model_url;
  const modelName = runtimeConfig.model_name;

  if (!url) {
    throw new Error("Yerel model adresi tanımlı değil (config.json).");
  }

  const prompt =
    "Aşağıdaki e-postayı kısa ve öz bir şekilde Türkçe olarak özetle. " +
    "Önemli noktaları madde madde belirt:\n\n" +
    text;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model: modelName }),
  });

  if (!res.ok) {
    throw new Error(`Yerel model hatası (${res.status})`);
  }

  const data = await res.json();
  return data.response || "(Boş cevap)";
}

async function onSummarizeClick() {
  if (!currentMessageBody) {
    showToast("Önce bir mail seçin.");
    return;
  }
  const area = document.getElementById("summary-area");
  const content = document.getElementById("summary-content");
  area.classList.remove("hidden");
  content.innerHTML = '<span class="spinner"></span>Yerel modele istek gönderiliyor...';

  try {
    const summary = await summarizeText(currentMessageBody);
    content.textContent = summary;
  } catch (err) {
    content.innerHTML = `<span style="color:#d93025">Hata: ${escapeHtml(
      err.message
    )}</span><br><small>Yerel model adresinin doğru olduğundan emin olun (Ayarlar sekmesi).</small>`;
  }
}

// ----------------------- Ayarlar -------------------------------

function fillSettingsForm() {
  document.getElementById("cfg-backend-url").value = runtimeConfig.backend_url || "";
  document.getElementById("cfg-model-url").value = runtimeConfig.local_model_url || "";
  document.getElementById("cfg-model-name").value = runtimeConfig.model_name || "";
  document.getElementById("cfg-client-id").value = runtimeConfig.google_client_id || "";

  const hint = document.getElementById("hint-model-url");
  if (hint) hint.textContent = runtimeConfig.local_model_url || "(yapılandırılmadı)";
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
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tab-panel")
        .forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(target).classList.add("active");

      if (target === "tab-labels" && cachedLabels.length === 0) {
        loadLabels();
      }
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
      loadMessages();
      loadLabels();
    } catch (err) {
      showToast("Giriş başarısız: " + err.message);
    }
  });

  document.getElementById("btn-logout").addEventListener("click", logout);

  document
    .getElementById("btn-refresh-messages")
    .addEventListener("click", loadMessages);
  document
    .getElementById("btn-refresh-labels")
    .addEventListener("click", loadLabels);

  document
    .getElementById("btn-back-to-list")
    .addEventListener("click", backToList);

  document
    .getElementById("btn-summarize")
    .addEventListener("click", onSummarizeClick);

  document
    .getElementById("btn-apply-label")
    .addEventListener("click", showLabelPicker);

  document
    .getElementById("btn-close-label-picker")
    .addEventListener("click", () =>
      document.getElementById("label-picker").classList.add("hidden")
    );

  document.getElementById("compose-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const to = document.getElementById("compose-to").value.trim();
    const subject = document.getElementById("compose-subject").value.trim();
    const body = document.getElementById("compose-body").value;
    sendMail(to, subject, body);
  });

  document.getElementById("btn-clear-compose").addEventListener("click", () => {
    document.getElementById("compose-form").reset();
    setStatus("compose-status", "");
  });

  document.getElementById("new-label-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("new-label-name").value.trim();
    if (!name) return;
    createLabel(name);
    document.getElementById("new-label-name").value = "";
  });

  document
    .getElementById("btn-save-settings")
    .addEventListener("click", onSaveSettings);
  document
    .getElementById("btn-reset-settings")
    .addEventListener("click", onResetSettings);
}

// ----------------------- Başlangıç -----------------------------

async function init() {
  setupTabs();
  bindEvents();

  await loadConfig();
  fillSettingsForm();

  // Sessiz token denemesi - kullanıcı önceden onay vermişse oturum açık say
  try {
    await getAuthToken(false);
    updateAuthUI(true);
    loadMessages();
    loadLabels();
  } catch (_) {
    updateAuthUI(false);
  }
}

document.addEventListener("DOMContentLoaded", init);
