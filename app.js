// Ammetid – amme-tæller
(() => {
  'use strict';
  const { cue, unlockAudio, haptic, stopSound } = window.Boobie;

  // Nøglerne bærer appens gamle navn, så eksisterende data stadig findes
  const K = {
    feeds: 'boobielicious.v2.feeds',     // [{ t, d, s, u }] – t: start (ms), d: varighed (s) eller null, s: side ('L','R','LR','RL',''), u: 1 hvis ikke stoppet
    active: 'boobielicious.active',      // { start, fired: [minutter], paused?: tidspunkt, pausedMs?: samlet pause }
    settings: 'boobielicious.settings',
    cel: 'boobielicious.celebrated',
    backup: 'boobielicious.lastBackup',
    push: 'boobielicious.push',          // push-abonnement (kun når notifikationer er slået til)
    oldFeeds: 'boobielicious.feeds',     // v1-data
    oldDur: 'boobielicious.durations'
  };
  const MILESTONES = [10, 15, 25];       // minutter
  const FULL = 25;                       // ringen er fuld ved 25 min
  const AUTO_STOP = 90 * 60e3;           // glemt timer stoppes efter 90 min
  const HOLD_MS = 650;                   // hold for at stoppe
  const PAUSE_MAX = 60 * 60e3;           // glemt pause: amningen afsluttes efter en time
  const DEFAULTS = { goal: 8, theme: 'auto', shortcut: false, shortcutName: 'Amningstimer', push: false };
  // Notifikationsserveren (push/worker.js) og dens offentlige nøgle
  const PUSH_URL = 'https://ammetid-push.danielbalsby.workers.dev';
  const PUSH_KEY = 'BLLXRK8O3ob25RvFKh-2cjdA7ox07j4LLsHcscajn8sDCdrN-BiD2itSNFayC3p_0NTGhk4xBk4I8Ug8Au0sRo4';
  const WORDS = { 1: 'En', 2: 'To', 3: 'Tre', 4: 'Fire', 5: 'Fem', 6: 'Seks', 7: 'Syv', 8: 'Otte', 9: 'Ni', 10: 'Ti', 11: 'Elleve', 12: 'Tolv', 13: 'Tretten', 14: 'Fjorten', 15: 'Femten', 16: 'Seksten' };
  const SIDE = { L: 'venstre', R: 'højre' };

  const $ = id => document.getElementById(id);
  const els = {
    date: $('date'), n: $('n'), dots: $('dots'), sides: $('sides'), press: $('press'),
    clock: $('clock'), sub: $('sub'), arc: $('arc'), ticks: $('ticks'),
    strip: $('strip'), marks: $('marks'), total: $('total'), since: $('since'), nudge: $('nudge'),
    sheet: $('sheet'), seg: $('seg'), stats: $('stats'), days: $('days'),
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
  // Ammetid uden pauser
  const elapsed = (a, now = Date.now()) => now - a.start - (a.pausedMs || 0) - (a.paused ? now - a.paused : 0);
  const durMs = f => f.d ? f.d * 1000 : (isLive(f) ? elapsed(active()) : 0);
  const dayTotal = start => inDay(start).reduce((sum, f) => sum + durMs(f), 0);

  // Siderne: samme bryst to gange, så skift. En amning tæller for den side, den sluttede på.
  // run() fortæller hvilken side de seneste amninger var på, og om den sidste var nr. 1/2 eller 2/2.
  function run(list = feeds()) {
    const withSide = list.filter(f => f.s);
    if (!withSide.length) return null;
    const side = withSide[withSide.length - 1].s.slice(-1);
    let n = 0;
    for (let i = withSide.length - 1; i >= 0; i--) {
      const s = withSide[i].s;
      if (s.slice(-1) !== side) break;
      n++;
      if (s.length > 1) break;                  // skiftede side undervejs: tællingen starter her
    }
    return { side, pos: (n - 1) % 2 + 1 };
  }
  const nextPos = side => { const r = run(); return r && r.side === side ? r.pos % 2 + 1 : 1; };
  function suggestedSide() {
    const r = run();
    if (!r) return 'L';
    return r.pos === 1 ? r.side : (r.side === 'L' ? 'R' : 'L');
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
    document.querySelector('.count .of').textContent = goal ? `af ${goal}` : 'i dag';
    if (dotsFor !== goal) { els.dots.innerHTML = '<i></i>'.repeat(goal); dotsFor = goal; }
    [...els.dots.children].forEach((d, i) => d.classList.toggle('on', i < count));

    renderSides();
    drawDayline();
    renderTotal();
    renderSince();
    els.nudge.hidden = !needsBackup();
    if (els.sheet.classList.contains('open')) renderLog();
  }

  function renderSides() {
    const a = active(), f = a && findFeed(a.start);
    const on = f ? (f.s || '') : currentSide();
    const r = f ? run() : null;               // under en amning: hvilken gang i rækken denne er
    [...els.sides.children].forEach(b => {
      const x = b.dataset.side, isOn = on.includes(x);
      b.classList.toggle('on', isOn);
      const pos = !isOn ? '' : f ? (r && r.side === x && on.slice(-1) === x ? r.pos : '') : nextPos(x);
      b.querySelector('.nth').textContent = pos ? `${pos}/2` : '';
    });
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

  // Forsiden: de seneste 24 timer, højre ende er "nu". Én prik pr. amning;
  // amninger tæt på hinanden samles til én lidt større prik.
  const WINDOW = 24 * 3600e3, CLUSTER = 45 * 60e3;
  function drawDayline() {
    const now = Date.now(), from = now - WINDOW;
    const pos = t => ((t - from) / WINDOW * 100).toFixed(2) + '%';
    const groups = [];
    feeds().filter(f => f.t >= from && f.t <= now).forEach(f => {
      const g = groups[groups.length - 1];
      if (g && f.t - g.last < CLUSTER) { g.n++; g.last = f.t; g.live = g.live || isLive(f); }
      else groups.push({ first: f.t, last: f.t, n: 1, live: isLive(f) });
    });
    let html = '', labels = '';
    // Pejlemærker: kl. 00, 06, 12 og 18 glider med, ligesom prikkerne
    for (let t = dayStartOf(from); t <= now; t += 6 * 3600e3) {
      const pct = (t - from) / WINDOW * 100;
      if (pct <= 0 || pct >= 100) continue;
      html += `<i class="mid" style="left:${pct.toFixed(2)}%"></i>`;
      if (pct > 5 && pct < 90) labels += `<span style="left:${pct.toFixed(2)}%">${pad(new Date(t).getHours())}</span>`;
    }
    groups.forEach(g => {
      const size = g.n === 1 ? 7 : g.n === 2 ? 10 : 12;
      html += `<i class="p${g.live ? ' live' : ''}" style="left:${pos((g.first + g.last) / 2)};width:${size}px;height:${size}px;margin:-${size / 2}px 0 0 -${size / 2}px"></i>`;
    });
    els.strip.innerHTML = html;
    els.marks.innerHTML = labels;
  }

  function renderTotal() {
    const from = Date.now() - WINDOW;
    const ms = feeds().filter(f => f.t >= from).reduce((sum, f) => sum + durMs(f), 0);
    els.total.textContent = ms ? fmtTotal(ms) : '';
  }

  function renderSince() {
    const list = feeds();
    if (!list.length) { els.since.textContent = 'Tryk på brystet, når I begynder'; return; }
    // Kun ét 1/2-tal på skærmen: sidevalget viser det for næste amning, så her står kun siden
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

  // ---------- Råd (Sundhedsstyrelsen) ----------
  // Korte, generelle råd. Øverst i Råd står det, der passer til tidspunktet og rytmen lige nu.
  const ADVICE = [
    { id: 'cues', title: 'Før gråden',
      body: 'Barnet fortæller, at det er sultent, før det græder. Det sutter, savler, putter fingre i munden, åbner munden og drejer hovedet fra side til side. Læg det til ved de tegn, også om natten. Gråd er et sent tegn, og så kan det være sværere at få godt fat.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'same', title: 'Samme bryst, til barnet slipper',
      body: 'Mælkens sammensætning ændrer sig undervejs. Den første slukker tørsten, den senere er mere mættende. Læg barnet til samme bryst flere gange, indtil det selv afviser det, og tilbyd først derefter det andet. 1/2 og 2/2 er appens måde at huske det på: bliv ved det bryst, I er i gang med, og skift bagefter.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'eight', title: 'Mindst otte i starten',
      body: 'Den nyfødtes mave er lille, så måltiderne er mange og små. I de første uger skal der mindst otte ammemåltider til i døgnet, også om natten, for at mætte barnet og holde mælken i gang. Senere kan der godt være færre, og en tår indimellem. Tallet på forsiden er jeres eget mål og kan ændres i Indstillinger.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'evening', title: 'Tættere om aftenen',
      body: 'Nogle måltider er lange, andre ligger tæt. Det er især om aftenen, barnet ofte vil ammes hyppigere. Følg rytmen. Vil det ammes næsten uafbrudt, kan det også være, at det ikke fik den mættende mælk til sidst på brystet, eller at det ikke har godt fat. Er I i tvivl, så spørg sundhedsplejersken.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'night', title: 'Også om natten',
      body: 'I starten skelner barnet ikke mellem nat og dag. Det skal ammes en eller flere gange om natten for at få nok i løbet af døgnet, og for at mælken bliver ved med at blive dannet. Mindst otte måltider i døgnet hører med, så længe barnet er helt lille.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'diapers', title: 'Bleen siger mere end uret',
      body: 'Hvor meget der kommer ind, kan ikke ses. Bleen giver et indtryk. Når de første dage er gået, er mindst seks tunge, våde bleer i døgnet, synkelyde ved brystet og mindst otte måltider, mens barnet er lille, tegn på, at det får nok. I de første dage er der færre våde bleer. Vægten følges på en kurve hos sundhedsplejersken og lægen. Den må gerne svinge lidt.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'supply', title: 'Mælken følger barnet',
      body: 'Mængden retter sig efter det, barnet tager. Den kan ikke gemmes til senere. Vil barnet pludselig ammes oftere, er det ofte, fordi det er vokset. Læg det til oftere, også om natten, og lad det blive færdigt ved det ene bryst, før I tilbyder det andet. Overvejer I modermælkserstatning, så tal med sundhedsplejersken. Gives det, er det efter amningen.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'water', title: 'Tørsten',
      body: 'Modermælk dækker både mad og væske og beskytter mod væskemangel. Så længe barnet ammes fuldt, behøver det ikke vand ved siden af.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'latch', title: 'Når det gør ondt',
      body: 'I de første uger er ømme brystvorter almindelige, især lige når barnet tager fat. Gør det stadig ondt efter et par minutter, har barnet sandsynligvis ikke godt fat. Munden skal dække det brune område, læberne være krænget ud, og hagen røre brystet. Der skal være rytmiske sut og synk. Tilbagelænet stilling giver mindre træk. Slip brystet ved at stikke en finger i barnets mundvig. En dråbe mælk på brystvorten bagefter plejer huden. Fortsætter det, så tal med sundhedsplejersken.',
      source: 'Sundhedsstyrelsen, Sunde børn, og Amning – en håndbog for sundhedspersonale (2023)' },
    { id: 'breast', title: 'Hårdt, ømt eller rødt',
      body: 'Spænding, knuder og brystbetændelse hænger sammen. Amningen fortsætter efter barnets behov, og det er ikke et mål at tømme brystet. Brug pumpen mindst muligt, så produktionen ikke presses op over det, barnet tager. Kølige omslag i 10 til 20 minutter mellem amningerne kan dæmpe hævelse og smerte. Dyb massage kan skade vævet. Tilbagelænet stilling og godt fat hjælper. Føler du dig sløj eller får feber, så kontakt lægen. Amningen fortsætter, også hvis du får antibiotika.',
      source: 'Sundhedsstyrelsen, Amning – en håndbog for sundhedspersonale (2023)' },
    { id: 'months', title: 'Hvor længe',
      body: 'Spædbørn ammes fuldt, til de er omkring seks måneder, og delvist til de er tolv måneder eller længere, hvis I trives med det. Overgangskosten introduceres tidligst fra fire måneder og ikke meget efter seks. Vokser barnet, som det skal, så vent til tæt på seks måneder. Fra seks måneder skal maden være jernholdig, med kød eller fisk til de fleste måltider. Børn, der ikke ammes, skal have modermælkserstatning hele første leveår.',
      source: 'Sundhedsstyrelsen, Sunde børn, Amning – en håndbog for sundhedspersonale (2023) og vejledningen om vitamin og jern' },
    { id: 'vitamin', title: 'D-vitamin',
      body: 'Alle børn skal have 10 mikrogram D-vitamin om dagen fra de er to uger, hele året, til de fylder fire år. Det gælder også børn, der ammes. Dråberne skal være beregnet til spædbørn og gives i munden eller på en ske, ikke i en flaske. Børn, der hver dag drikker mindst 800 ml modermælkserstatning med mindst 1,3 mikrogram D-vitamin pr. 100 ml, skal ikke have ekstra dråber i den periode.',
      source: 'Sundhedsstyrelsen og Fødevarestyrelsen' },
    { id: 'sut', title: 'Sut',
      body: 'Mens amningen er ved at komme i gang, og når der er knuder i brystet, er suttebehovet bedst brugt ved brystet. Når amningen er kommet godt i gang, kan I overveje en sut. Giv den første gang, når barnet er roligt, ikke mens det græder.',
      source: 'Sundhedsstyrelsen, Sunde børn' },
    { id: 'self', title: 'Dig selv',
      body: 'Undgå rygning. Kan du ikke holde op, så ryg efter amningen. Den, der ammer, bør være tilbageholdende med alkohol: højst én genstand på en dag, og vent to til tre timer med næste amning. Nogle få genstande om ugen er ikke en grund til at stoppe. Højst tre kopper kaffe om dagen. Nødvendig medicin aftales med lægen.',
      source: 'Sundhedsstyrelsen, anbefalinger om alkohol, og Sunde børn' },
    { id: 'call', title: 'Ring hellere en gang for meget',
      body: 'Kontakt sundhedsplejersken eller lægen, hvis barnet er svært at vække til måltiderne eller sutter svagt, får færre våde bleer end før eller har mørk urin, bliver mere gult i huden eller i det hvide i øjnene, eller ikke tager på. Har et barn under tre måneder feber, altså 38 grader eller mere, så ring altid til lægen. Uden for lægens åbningstid ringer I til lægevagten, i Region Hovedstaden 1813. Ved livsfare: 112.',
      source: 'Sundhedsstyrelsen, Sunde børn, og sundhed.dk' },
  ];
  const ADVICE_GROUPS = [
    { title: 'Måltidet', ids: ['cues', 'same', 'eight', 'evening', 'night'] },
    { title: 'Om barnet får nok', ids: ['diapers', 'supply', 'water', 'call'] },
    { title: 'Når brystet gør ondt', ids: ['latch', 'breast'] },
    { title: 'Hen ad vejen', ids: ['months', 'vitamin', 'sut'] },
    { title: 'Dig selv', ids: ['self'] },
  ];
  const ADVICE_POOL = ['cues', 'same', 'eight', 'diapers', 'supply', 'latch', 'vitamin', 'months', 'water'];
  const adviceById = id => ADVICE.find(t => t.id === id);

  function adviceId() {
    const now = Date.now(), h = new Date().getHours(), list = feeds();
    if (!list.length) return 'cues';
    const last = list[list.length - 1];
    if (list.filter(f => now - f.t < 3 * 3600e3).length >= 3) return 'evening';
    if (last.d && last.d < 5 * 60 && now - (last.t + last.d * 1000) < 30 * 60e3) return 'same';
    if (h >= 17 && h < 22) return 'evening';
    if (h >= 22 || h < 6) return 'night';
    if (!isLive(last) && now - last.t - durMs(last) > 4 * 3600e3 && h >= 6 && h < 17) return 'eight';
    return ADVICE_POOL[Math.floor(now / 86400000) % ADVICE_POOL.length];
  }

  function renderAdviceSheet() {
    const now = adviceById(adviceId());
    const card = t => `<h4>${t.title}</h4><p>${t.body}</p><p class="src">${t.source}</p>`;
    $('adviceList').innerHTML =
      `<article class="adv-now"><span class="k">Lige nu</span>${card(now)}</article>` +
      ADVICE_GROUPS.map(g =>
        `<section class="adv-block"><h3>${g.title}</h3>` +
        g.ids.filter(id => id !== now.id).map(id => `<article${id === 'call' ? ' class="call"' : ''}>${card(adviceById(id))}</article>`).join('') + '</section>'
      ).join('');
  }

  $('adviceBtn').addEventListener('click', () => { renderAdviceSheet(); openSheet($('adviceSheet')); });
  $('closeAdvice').addEventListener('click', () => closeSheet($('adviceSheet')));

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
    drawDayline();
  });

  // ---------- Tidtagning ----------
  const R = 108;
  [10, 15].forEach(m => {
    const ang = (m / FULL) * 2 * Math.PI;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', 'tick'); c.dataset.m = m; c.style.setProperty('--at', m / FULL);
    c.setAttribute('cx', 110 + R * Math.cos(ang)); c.setAttribute('cy', 110 + R * Math.sin(ang)); c.setAttribute('r', 2.2);
    els.ticks.appendChild(c);
  });

  let subTimer = null;
  const subDefault = () => active()?.paused ? 'På pause · tryk for at fortsætte' : 'Tryk for pause · hold for at stoppe';
  const resetSub = () => { clearTimeout(subTimer); els.sub.textContent = subDefault(); };
  function flashSub(text) {
    els.sub.textContent = text;
    clearTimeout(subTimer);
    subTimer = setTimeout(resetSub, 2600);
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch {}
  }

  function pulse() {
    // Den første bølge skal ende præcis på tidsringen, uanset brystets størrelse
    els.press.style.setProperty('--to-track', (els.press.offsetWidth + 28) / els.press.offsetWidth);
    els.press.classList.remove('pulse', 'starting'); void els.press.offsetWidth; els.press.classList.add('pulse');
  }

  function startFeed() {
    const now = Date.now();
    const list = feeds().slice();
    list.push({ t: now, d: null, s: currentSide() });
    saveFeeds(list);
    store.set(K.active, { start: now, fired: [] });
    chosenSide = null;
    keepAwake(true);
    resetSub();
    pulse();
    els.press.classList.add('starting');      // ringen tegnes, prikkerne og dråben kommer frem
    tick();
    render({ animate: true });

    const goal = settings().goal;
    if (goal && inDay(midnight()).length === goal && store.get(K.cel, '') !== dayKey()) {
      store.set(K.cel, dayKey());
      setTimeout(celebrate, 600);
    }
    const st = settings();
    if (st.shortcut) setTimeout(() => runShortcut(st.shortcutName), 450);
    if (st.push) pushCall('/schedule', { start: now, label: pushLabel() });
  }

  // Tekst til notifikationen, fx "Venstre 1/2"
  function pushLabel() {
    const a = active(), f = a && findFeed(a.start), r = run();
    if (!f || f.s.length !== 1 || !r) return '';
    return `${SIDE[f.s][0].toUpperCase()}${SIDE[f.s].slice(1)} ${r.pos}/2`;
  }

  // Pause: uret står stille, notifikationerne holder pause, og pausen tæller ikke med i varigheden
  function pauseFeed() {
    const a = active();
    if (!a || a.paused) return;
    a.paused = Date.now();
    store.set(K.active, a);
    pushCancel();
    keepAwake(false);
    haptic([20]);
    resetSub(); tick(); render();
  }
  function resumeFeed() {
    const a = active();
    if (!a || !a.paused) return;
    const now = Date.now();
    a.pausedMs = (a.pausedMs || 0) + (now - a.paused);
    delete a.paused;
    store.set(K.active, a);
    if (settings().push) pushCall('/schedule', { start: now - elapsed(a, now), label: pushLabel() });   // samme milepæle, rykket med pausen
    keepAwake(true);
    haptic([20]);
    pulse();
    resetSub(); tick(); render();
  }

  function stopFeed({ unfinished = false } = {}) {
    const a = active();
    if (!a) return;
    const list = feeds().slice(), f = list.find(x => x.t === a.start);
    if (f) {
      if (unfinished) { f.d = null; f.u = 1; }
      else { f.d = Math.max(1, Math.round(elapsed(a) / 1000)); delete f.u; }
      saveFeeds(list);
    }
    store.set(K.active, null);
    pushCancel();
    els.press.classList.remove('starting');
    stopAlarm();
    keepAwake(false);
    resetSub();
    tick();
    render();
    return f;
  }

  // Fortryd vises kort efter et start eller stop. Ellers rettes og slettes amninger i Historik.
  // Efter et start slettes amningen igen; efter et stop fortsætter den, som om den aldrig var stoppet.
  let toastTimer = null, toastFeed = null, toastResume = null;
  function toast(text, t, ms, resume = null, earlier = false) {
    toastFeed = t;
    toastResume = resume;
    $('toastText').textContent = text;
    $('toastEarlier').hidden = !earlier || earliestStart(t) >= t;
    $('toast').classList.add('show');
    $('toast').parentElement.classList.add('toasting');
    $('toast').setAttribute('aria-hidden', 'false');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').classList.remove('show');
    $('toast').parentElement.classList.remove('toasting');
    $('toast').setAttribute('aria-hidden', 'true');
    toastFeed = null; toastResume = null;
  }
  // Glemte at trykke: rykker starten 5 min tilbage pr. tryk, dog ikke ind i forrige amning og højst en time
  const EARLIER_STEP = 5 * 60e3, EARLIER_MAX = 60 * 60e3;
  function earliestStart(t) {
    const prev = feeds().filter(f => f.t < t).pop();
    const prevEnd = prev ? prev.t + (prev.d || 0) * 1000 + 60e3 : -Infinity;
    return Math.max(Date.now() - EARLIER_MAX, prevEnd);
  }
  $('toastEarlier').addEventListener('click', () => {
    const a = active();
    if (!a || a.start !== toastFeed) return;
    let t = Math.max(a.start - EARLIER_STEP, earliestStart(a.start));
    if (t >= a.start) return;
    const list = feeds().slice(), f = list.find(x => x.t === a.start);
    while (list.some(x => x.t === t)) t -= 1;
    f.t = t; a.start = t;
    a.fired = MILESTONES.filter(m => elapsed(a) / 60000 >= m);   // ingen klokke for minutter, der allerede er gået
    saveFeeds(list);
    store.set(K.active, a);
    if (settings().push && !a.paused) pushCall('/schedule', { start: Date.now() - elapsed(a), label: pushLabel() });
    haptic([15]);
    toast(`Startet kl. ${fmtTime(t)}`, t, 6000, null, true);
    tick(); render();
  });
  function stopWithUndo() {
    const a = active(), f = stopFeed();
    if (f && f.d) toast(`Gemt · ${Math.max(1, Math.round(f.d / 60))} min`, f.t, 8000, a);
  }
  $('toastUndo').addEventListener('click', () => {
    const f = findFeed(toastFeed), resume = toastResume;
    hideToast();
    if (!f || (resume && active())) return;
    if (resume) {
      const list = feeds().slice(), g = list.find(x => x.t === f.t);
      g.d = null; delete g.u;
      saveFeeds(list);
      store.set(K.active, resume);
      if (!resume.paused) {
        keepAwake(true);
        if (settings().push) pushCall('/schedule', { start: Date.now() - elapsed(resume), label: pushLabel() });
      }
    } else {
      if (isLive(f)) { store.set(K.active, null); pushCancel(); stopAlarm(); keepAwake(false); els.press.classList.remove('starting'); }
      saveFeeds(feeds().filter(x => x.t !== f.t));
      chosenSide = null;
    }
    haptic([20]);
    resetSub(); tick(); render();
  });

  function tick() {
    applyTheme();
    const a = active();
    document.body.classList.toggle('timing', !!a);
    document.body.classList.toggle('paused', !!a?.paused);
    els.press.setAttribute('aria-label', !a ? 'Start amning' : a.paused ? 'Fortsæt amningen. Hold for at stoppe' : 'Sæt amningen på pause. Hold for at stoppe');
    if (!a) {
      els.arc.style.strokeDasharray = '0 1';
      drawDayline();
      renderSince();
      return;
    }
    const ms = elapsed(a), min = ms / 60000;
    if (a.paused && Date.now() - a.paused > PAUSE_MAX) { stopFeed(); return; }   // varigheden er tiden før pausen
    if (ms > AUTO_STOP) { stopFeed({ unfinished: true }); return; }
    drawDayline();
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
      stopWithUndo();
    }, HOLD_MS);
  });
  const cancelHold = () => { clearTimeout(holdTimer); els.press.classList.remove('holding'); };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => els.press.addEventListener(ev, cancelHold));
  els.press.addEventListener('click', () => {
    if (held) { held = false; return; }
    const a = active();
    if (a) { if (a.paused) resumeFeed(); else pauseFeed(); return; }
    const now = Date.now();
    if (now - lastTap < 800) return;           // undgå utilsigtede dobbelttryk
    lastTap = now;
    unlockAudio();
    haptic([30]);
    startFeed();
    toast('Amning startet', active().start, 6000, null, true);
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
  $('awakeBtn').addEventListener('click', () => { haptic([30]); stopAlarm(); pushCancel(); });
  $('endBtn').addEventListener('click', () => { haptic([30]); stopWithUndo(); });
  document.addEventListener('pointerdown', () => unlockAudio());   // også når appen genåbnes midt i en amning

  // ---------- Notifikationer på låst skærm ----------
  // Serveren får kun push-adressen, starttidspunktet og fx "Venstre 1/2" – og glemmer det, når amningen slutter.
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function urlKey(b64) {
    const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64.length % 4) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  async function pushSub(create = false) {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(PUSH_KEY) });
    if (sub) store.set(K.push, sub.toJSON());
    return sub;
  }
  async function pushCall(path, data = {}) {
    try {
      const sub = (await pushSub()) || null;
      const json = sub ? sub.toJSON() : store.get(K.push, null);
      if (!json) return false;
      const res = await fetch(PUSH_URL + path, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: json, ...data }),
      });
      return res.ok;
    } catch { return false; }
  }
  const pushCancel = () => { if (settings().push) pushCall('/cancel'); };

  async function enablePush() {
    if (!pushSupported() || !standalone()) throw new Error('Åbn Ammetid fra hjemmeskærmen for at slå notifikationer til (kræver iOS 16.4 eller nyere).');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifikationer er ikke tilladt. Slå dem til under Indstillinger › Notifikationer › Ammetid.');
    await pushSub(true);
    setSetting('push', true);
    const a = active();
    if (a) pushCall('/schedule', { start: a.start, label: '' });
  }
  async function disablePush() {
    await pushCall('/cancel');
    setSetting('push', false);
    try { const sub = await pushSub(); if (sub) await sub.unsubscribe(); } catch {}
    store.set(K.push, null);
  }

  // ---------- iPhone-timer via Genveje ----------
  function runShortcut(name) {
    location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(name);
  }

  // ---------- Historik ----------
  let logDays = 7;
  function renderLog({ fresh = false } = {}) {
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
    $('statsNote').textContent = fullDays.length
      ? `Tal pr. døgn er gennemsnit af ${fullDays.length === 1 ? 'ét helt døgn' : `${fullDays.length} hele døgn`}. I dag tæller med, når døgnet er omme.`
      : '';

    const open = fresh ? new Set([String(midnight())]) : new Set([...els.days.querySelectorAll('li.open')].map(li => li.dataset.start));
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
  // Træk ned fra toppen for at lukke, så Luk-knappen oppe i hjørnet ikke er den eneste vej ud med én hånd
  document.querySelectorAll('.sheet').forEach(el => {
    let y0 = null, dy = 0;
    el.addEventListener('touchstart', e => {
      y0 = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
      dy = 0;
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (y0 === null) return;
      dy = e.touches[0].clientY - y0;
      if (dy <= 0) { y0 = null; el.style.transform = ''; el.style.transition = ''; return; }
      e.preventDefault();
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
    }, { passive: false });
    const end = () => {
      if (y0 === null) return;
      y0 = null;
      el.style.transition = ''; el.style.transform = '';
      if (dy > 110) el.querySelector('.close').click();
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', () => { dy = 0; end(); });
  });
  const openLog = () => { renderLog({ fresh: true }); openSheet(els.sheet); };
  $('logBtn').addEventListener('click', openLog);
  $('dayBtn').addEventListener('click', openLog);
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
  const goalVal = $('goalVal'), themeSeg = $('themeSeg'), scToggle = $('scToggle'), pushToggle = $('pushToggle'), pushStatus = $('pushStatus');
  function renderSettings() {
    const st = settings();
    goalVal.textContent = st.goal || '–';
    $('goalHelp').textContent = st.goal ? 'Antal amninger pr. døgn' : 'Intet mål. Forsiden viser kun antallet';
    [...themeSeg.children].forEach(b => b.classList.toggle('on', b.dataset.v === st.theme));
    scToggle.checked = !!st.shortcut;
    // Genveje-timeren er en nødløsning fra før notifikationerne: kun for dem, der bruger den, eller hvis push ikke findes
    if (st.shortcut || !pushSupported()) $('scSection').hidden = false;
    pushToggle.checked = !!st.push;
    $('pushTestRow').hidden = !st.push;
    renderBackupInfo();
  }
  $('setBtn').addEventListener('click', () => { renderSettings(); openSheet(els.settings); });
  $('closeSet').addEventListener('click', () => { closeSheet(els.settings); render(); });
  $('goalStep').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSetting('goal', Math.max(0, Math.min(16, settings().goal + +b.dataset.step)));
    haptic([15]);
    renderSettings(); render();
  });
  themeSeg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSetting('theme', b.dataset.v);
    renderSettings(); applyTheme();
  });
  scToggle.addEventListener('change', () => setSetting('shortcut', scToggle.checked));
  pushToggle.addEventListener('change', async () => {
    pushStatus.textContent = '';
    try {
      if (pushToggle.checked) { await enablePush(); pushStatus.textContent = 'Slået til. Tryk “Send en prøve” for at se, hvordan det ser ud.'; }
      else { await disablePush(); pushStatus.textContent = 'Slået fra.'; }
    } catch (err) {
      pushToggle.checked = false; setSetting('push', false);
      pushStatus.textContent = err.message || 'Det lykkedes ikke. Prøv igen.';
    }
    renderSettings();
  });
  $('pushTest').addEventListener('click', async () => {
    pushStatus.textContent = 'Sender …';
    pushStatus.textContent = await pushCall('/test') ? 'Sendt. Den bør dukke op om et øjeblik.' : 'Kunne ikke sende. Tjek internetforbindelsen.';
  });
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
    const data = { app: 'ammetid', version: 2, exported: new Date().toISOString(), feeds: feeds(), settings: store.get(K.settings, {}) };
    const name = `ammetid-backup-${dayKey()}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Ammetid backup' }); markBackup(); return; }
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
      if (!data || !['ammetid', 'boobielicious'].includes(data.app) || !Array.isArray(data.feeds)) throw new Error('format');
      const have = new Set(feeds().map(f => f.t));
      // Kun kendte værdier: siden indgår i HTML-klasser, så en redigeret fil må ikke kunne smugle kode ind
      const incoming = data.feeds.filter(valid).map(f => ({
        t: f.t,
        d: Number.isFinite(f.d) && f.d > 0 ? Math.round(f.d) : null,
        s: ['L', 'R', 'LR', 'RL'].includes(f.s) ? f.s : '',
        ...(f.u ? { u: 1 } : {})
      }));
      const added = incoming.filter(f => !have.has(f.t));
      saveFeeds(feeds().concat(added));
      backupStatus.textContent = added.length
        ? `${added.length} amninger hentet${incoming.length - added.length ? `, ${incoming.length - added.length} fandtes i forvejen` : ''}.`
        : 'Alle amninger i filen fandtes i forvejen.';
      renderBackupInfo(); render();
    } catch {
      backupStatus.textContent = 'Filen kunne ikke læses som en Ammetid-backup.';
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
    if (active() && !active().paused) keepAwake(true);
    tick(); render();
  });

  // Genåbnet midt i en amning: spring milepæle over, der allerede er passeret
  (() => {
    const a = active();
    if (!a) return;
    if (!findFeed(a.start)) { store.set(K.active, null); return; }
    const min = elapsed(a) / 60000;
    a.fired = MILESTONES.filter(m => min >= m);
    store.set(K.active, a);
    resetSub();
    if (!a.paused) keepAwake(true);
  })();

  applyTheme();
  tick();
  render();

  // ---------- Opstart ----------
  // Brystet bygges op, "Ammetid" skrives frem, og brystet glider ned på sin plads i appen.
  // Fuld udgave ved kold start, kort udgave (kun brystet) når appen hentes frem fra baggrunden.
  // Et tryk springer over. Under en amning vises ingen intro – så er timeren det vigtige.
  const intro = (() => {
    const splash = $('splash'), mark = $('spMark'), root = document.documentElement;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let done = true, handoff = null, cleanup = null, quick = false;

    function reset(short = false) {
      quick = short;
      splash.classList.toggle('quick', quick);
      clearTimeout(handoff); clearTimeout(cleanup);
      done = false;
      splash.classList.remove('play', 'font', 'out');
      els.press.classList.remove('arrive');
      splash.classList.toggle('live', !!active());     // dråben er kun med under en amning
      mark.style.transition = 'none';
      mark.style.transform = '';
      els.press.style.opacity = '';
      splash.hidden = false;
      root.classList.add('intro');
    }

    function finish(fast) {
      if (done) return;
      done = true;
      clearTimeout(handoff);
      const a = mark.getBoundingClientRect(), b = els.press.getBoundingClientRect();
      const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
      const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      const k = b.width / a.width;
      const ms = reduce ? 0 : fast ? 360 : quick ? 520 : 860;
      splash.classList.add('out');
      root.classList.remove('intro');
      els.press.style.transition = 'none';
      els.press.style.opacity = '0';
      if (ms) {
        mark.style.transition = `transform ${ms}ms cubic-bezier(.55,0,.15,1)`;
        mark.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
      }
      cleanup = setTimeout(() => {
        els.press.style.opacity = '';
        els.press.classList.add('arrive');          // teksten under brystet toner frem
        setTimeout(() => els.press.classList.remove('arrive'), 1000);
        splash.hidden = true;
        requestAnimationFrame(() => { els.press.style.transition = ''; });
      }, ms + 20);
    }

    function play() {
      if (document.body.classList.contains('alarm')) { finish(true); return; }   // alarmen må ikke dækkes
      if (reduce) { handoff = setTimeout(() => finish(), quick ? 150 : 350); return; }
      if (quick) {
        void splash.offsetWidth;
        splash.classList.add('play');
        handoff = setTimeout(() => finish(), 380);
        return;
      }
      // Brystet starter med det samme; ordet venter kort på skrifttypen, så det ikke skifter form undervejs
      void splash.offsetWidth;                         // genstart animationerne
      splash.classList.add('play');
      handoff = setTimeout(() => finish(), 1700);
      const font = document.fonts && document.fonts.load ? document.fonts.load('italic 40px "Cormorant Garamond"') : Promise.resolve();
      Promise.race([font, new Promise(r => setTimeout(r, 300))]).then(() => { if (!done) splash.classList.add('font'); });
    }

    function skip() {
      clearTimeout(handoff); clearTimeout(cleanup);
      done = true;
      splash.classList.remove('play', 'font', 'out');
      splash.hidden = true;
      root.classList.remove('intro');
      mark.style.transition = 'none';
      mark.style.transform = '';
      els.press.style.opacity = '';
      els.press.style.transition = '';
    }

    splash.addEventListener('pointerdown', () => finish(true));
    return { reset, play, skip, get done() { return done; } };
  })();

  if (active()) intro.skip();
  else { intro.reset(); intro.play(); }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {                                 // klar før appen ses igen
      if (active()) intro.skip(); else intro.reset(true);
      return;
    }
    if (active()) { intro.skip(); return; }
    if (intro.done) intro.reset(true);
    intro.play();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  // Bed browseren om ikke at rydde historikken, når telefonen mangler plads
  if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {});
})();
