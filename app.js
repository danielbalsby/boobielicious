// Boobielicious – amme-tæller
(() => {
  'use strict';
  const { cue, unlockAudio, haptic, stopSound } = window.Boobie;

  const K = {
    feeds: 'boobielicious.v2.feeds',     // [{ t, d, s, u }] – t: start (ms), d: varighed (s) eller null, s: side ('L','R','LR','RL',''), u: 1 hvis ikke stoppet
    active: 'boobielicious.active',      // { start, fired: [minutter] }
    settings: 'boobielicious.settings',
    cel: 'boobielicious.celebrated',
    backup: 'boobielicious.lastBackup',
    oldFeeds: 'boobielicious.feeds',     // v1-data
    oldDur: 'boobielicious.durations'
  };
  const MILESTONES = [10, 15, 25];       // minutter
  const FULL = 25;                       // ringen er fuld ved 25 min
  const AUTO_STOP = 90 * 60e3;           // glemt timer stoppes efter 90 min
  const HOLD_MS = 650;                   // hold for at stoppe
  const DEFAULTS = { goal: 8, theme: 'auto', shortcut: false, shortcutName: 'Amningstimer' };
  const WORDS = { 1: 'En', 2: 'To', 3: 'Tre', 4: 'Fire', 5: 'Fem', 6: 'Seks', 7: 'Syv', 8: 'Otte', 9: 'Ni', 10: 'Ti', 11: 'Elleve', 12: 'Tolv', 13: 'Tretten', 14: 'Fjorten', 15: 'Femten', 16: 'Seksten' };
  const SIDE = { L: 'venstre', R: 'højre' };

  const $ = id => document.getElementById(id);
  const els = {
    date: $('date'), n: $('n'), dots: $('dots'), sides: $('sides'), press: $('press'), hint: $('hint'),
    clock: $('clock'), sub: $('sub'), arc: $('arc'), ticks: $('ticks'),
    strip: $('strip'), total: $('total'), since: $('since'), undo: $('undo'), nudge: $('nudge'),
    sheet: $('sheet'), seg: $('seg'), stats: $('stats'), days: $('days'), bars: $('bars'), chartAvg: $('chartAvg'), chartFrom: $('chartFrom'),
    settings: $('settings'), editor: $('editor'), wake: $('wake'), cel: $('celebrate'), msg: $('message'), celText: $('celText')
  };

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  // ---------- Tid ----------
  const pad = n => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayStartOf = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const midnight = () => dayStartOf(Date.now());
  const nextDay = t => { const d = new Date(t); d.setDate(d.getDate() + 1); return d.getTime(); };
  const fmtTime = t => new Date(t).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  const fmtDate = d => d.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtClock = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const fmtSpan = ms => {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} t ${r} min` : `${h} t`;
  };
  const fmtTotal = ms => {
    const m = Math.floor(ms / 60000);
    if (!m) return ms ? '< 1 min' : '';
    const h = Math.floor(m / 60), r = m % 60;
    return h ? `${h} t ${pad(r)} min` : `${m} min`;
  };
  const fmtTotalShort = ms => {
    const m = Math.round(ms / 60000);
    if (!m) return '';
    const h = Math.floor(m / 60), r = m % 60;
    return h ? `${h} t ${pad(r)}` : `${m} min`;
  };
  function dayLabel(start) {
    const t = midnight();
    if (start === t) return 'I dag';
    if (start === dayStartOf(t - 1)) return 'I går';
    const d = new Date(start);
    return d.toLocaleDateString('da-DK', { weekday: 'short' }).replace('.', '') + ' ' + d.getDate() + '.';
  }

  // ---------- Data ----------
  (function migrate() {
    if (localStorage.getItem(K.feeds) !== null) return;
    const old = store.get(K.oldFeeds, []), dur = store.get(K.oldDur, {});
    store.set(K.feeds, old.filter(Number.isFinite).map(t => ({ t, d: dur[t] || null, s: '' })));
  })();

  let cache = null;
  const valid = f => f && Number.isFinite(f.t);
  const feeds = () => cache || (cache = store.get(K.feeds, []).filter(valid).sort((a, b) => a.t - b.t));
  function saveFeeds(list) { cache = list.filter(valid).sort((a, b) => a.t - b.t); store.set(K.feeds, cache); }
  const findFeed = t => feeds().find(f => f.t === t);
  const inDay = (start, list = feeds()) => { const end = nextDay(start); return list.filter(f => f.t >= start && f.t < end); };

  const settings = () => ({ ...DEFAULTS, ...store.get(K.settings, {}) });
  const setSetting = (k, v) => store.set(K.settings, { ...store.get(K.settings, {}), [k]: v });

  const active = () => store.get(K.active, null);
  const isLive = f => { const a = active(); return !!a && a.start === f.t; };
  const durMs = f => f.d ? f.d * 1000 : (isLive(f) ? Date.now() - f.t : 0);
  const dayTotal = start => inDay(start).reduce((sum, f) => sum + durMs(f), 0);

  // Næste side: modsat af den side, der sidst blev ammet fra
  function suggestedSide() {
    const last = [...feeds()].reverse().find(f => f.s);
    if (!last) return 'L';
    return last.s.slice(-1) === 'L' ? 'R' : 'L';
  }
  let chosenSide = null;
  const currentSide = () => chosenSide || suggestedSide();
  const sideText = s => !s ? '' : s.length === 1 ? SIDE[s] : `${SIDE[s[0]]} → ${SIDE[s[1]]}`;

  // ---------- Tema ----------
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  function applyTheme() {
    const st = settings().theme, h = new Date().getHours();
    const night = st === 'night' || (st === 'auto' && (h >= 22 || h < 6));
    const theme = night ? 'night' : 'day';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = night ? 'dark' : 'light';
      themeMeta.setAttribute('content', night ? '#1E1917' : '#F7F2EC');
    }
  }

  // ---------- Forside ----------
  let dotsFor = 0;
  function render(opts = {}) {
    const list = inDay(midnight()), count = list.length, goal = settings().goal;
    els.date.textContent = fmtDate(new Date());
    if (els.n.textContent !== String(count)) {
      els.n.textContent = count;
      if (opts.animate) { els.n.classList.remove('bump'); void els.n.offsetWidth; els.n.classList.add('bump'); }
    }
    document.querySelector('.count .of').textContent = `af ${goal}`;
    if (dotsFor !== goal) { els.dots.innerHTML = '<i></i>'.repeat(goal); dotsFor = goal; }
    [...els.dots.children].forEach((d, i) => d.classList.toggle('on', i < count));

    renderSides();
    drawStrip(els.strip, midnight());
    renderTotal();
    renderSince();
    els.undo.disabled = count === 0;
    els.hint.style.opacity = !feeds().length && !active() ? 1 : 0;
    els.nudge.hidden = !needsBackup();
    if (els.sheet.classList.contains('open')) renderLog();
  }

  function renderSides() {
    const a = active(), f = a && findFeed(a.start);
    const on = f ? (f.s || '') : currentSide();
    [...els.sides.children].forEach(b => b.classList.toggle('on', on.includes(b.dataset.side)));
  }

  function drawStrip(el, start) {
    const end = nextDay(start), len = end - start, now = Date.now();
    let html = [25, 50, 75].map(p => `<i class="h" style="left:${p}%"></i>`).join('');
    inDay(start).forEach(f => {
      const left = (f.t - start) / len * 100;
      const w = Math.min(100 - left, durMs(f) / len * 100);
      const cls = `b s-${f.s || 'x'}${isLive(f) ? ' live' : ''}`;
      html += `<i class="${cls}" style="left:${left.toFixed(3)}%;width:${w.toFixed(3)}%"></i>`;
    });
    if (now >= start && now < end) html += `<i class="now" style="left:${((now - start) / len * 100).toFixed(3)}%"></i>`;
    el.innerHTML = html;
  }

  function renderTotal() {
    const ms = dayTotal(midnight());
    els.total.textContent = ms ? fmtTotal(ms) + ' ammet' : '';
  }

  function renderSince() {
    const list = feeds();
    if (!list.length) { els.since.textContent = 'Tryk på brystet, når I begynder'; return; }
    const last = list[list.length - 1];
    const loose = list.filter(f => f.u && f.t > Date.now() - 24 * 3600e3).pop();
    if (loose) {
      els.since.innerHTML = `Amningen kl. ${fmtTime(loose.t)} blev ikke stoppet · <button data-fix="${loose.t}">Ret den</button>`;
      return;
    }
    if (isLive(last)) { els.since.textContent = ''; return; }
    const ago = Date.now() - last.t - durMs(last);
    const side = last.s ? ` · ${sideText(last.s)}` : '';
    els.since.innerHTML = ago < 60000 ? `Sidst ammet <b>lige nu</b>${side}` : `Sidst ammet for <b>${fmtSpan(ago)}</b> siden${side}`;
  }
  els.since.addEventListener('click', e => {
    const b = e.target.closest('[data-fix]');
    if (b) openEditor({ feed: findFeed(+b.dataset.fix) });
  });

  // ---------- Sidevalg ----------
  els.sides.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const side = b.dataset.side;
    haptic([20]);
    const a = active();
    if (a) {                                   // skift side under amningen
      const list = feeds().slice(), f = list.find(x => x.t === a.start);
      if (f && !f.s.includes(side)) { f.s = (f.s + side).slice(-2); saveFeeds(list); flashSub(`Skiftet til ${SIDE[side]}`); }
    } else chosenSide = side;
    renderSides();
    drawStrip(els.strip, midnight());
  });

  // ---------- Tidtagning ----------
  const R = 108;
  [10, 15].forEach(m => {
    const ang = (m / FULL) * 2 * Math.PI;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', 'tick'); c.dataset.m = m;
    c.setAttribute('cx', 110 + R * Math.cos(ang)); c.setAttribute('cy', 110 + R * Math.sin(ang)); c.setAttribute('r', 2.2);
    els.ticks.appendChild(c);
  });

  let subTimer = null;
  const SUB_DEFAULT = 'Hold fingeren nede for at stoppe';
  function flashSub(text) {
    els.sub.textContent = text;
    clearTimeout(subTimer);
    subTimer = setTimeout(() => { els.sub.textContent = SUB_DEFAULT; }, 2600);
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch {}
  }

  function pulse() { els.press.classList.remove('pulse'); void els.press.offsetWidth; els.press.classList.add('pulse'); }

  function startFeed() {
    const now = Date.now();
    const list = feeds().slice();
    list.push({ t: now, d: null, s: currentSide() });
    saveFeeds(list);
    store.set(K.active, { start: now, fired: [] });
    chosenSide = null;
    keepAwake(true);
    pulse();
    tick();
    render({ animate: true });

    const goal = settings().goal;
    if (inDay(midnight()).length === goal && store.get(K.cel, '') !== dayKey()) {
      store.set(K.cel, dayKey());
      setTimeout(celebrate, 600);
    }
    const st = settings();
    if (st.shortcut) setTimeout(() => runShortcut(st.shortcutName), 450);
  }

  function stopFeed({ unfinished = false } = {}) {
    const a = active();
    if (!a) return;
    const list = feeds().slice(), f = list.find(x => x.t === a.start);
    if (f) {
      if (unfinished) { f.d = null; f.u = 1; }
      else { f.d = Math.max(1, Math.round((Date.now() - a.start) / 1000)); delete f.u; }
      saveFeeds(list);
    }
    store.set(K.active, null);
    stopAlarm();
    keepAwake(false);
    els.sub.textContent = SUB_DEFAULT;
    tick();
    render();
  }

  function tick() {
    applyTheme();
    const a = active();
    document.body.classList.toggle('timing', !!a);
    if (!a) {
      els.arc.style.strokeDasharray = '0 1';
      drawStrip(els.strip, midnight());
      renderSince();
      return;
    }
    const ms = Date.now() - a.start, min = ms / 60000;
    if (ms > AUTO_STOP) { stopFeed({ unfinished: true }); return; }
    drawStrip(els.strip, midnight());
    renderTotal();
    els.clock.textContent = fmtClock(ms);
    els.arc.style.strokeDasharray = `${Math.min(1, min / FULL)} 1`;
    [...els.ticks.children].forEach(c => c.classList.toggle('done', min >= +c.dataset.m));
    for (const m of MILESTONES) {
      if (min >= m && !a.fired.includes(m)) {
        a.fired.push(m); store.set(K.active, a);
        if (m === 25) startAlarm(); else { cue(m); pulse(); }
      }
    }
  }
  setInterval(tick, 1000);

  // Tryk = start. Under en amning: hold fingeren nede for at stoppe.
  let holdTimer = null, held = false, lastTap = 0;
  els.press.addEventListener('contextmenu', e => e.preventDefault());
  els.press.addEventListener('pointerdown', () => {
    unlockAudio();
    if (!active()) return;
    held = false;
    els.press.classList.add('holding');
    holdTimer = setTimeout(() => {
      held = true;
      els.press.classList.remove('holding');
      haptic([40]);
      stopFeed();
    }, HOLD_MS);
  });
  const cancelHold = () => { clearTimeout(holdTimer); els.press.classList.remove('holding'); };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => els.press.addEventListener(ev, cancelHold));
  els.press.addEventListener('click', () => {
    if (held) { held = false; return; }
    if (active()) { haptic([15]); flashSub('Hold fingeren nede for at stoppe'); return; }
    const now = Date.now();
    if (now - lastTap < 800) return;           // undgå utilsigtede dobbelttryk
    lastTap = now;
    unlockAudio();
    haptic([30]);
    startFeed();
  });

  els.undo.addEventListener('click', () => {
    const today = inDay(midnight());
    if (!today.length) return;
    const last = today[today.length - 1];
    if (isLive(last)) { store.set(K.active, null); stopAlarm(); keepAwake(false); }
    saveFeeds(feeds().filter(f => f.t !== last.t));
    chosenSide = null;
    tick(); render();
  });

  // ---------- Sikkerhedsalarm ----------
  let alarmTimer = null;
  function startAlarm() {
    clearInterval(alarmTimer);
    document.body.classList.add('alarm');
    els.wake.setAttribute('aria-hidden', 'false');
    cue(25);
    alarmTimer = setInterval(() => cue(25), 9000);   // lydklippet er 8 s
  }
  function stopAlarm() {
    clearInterval(alarmTimer); alarmTimer = null;
    document.body.classList.remove('alarm');
    els.wake.setAttribute('aria-hidden', 'true');
    stopSound();
  }
  $('awakeBtn').addEventListener('click', () => { haptic([30]); stopAlarm(); });
  $('endBtn').addEventListener('click', () => { haptic([30]); stopFeed(); });
  document.addEventListener('pointerdown', () => unlockAudio());   // også når appen genåbnes midt i en amning

  // ---------- iPhone-timer via Genveje ----------
  function runShortcut(name) {
    location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(name);
  }

  // ---------- Historik ----------
  let logDays = 7;
  function renderLog() {
    const all = feeds();
    const starts = [];
    let s0 = midnight();
    for (let i = 0; i < logDays; i++) { starts.push(s0); s0 = dayStartOf(s0 - 1); }
    const from = starts[starts.length - 1];
    const inRange = all.filter(f => f.t >= from);

    // Nøgletal over hele døgn (i dag bruges kun, hvis der ikke er andre data)
    const fullDays = starts.slice(1).filter(s => inDay(s, all).length);
    const basis = fullDays.length ? fullDays : [midnight()];
    const perDay = basis.reduce((n, s) => n + inDay(s, all).length, 0) / basis.length;
    const durs = inRange.map(f => f.d).filter(Boolean);
    const avgDur = durs.length ? durs.reduce((x, y) => x + y, 0) / durs.length / 60 : 0;
    const gaps = [];
    for (let i = 1; i < inRange.length; i++) {
      const g = inRange[i].t - inRange[i - 1].t - (inRange[i - 1].d || 0) * 1000;
      if (g > 0 && g < 12 * 3600e3) gaps.push(g);
    }
    const avgGap = gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : 0;
    const totals = basis.map(dayTotal).filter(Boolean);
    const avgTotal = totals.length ? totals.reduce((x, y) => x + y, 0) / totals.length : 0;
    const ht = ms => `${Math.floor(ms / 3600e3)}<small>t</small> ${Math.round(ms % 3600e3 / 60000)}<small>m</small>`;
    const fmtNum = n => n.toLocaleString('da-DK', { maximumFractionDigits: 1 });
    els.stats.innerHTML =
      `<div><b>${inRange.length ? fmtNum(perDay) : '–'}</b><span>Pr. døgn</span></div>` +
      `<div><b>${avgTotal ? ht(avgTotal) : '–'}</b><span>Ammetid pr. døgn</span></div>` +
      `<div><b>${avgDur ? Math.round(avgDur) + '<small>min</small>' : '–'}</b><span>Varighed pr. amning</span></div>` +
      `<div><b>${avgGap ? ht(avgGap) : '–'}</b><span>Mellem amninger</span></div>`;

    // Kurve: ammetid pr. døgn, ældste til venstre
    const series = starts.slice().reverse().map(s => ({ s, ms: dayTotal(s) }));
    const max = Math.max(60 * 60e3, ...series.map(x => x.ms)) * 1.1;
    els.bars.innerHTML = series.map(x =>
      `<i class="${x.s === midnight() ? 'today' : ''}" style="height:${(x.ms / max * 100).toFixed(1)}%" title="${dayLabel(x.s)}: ${fmtTotal(x.ms) || '0 min'}"></i>`).join('') +
      (avgTotal ? `<span class="avg" style="bottom:${(avgTotal / max * 100).toFixed(1)}%"></span>` : '');
    els.chartAvg.textContent = avgTotal ? `Ø ${fmtTotalShort(avgTotal)}` : '';
    els.chartFrom.textContent = dayLabel(from);

    const open = new Set([...els.days.querySelectorAll('li.open')].map(li => li.dataset.start));
    els.days.innerHTML = '';
    starts.forEach((start, i) => {
      const list = inDay(start, all), total = dayTotal(start);
      const li = document.createElement('li');
      li.dataset.start = start;
      if (i === 0) li.classList.add('today');
      if (open.has(String(start))) li.classList.add('open');
      const chips = list.map(f => {
        const dur = f.d ? Math.max(1, Math.round(f.d / 60)) + ' min' : isLive(f) ? 'i gang' : f.u ? 'ikke stoppet' : '–';
        return `<button class="chip" data-t="${f.t}" ${isLive(f) ? 'disabled' : ''} aria-label="Ret amning kl. ${fmtTime(f.t)}"><i class="sd ${f.s}"></i><em>${fmtTime(f.t)}</em>${dur}</button>`;
      }).join('');
      li.innerHTML =
        `<button class="row" aria-expanded="${li.classList.contains('open')}" aria-label="${dayLabel(start)}: ${list.length} amninger, ${fmtTotal(total) || 'ingen ammetid'}"><span class="lbl">${dayLabel(start)}</span><span class="strip"></span><span class="cnt">${list.length || ''}<small>${fmtTotalShort(total)}</small></span></button>` +
        `<div class="detail">${chips}<button class="chip add" data-day="${start}">+ Tilføj</button></div>`;
      drawStrip(li.querySelector('.strip'), start);
      els.days.appendChild(li);
    });
  }
  els.days.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) {
      if (chip.dataset.day) openEditor({ dayStart: +chip.dataset.day });
      else openEditor({ feed: findFeed(+chip.dataset.t) });
      return;
    }
    const row = e.target.closest('.row');
    if (row) { const li = row.parentElement; li.classList.toggle('open'); row.setAttribute('aria-expanded', li.classList.contains('open')); }
  });

  function openSheet(el) { el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); el.scrollTop = 0; }
  function closeSheet(el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); }
  $('logBtn').addEventListener('click', () => { renderLog(); openSheet(els.sheet); });
  $('dayBtn').addEventListener('click', () => { renderLog(); openSheet(els.sheet); });
  $('closeLog').addEventListener('click', () => closeSheet(els.sheet));
  els.seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    logDays = +b.dataset.days;
    [...els.seg.children].forEach(x => x.classList.toggle('on', x === b));
    renderLog();
  });

  // ---------- Ret / tilføj amning ----------
  const ed = { time: $('edTime'), dur: $('edDur'), side: $('edSide'), err: $('edErr'), del: $('edDelete'), title: $('edTitle'), day: $('edDay') };
  let editing = null;   // { orig: t eller null, dayStart, side }
  let delArmed = null;

  function openEditor({ feed, dayStart }) {
    if (feed && isLive(feed)) return;
    const start = feed ? dayStartOf(feed.t) : dayStart;
    let t = feed ? feed.t : (start === midnight() ? Date.now() : start + 12 * 3600e3);
    const d = new Date(t);
    editing = { orig: feed ? feed.t : null, dayStart: start, side: feed ? feed.s : '' };
    ed.title.textContent = feed ? 'Ret amning' : 'Tilføj amning';
    ed.day.textContent = fmtDate(new Date(start));
    ed.time.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    ed.dur.value = feed && feed.d ? Math.max(1, Math.round(feed.d / 60)) : (feed ? '' : 15);
    ed.err.textContent = '';
    ed.del.hidden = !feed;
    ed.del.textContent = 'Slet amning'; delArmed = null;
    renderEdSide();
    els.editor.classList.add('open');
    els.editor.setAttribute('aria-hidden', 'false');
  }
  function closeEditor() { els.editor.classList.remove('open'); els.editor.setAttribute('aria-hidden', 'true'); editing = null; }
  function renderEdSide() { [...ed.side.children].forEach(b => b.classList.toggle('on', b.dataset.s === (editing.side.length === 2 ? 'LR' : editing.side))); }

  ed.side.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !editing) return;
    editing.side = editing.side === b.dataset.s ? '' : b.dataset.s;
    renderEdSide();
  });
  document.querySelector('#editor .stepper').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const v = Math.max(0, Math.min(180, (parseInt(ed.dur.value, 10) || 0) + +b.dataset.step));
    ed.dur.value = v;
  });
  els.editor.addEventListener('click', e => { if (e.target === els.editor) closeEditor(); });
  $('edCancel').addEventListener('click', closeEditor);

  $('edSave').addEventListener('click', () => {
    if (!editing) return;
    const [h, m] = (ed.time.value || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) { ed.err.textContent = 'Vælg et tidspunkt.'; return; }
    const d = new Date(editing.dayStart); d.setHours(h, m, 0, 0);
    let t = d.getTime();
    if (t > Date.now() + 60e3) { ed.err.textContent = 'Tidspunktet ligger ude i fremtiden.'; return; }
    const mins = parseInt(ed.dur.value, 10);
    const list = feeds().filter(f => f.t !== editing.orig);
    while (list.some(f => f.t === t)) t += 1;          // to amninger samme minut
    const rec = { t, d: mins > 0 ? mins * 60 : null, s: editing.side };
    list.push(rec);
    saveFeeds(list);
    haptic([20]);
    closeEditor();
    render();
    renderLog();
  });

  ed.del.addEventListener('click', () => {
    if (!editing || editing.orig == null) return;
    if (!delArmed) {
      ed.del.textContent = 'Tryk igen for at slette';
      delArmed = setTimeout(() => { ed.del.textContent = 'Slet amning'; delArmed = null; }, 3000);
      return;
    }
    clearTimeout(delArmed); delArmed = null;
    saveFeeds(feeds().filter(f => f.t !== editing.orig));
    haptic([30]);
    closeEditor();
    render();
    renderLog();
  });

  // ---------- Indstillinger ----------
  const goalVal = $('goalVal'), themeSeg = $('themeSeg'), scToggle = $('scToggle');
  function renderSettings() {
    const st = settings();
    goalVal.textContent = st.goal;
    [...themeSeg.children].forEach(b => b.classList.toggle('on', b.dataset.v === st.theme));
    scToggle.checked = !!st.shortcut;
    renderBackupInfo();
  }
  $('setBtn').addEventListener('click', () => { renderSettings(); openSheet(els.settings); });
  $('closeSet').addEventListener('click', () => { closeSheet(els.settings); render(); });
  $('goalStep').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSetting('goal', Math.max(1, Math.min(16, settings().goal + +b.dataset.step)));
    haptic([15]);
    renderSettings(); render();
  });
  themeSeg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSetting('theme', b.dataset.v);
    renderSettings(); applyTheme();
  });
  scToggle.addEventListener('change', () => setSetting('shortcut', scToggle.checked));
  $('scTest').addEventListener('click', () => runShortcut(settings().shortcutName));

  // ---------- Backup ----------
  const backupStatus = $('backupStatus');
  const needsBackup = () => {
    const last = store.get(K.backup, 0);
    return feeds().length >= 20 && Date.now() - last > 14 * 864e5;
  };
  function renderBackupInfo() {
    const last = store.get(K.backup, 0);
    const n = feeds().length;
    const when = !last ? 'Du har ikke gemt en backup endnu.'
      : dayStartOf(last) === midnight() ? 'Seneste backup: i dag.'
      : `Seneste backup: for ${Math.round((midnight() - dayStartOf(last)) / 864e5)} dage siden.`;
    $('backupInfo').textContent = `${n} amninger gemt på telefonen. ${when}`;
  }
  function markBackup() { store.set(K.backup, Date.now()); renderBackupInfo(); els.nudge.hidden = true; backupStatus.textContent = 'Backup gemt.'; }

  $('exportBtn').addEventListener('click', async () => {
    const data = { app: 'boobielicious', version: 2, exported: new Date().toISOString(), feeds: feeds(), settings: store.get(K.settings, {}) };
    const name = `boobielicious-backup-${dayKey()}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Boobielicious backup' }); markBackup(); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    markBackup();
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'boobielicious' || !Array.isArray(data.feeds)) throw new Error('format');
      const have = new Set(feeds().map(f => f.t));
      const incoming = data.feeds.filter(valid).map(f => ({ t: f.t, d: Number.isFinite(f.d) ? f.d : null, s: typeof f.s === 'string' ? f.s : '', ...(f.u ? { u: 1 } : {}) }));
      const added = incoming.filter(f => !have.has(f.t));
      saveFeeds(feeds().concat(added));
      backupStatus.textContent = added.length
        ? `${added.length} amninger hentet${incoming.length - added.length ? `, ${incoming.length - added.length} fandtes i forvejen` : ''}.`
        : 'Alle amninger i filen fandtes i forvejen.';
      renderBackupInfo(); render();
    } catch {
      backupStatus.textContent = 'Filen kunne ikke læses som en Boobielicious-backup.';
    }
  });

  // ---------- Fejring ----------
  function celebrate() {
    const goal = settings().goal;
    els.celText.textContent = `${WORDS[goal] || goal} i dag.`;
    const styles = getComputedStyle(document.documentElement);
    const colors = ['--areola', '--skin', '--side-r', '--sand-deep'].map(v => styles.getPropertyValue(v).trim());
    const pieces = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 34;
    for (let i = 0; i < pieces; i++) {
      const p = document.createElement('span');
      p.className = 'p ' + (Math.random() < .55 ? 'leaf' : 'dot');
      p.style.left = (Math.random() * 100) + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--drift', ((Math.random() - .5) * 120).toFixed(0) + 'px');
      p.style.setProperty('--spin', ((Math.random() - .5) * 540).toFixed(0) + 'deg');
      p.style.animationDuration = (7 + Math.random() * 5).toFixed(2) + 's';
      p.style.animationDelay = (Math.random() * 3.5).toFixed(2) + 's';
      p.addEventListener('animationend', () => p.remove());
      els.cel.appendChild(p);
    }
    els.msg.classList.add('show');
    setTimeout(() => els.msg.classList.remove('show'), 6500);
  }

  // ---------- Start ----------
  let currentDay = dayKey();
  setInterval(() => { const k = dayKey(); if (k !== currentDay) { currentDay = k; render(); } }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    cache = null;
    if (active()) keepAwake(true);
    tick(); render();
  });

  // Genåbnet midt i en amning: spring milepæle over, der allerede er passeret
  (() => {
    const a = active();
    if (!a) return;
    if (!findFeed(a.start)) { store.set(K.active, null); return; }
    const min = (Date.now() - a.start) / 60000;
    a.fired = MILESTONES.filter(m => min >= m);
    store.set(K.active, a);
    keepAwake(true);
  })();

  applyTheme();
  tick();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
