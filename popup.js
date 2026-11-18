const LABEL = {
  new: '… not checked this week',
  claimed: '✅ Claimed',
  already: '☑ Already claimed',
  claimable: 'Can be claimed (not clicked yet)',
  unverified: '⚠ Clicked Claim, not confirmed',
  app_only: '⚠ Website cannot claim, use the app',
  no_prize: '– No weekly prize',
  not_open: '⏳ Not available yet (will retry)',
  not_member: '– Not a Play Points member',
  notfound: '⚠ Weekly prize not found (page changed?)',
  login: '⚠ Chrome is not signed in to Google',
  timeout: '⚠ Page load timed out',
  error: '❌ Error'
};
const OK = ['claimed', 'already', 'no_prize', 'not_member'];
const SPONSOR_URL = 'https://ko-fi.com/sagiriben';

function weekKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() - 5 + 7) % 7));
  return d.toLocaleDateString('sv-SE');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function render() {
  const s = await chrome.storage.local.get(['week', 'accounts', 'log', 'runningSince']);
  const wk = weekKey();
  const acc = s.week === wk ? (s.accounts || {}) : {};
  const list = Object.entries(acc).sort((a, b) => (a[1].authuser ?? 99) - (b[1].authuser ?? 99));
  const done = list.filter(([, a]) => OK.includes(a.status)).length;
  const wait = (st) => st === 'no_prize' || st === 'not_member';
  const since = new Date(wk + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  document.getElementById('week').textContent = list.length
    ? `This week (from Fri ${since}): ${done} / ${list.length} accounts done`
    : `This week (from Fri ${since}): not checked yet`;

  const table = document.getElementById('accounts');
  table.innerHTML = '';
  for (const [email, a] of list) {
    const tr = el('tr');
    const left = el('td');
    const note = a.neverSince ? ` (no prize since the week of ${a.neverSince}; not re-checked every week)` : '';
    left.append(el('div', '', email), el('div', 't', `${a.time || ''}  ${a.info || ''}${note}`));
    const right = el('td', 'st ' + (wait(a.status) ? 'wait' : OK.includes(a.status) ? 'ok' : 'bad'), LABEL[a.status] || a.status);
    tr.append(left, right);
    table.append(tr);
  }

  const ul = document.getElementById('log');
  ul.innerHTML = '';
  for (const item of (s.log || []).slice(0, 15)) {
    const li = el('li');
    li.append(el('div', 't', `${item.time}  ${item.email}`),
      el('div', '', (LABEL[item.status] || item.status) + (item.text ? ': ' + item.text : '')));
    ul.append(li);
  }

  const btn = document.getElementById('run');
  const running = s.runningSince && Date.now() - s.runningSince < 600000;
  btn.disabled = !!running;
  btn.textContent = running ? 'Running… (about 10 seconds per account)' : 'Check & claim now';
}

document.getElementById('run').addEventListener('click', async () => {
  const btn = document.getElementById('run');
  btn.disabled = true;
  btn.textContent = 'Running… (about 10 seconds per account)';
  await chrome.runtime.sendMessage({ cmd: 'run' });
  render();
});

document.getElementById('sponsorBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: SPONSOR_URL });
  window.close();
});

const only = document.getElementById('onlyEmails');
chrome.storage.local.get(['onlyEmails']).then((s) => { only.value = s.onlyEmails || ''; });
only.addEventListener('input', () => chrome.storage.local.set({ onlyEmails: only.value }));

chrome.storage.onChanged.addListener(render);
render();
