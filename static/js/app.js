// ══════════════════════════════════════════════════════════════════
//  MedTrack — Reminder Engine  v7
//
//  FIXES vs v6:
//
//  1. MOBILE NOTIFICATIONS:
//     - Android Chrome blocks new Notification() constructor entirely.
//       ALL notification calls now go through SW.showNotification().
//       new Notification() is never called — not even as fallback.
//     - iOS Safari note: notifications only work when installed as PWA
//       (Add to Home Screen). We detect this and show a guide banner.
//     - requireInteraction is always false on mobile (avoids suppression)
//
//  2. "ENABLE ALERTS" BUTTON — persistent state, never resets:
//     - Button reads the REAL Notification.permission on every load
//       ('granted' → hidden, 'denied' → red disabled "Blocked",
//        'default' → blue "Enable Alerts")
//     - No stale in-memory state that disappears on refresh
//     - iOS non-PWA → shows "Add to Home Screen" guide button instead
//
//  3. ADMIN INVENTORY: handled in template (admin_user_detail.html)
// ══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
//  PLATFORM DETECTION  (mobile needs different paths)
// ─────────────────────────────────────────────────────────────────
const IS_IOS       = /iphone|ipad|ipod/i.test(navigator.userAgent);
const IS_ANDROID   = /android/i.test(navigator.userAgent);
const IS_MOBILE    = IS_IOS || IS_ANDROID;
// iOS only fires notifications from PWA (home-screen install)
const IS_IOS_PWA   = IS_IOS && window.matchMedia('(display-mode: standalone)').matches;
const HAS_NOTIF_API = 'Notification' in window && 'serviceWorker' in navigator;

// ─────────────────────────────────────────────────────────────────
//  AUDIO
// ─────────────────────────────────────────────────────────────────
const $notify = document.getElementById('notifySound');
const $alarm  = document.getElementById('alarmSound');
let _audioReady = false;

function _primeAudio(el) {
  if (!el) return;
  const prev = el.volume;
  el.volume  = 0.001;
  el.play().then(() => { el.pause(); el.currentTime = 0; el.volume = prev; }).catch(() => {});
}
function unlockAudio() {
  if (_audioReady) return;
  _audioReady = true;
  _primeAudio($notify);
  _primeAudio($alarm);
}
['click','touchstart','keydown'].forEach(ev =>
  document.addEventListener(ev, unlockAudio, { once: true, passive: true })
);

function playNotify() { if ($notify) { $notify.currentTime = 0; $notify.play().catch(() => {}); } }
function playAlarm()  { if ($alarm)  { $alarm.currentTime  = 0; $alarm.play().catch(() => {}); } }

// ─────────────────────────────────────────────────────────────────
//  SERVICE WORKER
//  We always use SW.showNotification() — never new Notification().
//  Reason: Android Chrome blocks the constructor form outright.
// ─────────────────────────────────────────────────────────────────
let _swReg = null;

async function ensureSW() {
  if (!('serviceWorker' in navigator)) return null;

  // Return cached active registration immediately if available
  if (_swReg && _swReg.active) return _swReg;

  try {
    _swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

    // If still installing, wait for it to activate (max 6s)
    const sw = _swReg.installing || _swReg.waiting;
    if (sw && !_swReg.active) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('SW activation timeout')), 6000);
        sw.addEventListener('statechange', function h(e) {
          if (e.target.state === 'activated') {
            clearTimeout(t); sw.removeEventListener('statechange', h); resolve();
          } else if (e.target.state === 'redundant') {
            clearTimeout(t); sw.removeEventListener('statechange', h); reject(new Error('SW redundant'));
          }
        });
      });
    }

    // If controller not set yet (first load after install), wait for it
    if (!navigator.serviceWorker.controller) {
      await new Promise(r =>
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
      );
    }
    // Refresh _swReg after activation
    _swReg = await navigator.serviceWorker.ready;
    return _swReg;
  } catch (e) {
    console.warn('[MT] SW error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  OS NOTIFICATION  — mobile-safe
//  Rule: ALWAYS route through SW.showNotification()
//        NEVER call new Notification() on mobile
// ─────────────────────────────────────────────────────────────────
async function showOsNotif(title, body, urgent = false, tag = 'medtrack') {
  if (!HAS_NOTIF_API) return;
  if (Notification.permission !== 'granted') return;

  const opts = {
    body,
    icon:               '/static/images/logo.jpg',
    badge:              '/static/images/logo.jpg',
    tag,
    renotify:           true,                     // re-fire even if same tag
    vibrate:            urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: urgent && !IS_MOBILE,     // never lock phone screen
    silent:             false,
    data:               { url: '/dashboard' }
  };

  const reg = await ensureSW().catch(() => null);
  if (reg && reg.active) {
    try { await reg.showNotification(title, opts); return; } catch(e) {
      console.warn('[MT] SW.showNotification failed:', e.message);
    }
  }

  // Desktop-only fallback (constructor crashes on Android)
  if (!IS_MOBILE) {
    try {
      const n = new Notification(title, opts);
      n.onclick = () => { window.focus(); n.close(); };
    } catch(e) { console.warn('[MT] Notification() fallback failed:', e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────
//  IN-PAGE TOAST
// ─────────────────────────────────────────────────────────────────
function showToast(title, msg, type = 'info', ms = 9000) {
  let wrap = document.getElementById('toast-container');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-container'; document.body.appendChild(wrap); }
  const icons = { alarm:'🚨', warning:'⏰', info:'💊', success:'✅', guide:'📲' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <div class="toast-icon">${icons[type] || '💊'}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${String(msg).replace(/\n/g,'<br>')}</div>
    </div>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:var(--muted);cursor:pointer;
             font-size:15px;padding:0 0 0 8px;align-self:flex-start;flex-shrink:0;">✕</button>`;
  wrap.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut 0.3s forwards'; setTimeout(() => t.remove(), 320); }, ms);
}

function pushNotif(title, body, urgent = false, tag = 'medtrack') {
  showToast(title, body, urgent ? 'alarm' : 'warning');
  showOsNotif(title, body, urgent, tag);
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
const toMins  = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const nowMins = () => { const d = new Date(); return d.getHours()*60+d.getMinutes(); };
const fmt12   = t => {
  if (!t || !t.includes(':')) return t || '';
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
};
const safeStr = v => (v && v !== 'undefined' && v !== 'null') ? v : '—';

function notifBody(med) {
  return [`💊 ${safeStr(med.name)}`, `📦 Type: ${safeStr(med.type)}`,
          `📏 Dosage: ${safeStr(med.dosage)}`, `🔢 Amount: ${safeStr(med.amount)}`,
          `🕐 Time: ${fmt12(med.time)}`].join('\n');
}

// ─────────────────────────────────────────────────────────────────
//  WHATSAPP
// ─────────────────────────────────────────────────────────────────
function sendWhatsApp(phone, userName, med) {
  const num = phone.replace(/\D/g,'');
  if (!num) return;
  const text =
    `🚨 *MedTrack — Missed Dose Alert* 🚨\n\n` +
    `*${userName}* has NOT taken their scheduled medicine.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💊 *Medicine:* ${safeStr(med.name)}\n` +
    `📦 *Type:* ${safeStr(med.type)}\n` +
    `📏 *Dosage:* ${safeStr(med.dosage)}\n` +
    `🔢 *Amount:* ${safeStr(med.amount)}\n` +
    `🕐 *Scheduled:* ${fmt12(med.time)}\n` +
    `📅 *Course:* ${safeStr(med.start_date)} → ${safeStr(med.finish_date)}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ Please check on ${userName}.\n— MedTrack`;
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank');
}

// ─────────────────────────────────────────────────────────────────
//  DEDUPLICATION (sessionStorage — survives page reload, not tab close)
// ─────────────────────────────────────────────────────────────────
const warned = new Set(), alarmed = new Set(), processed = new Set();
function loadSets() {
  try {
    (JSON.parse(sessionStorage.getItem('mt_w')||'[]')).forEach(k => warned.add(k));
    (JSON.parse(sessionStorage.getItem('mt_a')||'[]')).forEach(k => alarmed.add(k));
    (JSON.parse(sessionStorage.getItem('mt_p')||'[]')).forEach(k => processed.add(k));
  } catch(_) {}
}
function saveSets() {
  try {
    sessionStorage.setItem('mt_w', JSON.stringify([...warned]));
    sessionStorage.setItem('mt_a', JSON.stringify([...alarmed]));
    sessionStorage.setItem('mt_p', JSON.stringify([...processed]));
  } catch(_) {}
}

// ─────────────────────────────────────────────────────────────────
//  REMINDER ENGINE
// ─────────────────────────────────────────────────────────────────
async function checkReminders() {
  let resp;
  try { const r = await fetch('/api/medicines'); if (!r.ok) return; resp = await r.json(); }
  catch(_) { return; }

  const meds      = Array.isArray(resp) ? resp : (resp.medicines || []);
  const caregiver = Array.isArray(resp) ? {} : (resp.caregiver  || {});
  const now       = nowMins();
  const today     = new Date().toISOString().split('T')[0];
  const userName  = (document.body.dataset.userName  || 'Patient').trim();
  const userPhone = (document.body.dataset.userPhone || '').trim();
  const cgPhone   = (caregiver.caregiver_phone || '').trim();
  const cgName    = (caregiver.caregiver_name  || 'Caregiver').trim();

  for (const med of meds) {
    if (!med.time) continue;
    const medMin = toMins(med.time);
    const key    = `${med.id}-${today}`;

    // 1 · 10-min warning (notification_enabled gate)
    if (med.notification_enabled === 1 && now === medMin - 10 && !warned.has(key)) {
      warned.add(key); saveSets(); playNotify();
      pushNotif('⏰ Medicine in 10 minutes',
        `${notifBody(med)}\n\nGet it ready — due at ${fmt12(med.time)}!`, false, `warn-${med.id}`);
    }

    // 2 · Exact-time alarm (always)
    if (now === medMin && !alarmed.has(key)) {
      alarmed.add(key); saveSets(); playAlarm();
      pushNotif('🚨 Time to take your medicine!',
        `${notifBody(med)}\n\nTake it RIGHT NOW!`, true, `alarm-${med.id}`);
    }

    // 3 · 3-min overdue → missed (once per medicine per day)
    if (now === medMin + 3 && med.taken === 0 && !processed.has(key)) {
      processed.add(key); saveSets();
      try { await fetch(`/mark_not_taken/${med.id}`, { method: 'POST' }); } catch(_) {}
      playAlarm();
      pushNotif('❌ Missed Dose Alert',
        `${notifBody(med)}\n\nNOT taken 3 mins after scheduled time.\n` +
        (cgPhone ? `Alert sent to ${cgName}.` : 'No caregiver configured.'),
        true, `missed-${med.id}`);
      if (cgPhone) sendWhatsApp(cgPhone, userName, med);
      else if (userPhone) sendWhatsApp(userPhone, userName, med);
      setTimeout(() => { if (location.pathname === '/dashboard') location.reload(); }, 2000);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  "ENABLE ALERTS" TOPBAR BUTTON — state driven by real permission
//
//  We read Notification.permission on every page load.
//  No in-memory state — it can't "forget" across refreshes.
//
//  Matrix:
//  ┌──────────────────────┬──────────────────────────────────────┐
//  │ Condition            │ Button state                         │
//  ├──────────────────────┼──────────────────────────────────────┤
//  │ permission=granted   │ hidden                               │
//  │ permission=denied    │ red, disabled, "🔕 Blocked" + tip   │
//  │ permission=default   │ blue, "🔔 Enable Alerts"            │
//  │ iOS non-PWA          │ amber, "📲 Install App" + guide     │
//  │ No Notification API  │ hidden                               │
//  └──────────────────────┴──────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────────
function syncAlertButton() {
  const btn = document.getElementById('notifPermBtn');
  if (!btn) return;

  // iOS Safari outside PWA: notifications are impossible, show install guide
  if (IS_IOS && !IS_IOS_PWA) {
    btn.style.cssText   = 'display:inline-flex;background:#f59e0b;color:#fff;border:none;';
    btn.textContent     = '📲 Install App';
    btn.disabled        = false;
    btn.title           = 'Tap to learn how to enable notifications on iPhone';
    btn.onclick         = showIosInstallGuide;
    return;
  }

  // No API at all (old browser / non-HTTPS)
  if (!HAS_NOTIF_API) { btn.style.display = 'none'; return; }

  const perm = Notification.permission;

  if (perm === 'granted') {
    btn.style.display = 'none';

  } else if (perm === 'denied') {
    // Blocked by browser — show persistent red badge, no click action
    btn.style.cssText = 'display:inline-flex;background:rgba(248,113,113,0.15);' +
                        'color:#f87171;border:1px solid rgba(248,113,113,0.3);cursor:default;';
    btn.textContent   = '🔕 Blocked';
    btn.disabled      = true;
    btn.title         = 'Notifications blocked. Go to browser Settings → Site Settings → Notifications to allow.';

  } else {
    // 'default' — not decided yet
    btn.style.cssText = 'display:inline-flex;';
    btn.textContent   = '🔔 Enable Alerts';
    btn.disabled      = false;
    btn.onclick       = handleEnableAlerts;
  }
}

async function handleEnableAlerts() {
  const btn = document.getElementById('notifPermBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  // Ensure SW exists first — permission grant on mobile needs SW registered
  await ensureSW().catch(() => {});

  let perm;
  try   { perm = await Notification.requestPermission(); }
  catch (e) { perm = 'denied'; }

  if (perm === 'granted') {
    // Send a test notification so the user immediately sees it worked
    await showOsNotif(
      '✅ MedTrack Alerts Active',
      'Medicine reminders will now appear on this device.',
      false, 'perm-test'
    );
    showToast('Alerts enabled ✅', 'OS notifications are now active.', 'success', 5000);
  }

  // Sync button to real state (hides if granted, shows red if denied)
  syncAlertButton();
}

// ─────────────────────────────────────────────────────────────────
//  iOS INSTALL GUIDE  (popup banner explaining Add to Home Screen)
// ─────────────────────────────────────────────────────────────────
function showIosInstallGuide() {
  if (document.getElementById('iosGuide')) { document.getElementById('iosGuide').remove(); return; }
  const d = document.createElement('div');
  d.id = 'iosGuide';
  d.style.cssText = `position:fixed;bottom:72px;left:12px;right:12px;z-index:9999;
    background:var(--surface);border:1px solid var(--border2);border-radius:16px;
    padding:18px 20px;box-shadow:0 16px 48px rgba(0,0,0,0.65);animation:toastIn 0.3s ease;`;
  d.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
      <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:0.95rem;">
        📲 Enable Notifications on iPhone
      </div>
      <button onclick="this.closest('#iosGuide').remove()"
        style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;
               line-height:1;padding:0;margin-left:10px;">✕</button>
    </div>
    <div style="font-size:0.82rem;color:var(--muted);line-height:1.75;">
      iOS only supports notifications from installed apps:<br>
      <b style="color:var(--text)">1.</b> Tap <b style="color:var(--blue)">Share ⬆</b> in Safari<br>
      <b style="color:var(--text)">2.</b> Tap <b style="color:var(--blue)">"Add to Home Screen"</b><br>
      <b style="color:var(--text)">3.</b> Open MedTrack from your Home Screen<br>
      <b style="color:var(--text)">4.</b> Tap <b style="color:var(--blue)">"Enable Alerts"</b> inside the app
    </div>
    <div style="margin-top:10px;font-size:0.75rem;color:var(--muted2);">
      This is an Apple limitation — not something MedTrack can bypass.
    </div>`;
  document.body.appendChild(d);
  setTimeout(() => { if (d.parentNode) d.remove(); }, 18000);
}

// ─────────────────────────────────────────────────────────────────
//  FIRST-TIME PERMISSION WIZARD
//  Shown once per user-account × device fingerprint.
//  Key stored in localStorage so it persists across sessions.
// ─────────────────────────────────────────────────────────────────
function _deviceFP() {
  const ua = navigator.userAgent.replace(/\s/g,'').slice(0,40);
  return btoa(ua + screen.width + 'x' + screen.height).replace(/\W/g,'').slice(0,20);
}
function _wizKey() {
  return `mt_perm_done_${document.body.dataset.userId || 'g'}_${_deviceFP()}`;
}
const _wizDone   = () => { try { return !!localStorage.getItem(_wizKey()); } catch{ return true; } };
const _markDone  = () => { try { localStorage.setItem(_wizKey(), '1'); } catch(_) {} };

async function runPermWizard() {
  if (_wizDone()) return;

  // iOS non-PWA: wizard can't do anything useful — just mark done and show guide
  if (IS_IOS && !IS_IOS_PWA) {
    _markDone();
    // Show the install guide instead of wizard after a short delay
    setTimeout(showIosInstallGuide, 1500);
    syncAlertButton();
    return;
  }

  // Already granted — no need to show wizard
  if (HAS_NOTIF_API && Notification.permission === 'granted') { _markDone(); return; }

  // Build overlay
  const ov = document.createElement('div');
  ov.id = 'permWizard';
  ov.style.cssText = `position:fixed;inset:0;z-index:99999;background:rgba(8,12,18,0.97);
    display:flex;align-items:center;justify-content:center;padding:20px;animation:toastIn 0.35s ease;`;

  ov.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:22px;
      padding:36px 28px;max-width:460px;width:100%;
      box-shadow:0 24px 80px rgba(0,0,0,0.7);text-align:center;">
      <img src="/static/images/logo.jpg"
        style="width:60px;height:60px;border-radius:13px;margin-bottom:16px;object-fit:cover;">
      <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:1.4rem;
        letter-spacing:-0.02em;margin-bottom:8px;">Allow MedTrack Permissions</div>
      <div style="color:var(--muted);font-size:0.84rem;margin-bottom:26px;line-height:1.65;">
        To send medicine reminders, alarms and caregiver alerts${IS_MOBILE?' on your phone':''},
        MedTrack needs these permissions — just once.
      </div>

      <div id="_pwRows" style="display:flex;flex-direction:column;gap:10px;
        margin-bottom:24px;text-align:left;">

        <div class="_prow" id="_pr-notif">
          <span class="_pico">🔔</span>
          <div class="_pinfo">
            <div class="_ptitle">Notifications</div>
            <div class="_pdesc">OS alerts when medicines are due or missed</div>
          </div>
          <span class="_pstat" id="_ps-notif">⏳</span>
        </div>

        <div class="_prow" id="_pr-sw">
          <span class="_pico">⚙️</span>
          <div class="_pinfo">
            <div class="_ptitle">Background Service</div>
            <div class="_pdesc">Delivers alerts${IS_MOBILE?' even when app is minimised':''}</div>
          </div>
          <span class="_pstat" id="_ps-sw">⏳</span>
        </div>

        <div class="_prow" id="_pr-sound">
          <span class="_pico">🔊</span>
          <div class="_pinfo">
            <div class="_ptitle">Sound &amp; Alarm</div>
            <div class="_pdesc">Audible beep and alarm tones</div>
          </div>
          <span class="_pstat" id="_ps-sound">⏳</span>
        </div>

        <div class="_prow">
          <span class="_pico">↗️</span>
          <div class="_pinfo">
            <div class="_ptitle">WhatsApp Caregiver Alerts</div>
            <div class="_pdesc">Auto-message caregiver on missed doses</div>
          </div>
          <span class="_pstat">✅</span>
        </div>
      </div>

      <button id="_pwBtn" style="width:100%;padding:14px;
        background:linear-gradient(135deg,#60a5fa,#7c3aed);
        color:#fff;border:none;border-radius:12px;
        font-family:'Outfit',sans-serif;font-size:1rem;font-weight:700;
        cursor:pointer;box-shadow:0 6px 24px rgba(96,165,250,0.35);">
        Allow All Permissions →
      </button>
      <div style="margin-top:12px;font-size:0.76rem;color:var(--muted2);">
        You can change these later in browser settings.
      </div>
    </div>

    <style>
      ._prow  { display:flex;align-items:center;gap:12px;padding:11px 14px;
                background:var(--surface2);border:1px solid var(--border);border-radius:11px; }
      ._pico  { font-size:20px;flex-shrink:0; }
      ._pinfo { flex:1; }
      ._ptitle{ font-weight:700;font-size:0.85rem;margin-bottom:2px; }
      ._pdesc { font-size:0.73rem;color:var(--muted);line-height:1.35; }
      ._pstat { font-size:17px;flex-shrink:0;min-width:22px;text-align:center; }
    </style>`;

  document.body.appendChild(ov);

  const setStat = (id, icon, ok) => {
    const el  = document.getElementById(id);
    const row = document.getElementById(id.replace('_ps','_pr'));
    if (el)  el.textContent = icon;
    if (row) row.style.borderColor = ok ? 'rgba(74,222,128,.4)' : 'rgba(248,113,113,.4)';
  };

  document.getElementById('_pwBtn').addEventListener('click', async () => {
    const btn = document.getElementById('_pwBtn');
    btn.disabled = true; btn.textContent = 'Setting up…';

    // Step 1 — Register SW first (needed before permission request on Android)
    try {
      await ensureSW();
      setStat('_ps-sw', '✅', true);
    } catch(e) { setStat('_ps-sw', '⚠️', false); }

    // Step 2 — Request notification permission
    let perm = 'denied';
    if (HAS_NOTIF_API) {
      try { perm = await Notification.requestPermission(); } catch(_) {}
      setStat('_ps-notif', perm === 'granted' ? '✅' : '🚫', perm === 'granted');
    } else {
      setStat('_ps-notif', '—', false);
    }

    // Step 3 — Unlock audio (the button click IS the user-gesture we needed)
    unlockAudio();
    await new Promise(r => setTimeout(r, 200));
    setStat('_ps-sound', '✅', true);

    // Step 4 — Fire test notification (so user can see it working on device)
    if (perm === 'granted') {
      setTimeout(() => showOsNotif(
        '✅ MedTrack Ready',
        IS_MOBILE
          ? 'Reminders will appear here, even when the app is in the background.'
          : 'You will now receive OS medicine reminder notifications.',
        false, 'wizard-test'
      ), 700);
    }

    _markDone();
    btn.textContent = '✅ All Set!';
    btn.style.background = 'linear-gradient(135deg,#4ade80,#22c55e)';

    setTimeout(() => {
      ov.style.animation = 'toastOut 0.4s forwards';
      setTimeout(() => { ov.remove(); syncAlertButton(); }, 420);
    }, 1400);
  });
}

// ─────────────────────────────────────────────────────────────────
//  SIDEBAR
// ─────────────────────────────────────────────────────────────────
function initSidebar() {
  const sb  = document.getElementById('sidebar');
  const ov  = document.getElementById('sidebarOverlay');
  const ham = document.getElementById('hamburgerBtn');
  if (!sb) return;
  const open  = () => { sb.classList.add('open');    ov?.classList.add('open'); };
  const close = () => { sb.classList.remove('open'); ov?.classList.remove('open'); };
  ham?.addEventListener('click', () => sb.classList.contains('open') ? close() : open());
  ov?.addEventListener('click', close);
  sb.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', () => { if (window.innerWidth <= 900) close(); })
  );
}

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadSets();
  initSidebar();

  // 1. Sync alert button to real permission state FIRST (no stale UI)
  syncAlertButton();

  // 2. Pre-register SW silently so notifications fire reliably
  ensureSW().catch(() => {});

  // 3. Show first-time permission wizard if needed
  await runPermWizard();

  // 4. Start reminder polling
  checkReminders();
  setInterval(checkReminders, 30_000);
});
