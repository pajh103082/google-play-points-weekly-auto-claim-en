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
  if ((m = info.match(new RegExp('\\b' + MON + '\\s*(\\d{1,2})(?!\\d)', 'i')))) { mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; da = +m[2]; }
  else if ((m = info.match(new RegExp('(?<!\\d)(\\d{1,2})\\s+' + MON, 'i')))) { mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; da = +m[1]; }
  else if ((m = info.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) { mo = +m[1]; da = +m[2]; }
  if (!mo || !da) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let rel = new Date(now.getFullYear(), mo - 1, da);
  if (rel - today > 180 * 864e5) rel = new Date(now.getFullYear() - 1, mo - 1, da);
  if (rel - today < -180 * 864e5) rel = new Date(now.getFullYear() + 1, mo - 1, da);
  return rel > today;
}

// On install / update: every account marked "already claimed" this week is set back to "new" and checked once more
// (v1.2.0 treated "no date" as claimed; before v1.2.3 the claimable card was misread as grey). Re-checking is cheap:
// accounts that really were claimed are still "already claimed" afterwards.
async function recheckDoubtfulAlready() {
  const s = await loadState();
  let changed = 0;
  for (const a of Object.values(s.accounts)) {
    if (a.status === 'already') { a.status = 'new'; changed++; }
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
  // v1.2.3 (real page, 2026-11-21): the "Claim" <button> inside both prize cards has inert + aria-hidden (decoration only);
  // the only difference is `disabled`: this week's prize = disabled=false, next prize = disabled=true.
  // The element you actually click is the whole card, a <div role="button">. So inert must NOT count as disabled.
  const isDisabled = (b) => !!(b.disabled || b.getAttribute('aria-disabled') === 'true');
  const clickTarget = (b) => b.closest('[role="button"]') || b;   // the claimable card's wrapper is role=button
  // Every clickable element in the section whose text is exactly "Claim" (button / link / role=button); innermost only
  const claimCtrls = (root) => {
    const all = [...root.querySelectorAll('button,a,[role="button"]')]
      .filter((x) => /^(Claim|Collect|Claim prize|領取|立即領取)$/i.test(clean(x.textContent)));
    return all.filter((x) => !all.some((y) => y !== x && x.contains(y)));
  };
  // v1.2.2: the "Weekly prize" section can hold several cards: this week's prize ("Expires Nov 27", claimable)
  // and the next prize ("Available on Nov 27", grey). Each Claim control is mapped to its own card; a claimable one wins.
  const findWeekly = () => {
    const h = [...document.querySelectorAll('h1,h2,h3,h4,div,span')].find(
      (e) => e.childElementCount === 0 && /^(Weekly prize|每週獎勵)/i.test(clean(e.textContent)));
    if (!h) return null;
    let sec = h.parentElement;
    for (let i = 0; i < 8 && sec && claimCtrls(sec).length === 0; i++) sec = sec.parentElement;
    if (!sec || claimCtrls(sec).length === 0) return { card: null, btn: null, cards: [] };
    // sec = the first ancestor of the heading that contains a Claim control = heading + its row of cards.
    // Not widened further, so Claim buttons of other perks (e.g. game items) are never included.
    const cards = claimCtrls(sec).map((b) => {
      let k = b;   // climb until going higher would include another Claim control = this control's own card
      while (k.parentElement && k.parentElement !== sec && claimCtrls(k.parentElement).length === 1) k = k.parentElement;
      return { btn: b, card: k, open: !isDisabled(b) };
    });
    const pick = cards.find((x) => x.open) || cards[0];
    return { card: pick.card, btn: pick.btn, cards };
  };

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
    .replace(/^(Weekly prize|每週獎勵)\s*/i, '').replace(/\b(lock|hourglass)\s*/g, '').slice(0, 80);
  const allCards = (x) => (x && x.cards ? x.cards : []).map((c) => (c.open ? '[open] ' : '[grey] ') + cardText({ card: c.card })).join(' | ').slice(0, 200);

  if (!w || !w.btn) {
    if (other === 'not_member') return { status: 'not_member', email, info: 'this account has not joined Play Points' };
    if (other === 'no_prize') return { status: 'no_prize', email, info: 'Perks tab says "Your unlocked perks will show up here as you level up"' };
    if (other === 'app_only' || APP_ONLY.test(document.body.innerText)) return { status: 'app_only', email, info: 'the website asks you to claim in the Play Store app on Android' };
    return { status: 'notfound', email, info: 'weekly prize card not found (the page may have changed)' };
  }
  const info = cardText(w);
  if (isDisabled(w.btn)) {   // getting here means every Claim control in the section is grey
    // Use only the "Available on" date, never the "Expires" date of this week's card
    const dateText = clean(w.cards.map((c) => cardText({ card: c.card })).join(' '))
      .replace(/(Expires?( on)?|到期日|到期)[：:\s]*([A-Za-z]{3,9}\.?\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}|\d{1,2}\s*月\s*\d{1,2}\s*日)/gi, '');
    // Grey can mean "next prize not available yet" or "already claimed this week". Only an "Available on" date AFTER
    // today means claimed (waiting for the next one); a date today or earlier, or no readable date -> not available yet.
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
    let mo = 0, da = 0, m;
    if ((m = dateText.match(new RegExp('\\b' + MON + '\\s*(\\d{1,2})(?!\\d)', 'i')))) { mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; da = +m[2]; }
    else if ((m = dateText.match(new RegExp('(?<!\\d)(\\d{1,2})\\s+' + MON, 'i')))) { mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; da = +m[1]; }
    else if ((m = dateText.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) { mo = +m[1]; da = +m[2]; }
    if (mo && da) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let rel = new Date(now.getFullYear(), mo - 1, da);
      if (rel - today > 180 * 864e5) rel = new Date(now.getFullYear() - 1, mo - 1, da);
      if (rel - today < -180 * 864e5) rel = new Date(now.getFullYear() + 1, mo - 1, da);
      if (rel > today) return { status: 'already', email, info: allCards(w) };
    }
    return { status: 'not_open', email, info: allCards(w) + (mo ? '' : ' (no "Available on" date found, treated as not available yet)') };
  }
  if (!doClaim) return { status: 'claimable', email, info: allCards(w) };

  // Real flow (verified on 2026-11-21 with the Traditional Chinese page):
  //   1. click the whole card -> a dialog "Tap to see your prize! Up to 100 Play Points" (zh: 按一下即可查看獎勵內容)
  //   2. click the gift inside the dialog -> "+5 You got 5 Play Points! ..." (zh: +5 你已獲得 5 點 Play 點數)
  //   3. close the dialog ("Close dialog" button, or "Done"). After reloading, the claimable card is gone and only
  //      the grey "Available on" card is left.
  const visibleDialog = () => [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')]
    .find((d) => d.getClientRects().length > 0);
  const waitDialog = async (test, ms) => {
    for (let t = 0; t < ms; t += 300) {
      const d = visibleDialog();
      if (d && (!test || test(clean(d.innerText)))) return d;
      await sleep(300);
    }
    return visibleDialog();
  };
  const GOT = /You('ve)? (got|won|earned)|\+\s*\d+\s*(Play|points|點)|你已獲得|已獲得\s*\d+/i;
  const REVEAL = /Tap to|Click to|see (your )?(prize|reward)|reveal|Up to \d+|查看獎勵內容|按一下即可|最多可獲得/i;

  // v1.2.5: the dialog is empty for a moment (only "Close dialog") before its content appears, so wait for the content
  // before clicking the gift. In a background tab the animation runs through raf_shim.js on timers, which Chrome limits
  // to about once a second there, so the waits are longer.
  const bg = document.hidden ? ' (background tab)' : '';
  clickTarget(w.btn).click();
  let dlg = await waitDialog((t) => REVEAL.test(t) || GOT.test(t) || APP_ONLY.test(t), 20000);
  let result = '';
  if (!dlg) return { status: 'clicked', email, info, result: 'clicked the card but no dialog appeared' + bg };
  let txt = clean(dlg.innerText);
  if (!(REVEAL.test(txt) || GOT.test(txt) || APP_ONLY.test(txt))) {
    return { status: 'clicked', email, info, result: 'the dialog stayed empty, no gift appeared' + bg };
  }
  if (APP_ONLY.test(txt)) return { status: 'app_only', email, info: 'the website asks you to claim in the Play Store app on Android' };
  if (!GOT.test(txt)) {
    // Step 2: open the gift (a control whose text looks like "Tap to see your prize"; otherwise the first non-close control)
    const ctrls = [...dlg.querySelectorAll('button,[role="button"]')].filter((x) => !/Close|關閉/i.test(x.getAttribute('aria-label') || ''));
    const gift = ctrls.find((x) => REVEAL.test(clean(x.textContent))) || ctrls.find((x) => clean(x.textContent));
    if (gift) {
      gift.click();
      dlg = await waitDialog((t) => GOT.test(t) || APP_ONLY.test(t), 30000) || dlg;
      txt = clean(dlg.innerText);
      if (APP_ONLY.test(txt)) return { status: 'app_only', email, info: 'the website asks you to claim in the Play Store app on Android' };
      // The prize animation did not finish: don't close the dialog (that could cancel the claim); reload-check and retry later
      if (!GOT.test(txt)) return { status: 'clicked', email, info, result: 'clicked the gift but the prize animation did not finish' + bg };
    }
  }
  result = txt.replace(/^Close dialog\s*|^關閉對話方塊\s*/i, '').slice(0, 120) + bg;
  // Step 3: close the dialog
  const closeBtn = dlg.querySelector('[aria-label="Close dialog"],[aria-label="關閉對話方塊"],[aria-label*="Close"],[aria-label*="關閉"]');
  if (closeBtn) closeBtn.click();
  else {
    const done = [...dlg.querySelectorAll('*')].find((x) => /^(Done|OK|完成|確定)$/i.test(clean(x.textContent)) && x.closest('[jsaction*="click"],button,[role="button"]'));
    if (done) (done.closest('[jsaction*="click"],button,[role="button"]') || done).click();
  }
  await sleep(1500);
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
    const mask = (e) => e.replace(/^(.{2}).*?(.{0,3})@.*$/, '$1***$2');   // keep only the first 2 / last 3 characters, never the full email
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
