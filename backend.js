"use strict";

// =============================================================
// Gmail Yardımcısı - Backend Kimlik Doğrulama Katmanı
// Magi AI Backend (JWT) ile giriş, token yenileme ve auth'lu
// istekler için ortak fetch sarmalayıcısı. popup.js'ten ÖNCE
// yüklenir; runtimeConfig / loadConfig popup.js içinde tanımlı.
// =============================================================

const BACKEND_AUTH_KEY = "backend_auth"; // { access_token, refresh_token, user }

class BackendAuthError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "BackendAuthError";
    // kind: "config" | "offline" | "login_required" | "login_failed"
    //     | "password_change_required" | "license_required" | "server_error"
    this.kind = kind;
  }
}

async function getBackendUrl() {
  if (!runtimeConfig) await loadConfig();
  return (runtimeConfig.backend_url || "").replace(/\/+$/, "");
}

async function getBackendAuth() {
  const stored = await chrome.storage.local.get(BACKEND_AUTH_KEY);
  return stored[BACKEND_AUTH_KEY] || null;
}

async function setBackendAuth(auth) {
  await chrome.storage.local.set({ [BACKEND_AUTH_KEY]: auth });
}

async function clearBackendAuth() {
  await chrome.storage.local.remove(BACKEND_AUTH_KEY);
}

async function backendLogin(username, password) {
  const url = await getBackendUrl();
  if (!url) throw new BackendAuthError("Sunucu adresi tanımlı değil (Ayarlar sekmesi).", "config");

  let res;
  try {
    res = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (_) {
    throw new BackendAuthError("Sunucuya ulaşılamıyor.", "offline");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new BackendAuthError(data.detail || `Giriş başarısız (${res.status})`, "login_failed");
  }

  await setBackendAuth({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user || null,
  });

  return { mustChangePassword: !!data.must_change_password };
}

async function backendLogout() {
  await clearBackendAuth();
}

async function refreshBackendToken() {
  const auth = await getBackendAuth();
  if (!auth || !auth.refresh_token) return false;

  const url = await getBackendUrl();
  if (!url) return false;

  let res;
  try {
    res = await fetch(`${url}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    });
  } catch (_) {
    return false;
  }
  if (!res.ok) return false;

  const data = await res.json().catch(() => ({}));
  if (!data.access_token) return false;

  await setBackendAuth({ ...auth, access_token: data.access_token });
  return true;
}

// backendFetch: path "/api/v1/..." ile başlamalı. JSON gövde/yanıt varsayar.
async function backendFetch(path, options = {}, _retried = false) {
  const url = await getBackendUrl();
  if (!url) throw new BackendAuthError("Sunucu adresi tanımlı değil (Ayarlar sekmesi).", "config");

  const auth = await getBackendAuth();
  if (!auth || !auth.access_token) {
    throw new BackendAuthError("Giriş yapmanız gerekiyor.", "login_required");
  }

  let res;
  try {
    res = await fetch(url + path, {
      ...options,
      headers: {
        Authorization: "Bearer " + auth.access_token,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (_) {
    throw new BackendAuthError("Sunucuya ulaşılamıyor.", "offline");
  }

  if (res.status === 401 && !_retried) {
    const refreshed = await refreshBackendToken();
    if (refreshed) {
      return backendFetch(path, options, true);
    }
    await clearBackendAuth();
    throw new BackendAuthError("Oturum sona erdi, tekrar giriş yapın.", "login_required");
  }

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }

  if (res.status === 403 && data && data.password_change_required) {
    throw new BackendAuthError("Şifrenizi web panelinden değiştirmeniz gerekiyor.", "password_change_required");
  }
  if (res.status === 402) {
    throw new BackendAuthError((data && data.detail) || "Lisans geçersiz.", "license_required");
  }
  if (!res.ok) {
    throw new BackendAuthError((data && data.detail) || `Sunucu hatası (${res.status})`, "server_error");
  }

  return data;
}

// Popup açılışında sessizce oturum doğrular; geçersizse null döner (login formuna düşülür).
async function checkBackendSession() {
  const auth = await getBackendAuth();
  if (!auth || !auth.access_token) return null;

  try {
    const data = await backendFetch("/api/v1/auth/verify-token", { method: "GET" });
    return { ...auth, ...data };
  } catch (_) {
    return null;
  }
}
