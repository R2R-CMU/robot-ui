'use strict';
/* Robot Line Assistant - demo front end.
   Robot, rack and log data are simulated in-browser. To connect a real robot,
   replace `Engine` (below) with a client that speaks to your backend; the UI only
   reads `S` and calls start/stop/resume/addOrder/confirm/skip/estop. */

const $ = (id) => document.getElementById(id);
const PARTS = {
  'air duct':      { rack: 1, label: 'Air duct',      re: /air[\s-]?ducts?/ },
  'a-pillar trim': { rack: 2, label: 'A-pillar trim', re: /a[\s-]?pillar(\s+trims?)?/ },
  'sill trim':     { rack: 3, label: 'Sill trim',     re: /sill(\s+trims?)?/ },
};
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
const dkey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const safe = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

/* ---------- live state ---------- */
const S = {
  status: 'idle',            // idle | running | paused | attention | done | estop
  order: [],
  phase: null, phaseT: 0, cell: null, resumeTo: 'running',
  fixtures: { 1: 0, 2: 0 },
  runSec: 0, battery: 78, sillChecked: false,
  rack: freshRack(),
};
function freshRack() {
  return [
    ['full','full','full','empty'],
    ['full','full','full','full'],
    ['full','full','full','empty'],
  ];
}
let nextId = 1;

/* ---------- log (today) ---------- */
const today = new Date();
const TODAY = dkey(today);
let todayLog = [];
try { todayLog = JSON.parse(safe.get('rla-log-' + TODAY) || '[]'); } catch (e) { todayLog = []; }
if (!Array.isArray(todayLog)) todayLog = [];
todayLog = todayLog.filter((e) => e && typeof e.msg === 'string' && /^[a-z]+$/.test(e.kind) && !isNaN(new Date(e.t)));
function logEv(kind, msg, n) {
  todayLog.push({ t: new Date().toISOString(), kind, msg, n: n || 0 });
  if (todayLog.length > 500) todayLog.shift();
  safe.set('rla-log-' + TODAY, JSON.stringify(todayLog));
  if (selected === TODAY) renderDay();
  renderCalendar();
}

/* ---------- order ---------- */
function parseOrder(text) {
  const t = text.toLowerCase().trim();
  if (!t) return { err: 'Type what the robot should move.' };
  const key = Object.keys(PARTS).find((k) => PARTS[k].re.test(t));
  if (!key) return { err: 'Which part? Try: 2 air ducts from Rack 1 to Fixture 2' };
  const qty = parseInt((t.replace(/(rack|fixture)\s*\d+/g, '').match(/(\d+)/) || [, '1'])[1], 10);
  if (!(qty >= 1 && qty <= 12)) return { err: 'Choose between 1 and 12 parts.' };
  const rk = t.match(/rack\s*(\d+)/), fx = t.match(/fixture\s*(\d+)/);
  const rack = rk ? +rk[1] : PARTS[key].rack;
  const fixture = fx ? +fx[1] : 1;
  if (rack < 1 || rack > 3) return { err: 'Racks are 1 to 3.' };
  if (rack !== PARTS[key].rack) return { err: `${PARTS[key].label} is stored in Rack ${PARTS[key].rack}.` };
  if (fixture < 1 || fixture > 2) return { err: 'Fixtures are 1 and 2.' };
  const ready = S.rack[rack - 1].filter((c) => c === 'full' || c === 'pick').length;
  const planned = S.order.filter((o) => o.rack === rack).reduce((a, o) => a + (o.qty - o.done), 0);
  if (ready - planned < qty) return { err: `Rack ${rack} only has ${Math.max(0, ready - planned)} part(s) free for this order.` };
  return { item: { id: nextId++, qty, qty0: qty, key, label: PARTS[key].label, rack, fixture, done: 0 } };
}
function addOrder(text) {
  if (S.status === 'done') {            // a finished mission: adding starts a fresh batch
    S.order = []; S.rack = freshRack(); S.fixtures = { 1: 0, 2: 0 }; S.status = 'idle'; S.phase = null; S.cell = null; S.sillChecked = false;
    logEv('batch', 'New order started');
  }
  const r = parseOrder(text);
  if (r.err) return r;
  S.order.push(r.item);
  logEv('batch', `Added ${r.item.qty} x ${r.item.label} (Rack ${r.item.rack} to Fixture ${r.item.fixture})`);
  return r;
}

/* ---------- actions ---------- */
const pending = () => S.order.find((o) => o.done < o.qty);
function start() {
  // START always (re)starts the mission from the top: progress, rack and fixtures reset, video replays.
  if (!(S.status === 'idle' || S.status === 'done' || S.status === 'paused') || !S.order.length) return;
  S.order.forEach((o) => { o.done = 0; o.qty = o.qty0; });
  S.rack = freshRack(); S.fixtures = { 1: 0, 2: 0 };
  S.phase = null; S.phaseT = 0; S.cell = null; S.sillChecked = false; S.resumeTo = 'running';
  feed.restart = true;
  S.status = 'running'; logEv('batch', 'Operator pressed START: mission restarted');
}
function stop() {
  if (S.status !== 'running' && S.status !== 'attention') return;
  S.resumeTo = S.status === 'attention' ? 'attention' : 'running';
  S.status = 'paused'; logEv('stop', 'Operator pressed STOP');
}
function resume() {
  if (S.status !== 'paused') return;
  S.status = S.resumeTo; logEv('operator', 'Operator pressed RESUME');
}
const asking = () => S.status === 'attention' || (S.status === 'paused' && S.resumeTo === 'attention');
function answer(fn, msg) {
  if (!asking()) return;
  fn();
  if (S.status === 'attention') S.status = 'running';   // answered while live: carry on
  else S.resumeTo = 'running';                           // answered while STOPPED: stay stopped until RESUME
  S.sillChecked = true; logEv('operator', msg);
}
function confirmPart() {
  const { r, c } = S.cell;
  answer(() => { S.rack[r][c] = 'full'; }, `Operator: part is there in Rack ${r + 1}, slot ${c + 1}. Continuing`);
}
function skipSlot() {
  const { r, c } = S.cell;
  answer(() => { S.rack[r][c] = 'empty'; S.phase = null; }, `Operator skipped Rack ${r + 1}, slot ${c + 1}`);
}
function estop() {
  if (S.status === 'estop') {
    const back = S.preEstop;
    S.status = (back === 'idle' || back === 'done') ? back : 'paused';   // never restarts by itself
    logEv('operator', 'E-stop reset by operator'); return;
  }
  S.preEstop = S.status;
  if (S.status === 'running') S.resumeTo = 'running';
  else if (S.status === 'attention') S.resumeTo = 'attention';
  S.status = 'estop'; logEv('stop', 'EMERGENCY STOP pressed');
}

/* ---------- simulation (1 tick = 0.5 s) ---------- */
const PH = { locate: 1, pick: 2, place: 2 };
function tick() {
  if (dkey(new Date()) !== TODAY) { location.reload(); return; }
  if (S.status === 'running') {
    S.runSec += 0.5; S.battery = Math.max(5, S.battery - 0.004);
    const it = pending();
    if (!it) { S.status = 'done'; S.phase = null; logEv('batch', 'All items in the order are done'); return; }
    if (!S.phase) {
      const row = S.rack[it.rack - 1];
      if (it.key === 'sill trim' && !S.sillChecked) {
        const c = row.findIndex((x) => x === 'full');
        S.cell = { r: it.rack - 1, c: c < 0 ? 0 : c }; row[S.cell.c] = 'warn';
        S.status = 'attention';
        logEv('attention', `Needs attention: Rack ${it.rack}, slot ${S.cell.c + 1} - robot cannot tell if a part is there`);
        return;
      }
      const c = row.findIndex((x) => x === 'full');
      if (c < 0) {
        logEv('attention', `Rack ${it.rack} has no more parts. ${it.label}: placed ${it.done} of ${it.qty}, skipping the rest`);
        it.qty = it.done; if (it.qty === 0) S.order.splice(S.order.indexOf(it), 1);
        return;
      }
      S.cell = { r: it.rack - 1, c }; S.phase = 'locate'; S.phaseT = 0;
    }
    S.phaseT += 0.5;
    if (S.phase === 'pick' && S.phaseT <= 0.5) S.rack[S.cell.r][S.cell.c] = 'pick';
    if (S.phaseT >= PH[S.phase]) {
      S.phaseT = 0;
      if (S.phase === 'locate') { S.phase = 'pick'; S.rack[S.cell.r][S.cell.c] = 'pick'; }
      else if (S.phase === 'pick') { S.phase = 'place'; S.rack[S.cell.r][S.cell.c] = 'empty'; }
      else {
        it.done++; S.fixtures[it.fixture]++; S.phase = null;
        logEv('placed', `Placed ${it.label} on Fixture ${it.fixture} (${it.done} of ${it.qty})`, 1);
      }
    }
  }
  render();
}

/* ---------- ego-view stream (sample clips; swap for a real stream later) ---------- */
const CLIPS = { 'a-pillar trim': 'video/ego_a_pillar.mp4', 'air duct': 'video/ego_air_duct.mp4', 'sill trim': 'video/ego_sill_trim.mp4' };
const feed = { v: $('ego'), clip: null, restart: false };
function updateFeed(it) {
  const v = feed.v;
  const want = it && CLIPS[it.key];
  if (!want) { if (feed.clip) { feed.clip = null; v.removeAttribute('src'); v.load(); } }
  else if (want !== feed.clip) { feed.clip = want; v.src = want; v.load(); }
  if (feed.restart) { feed.restart = false; try { v.currentTime = 0; } catch (e) {} }
  const playing = S.status === 'running' || S.status === 'attention';   // camera stays live while the robot waits for the operator
  if (playing && v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  if (!playing && !v.paused) v.pause();
  const msg = { idle: S.order.length ? ['Waiting to start', 'Press START to begin the mission'] : ['No order yet', 'Add parts to the order, then press START'], paused: ['Stream paused', 'Robot stopped. Press RESUME'],
    estop: ['Emergency stop', 'Stream stopped'], done: ['Order complete', 'Stream stopped'] }[S.status];
  $('paused').hidden = playing;
  if (msg) { $('paused-title').textContent = msg[0]; $('paused-sub').textContent = msg[1]; }
  $('frame').classList.toggle('off', !playing);
  $('live').lastElementChild.textContent = playing ? 'LIVE' : 'OFFLINE';
}

/* ---------- available commands ---------- */
const EXAMPLES = ['2 air ducts from Rack 1 to Fixture 2', '3 A-pillar trim from Rack 2 to Fixture 1', '1 sill trim to Fixture 1'];
let helpKey = '';
function freeParts(rack) {
  const ready = S.rack[rack - 1].filter((c) => c === 'full' || c === 'pick').length;
  const planned = S.order.filter((o) => o.rack === rack).reduce((a, o) => a + (o.qty - o.done), 0);
  return Math.max(0, ready - planned);
}
function renderHelp() {
  const free = [1, 2, 3].map(freeParts), key = free.join(',');
  if (key === helpKey) return; helpKey = key;
  const body = $('help-body'); body.textContent = '';
  const h1 = document.createElement('h3'); h1.textContent = 'Parts you can ask for'; body.appendChild(h1);
  const ul = document.createElement('ul'); ul.className = 'parts';
  Object.keys(PARTS).forEach((k) => {
    const p = PARTS[k], n = free[p.rack - 1], li = document.createElement('li');
    li.innerHTML = '<span class="pn"></span><span class="pr"></span><span class="pa"></span>';
    li.querySelector('.pn').textContent = p.label; li.querySelector('.pr').textContent = `Rack ${p.rack}`;
    const pa = li.querySelector('.pa'); pa.textContent = n ? `${n} available` : 'none left'; if (!n) pa.classList.add('none');
    ul.appendChild(li);
  });
  body.appendChild(ul);
  const h2 = document.createElement('h3'); h2.textContent = 'Try one (tap to fill the box)'; body.appendChild(h2);
  const ex = document.createElement('div'); ex.className = 'ex-list';
  EXAMPLES.forEach((t) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ex'; b.textContent = t;
    b.addEventListener('click', () => { const i = $('add-input'); i.value = t; i.focus(); });
    ex.appendChild(b);
  });
  body.appendChild(ex);
  const tip = document.createElement('p'); tip.className = 'tip';
  tip.textContent = 'Controls: START begins or restarts the mission. STOP pauses it. RESUME continues. E-STOP is the emergency stop.';
  body.appendChild(tip);
}

/* ---------- operator window render ---------- */
function totals() {
  const total = S.order.reduce((a, o) => a + o.qty, 0), done = S.order.reduce((a, o) => a + o.done, 0);
  return { total, done };
}
function fmtEta(sec) {
  if (sec < 15) return 'Almost done';
  const m = Math.round(sec / 60);
  return m < 1 ? 'Under a minute left' : `About ${m} min left`;
}
function render() {
  const { total, done } = totals();
  const it = pending();
  const b = $('banner');
  b.className = 'banner s-' + S.status;
  const left = (total - done) * 5;
  let st, tx;
  switch (S.status) {
    case 'running':
      st = 'RUNNING';
      tx = S.phase === 'place' ? `Placing ${it.label.toLowerCase()} on Fixture ${it.fixture}`
         : S.phase === 'pick'  ? `Picking ${it.label.toLowerCase()} from Rack ${it.rack}`
         : it ? `Looking for ${it.label.toLowerCase()} in Rack ${it.rack}` : 'Finishing up';
      break;
    case 'paused': st = 'STOPPED'; tx = 'Press RESUME to continue where it left off.'; break;
    case 'attention': st = 'WAITING FOR YOU'; tx = 'The robot paused. See the message below.'; break;
    case 'done': st = 'ALL DONE'; tx = `${done} parts placed. Add more to the order to keep going.`; break;
    case 'estop': st = 'EMERGENCY STOP'; tx = 'The robot is stopped. Press E-STOP again to reset it.'; break;
    default: st = 'READY'; tx = pending() ? 'Check the order, then press START.' : 'Add parts to the order to begin.';
  }
  $('b-state').textContent = st; $('b-text').textContent = tx;
  $('b-count').textContent = total ? `${Math.min(done + (it ? 1 : 0), total)} of ${total}` : '';
  $('b-eta').textContent = S.status === 'done' ? '' : (total ? fmtEta(left) : '');
  $('b-fill').style.width = total ? Math.round((done / total) * 100) + '%' : '0';

  const att = $('attention');
  const showAtt = S.status === 'attention' || (S.status === 'paused' && S.resumeTo === 'attention');
  att.hidden = !showAtt;
  if (showAtt && S.cell) $('a-title').textContent = `Rack ${S.cell.r + 1}, slot ${S.cell.c + 1}: the robot can't tell if a part is there.`;

  const live = S.status === 'running' || S.status === 'attention';
  $('b-start').disabled = !((S.status === 'idle' || S.status === 'done' || S.status === 'paused') && S.order.length);
  $('b-stop').disabled = !live;
  $('b-resume').disabled = S.status !== 'paused';
  $('estop').textContent = S.status === 'estop' ? 'RESET' : 'E-STOP';

  const ul = $('order'); ul.textContent = '';
  S.order.forEach((o) => {
    const li = document.createElement('li');
    const isNow = pending() === o && (S.status === 'running' || S.status === 'attention' || S.status === 'paused');
    li.className = o.done >= o.qty ? 'done' : isNow ? 'now' : '';
    const label = o.done >= o.qty ? `Done ${o.qty}/${o.qty}` : isNow ? `In progress ${o.done}/${o.qty}` : 'Waiting';
    li.innerHTML = '<i class="d"></i><div class="t"><div class="n"></div><div class="r"></div></div><span class="pill"></span>';
    li.querySelector('.n').textContent = `${o.qty} x ${o.label}`;
    li.querySelector('.r').textContent = `Rack ${o.rack}  to  Fixture ${o.fixture}`;
    li.querySelector('.pill').textContent = label;
    ul.appendChild(li);
  });
  if (!S.order.length) { const li = document.createElement('li'); li.textContent = 'Nothing ordered yet. Add a part below.'; ul.appendChild(li); }

  const rk = $('rack'); rk.textContent = '';
  const names = ['Air duct', 'A-pillar trim', 'Sill trim'], txt = { full: 'Part ready', empty: 'Empty', pick: 'Picking now', warn: 'Check' };
  S.rack.forEach((row, r) => {
    const l = document.createElement('div'); l.className = 'rl'; l.innerHTML = `Rack ${r + 1}<small></small>`; l.querySelector('small').textContent = names[r]; rk.appendChild(l);
    row.forEach((st2) => { const c = document.createElement('div'); c.className = 'cell ' + st2; c.textContent = txt[st2]; rk.appendChild(c); });
  });

  updateFeed(it || S.order[S.order.length - 1]);
  renderHelp();

  const bat = Math.round(S.battery);
  $('chip-batt').lastElementChild.textContent = `Battery ${bat}%`;
  $('chip-batt').firstElementChild.className = 'dot ' + (bat < 20 ? 'bad' : bat < 35 ? 'warn' : 'ok');
  const rb = $('chip-robot');
  rb.lastElementChild.textContent = S.status === 'estop' ? 'Robot stopped' : S.status === 'attention' ? 'Needs you' : 'Robot OK';
  rb.firstElementChild.className = 'dot ' + (S.status === 'estop' ? 'bad' : S.status === 'attention' ? 'warn' : 'ok');
}

/* ---------- sample history (clearly labelled as sample) ---------- */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sampleCache = {};
function sampleDay(d) {
  const k = dkey(d); if (sampleCache[k]) return sampleCache[k];
  const r = rng(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
  const ev = []; let t = 6 * 60 + 55 + Math.floor(r() * 15);
  const at = (m) => { const x = new Date(d); x.setHours(0, m, 0, 0); return x.toISOString(); };
  const batches = (d.getDay() === 0 ? 2 : 3) + Math.floor(r() * 3);
  const keys = Object.keys(PARTS);
  for (let b = 0; b < batches; b++) {
    const items = 2 + Math.floor(r() * 2);
    ev.push({ t: at(t), kind: 'batch', msg: `Order loaded (${items} items)`, n: 0 }); t += 1;
    for (let i = 0; i < items; i++) {
      const key = keys[Math.floor(r() * 3)], q = 2 + Math.floor(r() * 4), fx = 1 + Math.floor(r() * 2);
      for (let u = 0; u < q; u++) {
        t += 1 + Math.floor(r() * 2);
        if (r() < 0.035) {
          const rack = PARTS[key].rack, slot = 1 + Math.floor(r() * 4);
          ev.push({ t: at(t), kind: 'attention', msg: `Needs attention: Rack ${rack}, slot ${slot} - robot cannot tell if a part is there`, n: 0 }); t += 1 + Math.floor(r() * 3);
          ev.push({ t: at(t), kind: 'operator', msg: r() < 0.6 ? 'Operator: part is there - continue' : `Operator skipped Rack ${rack}, slot ${slot}`, n: 0 });
        }
        if (r() < 0.012) { ev.push({ t: at(t), kind: 'stop', msg: 'Operator pressed STOP', n: 0 }); t += 2 + Math.floor(r() * 6); ev.push({ t: at(t), kind: 'operator', msg: 'Operator pressed RESUME', n: 0 }); }
        ev.push({ t: at(t), kind: 'placed', msg: `Placed ${PARTS[key].label} on Fixture ${fx}`, n: 1 });
      }
    }
    t += 8 + Math.floor(r() * 20);
  }
  ev.push({ t: at(Math.min(t, 15 * 60 + 40)), kind: 'batch', msg: 'Shift ended', n: 0 });
  return (sampleCache[k] = ev);
}
function eventsFor(key) {
  if (key === TODAY) return todayLog;
  const [y, m, dd] = key.split('-').map(Number), d = new Date(y, m - 1, dd);
  const lim = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
  return d < today && d >= lim ? sampleDay(d) : null;
}
function summarize(ev) {
  const s = { placed: 0, attn: 0, stops: 0, minutes: 0 };
  ev.forEach((e) => { s.placed += e.n || 0; if (e.kind === 'attention') s.attn++; if (e.kind === 'stop') s.stops++; });
  if (ev.length > 1) s.minutes = Math.max(0, Math.round((new Date(ev[ev.length - 1].t) - new Date(ev[0].t)) / 60000));
  return s;
}

/* ---------- calendar ---------- */
let view = new Date(today.getFullYear(), today.getMonth(), 1), selected = dkey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function renderCalendar() {
  $('cal-title').textContent = `${MONTHS[view.getMonth()]} ${view.getFullYear()}`;
  const g = $('cal-grid'); g.textContent = '';
  ['S','M','T','W','T','F','S'].forEach((d) => { const e = document.createElement('div'); e.className = 'dow'; e.textContent = d; g.appendChild(e); });
  const first = new Date(view.getFullYear(), view.getMonth(), 1), nd = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  for (let i = 0; i < first.getDay(); i++) g.appendChild(document.createElement('div'));
  for (let dn = 1; dn <= nd; dn++) {
    const d = new Date(view.getFullYear(), view.getMonth(), dn), k = dkey(d), ev = eventsFor(k);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'day' + (k === TODAY ? ' today' : '');
    b.disabled = !ev; b.setAttribute('aria-pressed', String(k === selected));
    b.innerHTML = '<span class="dn"></span><span class="pc"></span>'; b.querySelector('.dn').textContent = dn;
    if (ev) {
      const s = summarize(ev); b.querySelector('.pc').textContent = s.placed;
      const dot = document.createElement('i'); dot.className = 'dot ' + (s.attn || s.stops ? 'warn' : 'ok'); b.appendChild(dot);
      b.setAttribute('aria-label', `${MONTHS[d.getMonth()]} ${dn}: ${s.placed} parts placed, ${s.attn} needed help`);
    }
    b.addEventListener('click', () => { selected = k; renderCalendar(); renderDay(); });
    g.appendChild(b);
  }
}
function renderDay() {
  const [y, m, dd] = selected.split('-').map(Number), d = new Date(y, m - 1, dd);
  $('day-title').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  $('day-tag').textContent = selected === TODAY ? 'Live' : 'Sample data';
  const ev = eventsFor(selected) || [], s = summarize(ev);
  const st = $('day-stats'); st.textContent = '';
  [['Parts placed', s.placed, ''], ['Needed help', s.attn, s.attn ? 'flag' : ''], ['Stops', s.stops, s.stops ? 'flag' : ''],
   ['Hours on shift', (s.minutes / 60).toFixed(1), '']].forEach(([l, v, c]) => {
    const e = document.createElement('div'); e.className = 'stat ' + c; e.innerHTML = '<b></b><span></span>'; e.querySelector('b').textContent = v; e.querySelector('span').textContent = l; st.appendChild(e);
  });
  const ol = $('day-log'); ol.textContent = '';
  if (!ev.length) { const li = document.createElement('li'); li.innerHTML = '<span class="empty">No events yet.</span>'; ol.appendChild(li); return; }
  ev.forEach((e) => {
    const li = document.createElement('li'); li.innerHTML = '<time></time><i class="k"></i><span></span>';
    li.querySelector('time').textContent = hhmm(new Date(e.t)); li.querySelector('.k').classList.add(e.kind); li.querySelector('span').textContent = e.msg; ol.appendChild(li);
  });
}

/* ---------- role view + wiring ---------- */
function setRole(role) {
  if (role !== 'manager') role = 'operator';
  $('app').className = 'view-' + role;
  ['operator', 'manager'].forEach((r) => $('tab-' + r).setAttribute('aria-pressed', String(r === role)));
  if (location.hash.slice(1) !== role) history.replaceState(null, '', '#' + role);
}
document.querySelectorAll('.roles button').forEach((b) => b.addEventListener('click', () => setRole(b.dataset.role)));
window.addEventListener('hashchange', () => setRole(location.hash.slice(1)));

$('b-start').onclick = () => { start(); render(); };
$('b-stop').onclick = () => { stop(); render(); };
$('b-resume').onclick = () => { resume(); render(); };
$('estop').onclick = () => { estop(); render(); };
$('a-ok').onclick = () => { confirmPart(); render(); };
$('a-skip').onclick = () => { skipSlot(); render(); };
$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const r = addOrder($('add-input').value), m = $('add-msg');
  if (r.err) { m.textContent = r.err; m.className = 'add-msg err'; }
  else { m.textContent = `Added: ${r.item.qty} x ${r.item.label}. Press START if the robot is idle.`; m.className = 'add-msg'; $('add-input').value = ''; }
  render();
});
$('cal-prev').onclick = () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); renderCalendar(); };
$('cal-next').onclick = () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); renderCalendar(); };
$('cal-today').onclick = () => { selected = TODAY; view = new Date(today.getFullYear(), today.getMonth(), 1); renderCalendar(); renderDay(); };
$('cal-yest').onclick = () => { const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1); selected = dkey(y); view = new Date(y.getFullYear(), y.getMonth(), 1); renderCalendar(); renderDay(); };

/* ---------- boot ---------- */
logEv('batch', 'Session opened (demo)');
setRole(location.hash.slice(1));
renderCalendar(); renderDay(); render();
setInterval(tick, 500);
