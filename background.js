// Google Play Points Weekly Prize Auto Claim (Chrome extension, Manifest V3)
//
// How it works: in a background tab, open https://play.google.com/store/points/perks?authuser=N
//   (N = 0, 1, 2 ... = the Nth Google account signed in to Chrome), find the "Claim" button in the
//   "Weekly prize" card: disabled = already claimed this week; enabled = click it, reload, and confirm it became disabled.
// Schedule: wakes up every 30 minutes. From Friday 00:05 through the next Thursday (the whole week), it only
//   really runs when at least 2 hours have passed since the last run AND some account is still not handled.
//   It also runs when Chrome starts if some account is still pending. No retry limit.
// Accounts that can never get a prize (no weekly prize / not a Play Points member) are not failures:
//   their page is not opened again this week, the result carries over to next week, and they are re-checked
//   automatically only every RECHECK_DAYS days. "Check & claim now" in the popup re-checks everything.
// Status file: every time the status changes, "is this week done?" is written to google_play_weekly.json
//   (location: status_config.json, relative to Chrome's download folder) so the optional startup launcher
//   (boot-launcher\open_chrome.ps1) can decide whether to open Chrome at Windows sign-in.

const PERKS_URL = 'https://play.google.com/store/points/perks?hl=en&authuser=';
const MAX_ACCOUNTS = 20;          // check up to authuser=19 (past the last signed-in account Google keeps returning the last one; `seen` stops the loop)
const MAX_TRIES = Infinity;       // keep retrying all week
const RUN_GAP_MIN = 110;          // minimum minutes between automatic runs
const LOCK_MS = 10 * 60 * 1000;   // a run takes at most a few minutes; lock to avoid overlapping runs
const LOG_LIMIT = 40;
// Statuses that count as "handled this week" (no more retries).
// no_prize   = the Perks tab says "Your unlocked perks will show up here as you level up" (no weekly prize)
// not_member = not a Play Points member yet (only "Join for free" is shown)
const DONE = ['claimed', 'already', 'app_only', 'no_prize', 'not_member'];
const OK = ['claimed', 'already', 'no_prize', 'not_member'];   // statuses that are not a problem (badge / notifications)
// "This account can never get a prize": not a claim failure. Carried over to the next week without opening its page;
// re-checked automatically every RECHECK_DAYS days (in case the account joins Play Points or earns points later).
const NEVER = ['no_prize', 'not_member'];
const RECHECK_DAYS = 28;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d = new Date()) =>
  d.toLocaleDateString('sv-SE') + ' ' + d.toTimeString().slice(0, 5);

// The most recent Friday (including today) as YYYY-MM-DD = "this week"
function weekKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() - 5 + 7) % 7));
  return d.toLocaleDateString('sv-SE');
}

// Auto-claim window: Friday 00:05 through Thursday 23:59 (the whole week). Only skips the first minutes after the week changes.
function inWindow(now = new Date()) {
  return !(now.getDay() === 5 && now.getHours() === 0 && now.getMinutes() < 5);
}

const STATUS_NAME = 'google_play_weekly.json';
const DEFAULT_STATUS_DIR = 'ChromeExtensionStatus';

// Where to save the status file: "statusDir" in status_config.json in the extension folder
// (relative to Chrome's download folder, e.g. "ChromeExtensionStatus")
async function statusPath() {
  try {
    const j = await (await fetch(chrome.runtime.getURL('status_config.json'))).json();
    const d = String(j.statusDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (d && !d.split('/').includes('..') && !/^[a-z]:/i.test(d)) return d + '/' + STATUS_NAME;
  } catch (_) {}
  return DEFAULT_STATUS_DIR + '/' + STATUS_NAME;
}

function setupAlarm() {
  chrome.alarms.create('gp-tick', { delayInMinutes: 1, periodInMinutes: 30 });
}

chrome.runtime.onInstalled.addListener(async () => {
  await recheckDoubtfulAlready();
  setupAlarm();
  await refreshBadge();
  await writeStatus(true);
  maybeRun(false, 'startup');
});

// Same rule as inside the injected function: does the text contain a date AFTER today (Nov 20, 20 Nov, 11月20日)?
function hasFutureDate(info) {
  info = info || '';
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
  let mo = 0, da = 0, m;
  if ((m = info.match(new RegExp('\\b' + MON + '\\s+(\\d{1,2})\\b', 'i')))) { mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; da = +m[2]; }
  else if ((m = info.match(new RegExp('\\b(\\d{1,2})\\s+' + MON, 'i')))) { mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; da = +m[1]; }
  else if ((m = info.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) { mo = +m[1]; da = +m[2]; }
  if (!mo || !da) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let rel = new Date(now.getFullYear(), mo - 1, da);
  if (rel - today > 180 * 864e5) rel = new Date(now.getFullYear() - 1, mo - 1, da);
  if (rel - today < -180 * 864e5) rel = new Date(now.getFullYear() + 1, mo - 1, da);
  return rel > today;
}

// On update to v1.2.1: accounts marked "already claimed" this week without a future date may have been misjudged
// by v1.2.0 -> mark them "new" so they are checked again
async function recheckDoubtfulAlready() {
  const s = await loadState();
  let changed = 0;
  for (const a of Object.values(s.accounts)) {
    if (a.status === 'already' && !hasFutureDate(a.info)) { a.status = 'new'; changed++; }
  }
  if (changed) {
    await chrome.storage.local.set({ accounts: s.accounts, lastRun: 0 });
    await addLog('—', 'new', `re-checking ${changed} account(s) that may have been wrongly marked "already claimed"`);
  }
}

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  refreshBadge();
  writeStatus(false);
  maybeRun(false, 'startup');
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'gp-tick') maybeRun(false, 'alarm');
});

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.cmd === 'run') {
    maybeRun(true, 'manual').then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function loadState() {
  const s = await chrome.storage.local.get(['week', 'accounts', 'log', 'lastRun', 'runningSince', 'onlyEmails']);
  const wk = weekKey();
  if (s.week !== wk) {
    // New week: keep the whole account list. Normal accounts become "new" (not checked this week yet);
    // accounts that can never get a prize keep their status (no need to open their page every week)
    // until RECHECK_DAYS have passed, then they become "new" and are checked once again.
    const carry = {};
    for (const [e, a] of Object.entries(s.accounts || {})) {
      const since = a.neverSince || s.week || wk;
      if (NEVER.includes(a.status) && (new Date(wk) - new Date(since)) / 864e5 < RECHECK_DAYS) {
        carry[e] = { status: a.status, info: a.info, time: a.time, authuser: a.authuser, tries: 0, neverSince: since };
      } else {
        carry[e] = { status: 'new', info: '', time: '', authuser: a.authuser, tries: 0 };
      }
    }
    s.week = wk;
    s.accounts = carry;
    await chrome.storage.local.set({ week: wk, accounts: carry });
  }
  s.accounts = s.accounts || {};
  s.log = s.log || [];
  return s;
}

function pendingEmails(s) {
  const list = Object.entries(s.accounts);
  if (list.length === 0) return ['(accounts not detected yet)'];
  return list
    .filter(([e, a]) => !DONE.includes(a.status) && (a.tries || 0) < MAX_TRIES && allowed(s, e))
    .map(([e]) => e);
}

function allowed(s, email) {
  const only = (s.onlyEmails || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return only.length === 0 || only.includes(email.toLowerCase());
}

async function maybeRun(force, reason) {
  const s = await loadState();
  if (s.runningSince && Date.now() - s.runningSince < LOCK_MS) return;
  if (!force) {
    if (pendingEmails(s).length === 0) return;
    if (reason !== 'startup' && !inWindow()) return;
    if (s.lastRun && Date.now() - s.lastRun < RUN_GAP_MIN * 60000) return;
  }
  await chrome.storage.local.set({ runningSince: Date.now(), lastRun: Date.now() });
  try {
    await run(force);
  } catch (e) {
    await addLog('—', 'error', String(e && e.message ? e.message : e));
  } finally {
    await chrome.storage.local.set({ runningSince: 0 });
    await refreshBadge();
    await writeStatus(false);
  }
}

async function run(force) {
  let tabId = null;
  let ownWindowId = null;
  const results = [];
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length === 0) {
      const w = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
      ownWindowId = w.id;
      tabId = w.tabs[0].id;
    } else {
      tabId = (await chrome.tabs.create({ url: 'about:blank', active: false })).id;
    }

    // Accounts already handled this week (including ones that can never get a prize) are skipped
    // without opening their page, using the authuser number remembered from the last run
    const skipAuth = new Map();
    if (!force) {
      const s0 = await loadState();
      for (const [e, a] of Object.entries(s0.accounts)) {
        if (DONE.includes(a.status) && Number.isInteger(a.authuser)) skipAuth.set(a.authuser, e);
      }
    }
    const seen = new Set();
    for (let n = 0; n < MAX_ACCOUNTS; n++) {
      if (skipAuth.has(n)) { seen.add(skipAuth.get(n)); continue; }
      const r = await inspect(tabId, n, false);
      if (r.status === 'login' || !r.email) {
        if (n === 0) await addLog('—', r.status === 'login' ? 'login' : r.status, r.info || '');
        break; // no more signed-in accounts
      }
      if (seen.has(r.email)) break; // past the last signed-in account
      seen.add(r.email);

      const s = await loadState();
      if (!allowed(s, r.email)) continue;
      const a = s.accounts[r.email] || { tries: 0 };
      if (!force && DONE.includes(a.status)) continue;
      if (!force && (a.tries || 0) >= MAX_TRIES) continue;

      let final = r;
      if (r.status === 'claimable') {
        const c = await inspect(tabId, n, true);
        if (c.status === 'clicked') {
          const v = await inspect(tabId, n, false); // reload and confirm the button turned grey
          final = (v.status === 'already' || v.status === 'not_open')   // button disabled after clicking = claimed
            ? { ...v, status: 'claimed', info: c.result || v.info }
            : { ...v, status: 'unverified', info: (c.result ? c.result + '; ' : '') + 'button was still enabled after reloading' };
        } else {
          final = c;
        }
      }
      a.tries = (a.tries || 0) + 1;
      a.status = final.status;
      a.info = final.info || '';
      a.time = fmt();
      a.authuser = n;
      if (NEVER.includes(a.status)) a.neverSince = a.neverSince || s.week;
      else delete a.neverSince;
      s.accounts[r.email] = a;
      await chrome.storage.local.set({ accounts: s.accounts });
      await addLog(r.email, final.status, final.info || '');
      results.push([r.email, final.status]);
    }
  } finally {
    if (ownWindowId !== null) {
      try { await chrome.windows.remove(ownWindowId); } catch (_) {}
    } else if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
  notifyIfNeeded(results);
}

async function inspect(tabId, n, doClaim) {
  if (!doClaim) {
    await chrome.tabs.update(tabId, { url: PERKS_URL + n });
    if (!(await waitComplete(tabId, 30000))) return { status: 'timeout', info: 'page did not finish loading in 30 seconds' };
  }
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: perksPage, args: [doClaim] });
  return (res && res.result) || { status: 'error', info: 'no result returned' };
}

// ↓ This function is injected into the Play Points page. It must be self-contained (no outside variables).
// Text patterns are English first (the page is opened with hl=en), with Traditional Chinese as a fallback.
async function perksPage(doClaim) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const APP_ONLY = /can't (use|redeem) this|on an Android device|Android device|無法在這裡使用|Android 裝置上透過 Play 商店/i;
  const NO_PRIZE = /unlocked perks will show up here|perks .*will (show|appear) here as you level up|升級後解鎖的獎勵會顯示在這裡/i;
  const isNotMember = () => [...document.querySelectorAll('button,a,[role="button"]')]
    .some((b) => /^(Join for free|Join now|免費加入|立即加入)$/i.test(clean(b.textContent)));

  const emailOf = () => {
    for (const el of document.querySelectorAll('[aria-label]')) {
      const l = el.getAttribute('aria-label') || '';
      if (/Google Account|Google 帳戶/i.test(l)) {
        const m = l.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
        if (m) return m[0];
      }
    }
    return '';
  };
  const findWeekly = () => {
    const h = [...document.querySelectorAll('h1,h2,h3,h4,div,span')].find(
      (e) => e.childElementCount === 0 && /^(Weekly prize|每週獎勵)/i.test(clean(e.textContent)));
    if (!h) return null;
    let c = h.parentElement;
    for (let i = 0; i < 8 && c; i++) {
      const b = [...c.querySelectorAll('button')].find((x) => /Claim|Collect|領取/i.test(x.textContent));
      if (b) return { card: c, btn: b };
      c = c.parentElement;
    }
    return { card: null, btn: null };
  };
  const isDisabled = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true' || b.hasAttribute('inert');

  if (/accounts\.google\.com/.test(location.href)) return { status: 'login', info: 'Chrome is not signed in to Google' };
  // Accounts that are not Play Points members are redirected from perks to /store/points/enroll
  if (/\/points\/enroll/.test(location.pathname)) {
    await sleep(500);
    return { status: 'not_member', email: emailOf(), info: 'this account has not joined Play Points' };
  }

  let w = null;
  let other = '';   // 'no_prize' / 'not_member' / 'app_only': definitely no weekly prize, no need to wait the full 15 seconds
  for (let i = 0; i < 30; i++) {
    w = findWeekly();
    if (w && w.btn) break;
    const txt = document.body.innerText;
    if (APP_ONLY.test(txt)) { other = 'app_only'; break; }
    if (NO_PRIZE.test(txt) || isNotMember()) {
      await sleep(1000);              // wait one more second in case the weekly prize card shows up late
      w = findWeekly();
      if (w && w.btn) break;
      other = isNotMember() ? 'not_member' : 'no_prize';
      break;
    }
    await sleep(500);
  }
  const email = emailOf();
  const cardText = (x) => clean(x && x.card ? x.card.innerText : '')
    .replace(/^(Weekly prize|每週獎勵)\s*/i, '').replace(/lock\s*/g, '').slice(0, 80);

  if (!w || !w.btn) {
    if (other === 'not_member') return { status: 'not_member', email, info: 'this account has not joined Play Points' };
    if (other === 'no_prize') return { status: 'no_prize', email, info: 'Perks tab says "Your unlocked perks will show up here as you level up"' };
    if (other === 'app_only' || APP_ONLY.test(document.body.innerText)) return { status: 'app_only', email, info: 'the website asks you to claim in the Play Store app on Android' };
    return { status: 'notfound', email, info: 'weekly prize card not found (the page may have changed)' };
  }
  const info = cardText(w);
  if (isDisabled(w.btn)) {
    // A grey button means either "next prize not available yet" or "already claimed this week" - both look the same
    // and show "Available on Nov 20". Only a date AFTER today means this week's prize was claimed (waiting for the
    // next one). A date today or earlier, or no readable date at all (e.g. "Available today" or a time on release
    // day) -> treated as not available yet, try again in 2 hours. (v1.2.0 treated "no date" as already claimed.)
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
    let mo = 0, da = 0, m;
    if ((m = info.match(new RegExp('\\b' + MON + '\\s+(\\d{1,2})\\b', 'i')))) { mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; da = +m[2]; }
    else if ((m = info.match(new RegExp('\\b(\\d{1,2})\\s+' + MON, 'i')))) { mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; da = +m[1]; }
    else if ((m = info.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) { mo = +m[1]; da = +m[2]; }
    if (mo && da) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let rel = new Date(now.getFullYear(), mo - 1, da);
      if (rel - today > 180 * 864e5) rel = new Date(now.getFullYear() - 1, mo - 1, da);
      if (rel - today < -180 * 864e5) rel = new Date(now.getFullYear() + 1, mo - 1, da);
      if (rel > today) return { status: 'already', email, info };
    }
    return { status: 'not_open', email, info: info + (mo ? '' : ' (no date for the next prize, treated as not available yet)') };
  }
  if (!doClaim) return { status: 'claimable', email, info };

  w.btn.click();
  await sleep(4000);
  let result = '';
  for (let k = 0; k < 3; k++) {
    const dlg = document.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
    const txt = clean(dlg ? dlg.innerText : document.body.innerText);
    if (APP_ONLY.test(txt)) return { status: 'app_only', email, info: 'the website asks you to claim in the Play Store app on Android' };
    if (!dlg) break;
    result = txt.slice(0, 120);
    // If there is a choice, pick Play Points; then press a Claim / OK style button
    const pick = [...dlg.querySelectorAll('button,[role="button"],[role="radio"]')].find((x) => /Play Points|Play 點數/.test(x.textContent));
    if (pick && k === 0) { pick.click(); await sleep(1500); }
    const b = [...dlg.querySelectorAll('button')].find((x) => !isDisabled(x) && /Claim|OK|Done|Got it|Close|領取|確定|完成|知道了|關閉/i.test(x.textContent));
    if (!b) break;
    b.click();
    await sleep(3000);
  }
  return { status: 'clicked', email, info, result };
}

function waitComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function addLog(email, status, text) {
  const s = await chrome.storage.local.get(['log']);
  const log = s.log || [];
  log.unshift({ time: fmt(), email, status, text });
  await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
}

function notifyIfNeeded(results) {
  const claimed = results.filter(([, st]) => st === 'claimed').map(([e]) => e);
  const bad = results.filter(([, st]) => !OK.includes(st));
  if (claimed.length === 0 && bad.length === 0) return;
  const lines = [];
  if (claimed.length) lines.push(`Claimed: ${claimed.join(', ')}`);
  if (bad.length) lines.push(`Needs a look: ${bad.map(([e, st]) => `${e} (${STATUS_TEXT[st] || st})`).join(', ')}`);
  chrome.notifications.create('gp-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Google Play Weekly Prize',
    message: lines.join('\n')
  });
}

const STATUS_TEXT = {
  new: 'not checked this week', claimed: 'claimed', already: 'already claimed this week', claimable: 'can be claimed',
  unverified: 'clicked Claim but could not confirm', no_prize: 'no weekly prize for this account',
  not_member: 'not a Play Points member', not_open: 'weekly prize not available yet',
  app_only: 'website cannot claim, use the app', notfound: 'weekly prize not found', login: 'not signed in to Google',
  timeout: 'page load timed out', error: 'error'
};

async function refreshBadge() {
  const s = await loadState();
  const list = Object.entries(s.accounts).filter(([e]) => allowed(s, e));
  const bad = list.filter(([, a]) => !OK.includes(a.status));
  if (list.length && bad.length === 0) {
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  } else if (bad.length) {
    await chrome.action.setBadgeText({ text: String(bad.length) });
    await chrome.action.setBadgeBackgroundColor({ color: inWindow() ? '#c62828' : '#757575' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ---------- Status file (for the optional startup launcher) ----------
// Saved with chrome.downloads. The download bar is turned off while saving and the entry is erased from
// the download history afterwards, so no download prompt is shown (the file itself stays). Not rewritten if unchanged.
async function writeStatus(force) {
  try {
    const s = await loadState();
    const list = Object.entries(s.accounts).filter(([e]) => allowed(s, e));
    const pending = list.filter(([, a]) => !DONE.includes(a.status)).map(([e]) => e);
    const mask = (e) => e.replace(/^(.{2}).*?(.{0,2})@.*$/, '$1***$2');   // keep only the first/last 2 characters, never the full email
    const obj = {
      week: s.week, allDone: list.length > 0 && pending.length === 0, accounts: list.length, pending: pending.length,
      detail: list.map(([e, a]) => ({ account: mask(e), status: a.status, info: a.info || '', time: a.time || '' }))
    };
    const path = await statusPath();
    const key = path + JSON.stringify(obj);
    const prev = (await chrome.storage.local.get(['statusWritten'])).statusWritten;
    if (!force && prev === key) return;
    obj.updated = fmt();
    if (await saveJsonFile(path, obj)) await chrome.storage.local.set({ statusWritten: key });
  } catch (e) {
    console.warn('failed to write status file', e);
  }
}

async function saveJsonFile(path, obj) {
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2));
  let id = null;
  try {
    try { await chrome.downloads.setUiOptions({ enabled: false }); } catch (_) {}
    id = await chrome.downloads.download({ url, filename: path, conflictAction: 'overwrite', saveAs: false });
    return await waitDownload(id, 15000);
  } catch (e) {
    console.warn('failed to save file', e);
    return false;
  } finally {
    if (id !== null) { try { await chrome.downloads.erase({ id }); } catch (_) {} }
    try { await chrome.downloads.setUiOptions({ enabled: true }); } catch (_) {}
  }
}

function waitDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function listener(d) {
      if (d.id === id && d.state) {
        if (d.state.current === 'complete') finish(true);
        if (d.state.current === 'interrupted') finish(false);
      }
    }
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([it]) => {   // it may already be saved before the listener was attached
      if (it && it.state === 'complete') finish(true);
      if (it && it.state === 'interrupted') finish(false);
    });
  });
}
