// login.js
//
// Production Security Fix Pass (Critical): credential verification used to
// happen HERE, in the browser — handleStaffPinLogin()/handleLogin() used to
// download every employee's record (name/role/PIN, including PASSWORD IN
// PLAIN TEXT) for the whole restaurant and compare the typed PIN/password in
// JS. Both flows now POST to the backend (routes/auth.js), which verifies
// against a bcrypt hash server-side and never returns another user's
// credential to the browser. When the backend has a Firebase Admin service
// account configured, it also returns a custom token; signInWithCustomToken()
// below turns that into a real, persisted Firebase Auth session — the same
// session every other admin-frontend page (admin.js, kassa.js, chef.js, ...)
// already shares via the same Firebase app config, so this is the only file
// that needed to change for the rest of the app to gain a real identity.
import { getDatabase, forceWebSockets } from "./pgRtdb.js";
import { parseRestId } from "./pgRestId.js";
import { getAuth, signInWithEmailAndPassword, signInWithCustomToken, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { loadNestaFirebaseApp } from "./nestaFirebaseApp.js";
import { t, getLang, setLang, applyLang, onLangChange } from "./i18n.js";

// Force WebSocket-only transport (never fall back to `.lp` long-polling) —
// first executable statement in this module.
forceWebSockets();

// ── bfcache himoyasi: sahifa "orqaga/oldinga" tugmasi orqali keshdan
// tiklanganda Firebase ulanishi uzilgan bo'lishi mumkin (WebSocket yopiladi).
// Shu holatni aniqlab, sahifani majburan qayta yuklaymiz — shunda yangi,
// tirik Firebase ulanishi bilan ishlaymiz va "Kod noto'g'ri" kabi soxta
// xatolarning oldini olamiz.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

// Best-effort "Employee Login" instant alert (Notification Center — additive,
// 2026 expansion). Uses the dedicated /notifications/employee-event endpoint
// (not the general /trigger one), which only requires "notifications:view" —
// every role has that — so a waiter/chef/cashier logging in never needs
// admin-level permission just to report their own login. Fire-and-forget:
// a failure here must never block login.
//
// Production Security Fix Pass (P0-1): this endpoint's backend authorization
// used to trust the x-user-id/x-rest-id headers below directly (proven
// live-exploitable — see PRODUCTION-AUDIT.md) and now REQUIRES a verified
// Authorization: Bearer <firebase-id-token>. Both call sites below invoke
// this AFTER signInWithCustomToken(auth, result.token) has already
// completed, so `auth.currentUser` (module-level const, declared above) is
// already the freshly-signed-in employee by the time this runs.
async function notifyEmployeeLogin(restId, userId) {
  try {
    const headers = { "Content-Type": "application/json", "x-user-id": userId, "x-rest-id": restId };
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
    } catch (_e) { /* no session yet — request will 401, same as any unauthenticated caller */ }
    fetch(`/api/notifications/employee-event?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "employee_login" }),
    }).catch(() => { });
  } catch (_e) { /* ignore — non-critical */ }
}

const app = await loadNestaFirebaseApp();
getDatabase(app);
const auth = getAuth(app);

// 🩹 Cross-tab session bleed fix — live-reproduced: a cashier's kassa.html
// tab (already open, listeners actively receiving data) suddenly started
// getting permission_denied on an already-open `tables` onValue() listener
// (Firebase's own onListenRevoked_) mid-session, with no device-disable/
// force-logout audit entry and the account confirmed `active:true` —
// ruling out an intentional revocation. Root cause: every sign-in below
// (staff PIN, manager/admin, and superadmin email+password — all three
// share this one file) used Firebase's DEFAULT persistence
// (browserLocalPersistence), which is shared IndexedDB storage for the
// WHOLE BROWSER ORIGIN, not just this tab. Signing in as a DIFFERENT
// staff member (or a different restaurant, or superadmin) in ANOTHER tab
// of the same browser silently swaps `auth.currentUser` in THIS tab too —
// any of this tab's still-open listeners keep running, but now evaluate
// every Firebase Rule against the OTHER tab's identity, which is exactly
// what a mid-session, previously-working listener suddenly getting denied
// looks like. This is the exact same leak class already fixed for
// admin.js's "Login As" ssoToken flow and client.js's QR customer session
// (both now scoped) — login.js was the one remaining shared entry point
// still using unscoped default persistence, for every staff role AND
// superadmin. browserSessionPersistence (not inMemoryPersistence) is used
// here — unlike the QR/ssoToken flows, which deliberately want "gone on
// reload" freshness, a staff member refreshing their own tab (F5) should
// stay logged in; only OTHER tabs must never inherit this one's session.
async function _setLoginPersistence() {
  try {
    await setPersistence(auth, browserSessionPersistence);
  } catch (e) {
    console.error("[LOGIN-AUTH] setPersistence xatosi (davom etamiz, standart persistence bilan):", e?.code || e?.message);
  }
}

// ══════════════════════════════════════════════════════
// 🏢 RESTORAN SKOPI — har bir login sahifasi faqat bitta
// restoranga bog'langan bo'lishi kerak. Xodim/rahbar qidiruvi
// HECH QACHON barcha restoranlar bo'ylab global amalga
// oshirilmasligi kerak (bir xodim kodi turli restoranlarda
// takrorlanishi mumkin, shuning uchun avval restoran aniqlanadi).
//
// Manba: login.html?rest=TRN001 (yoki kelajakda trn001.nesta.uz).
// Birinchi tashrifda URL'dan o'qib localStorage'ga saqlanadi;
// keyingi tashriflarda saqlangan qiymat qayta ishlatiladi. Agar
// foydalanuvchi boshqa restoranning havolasini ochsa, saqlangan
// skop yangisi bilan almashtiriladi.
// ══════════════════════════════════════════════════════
let currentRestaurantId = null;
let restaurantScopeError = null;

function acceptRestaurantScope(raw) {
  const parsed = parseRestId(raw);
  if (!parsed.ok || parsed.empty || parsed.composite) return null;
  return parsed.restId;
}

async function resolveRestaurantScope() {
  const urlRestId = new URLSearchParams(window.location.search).get("rest");

  if (urlRestId) {
    // PIN login is restaurant-scoped; existence/credentials are proven at
    // /api/auth/staff-login. Do not pre-read restaurants/*/info: the
    // PostgreSQL data plane requires a token, so that GET 401s before login
    // and permanently disables the keypad.
    const restId = acceptRestaurantScope(urlRestId);
    if (!restId) {
      restaurantScopeError = t(
        "error_invalid_restaurant_link",
        "Havola noto'g'ri: bunday restoran topilmadi."
      );
      return;
    }
    currentRestaurantId = restId;
    localStorage.setItem("restaurantId", restId);
    return;
  }

  const storedRestId = acceptRestaurantScope(localStorage.getItem("restaurantId"));

  if (storedRestId) {
    currentRestaurantId = storedRestId;
    return;
  }

  restaurantScopeError = t(
    "error_missing_restaurant_link",
    "Kirish havolasi noto'g'ri. Administratordan restoranga tegishli havolani so'rang."
  );
}

const restaurantScopeReady = resolveRestaurantScope();

// UNIVERSAL LOGIN: manager/admin login (#loginInput/#passwordInput/
// #loginBtn) no longer depends on restaurant scope at all — the backend
// (routes/auth.js manager-login) now identifies the restaurant FROM the
// submitted login+password itself. `?rest=` (or a stored localStorage
// restaurantId) is only ever passed along as an optional, non-authoritative
// hint (see handleLogin() below) — old login.html?rest=<id> links keep
// working exactly as before, but a missing/invalid one no longer blocks
// the manager login form (talab #13).
//
// PIN (employee) login is the one flow that still genuinely needs a
// resolved restaurant scope (an employee's 4-digit PIN is only unique
// *within* their own restaurant) — _applyRestaurantScopeGate() below still
// gates ONLY the `.pin-key` keypad on `currentRestaurantId`, unchanged in
// spirit from before, just no longer also disabling the manager form.
//
// The previous browser-autofill-detection workaround (CSS :-webkit-
// autofill/:autofill animation trick + _loginInputTypedByUser/
// _passwordInputTypedByUser flags + field-clearing-on-scope-resolved) is
// removed: it existed specifically to stop a stale credential from being
// silently submitted against the WRONG restaurant's scope. That scope no
// longer exists for manager login — whatever credential ends up in the
// fields (typed or autofilled) simply authenticates as whichever
// restaurant it actually belongs to, which is correct behavior, not a bug.
restaurantScopeReady.then(() => {
  // Faqat PIN klaviaturasini boshqaradi — manager loginBtn/inputlar bunga
  // bog'liq emas.
  _applyRestaurantScopeGate(false);
});

function _applyRestaurantScopeGate(showMessage) {
  document.querySelectorAll(".pin-key").forEach(btn => btn.disabled = !currentRestaurantId);
  if (!currentRestaurantId && showMessage) {
    showError(restaurantScopeError || t("error_missing_restaurant_link", "Kirish havolasi noto'g'ri. Administratordan restoranga tegishli havolani so'rang."));
  }
}

window.hashPassword = async function (password) {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

// ══════════════════════════════════════════════════════
// 🔢 XODIM KIRISH REJIMI — 4 xonali PIN kod
// ══════════════════════════════════════════════════════
let _pinDigits = "";

window.setLoginMode = function (mode) {
  const staffBox = document.getElementById("staffLoginBox");
  const managerBox = document.getElementById("managerLoginBox");
  const staffBtn = document.getElementById("loginModeBtnStaff");
  const managerBtn = document.getElementById("loginModeBtnManager");

  hideError();
  _pinDigits = "";
  _renderPinDots();

  if (mode === "staff") {
    staffBox.style.display = "block";
    managerBox.style.display = "none";
    staffBtn.style.background = "#fff";
    staffBtn.style.color = "#0f172a";
    staffBtn.style.boxShadow = "0 1px 3px rgba(0,0,0,0.08)";
    managerBtn.style.background = "transparent";
    managerBtn.style.color = "#64748b";
    managerBtn.style.boxShadow = "none";
  } else {
    staffBox.style.display = "none";
    managerBox.style.display = "block";
    managerBtn.style.background = "#fff";
    managerBtn.style.color = "#0f172a";
    managerBtn.style.boxShadow = "0 1px 3px rgba(0,0,0,0.08)";
    staffBtn.style.background = "transparent";
    staffBtn.style.color = "#64748b";
    staffBtn.style.boxShadow = "none";
  }
};

function _renderPinDots() {
  document.querySelectorAll("#staffPinDisplay .pin-dot").forEach((dot, i) => {
    dot.classList.toggle("filled", i < _pinDigits.length);
  });
}

window.pinKeyPress = function (digit) {
  if (_pinDigits.length >= 4) return;
  _pinDigits += digit;
  _renderPinDots();
  if (_pinDigits.length === 4) {
    // Kod to'liq terildi — biroz kutib (vizual tasdiq uchun), so'ng kirishga urinamiz
    setTimeout(() => handleStaffPinLogin(_pinDigits), 150);
  }
};

window.pinKeyBackspace = function () {
  _pinDigits = _pinDigits.slice(0, -1);
  _renderPinDots();
};

window.pinKeyClear = function () {
  _pinDigits = "";
  _renderPinDots();
};

// ── PIN kod orqali kirish: FAQAT joriy (URL/localStorage'dan aniqlangan)
// restoran ichidagi xodimni 4 xonali PIN bo'yicha qidiradi. Tekshiruv endi
// backend'da (routes/auth.js) — brauzer boshqa hech qaysi xodimning
// yozuvini (ayniqsa parolini) hech qachon ko'rmaydi.
async function handleStaffPinLogin(pin) {
  hideError();
  await restaurantScopeReady;
  if (!currentRestaurantId) {
    _applyRestaurantScopeGate(true);
    _pinDigits = ""; _renderPinDots();
    return;
  }
  try {
    const resp = await fetch("/api/auth/staff-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restId: currentRestaurantId, pin }),
    });
    const result = await resp.json().catch(() => ({}));

    if (resp.status === 402) {
      window.location.href = `expired.html?rest=${encodeURIComponent(currentRestaurantId)}`;
      return;
    }
    if (resp.status === 409) {
      // Bir nechta xodimda bir xil PIN kod topildi — xavfsizlik uchun
      // kirishga ruxsat berilmadi (backend tomonidan aniqlangan).
      showError(t("error_pin_conflict", "Bu kod bir nechta xodimda takrorlangan. Adminingizga murojaat qiling."));
      _pinDigits = ""; _renderPinDots();
      return;
    }
    if (resp.status === 403) {
      showError(t("error_profile_blocked", "Profilingiz bloklangan!"));
      _pinDigits = ""; _renderPinDots();
      return;
    }
    if (!resp.ok || !result.ok) {
      showError(t("error_invalid_pin", "Kod noto'g'ri! Qaytadan urinib ko'ring."));
      _pinDigits = ""; _renderPinDots();
      return;
    }

    const foundUser = result.user;
    const foundRestaurantId = result.restId;

    // Agar backend'da Firebase Admin service account sozlangan bo'lsa, real
    // Firebase Auth sessiyasi o'rnatiladi — shu orqali database.rules.json
    // endi auth.uid/auth.token.restId/role'ni tekshira oladi. Sozlanmagan
    // bo'lsa (result.token == null), oldingi xatti-harakat saqlanadi.
    if (result.token) {
      try {
        await _setLoginPersistence();
        await signInWithCustomToken(auth, result.token);
      } catch (e) {
        console.error("Firebase Auth sign-in xatosi (davom etamiz, sessiya faqat ilova darajasida):", e);
      }
    }

    // ── Yangi xodim uchun sessiyani to'liq, oldingi (masalan kassa/admin)
    // qiymatlarni qoldirmasdan yozamiz. restaurantId localStorage'da (barcha
    // tab'lar uchun umumiy — bitta restoran bilan ishlash odatiy holat).
    // userId/role/name/currentUser esa sessionStorage'da — bu HAR BIR
    // BRAUZER TABI UCHUN ALOHIDA saqlanadi. MUHIM SABAB: agar bular
    // localStorage'da bo'lsa, bir tabda moliyachi bilan, boshqa tabda admin
    // bilan login qilinganda ikkalasi bir xil (umumiy) localStorage'ni
    // ustma-ust yozib, bir-birining sessiyasini "bosib" o'tar edi — masalan
    // admin o'z tabiga qaytganda ham moliyachi roli bilan ko'rinib qolardi.
    sessionStorage.setItem("userId", foundUser.id);
    sessionStorage.setItem("role", foundUser.role);
    sessionStorage.setItem("name", foundUser.name);
    sessionStorage.setItem("currentUser", JSON.stringify({ id: foundUser.id, role: foundUser.role, name: foundUser.name }));
    localStorage.setItem("restaurantId", foundRestaurantId);
    notifyEmployeeLogin(foundRestaurantId, foundUser.id);

    const routes = {
      chef: "chef.html",
      head_chef: "chef.html",
      waiter: "waiter.html",
      cashier: "kassa.html",
      courier: "courier.html"
    };

    const targetPage = routes[foundUser.role] || "admin.html";

    window.location.href =
      `${targetPage}?rest=${encodeURIComponent(foundRestaurantId)}`;

  } catch (error) {
    console.error(t("log_login_error", "Login xatoligi:"), error);
    showError(t("error_network", "Internet aloqasini tekshiring."));
    _pinDigits = ""; _renderPinDots();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("errorMsg").style.display = "none";
  // PIN klaviaturasining yoqilgan/o'chirilgan holati restaurantScopeReady.
  // then() (yuqorida) orqali allaqachon boshqariladi — bu yerda qayta
  // chaqirish shart emas, va xato xabarini har bir oddiy (universal, ?rest=
  // siz) tashrifda ko'rsatib qo'yishi kerak emas edi.

  const langSelect = document.getElementById("langSelect");
  if (langSelect) {
    langSelect.value = getLang();
    applyLang();

    langSelect.addEventListener("change", e => {
      setLang(e.target.value);
    });
  }

  onLangChange(() => {
    applyLang();
    hideError();
    resetBtn();
  });

  const togglePassword = document.getElementById("togglePassword");
  const passwordInput = document.getElementById("passwordInput");

  togglePassword.addEventListener("click", function () {
    const type = passwordInput.getAttribute("type") === "password" ? "text" : "password";
    passwordInput.setAttribute("type", type);

    this.classList.toggle("fa-eye");
    this.classList.toggle("fa-eye-slash");
  });
});

document.getElementById("loginBtn").addEventListener("click", handleLogin);

['loginInput', 'passwordInput'].forEach(id => {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLogin();
  });
});

async function handleLogin() {
  let loginVal = document.getElementById("loginInput").value.trim().toLowerCase();
  const passVal = document.getElementById("passwordInput").value.trim();
  const btn = document.getElementById("loginBtn");

  if (!loginVal || !passVal) {
    showError(t("error_fill_fields", "Barcha maydonlarni to'ldiring!"));
    return;
  }

  if (loginVal === "superadmin") {
    loginVal = "superadmin@nesta.uz";
  }

  btn.innerText = t("login_checking", "Tekshirilmoqda... ⏳");
  btn.disabled = true;
  hideError();

  try {
    if (loginVal.includes("@")) {
      try {
        await _setLoginPersistence();
        await signInWithEmailAndPassword(auth, loginVal, passVal);

        sessionStorage.setItem("role", "superadmin");
        window.location.href = "superadmin.html";
        return;
      } catch (err) {
        showError(t("error_invalid_credentials", "Login yoki parol noto'g'ri!"));
        resetBtn();
        return;
      }
    }

    // UNIVERSAL LOGIN: manager/admin login endi restoran skopiga bog'liq
    // emas — currentRestaurantId (agar ?rest= yoki localStorage orqali
    // aniqlangan bo'lsa) faqat ixtiyoriy, ISHONCH BILDIRILMAYDIGAN maslahat
    // sifatida yuboriladi (backend uni faqat qidiruvni toraytirish uchun
    // ishlatadi, autentifikatsiya qarori sifatida emas — routes/auth.js
    // ga qarang). Skop aniqlanmagan bo'lsa ham (currentRestaurantId=null)
    // login davom etadi — backend login+parolning o'zidan restoranni
    // aniqlaydi.
    await restaurantScopeReady;

    // Tekshiruv endi backend'da (routes/auth.js) — parol/hash brauzerga
    // hech qachon boshqa foydalanuvchi uchun qaytarilmaydi.
    let loginResult = await postManagerLogin(currentRestaurantId, loginVal, passVal);

    if (loginResult.status === 402) {
      window.location.href = `expired.html?rest=${encodeURIComponent(currentRestaurantId)}`;
      return;
    }
    if (loginResult.status === 403) {
      showError(t("error_profile_blocked", "Profilingiz bloklangan!"));
      resetBtn();
      return;
    }
    if (loginResult.status === 429) {
      // authLimiter (backend/routes/auth.js) — brute-force himoyasi. Bu
      // holatda "Login yoki parol noto'g'ri" umumiy xabari chalkash bo'lardi
      // (parol to'g'ri bo'lishi mumkin, faqat urinishlar soni cheklangan).
      showError(t("error_too_many_attempts", "Juda ko'p urinish. Bir necha daqiqadan keyin qayta urinib ko'ring."));
      resetBtn();
      return;
    }
    if (loginResult.status === 503 || loginResult.body?.error === "PG_UNAVAILABLE") {
      showError(t("error_temporarily_unavailable", "Tizim vaqtincha mavjud emas. Keyinroq urinib ko'ring."));
      resetBtn();
      return;
    }

    // ── Optional 2FA gate (Settings → Security, off by default) ──────────
    // requires2FA is only set when the matched account opted in — a
    // founder/manager who never set it up logs in exactly as before, zero
    // behavior change unless the account owner explicitly turned it on.
    if (loginResult.body?.requires2FA) {
      const code = window.prompt(t("prompt_2fa_code", "Ilovadagi 6 xonali kodni kiriting:"));
      if (!code) { resetBtn(); return; }
      loginResult = await postManagerLogin(currentRestaurantId, loginVal, passVal, code);
      if (loginResult.body?.requires2FA || !loginResult.body?.ok) {
        showError(t("error_invalid_2fa", "2FA kod noto'g'ri!"));
        resetBtn();
        return;
      }
    }

    if (!loginResult.ok || !loginResult.body?.ok) {
      showError(t("error_invalid_credentials", "Login yoki parol noto'g'ri!"));
      resetBtn();
      return;
    }

    const foundUser = loginResult.body.user;
    const foundRestaurantId = loginResult.body.restId;

    if (loginResult.body.token) {
      try {
        await _setLoginPersistence();
        await signInWithCustomToken(auth, loginResult.body.token);
      } catch (e) {
        console.error("Firebase Auth sign-in xatosi (davom etamiz, sessiya faqat ilova darajasida):", e);
      }
    }

    // restaurantId localStorage'da (tab'lar orasida umumiy), userId/role/
    // name/currentUser esa sessionStorage'da (har bir tab uchun alohida) —
    // batafsil izoh yuqorida, handleStaffPinLogin ichida.
    localStorage.setItem("restaurantId", foundRestaurantId);
    sessionStorage.setItem("userId", foundUser.id);
    sessionStorage.setItem("role", foundUser.role);
    sessionStorage.setItem("name", foundUser.name);
    sessionStorage.setItem("currentUser", JSON.stringify({ id: foundUser.id, role: foundUser.role, name: foundUser.name }));
    notifyEmployeeLogin(foundRestaurantId, foundUser.id);

    const routes = {
      admin: "admin.html",
      manager: "admin.html"
    };

    const targetPage = routes[foundUser.role] || "admin.html";

    window.location.href =
      `${targetPage}?rest=${encodeURIComponent(foundRestaurantId)}#dashboard`;

  } catch (error) {
    console.error(t("log_login_error", "Login xatoligi:"), error);
    showError(t("error_network", "Internet aloqasini tekshiring."));
    resetBtn();
  }
}

async function postManagerLogin(restId, login, password, code) {
  const resp = await fetch("/api/auth/manager-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restId, login, password, code }),
  });
  const body = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, body };
}

function showError(msg) {
  const errorBox = document.getElementById("errorMsg");
  errorBox.querySelector("span").innerText = msg;
  errorBox.style.display = "flex";
}

function hideError() {
  document.getElementById("errorMsg").style.display = "none";
}

function resetBtn() {
  const btn = document.getElementById("loginBtn");
  btn.innerText = t("login_btn", "Tizimga kirish");
  btn.disabled = false;
}

window.showGuide = function () {
  window.location.href = 'guid.html';
};

window.showSupport = function () {
  window.location.href = 'help.html';
};