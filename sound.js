// Boobielicious – lyd og haptik.
// Lydene syntetiseres i Web Audio, renderes til små WAV-filer og afspilles i et <audio>-element.
(() => {
  const $ = id => document.getElementById(id);

  // Lyd: syntetiserede klokker i Web Audio (ingen lydfiler).
  // Hver tone er en lille klokke med uharmoniske overtoner, der klinger ud hver for sig,
  // et blødt anslag og en kort, varm rumklang. Alt går gennem en kompressor, så intet skærer.
  const Sound = (() => {
    const N = { D4: 293.66, A4: 440, D5: 587.33, E5: 659.25, Fs5: 739.99, A5: 880, B5: 987.77, D6: 1174.66 };
    // [frekvensforhold, styrke, efterklang i forhold til grundtonen]
    const PARTIALS = [[1, 1, 1], [2.0, .3, .62], [2.76, .14, .42], [4.07, .06, .3], [5.43, .035, .2]];

    function impulse(ctx, seconds, decay) {
      const rate = ctx.sampleRate, len = Math.floor(rate * seconds), pre = Math.floor(rate * .015);
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch); let lp = 0;
        for (let i = pre; i < len; i++) {
          const k = (i - pre) / (len - pre);
          const damp = .25 + .7 * k;                     // højtonerne dør hurtigere ud: varmere hale
          lp += (Math.random() * 2 - 1 - lp) * (1 - damp);
          d[i] = lp * Math.pow(1 - k, decay);
        }
      }
      return buf;
    }

    function engine(ctx) {
      const input = ctx.createGain();
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500; lp.Q.value = .4;
      const dry = ctx.createGain(); dry.gain.value = .85;
      const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 3.2, 2.8);
      const wet = ctx.createGain(); wet.gain.value = .3;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = .004; comp.release.value = .3;
      const out = ctx.createGain(); out.gain.value = 1.5;
      input.connect(hp).connect(lp);
      lp.connect(dry).connect(comp);
      lp.connect(verb).connect(wet).connect(comp);
      comp.connect(out).connect(ctx.destination);
      return { ctx, input };
    }

    // Én klokketone. vel 0–1, len = efterklang i sekunder, pan -1..1
    function bell(e, t, f, vel = .6, len = 3, pan = 0) {
      const { ctx } = e;
      const v = ctx.createGain(); v.gain.value = vel * .22;
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) { p.pan.value = pan; v.connect(p).connect(e.input); } else v.connect(e.input);
      PARTIALS.forEach(([r, a, d], i) => {
        const detunes = i === 0 ? [-2.5, 2.5] : [0];      // svag svævning i grundtonen giver liv
        detunes.forEach(c => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = f * r; o.detune.value = c;
          const amp = a * (i === 0 ? .55 : 1) * (1 - .35 * (1 - vel) * Math.min(i, 3) / 3);
          const atk = i === 0 ? .008 : .003;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(amp, t + atk);
          g.gain.exponentialRampToValueAtTime(.0001, t + len * d);
          o.connect(g).connect(v); o.start(t); o.stop(t + len * d + .05);
        });
      });
      // Blødt anslag: et kort pust af filtreret støj, som en filtkølle
      const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * .04), ctx.sampleRate);
      const nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length) ** 3;
      const ns = ctx.createBufferSource(); ns.buffer = nb;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 1.2;
      const ng = ctx.createGain(); ng.gain.value = .18 * vel;
      ns.connect(bp).connect(ng).connect(v); ns.start(t);
    }

    // Syngeskål: lav tone der svulmer op og svæver langsomt, til sikkerhedslyden
    function bowl(e, t, f, vel = .6, len = 5) {
      const { ctx } = e;
      const v = ctx.createGain(); v.connect(e.input);
      v.gain.setValueAtTime(0, t);
      v.gain.linearRampToValueAtTime(vel * .16, t + .35);
      v.gain.exponentialRampToValueAtTime(.0001, t + len);
      [[1, 1, 0], [1, .8, .9], [2.71, .18, 0], [5.2, .05, 0]].forEach(([r, a, beat]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f * r + beat; g.gain.value = a;
        o.connect(g).connect(v); o.start(t); o.stop(t + len + .05);
      });
    }

    const patterns = {
      // 10 min: to toner, en kvint op. Som et let skulderklap.
      10: (e, t) => { bell(e, t, N.D5, .5, 3.2, -.15); bell(e, t + .32, N.A5, .42, 3.6, .15); },
      // 15 min: en åben dur-brydning med en svag top. Rolig og varm.
      15: (e, t) => {
        bell(e, t, N.D5, .5, 3.2, -.2); bell(e, t + .26, N.Fs5, .44, 3.2, 0);
        bell(e, t + .52, N.A5, .44, 3.6, .2); bell(e, t + .86, N.D6, .26, 4, .1);
      },
      // 25 min: syngeskål under et tydeligt, men venligt klokkemotiv, spillet to gange.
      25: (e, t) => {
        bowl(e, t, N.D4, .9, 6);
        [0, 1.5].forEach((o, k) => {
          const v = k ? 1 : .85;
          bell(e, t + o, N.A5, v, 2.6, -.25); bell(e, t + o + .2, N.Fs5, v * .9, 2.6, .25);
          bell(e, t + o + .4, N.A5, v, 2.6, -.1); bell(e, t + o + .62, N.D6, v * .95, 3.4, .15);
        });
      }
    };
    return { engine, patterns };
  })();

  // Afspilning: lydene renderes én gang til små WAV-filer og spilles gennem et <audio>-element.
  // Lydfiler i et medieelement spiller på iPhone, også når lydløs-knappen er slået til.
  // Web Audio bruges kun som reserve.
  const player = $('player');
  const clips = {};
  let unlocked = false, ctx = null, eng = null;

  function toWav(b) {
    const ch = b.numberOfChannels, len = b.length, sr = b.sampleRate;
    const buf = new ArrayBuffer(44 + len * ch * 2), v = new DataView(buf);
    const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, len * ch * 2, true);
    const data = [...Array(ch)].map((_, i) => b.getChannelData(i));
    for (let i = 0, o = 44; i < len; i++) for (let c = 0; c < ch; c++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 32767, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  async function renderClips() {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return;
    for (const [name, secs] of [[10, 5], [15, 6], [25, 8]]) {
      try {
        const oc = new OAC(2, 44100 * secs, 44100);
        Sound.patterns[name](Sound.engine(oc), .05);
        clips[name] = toWav(await oc.startRendering());
      } catch {}
    }
    const oc = new OAC(1, 4410, 44100);   // 0,1 s stilhed til at låse afspilleren op
    clips.silence = toWav(await oc.startRendering());
  }
  renderClips();

  function unlockAudio() {
    try { if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; } catch {}
    if (!unlocked && clips.silence) {
      player.src = clips.silence;
      player.play().then(() => { unlocked = true; }).catch(() => {});
    }
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      eng = eng || Sound.engine(ctx);
    } catch {}
  }
  function play(name) {
    if (clips[name]) {
      player.src = clips[name];
      player.currentTime = 0;
      player.play().catch(() => playWebAudio(name));
    } else playWebAudio(name);
  }
  function playWebAudio(name) {
    if (!ctx || !eng) return;
    ctx.resume().then(() => Sound.patterns[name](eng, ctx.currentTime + .06)).catch(() => {});
  }

  // Haptik: Android har vibrate(). iPhone (iOS 18+) giver et lille tryk, når en skjult kontakt slås om.
  const hapticLabel = $('haptic');
  function haptic(pattern) {
    if (navigator.vibrate) { navigator.vibrate(pattern); return; }
    let t = 0;
    pattern.forEach((ms, i) => {
      if (i % 2 === 0) for (let k = 0; k < Math.max(1, Math.round(ms / 60)); k++) setTimeout(() => hapticLabel.click(), t + k * 60);
      t += ms;
    });
  }
  // Lyd + haptik for hver milepæl
  const cues = {
    10: () => { play(10); haptic([60, 260, 60]); },
    15: () => { play(15); haptic([60, 200, 60, 200, 60]); },
    25: () => { play(25); haptic([300, 150, 300, 150, 300, 400, 300, 150, 300, 150, 300]); }
  };
  const cue = m => cues[m] && cues[m]();
  const stopSound = () => { try { player.pause(); } catch {} };

  window.Boobie = { Sound, cue, unlockAudio, haptic, stopSound };
})();
