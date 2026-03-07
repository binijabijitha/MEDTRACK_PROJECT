// ══════════════════════════════════════════════════════════════════
//  MedTrack — Reminder Engine  v6
//
//  FIXES IN THIS VERSION:
//  1. Real OS-level notifications via Service Worker (not just toasts)
//     - Waits for SW active state before calling showNotification
//     - Falls back to Notification API if SW unavailable
//  2. First-time permission wizard (per user+device, localStorage keyed)
//     - Sound autoplay unlock, OS notification, SW registration
//  3. All button/icon SVGs in white via CSS
//  4. WhatsApp deduplication via sessionStorage
// ══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
//  AUDIO
// ─────────────────────────────────────────────────────────────────
const $notify = document.getElementById('notifySound');
const $alarm  = document.getElementById('alarmSound');

function playNotify() {
  if (!$notify) return;
  $notify.currentTime = 0;
  $notify.play().catch(() => {});
}
function playAlarm() {
  if (!$alarm) return;
  $alarm.currentTime = 0;
  $alarm.play().catch(() => {});
}

// Unlock audio on first user interaction (required by browsers)
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  // Play both at zero volume then pause — this primes the audio context
  [$notify, $alarm].forEach(el => {
    if (!el) return;
    el.volume = 0.001;
    el.play().then(() => { el.pause(); el.currentTime = 0; el.volume = 1; }).catch(() => {});
  });
}
document.addEventListener('click',     unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });
document.addEventListener('keydown',   unlockAudio, { once: true });

// ─────────────────────────────────────────────────────────────────
//  SERVICE WORKER + OS NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────
let swReg = null;

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Wait for the SW to become active (crucial for showNotification to work)
    if (swReg.installing) {
      await new Promise(resolve => {
        swReg.installing.addEventListener('statechange', e => {
          if (e.target.state === 'activated') resolve();
        });
      });
    }
    // Also wait for controller to be set on this page
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      });
    }
  } catch(e) {
    console.warn('[MedTrack] SW registration failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────────
//  SHOW OS NOTIFICATION  (the core fix)
// ─────────────────────────────────────────────────────────────────
async function showOsNotification(title, body, urgent = false, tag = 'medtrack') {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const opts = {
    body,
    icon:               '/static/images/logo.jpg',
    badge:              '/static/images/logo.jpg',
    tag,
    vibrate:            urgent ? [300, 100, 300, 100, 400] : [200, 100, 200],
    requireInteraction: urgent,
    silent:             false,
    data:               { url: '/dashboard' }
  };

  try {
    // Primary: use Service Worker (works when page is backgrounded/closed)
    if (swReg) {
      // Make sure SW is active before calling showNotification
      const active = swReg.active;
      if (active && active.state === 'activated') {
        await swReg.showNotification(title, opts);
        return;
      }
      // SW exists but not yet activated — wait up to 2s
      const readySW = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('SW timeout')), 2000))
      ]).catch(() => null);
      if (readySW) {
        await readySW.showNotification(title, opts);
        return;
      }
    }
    // Fallback: direct Notification API (only works while page is open)
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); n.close(); };
  } catch(e) {
    console.warn('[MedTrack] OS notification failed:', e);
    // Last resort: toast only (already shown by caller)
  }
}

// ─────────────────────────────────────────────────────────────────
//  IN-PAGE TOAST
// ─────────────────────────────────────────────────────────────────
function showToast(title, msg, type = 'info', ms = 9000) {
  let wrap = document.getElementById('toast-container');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-container';
    document.body.appendChild(wrap);
  }
  const icons = { alarm: '🚨', warning: '⏰', info: '💊', success: '✅' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <div class="toast-icon">${icons[type] || '💊'}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${String(msg).replace(/\n/g, '<br>')}</div>
    </div>
    <button onclick="this.parentElement.remove()"
      style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;padding:0 0 0 8px;align-self:flex-start;flex-shrink:0;">✕</button>
  `;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut 0.3s forwards';
    setTimeout(() => t.remove(), 320);
  }, ms);
}

// Combined: always show toast AND try OS notification
function pushNotif(title, body, urgent = false, tag = 'medtrack') {
  showToast(title, body, urgent ? 'alarm' : 'warning');
  showOsNotification(title, body, urgent, tag); // async, non-blocking
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
const toMins  = t  => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMins = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const fmt12   = t  => {
  if (!t || !t.includes(':')) return t;
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const safeStr = v  => (v && v !== 'undefined' && v !== 'null') ? v : '—';

function notifBody(med) {
  return [
    `💊 ${safeStr(med.name)}`,
    `📦 Type: ${safeStr(med.type)}`,
    `📏 Dosage: ${safeStr(med.dosage)}`,
    `🔢 Amount: ${safeStr(med.amount)}`,
    `🕐 Time: ${fmt12(med.time)}`
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────
//  WHATSAPP
// ─────────────────────────────────────────────────────────────────
function sendWhatsApp(phone, userName, med) {
  const num = phone.replace(/\D/g, '');
  if (!num) return;
  const text =
    `🚨 *MedTrack — Missed Dose Alert* 🚨\n\n` +
    `Hello! This is an automated alert from MedTrack.\n\n` +
    `*${userName}* has NOT taken their scheduled medicine.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💊 *Medicine :* ${safeStr(med.name)}\n` +
    `📦 *Type     :* ${safeStr(med.type)}\n` +
    `📏 *Dosage   :* ${safeStr(med.dosage)}\n` +
    `🔢 *Amount   :* ${safeStr(med.amount)}\n` +
    `🕐 *Scheduled:* ${fmt12(med.time)}\n` +
    `📅 *Course   :* ${safeStr(med.start_date)}  →  ${safeStr(med.finish_date)}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ Please check on ${userName} and ensure they take their medicine.\n\n` +
    `— MedTrack Reminder System`;
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank');
}

// ─────────────────────────────────────────────────────────────────
//  DEDUPLICATION  (sessionStorage survives page reloads)
// ─────────────────────────────────────────────────────────────────
const warned    = new Set();
const alarmed   = new Set();
const processed = new Set();

function loadSets() {
  try {
    const w = sessionStorage.getItem('mt_warned');
    const a = sessionStorage.getItem('mt_alarmed');
    const p = sessionStorage.getItem('mt_processed');
    if (w) JSON.parse(w).forEach(k => warned.add(k));
    if (a) JSON.parse(a).forEach(k => alarmed.add(k));
    if (p) JSON.parse(p).forEach(k => processed.add(k));
  } catch(_) {}
}
function saveSets() {
  try {
    sessionStorage.setItem('mt_warned',    JSON.stringify([...warned]));
    sessionStorage.setItem('mt_alarmed',   JSON.stringify([...alarmed]));
    sessionStorage.setItem('mt_processed', JSON.stringify([...processed]));
  } catch(_) {}
}

// ─────────────────────────────────────────────────────────────────
//  MAIN REMINDER CHECK
// ─────────────────────────────────────────────────────────────────
async function checkReminders() {
  let response;
  try {
    const r = await fetch('/api/medicines');
    if (!r.ok) return;
    response = await r.json();
  } catch(_) { return; }

  const meds      = Array.isArray(response) ? response : (response.medicines || []);
  const caregiver = Array.isArray(response) ? {} : (response.caregiver || {});

  const now      = nowMins();
  const today    = new Date().toISOString().split('T')[0];
  const userName = (document.body.dataset.userName  || 'Patient').trim();
  const userPhone = (document.body.dataset.userPhone || '').trim();
  const cgPhone  = (caregiver.caregiver_phone || '').trim();
  const cgName   = (caregiver.caregiver_name  || 'Caregiver').trim();

  for (const med of meds) {
    if (!med.time) continue;
    const medMin = toMins(med.time);
    const key    = `${med.id}-${today}`;

    // 1. 10-min warning (notification_enabled gate)
    if (med.notification_enabled === 1 && now === medMin - 10 && !warned.has(key)) {
      warned.add(key); saveSets();
      playNotify();
      pushNotif(
        '⏰ Medicine in 10 minutes',
        `${notifBody(med)}\n\nGet it ready — due at ${fmt12(med.time)}!`,
        false, `warn-${med.id}`
      );
    }

    // 2. Exact-time alarm (always)
    if (now === medMin && !alarmed.has(key)) {
      alarmed.add(key); saveSets();
      playAlarm();
      pushNotif(
        '🚨 Time to take your medicine!',
        `${notifBody(med)}\n\nTake it RIGHT NOW!`,
        true, `alarm-${med.id}`
      );
    }

    // 3. 3-min overdue → missed dose (always, once only)
    if (now === medMin + 3 && med.taken === 0 && !processed.has(key)) {
      processed.add(key); saveSets();

      try { await fetch(`/mark_not_taken/${med.id}`, { method: 'POST' }); } catch(_) {}

      playAlarm();

      const alertMsg = `${notifBody(med)}\n\nNOT taken 3 mins after scheduled time.\n` +
        (cgPhone ? `WhatsApp alert sent to ${cgName}.` : 'No caregiver phone configured.');
      pushNotif('❌ Missed Dose Alert', alertMsg, true, `missed-${med.id}`);

      if (cgPhone) sendWhatsApp(cgPhone, userName, med);
      else if (userPhone) sendWhatsApp(userPhone, userName, med);

      setTimeout(() => {
        if (window.location.pathname === '/dashboard') location.reload();
      }, 2000);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  FIRST-TIME PERMISSION WIZARD
//
//  Key: mt_perms_{userId}_{deviceFingerprint}
//  Shows a beautiful fullscreen modal asking for:
//    - Notification permission (OS level)
//    - Sound permission (unlocked via click)
//    - Marks done so it never shows again on this device for this user
// ─────────────────────────────────────────────────────────────────
function getDeviceKey() {
  // Simple device fingerprint: userAgent + screen size
  const ua  = navigator.userAgent.replace(/\s+/g, '').slice(0, 40);
  const scr = `${screen.width}x${screen.height}`;
  return btoa(ua + scr).replace(/[^a-z0-9]/gi, '').slice(0, 20);
}

function getPermKey() {
  const userId = document.body.dataset.userId || 'guest';
  return `mt_perms_done_${userId}_${getDeviceKey()}`;
}

function isPermWizardDone() {
  try { return !!localStorage.getItem(getPermKey()); } catch(_) { return false; }
}

function markPermWizardDone() {
  try { localStorage.setItem(getPermKey(), '1'); } catch(_) {}
}

async function runPermWizard() {
  if (isPermWizardDone()) return;

  // Build the wizard modal
  const overlay = document.createElement('div');
  overlay.id = 'permWizard';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    background:rgba(8,12,18,0.97);
    display:flex;align-items:center;justify-content:center;
    padding:20px;
    animation:toastIn 0.35s ease;
  `;

  overlay.innerHTML = `
    <div style="
      background:var(--surface);
      border:1px solid var(--border2);
      border-radius:22px;
      padding:40px 36px;
      max-width:480px;width:100%;
      box-shadow:0 24px 80px rgba(0,0,0,0.7);
      text-align:center;
    ">
      <!-- Logo -->
      <img src="/static/images/logo.jpg" style="width:64px;height:64px;border-radius:14px;margin-bottom:20px;object-fit:cover;">

      <!-- Title -->
      <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:1.5rem;letter-spacing:-0.03em;margin-bottom:8px;">
        Allow MedTrack Permissions
      </div>
      <div style="color:var(--muted);font-size:0.88rem;margin-bottom:32px;line-height:1.6;">
        MedTrack needs these permissions to send you medicine reminders,<br>
        play alarm sounds, and notify your caregiver if a dose is missed.
      </div>

      <!-- Permission rows -->
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:32px;text-align:left;">

        <div class="perm-row" id="prow-notif">
          <div class="perm-icon">🔔</div>
          <div class="perm-info">
            <div class="perm-title">Notifications</div>
            <div class="perm-desc">OS-level alerts when medicines are due or missed</div>
          </div>
          <div class="perm-status" id="pstat-notif">⏳</div>
        </div>

        <div class="perm-row" id="prow-sound">
          <div class="perm-icon">🔊</div>
          <div class="perm-info">
            <div class="perm-title">Sound &amp; Alarm</div>
            <div class="perm-desc">Audible beeps &amp; alarm tones for reminders</div>
          </div>
          <div class="perm-status" id="pstat-sound">⏳</div>
        </div>

        <div class="perm-row" id="prow-sw">
          <div class="perm-icon">⚙️</div>
          <div class="perm-info">
            <div class="perm-title">Background Service</div>
            <div class="perm-desc">Keeps reminders active even when app is minimised</div>
          </div>
          <div class="perm-status" id="pstat-sw">⏳</div>
        </div>

        <div class="perm-row" id="prow-popup">
          <div class="perm-icon">↗️</div>
          <div class="perm-info">
            <div class="perm-title">WhatsApp Redirects</div>
            <div class="perm-desc">Opens WhatsApp to alert your caregiver on missed doses</div>
          </div>
          <div class="perm-status" id="pstat-popup">✅</div>
        </div>

      </div>

      <!-- Action button -->
      <button id="permWizardBtn"
        style="
          width:100%;padding:15px;
          background:linear-gradient(135deg,#60a5fa,#7c3aed);
          color:#fff;border:none;border-radius:12px;
          font-family:'Outfit',sans-serif;font-size:1rem;font-weight:700;
          cursor:pointer;transition:all 0.2s;
          box-shadow:0 6px 24px rgba(96,165,250,0.35);
        "
        onmouseover="this.style.transform='translateY(-2px)'"
        onmouseout="this.style.transform='translateY(0)'"
      >
        Allow All Permissions →
      </button>

      <div id="permWizardNote" style="margin-top:14px;font-size:0.78rem;color:var(--muted2);line-height:1.5;">
        You can change these later in your browser settings or from the topbar.
      </div>
    </div>

    <style>
      .perm-row {
        display:flex;align-items:center;gap:14px;
        padding:13px 16px;
        background:var(--surface2);border:1px solid var(--border);
        border-radius:12px;
      }
      .perm-icon { font-size:22px;flex-shrink:0; }
      .perm-info { flex:1; }
      .perm-title { font-weight:700;font-size:0.88rem;margin-bottom:2px; }
      .perm-desc  { font-size:0.76rem;color:var(--muted);line-height:1.4; }
      .perm-status { font-size:18px;flex-shrink:0;min-width:24px;text-align:center; }
    </style>
  `;

  document.body.appendChild(overlay);

  // Wire up the button
  document.getElementById('permWizardBtn').addEventListener('click', async () => {
    const btn  = document.getElementById('permWizardBtn');
    const note = document.getElementById('permWizardNote');
    btn.disabled = true;
    btn.textContent = 'Setting up…';

    // ── 1. Notification permission ──────────────────────────────
    const setStat = (id, icon, color='') => {
      const el = document.getElementById(id);
      if (el) { el.textContent = icon; if (color) el.style.color = color; }
    };

    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        setStat('pstat-notif', '✅');
        document.getElementById('prow-notif').style.borderColor = 'rgba(74,222,128,0.35)';
      } else {
        setStat('pstat-notif', '🚫', '#f87171');
        document.getElementById('prow-notif').style.borderColor = 'rgba(248,113,113,0.35)';
      }
    } else {
      setStat('pstat-notif', '—');
    }

    // ── 2. Sound (unlock by simulating click interaction) ───────
    unlockAudio();
    await new Promise(r => setTimeout(r, 300)); // brief settle
    setStat('pstat-sound', '✅');
    document.getElementById('prow-sound').style.borderColor = 'rgba(74,222,128,0.35)';

    // ── 3. Service Worker ───────────────────────────────────────
    if ('serviceWorker' in navigator) {
      try {
        await registerSW();
        setStat('pstat-sw', '✅');
        document.getElementById('prow-sw').style.borderColor = 'rgba(74,222,128,0.35)';
      } catch(e) {
        setStat('pstat-sw', '⚠️');
      }
    } else {
      setStat('pstat-sw', '—');
    }

    // ── 4. Show test notification ───────────────────────────────
    if (Notification.permission === 'granted') {
      setTimeout(() => {
        showOsNotification(
          '✅ MedTrack Ready',
          'You will now receive medicine reminders as OS alerts. Tap to open the app.',
          false, 'welcome'
        );
      }, 500);
    }

    // ── Done ────────────────────────────────────────────────────
    markPermWizardDone();
    btn.textContent = 'All Set! Closing…';
    btn.style.background = 'linear-gradient(135deg,#4ade80,#22c55e)';

    setTimeout(() => {
      overlay.style.animation = 'toastOut 0.4s forwards';
      setTimeout(() => overlay.remove(), 420);
    }, 1200);
  });
}

// ─────────────────────────────────────────────────────────────────
//  SIDEBAR
// ─────────────────────────────────────────────────────────────────
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const ham     = document.getElementById('hamburgerBtn');
  if (!sidebar) return;
  const open   = () => { sidebar.classList.add('open');    overlay.classList.add('open'); };
  const close  = () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); };
  const toggle = () => sidebar.classList.contains('open') ? close() : open();
  ham?.addEventListener('click', toggle);
  overlay?.addEventListener('click', close);
  sidebar.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', () => { if (window.innerWidth <= 900) close(); })
  );
}

// ─────────────────────────────────────────────────────────────────
//  TOPBAR "Enable Alerts" BUTTON  (shows if perms not granted)
// ─────────────────────────────────────────────────────────────────
async function requestPushPermission() {
  const perm = await Notification.requestPermission();
  const btn  = document.getElementById('notifPermBtn');
  if (perm === 'granted') {
    if (btn) btn.style.display = 'none';
    await registerSW();
    showOsNotification('MedTrack Alerts Enabled ✅', 'You will now receive OS medicine reminders.', false, 'welcome');
    showToast('Alerts Enabled', 'OS notifications are now active.', 'success');
  } else {
    if (btn) { btn.textContent = '🔕 Blocked'; btn.disabled = true; }
  }
}

function updateNotifButton() {
  const btn = document.getElementById('notifPermBtn');
  if (!btn) return;
  if (!('Notification' in window)) { btn.style.display = 'none'; return; }
  if (Notification.permission === 'granted') {
    btn.style.display = 'none';
  } else {
    btn.style.display = 'inline-flex';
  }
}

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadSets();
  initSidebar();
  updateNotifButton();

  // Show permission wizard for new users/devices FIRST
  await runPermWizard();

  // If wizard already done, still register SW silently
  if (isPermWizardDone()) {
    registerSW().catch(() => {});
  }

  // Start reminder engine
  checkReminders();
  setInterval(checkReminders, 30_000);
});
