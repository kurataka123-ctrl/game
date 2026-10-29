/* ================================================================
   sound.js ― 音を鳴らす仕組み（設計書 第13節「音とエフェクト」）
   ----------------------------------------------------------------
   ふだんは編集しなくて大丈夫です。
     ・どの場面で、どの音を鳴らすか → data.js（行の sound、場面の ambient・mute など）
     ・はじめから音を鳴らすか        → data.js の SETTINGS.sound
   ・音は Web Audio API で、その場で合成します。音声ファイルは使いません
     （PCで index.html を直接開いても鳴り、GitHub に音源を置かずに済む）。
   ・ポケモンのゲームやアニメの曲・効果音には似せていません（和音や短い音を組み合わせた、手作りの音です）。
   ・iPhone の Safari では、最初に画面をタップするまで鳴りません。マナーモードでは鳴らないこともあります。
     鳴らせないときは何もせずに先へ進むので、ゲームは止まりません。
   ・鳴らし方は3通り（engine.js が場面ごとに切りかえる）
       full ：全部の音（PCの場面）
       short：短い通知音だけ（iPhoneの家の中の場面。正解音・不正解音など）
       off  ：鳴らさない（第3部の外の場面）
   ================================================================ */
(() => {
  "use strict";

  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  let ctx = null;          // 音を鳴らす場所（最初に画面をさわったときに作る）
  let bus = null;          // 全部の音が通る道（音量・音割れ防止・音の大きさを測る部品）
  let on = true;           // 遊ぶ人の設定（ON/OFF）
  let mode = "full";       // full / short / off（上の説明）
  let saveKey = "";        // ON/OFF を記録する名前
  let want = null;         // 鳴らしたい環境音（風など。鳴らせるようになったら始める）
  let amb = null;          // 鳴っている環境音 { name, stop }
  const last = {};         // 音の名前 → 最後に鳴らした時刻（同じ音が二重に重ならないように）

  // ==============================================================
  // 音を作る部品（c：AudioContext、out：つなぎ先、t：鳴らし始める時刻〔秒〕）
  // ==============================================================
  const EPS = 0.0001;

  // 「ポン」という音：高さ freq（to を書くと、その高さへすべる）、長さ dur、音量 gain
  //   type：sine（やわらかい）/ triangle（少し明るい）/ square・sawtooth（電気っぽい）
  function tone(c, out, t, o) {
    const osc = c.createOscillator();
    const g = c.createGain();
    const dur = o.dur || 0.2;
    const attack = o.attack == null ? 0.005 : o.attack;
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || dur));
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    g.gain.value = EPS;                  // 鳴り始める前も小さくしておく（始めに「プチッ」と鳴らないように）
    g.gain.setValueAtTime(EPS, t);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.2, t + attack);
    if (o.hold) g.gain.setValueAtTime(o.gain || 0.2, t + attack + o.hold);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    return osc;
  }

  // ザーッという音（白い雑音を、filter で形にする）。freq から to へ、ふるえる帯をすべらせる
  const noiseBufs = typeof WeakMap === "function" ? new WeakMap() : null;
  function noiseBuffer(c) {
    if (noiseBufs && noiseBufs.has(c)) return noiseBufs.get(c);
    const len = Math.floor(c.sampleRate * 1.5);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 20261224;   // 毎回同じ雑音（決まった順番の数）
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      d[i] = seed / 2147483648 - 1;
    }
    if (noiseBufs) noiseBufs.set(c, buf);
    return buf;
  }
  function noise(c, out, t, o) {
    const src = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    const dur = o.dur || 0.2;
    const attack = o.attack == null ? 0.005 : o.attack;
    src.buffer = noiseBuffer(c);
    src.loop = true;
    f.type = o.filter || "bandpass";
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || dur));
    f.Q.value = o.q == null ? 1 : o.q;
    g.gain.value = EPS;                  // 鳴り始める前も小さくしておく（始めに「プチッ」と鳴らないように）
    g.gain.setValueAtTime(EPS, t);
    if (o.swell) g.gain.linearRampToValueAtTime(o.gain || 0.1, t + attack);   // だんだん大きく（息を吸う音）
    else g.gain.exponentialRampToValueAtTime(o.gain || 0.1, t + attack);
    if (o.hold) g.gain.setValueAtTime(o.gain || 0.1, t + attack + o.hold);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t, o.offset || 0);
    src.stop(t + dur + 0.05);
    return g;
  }

  // ベルの音（基の音に、すぐ消える高い音を重ねる）
  function bell(c, out, t, freq, dur, gain) {
    tone(c, out, t, { freq, dur, gain, attack: 0.004 });
    tone(c, out, t, { freq: freq * 2.76, dur: dur * 0.45, gain: gain * 0.22, attack: 0.002 });
    tone(c, out, t, { freq: freq * 5.4, dur: dur * 0.2, gain: gain * 0.08, attack: 0.002 });
  }

  // はじく音（ハープのような音）
  function pluck(c, out, t, freq, dur, gain) {
    tone(c, out, t, { type: "triangle", freq, dur, gain, attack: 0.003 });
    tone(c, out, t, { freq: freq * 2, dur: dur * 0.5, gain: gain * 0.3, attack: 0.003 });
  }

  // ゆっくりふくらんで消える和音（freqs：高さの一覧）
  function pad(c, out, t, freqs, o) {
    freqs.forEach((freq, i) => tone(c, out, t, {
      freq, dur: o.dur, gain: o.gain, attack: o.attack || 0.2, hold: o.hold || 0,
      detune: (i % 2 ? 1 : -1) * (o.spread || 4),
    }));
  }

  // 音量を、ゆれるように変える（tremolo）。返り値に音をつなぐと、音量が (1 - depth)〜1 の間でゆれる
  function wobble(c, out, t, dur, rate, depth) {
    const g = c.createGain();
    const lfo = c.createOscillator();
    const amt = c.createGain();
    g.gain.value = 1 - depth / 2;
    lfo.frequency.value = rate;
    amt.gain.value = depth / 2;
    lfo.connect(amt);
    amt.connect(g.gain);
    g.connect(out);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
    return g;
  }

  // ==============================================================
  // 音の一覧
  //   label：テスト用メニューに出す名前 / len：だいたいの長さ（秒）
  //   short：true の音だけ、iPhone の家の中の場面でも鳴らす（短い通知音）
  //   loop ：true の音は、場面の ambient（くり返し鳴らす環境音）に使う
  // ==============================================================
  const SOUNDS = {
    // ---- 入力欄（全体） ----
    correct: {
      label: "正解音（入力欄）", len: 0.7, short: true,
      make(c, out, t) {
        [784, 987.8, 1174.7].forEach((f, i) => bell(c, out, t + i * 0.075, f, i === 2 ? 0.6 : 0.42, 0.15));
      },
    },
    toggle: {
      label: "音を ON にしたときの確かめの音", len: 0.4, short: true,
      make(c, out, t) {
        bell(c, out, t, 880, 0.32, 0.2);
      },
    },
    wrong: {
      label: "責めない軽い不正解音（入力欄）", len: 0.45, short: true,
      make(c, out, t) {
        tone(c, out, t, { type: "triangle", freq: 523.3, dur: 0.17, gain: 0.13, attack: 0.012 });
        tone(c, out, t + 0.14, { type: "triangle", freq: 440, to: 415.3, dur: 0.26, gain: 0.12, attack: 0.012 });
      },
    },

    // ---- 1-3 戦闘：友達3人の技 ----
    pingpong: {
      label: "ピンポンアタック（2回当たる）", len: 0.45,
      make(c, out, t) {
        [[0, 2000], [0.17, 1560]].forEach(([dt, f]) => {
          tone(c, out, t + dt, { freq: f, dur: 0.08, gain: 0.15, attack: 0.001 });
          tone(c, out, t + dt, { type: "triangle", freq: f / 2, dur: 0.05, gain: 0.07, attack: 0.001 });
          noise(c, out, t + dt, { filter: "highpass", freq: 3500, dur: 0.02, gain: 0.05, attack: 0.001 });
        });
      },
    },
    hello: {
      label: "ぶんぶんハローYouTube（応援）", len: 0.9,
      make(c, out, t) {
        noise(c, out, t, { freq: 450, to: 2200, dur: 0.17, gain: 0.17, attack: 0.05, q: 1.4 });
        noise(c, out, t + 0.17, { freq: 2200, to: 450, dur: 0.17, gain: 0.17, attack: 0.05, q: 1.4 });
        tone(c, out, t + 0.36, { type: "triangle", freq: 523.3, to: 1046.5, glide: 0.16, dur: 0.26, gain: 0.15, attack: 0.01 });
        bell(c, out, t + 0.52, 1568, 0.32, 0.08);
        bell(c, out, t + 0.6, 2093, 0.3, 0.07);
      },
    },
    bench: {
      label: "ベンチホテル（ひと休み）", len: 1.3,
      make(c, out, t) {
        tone(c, out, t, { freq: 130, to: 80, dur: 0.16, gain: 0.16, attack: 0.004 });                // ベンチに座る
        pad(c, out, t + 0.08, [349.2, 440, 523.3], { dur: 1.15, gain: 0.05, attack: 0.28, hold: 0.25 });  // ほっとする和音
        noise(c, out, t + 0.12, { filter: "lowpass", freq: 900, dur: 0.95, gain: 0.03, attack: 0.3, q: 0.5 });  // ふう
      },
    },

    // ---- 1-3 戦闘：雪だるま ----
    inhale: {
      label: "息を吸いこむ（ふぶきの前）", len: 1.05,
      make(c, out, t) {
        noise(c, out, t, { freq: 350, to: 2400, glide: 0.85, dur: 0.97, gain: 0.21, attack: 0.82, swell: true, q: 1.2 });
        tone(c, out, t, { freq: 90, to: 165, glide: 0.85, dur: 0.97, gain: 0.05, attack: 0.7 });
      },
    },
    roll: {
      label: "転がって合体する", len: 1.75,
      make(c, out, t) {
        const shake = wobble(c, out, t, 1.35, 9, 0.85);  // ゴロゴロとゆれる
        noise(c, shake, t, { filter: "lowpass", freq: 260, to: 430, glide: 1.25, dur: 1.35, gain: 0.2, attack: 0.25, q: 0.7 });
        [0.15, 0.45, 0.75, 1.02].forEach((dt) => tone(c, out, t + dt, { freq: 140, to: 70, dur: 0.13, gain: 0.15, attack: 0.003 }));
        tone(c, out, t + 1.28, { freq: 190, to: 60, dur: 0.34, gain: 0.2, attack: 0.004 });          // ドスン（ひとつに重なる）
        noise(c, out, t + 1.28, { filter: "lowpass", freq: 700, dur: 0.16, gain: 0.12, attack: 0.003 });
      },
    },

    // ---- 2-7 正体が分かる ----
    furniture: {
      label: "夢の景色が家具に変わる", len: 1.9,
      make(c, out, t) {
        [1046.5, 1174.7, 1318.5, 1568, 1760, 2093].forEach((f, i) => bell(c, out, t + i * 0.06, f, 0.5, 0.045));
        noise(c, out, t, { freq: 800, to: 4000, dur: 0.65, gain: 0.04, attack: 0.25, q: 0.8 });
        pad(c, out, t + 0.38, [523.3, 659.3, 784, 1046.5], { dur: 1.45, gain: 0.04, attack: 0.18, hold: 0.2 });
      },
    },
    wind: {
      label: "霧の外周の風（くり返し）", len: 6, loop: true,
      // くり返す音は、止める関数を返す
      start(c, out) {
        const t = c.currentTime;
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c);
        src.loop = true;
        const f = c.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = 520;
        f.Q.value = 0.8;
        const sweep = c.createOscillator();      // 風の高さを、ゆっくり上下させる
        const sweepAmt = c.createGain();
        sweep.frequency.value = 0.07;
        sweepAmt.gain.value = 260;
        sweep.connect(sweepAmt);
        sweepAmt.connect(f.frequency);
        const lp = c.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 1800;
        const gust = c.createGain();             // 風の強さを、ゆっくり変える
        gust.gain.value = 0.085;
        const gustLfo = c.createOscillator();
        const gustAmt = c.createGain();
        gustLfo.frequency.value = 0.11;
        gustAmt.gain.value = 0.045;
        gustLfo.connect(gustAmt);
        gustAmt.connect(gust.gain);
        const fade = c.createGain();      // 2秒かけて、だんだん聞こえてくる
        fade.gain.value = 0;
        fade.gain.setValueAtTime(0, t);
        fade.gain.linearRampToValueAtTime(1, t + 2);
        src.connect(f);
        f.connect(lp);
        lp.connect(gust);
        gust.connect(fade);
        fade.connect(out);
        src.start(t);
        sweep.start(t);
        gustLfo.start(t);
        return () => {
          const s = c.currentTime;
          fade.gain.cancelScheduledValues(s);
          fade.gain.setValueAtTime(Math.max(EPS, fade.gain.value), s);
          fade.gain.exponentialRampToValueAtTime(EPS, s + 1.2);
          for (const n of [src, sweep, gustLfo]) n.stop(s + 1.3);
        };
      },
    },

    // ---- 4-3 8匹が現れる（氷・妖精・太陽・月・水・炎・雷・草） ----
    ice: {
      label: "現れる音：氷（グレイシア）", len: 0.75,
      make(c, out, t) {
        [2093, 2793.8, 2349.3, 3136].forEach((f, i) => tone(c, out, t + i * 0.055, { freq: f, dur: 0.3, gain: 0.09, attack: 0.002 }));
        noise(c, out, t, { filter: "highpass", freq: 6000, dur: 0.3, gain: 0.025, attack: 0.01 });
      },
    },
    fairy: {
      label: "現れる音：妖精（ニンフィア）", len: 0.85,
      make(c, out, t) {
        [784, 987.8, 1174.7, 1568].forEach((f, i) => pluck(c, out, t + i * 0.07, f, i === 3 ? 0.55 : 0.35, 0.11));
      },
    },
    sun: {
      label: "現れる音：太陽（エーフィ）", len: 1.05,
      make(c, out, t) {
        const shimmer = wobble(c, out, t, 1, 6, 0.4);
        pad(c, shimmer, t, [880, 1318.5], { dur: 0.95, gain: 0.07, attack: 0.18, hold: 0.15 });
        bell(c, out, t + 0.05, 1760, 0.5, 0.04);
      },
    },
    moon: {
      label: "現れる音：月（ブラッキー）", len: 1.15,
      make(c, out, t) {
        bell(c, out, t, 392, 1.05, 0.13);
        bell(c, out, t + 0.13, 587.3, 0.8, 0.065);
        noise(c, out, t, { filter: "lowpass", freq: 600, dur: 0.45, gain: 0.02, attack: 0.1 });
      },
    },
    water: {
      label: "現れる音：水（シャワーズ）", len: 0.55,
      make(c, out, t) {
        tone(c, out, t, { freq: 1500, to: 550, glide: 0.09, dur: 0.13, gain: 0.19, attack: 0.002 });
        tone(c, out, t + 0.16, { freq: 1200, to: 500, glide: 0.09, dur: 0.13, gain: 0.15, attack: 0.002 });
        tone(c, out, t + 0.31, { freq: 420, to: 950, glide: 0.07, dur: 0.1, gain: 0.06, attack: 0.002 });
      },
    },
    fire: {
      label: "現れる音：炎（ブースター）", len: 0.7,
      make(c, out, t) {
        noise(c, out, t, { filter: "lowpass", freq: 300, to: 900, glide: 0.4, dur: 0.5, gain: 0.16, attack: 0.08, q: 0.7 });
        [0.05, 0.13, 0.19, 0.31, 0.37, 0.48].forEach((dt, i) =>
          noise(c, out, t + dt, { freq: 2600 + i * 230, dur: 0.014, gain: 0.16, attack: 0.001, q: 3 }));
        tone(c, out, t, { freq: 220, dur: 0.55, gain: 0.07, attack: 0.08 });
      },
    },
    thunder: {
      label: "現れる音：雷（サンダース）", len: 0.5,
      make(c, out, t) {
        const f = c.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = 1500;
        f.Q.value = 0.7;
        f.connect(out);
        const osc = tone(c, f, t, { type: "square", freq: 220, dur: 0.22, gain: 0.17, attack: 0.002 });
        [880, 330, 1320, 440, 990, 260, 1180].forEach((hz, i) => osc.frequency.setValueAtTime(hz, t + 0.02 + i * 0.025));
        noise(c, out, t, { filter: "highpass", freq: 2500, dur: 0.18, gain: 0.09, attack: 0.002 });
        tone(c, out, t + 0.2, { type: "triangle", freq: 1320, to: 660, dur: 0.18, gain: 0.11, attack: 0.002 });
      },
    },
    leaf: {
      label: "現れる音：草（リーフィア）", len: 0.75,
      make(c, out, t) {
        [0, 0.12, 0.22].forEach((dt) => noise(c, out, t + dt, { freq: 3500, dur: 0.13, gain: 0.08, attack: 0.03, q: 0.8 }));
        tone(c, out, t + 0.3, { freq: 880, to: 1320, glide: 0.08, dur: 0.12, gain: 0.1, attack: 0.003 });
        pluck(c, out, t + 0.38, 659.3, 0.26, 0.09);
      },
    },

    // ---- 4-5 プレゼント ----
    star: {
      label: "プレゼントの星", len: 1.5,
      make(c, out, t) {
        [2637, 3136, 2349.3, 3520, 2793.8, 3951].forEach((f, i) => bell(c, out, t + i * 0.09, f, 0.42, 0.07 - i * 0.006));
        pad(c, out, t + 0.05, [1318.5, 1975.5], { dur: 1.35, gain: 0.025, attack: 0.12, hold: 0.25 });
      },
    },
  };

  // ==============================================================
  // 鳴らす場所の準備
  // ==============================================================
  // 全部の音が通る道：音量 → 音割れ防止 → スピーカー（と、音の大きさを測る部品）
  function makeBus(c) {
    const input = c.createGain();
    input.gain.value = 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const vol = c.createGain();     // short のときは少し小さく
    input.connect(comp);
    comp.connect(vol);
    vol.connect(c.destination);
    let meter = null;
    if (typeof c.createAnalyser === "function") {
      meter = c.createAnalyser();
      meter.fftSize = 2048;
      vol.connect(meter);
    }
    return { input, vol, meter };
  }

  function create() {
    if (ctx || !AC) return;
    try {
      try { ctx = new AC({ latencyHint: "interactive" }); } catch (e) { ctx = new AC(); }
      bus = makeBus(ctx);
      setVolume();
      ctx.onstatechange = () => { if (ctx && ctx.state === "running") syncAmbient(); };
    } catch (e) {
      ctx = null;   // 音が使えない端末でも、ゲームは遊べる
      bus = null;
    }
  }

  // 画面をさわったときに、音を鳴らせるようにする（iPhone の Safari は、さわるまで鳴らない）
  //   ここでは画面の動きをじゃましない（クリックを止めたりしない）
  //   force：音が OFF でも準備する（テスト用メニューの試聴）
  function unlock(force) {
    if ((!on && force !== true) || !AC) return;
    create();
    if (!ctx || ctx.state === "running") return;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) { /* 鳴らせなくても進む */ }
    // iPhone の古い版は、さわったときに音を1回鳴らすと鳴らせるようになるので、無音を鳴らしておく
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { /* 何もしない */ }
  }
  for (const type of ["pointerdown", "pointerup", "touchend", "mousedown", "keydown", "click"]) {
    document.addEventListener(type, () => unlock(), { capture: true, passive: true });
  }
  // ほかのアプリやタブに切りかえたら止め、もどったら続ける
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    try {
      if (document.hidden) {
        if (ctx.state === "running") ctx.suspend();
      } else if (on) {
        const p = ctx.resume();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    } catch (e) { /* 何もしない */ }
  });

  const ready = () => Boolean(on && ctx && bus && ctx.state === "running");
  function setVolume() {
    if (bus) bus.vol.gain.value = mode === "short" ? 0.75 : 1;
  }

  // ==============================================================
  // 環境音（風など。場面の ambient）
  // ==============================================================
  function syncAmbient() {
    if (amb && (amb.name !== want || !ready() || mode !== "full")) {
      try { amb.stop(); } catch (e) { /* 何もしない */ }
      amb = null;
    }
    if (!amb && want && ready() && mode === "full" && SOUNDS[want] && SOUNDS[want].loop) {
      try { amb = { name: want, stop: SOUNDS[want].start(ctx, bus.input) }; } catch (e) { amb = null; }
    }
  }

  // ==============================================================
  // engine.js から使う入り口（window.SOUND）
  // ==============================================================
  window.SOUND = {
    // 最初に1回：key＝ON/OFF を記録する名前、on＝記録がないときの設定（data.js の SETTINGS.sound）
    init(opts) {
      const o = opts || {};
      saveKey = o.key || "";
      on = o.on !== false;
      try {
        const v = saveKey ? localStorage.getItem(saveKey) : null;
        if (v === "on") on = true;
        if (v === "off") on = false;
      } catch (e) { /* 記録できない環境でも遊べる */ }
    },

    // 音を1回鳴らす（鳴らせないとき・鳴らさない場面では、何もしない）
    //   force：テスト用メニューの試聴（ON/OFF と場面の決まりを無視する）
    play(name, force) {
      const s = SOUNDS[name];
      if (!s || s.loop) return false;
      if (force) unlock(true);
      else if (!on || mode === "off" || (mode === "short" && !s.short)) return false;
      if (!ctx || !bus || ctx.state !== "running") return false;   // まだ鳴らせない（ためておかない）
      const now = ctx.currentTime;
      if (last[name] != null && now - last[name] < 0.05) return false;
      last[name] = now;
      try {
        s.make(ctx, bus.input, now + 0.01);
        return true;
      } catch (e) {
        return false;
      }
    },

    // テスト用メニューの試聴：ON/OFF と場面の決まりを無視して鳴らす。くり返す音は、4秒だけ鳴らす
    preview(name) {
      const s = SOUNDS[name];
      if (!s) return;
      unlock(true);
      if (!s.loop) {
        this.play(name, true);
        return;
      }
      const go = () => {
        if (!ctx || !bus || ctx.state !== "running") return;
        try {
          const stop = s.start(ctx, bus.input);
          setTimeout(stop, 4000);
        } catch (e) { /* 何もしない */ }
      };
      if (ctx && ctx.state === "running") go();
      else setTimeout(go, 150);   // 準備（resume）が終わるのを少し待つ
    },

    // くり返す環境音を決める（null で止める）。鳴らせるようになったら、自動で始める
    ambient(name) {
      want = name && SOUNDS[name] && SOUNDS[name].loop ? name : null;
      syncAmbient();
    },

    // 鳴らし方：full / short / off
    setMode(m) {
      mode = m === "off" || m === "short" ? m : "full";
      setVolume();
      syncAmbient();
    },

    isOn: () => on,
    setOn(v) {
      on = Boolean(v);
      try { if (saveKey) localStorage.setItem(saveKey, on ? "on" : "off"); } catch (e) { /* 何もしない */ }
      if (on) unlock();
      syncAmbient();
    },

    has: (name) => Boolean(SOUNDS[name]),
    isLoop: (name) => Boolean(SOUNDS[name] && SOUNDS[name].loop),
    names: () => Object.keys(SOUNDS),
    label: (name) => (SOUNDS[name] ? SOUNDS[name].label : ""),
    isShort: (name) => Boolean(SOUNDS[name] && SOUNDS[name].short),

    // テスト用：いまの様子
    state: () => ({
      supported: Boolean(AC), context: ctx ? ctx.state : "none", on, mode,
      ambient: amb ? amb.name : null, want,
    }),

    // テスト用：いま鳴っている音の大きさ（0〜1。いちばん大きいところ）
    level() {
      if (!bus || !bus.meter) return 0;
      const data = new Float32Array(bus.meter.fftSize);
      if (typeof bus.meter.getFloatTimeDomainData !== "function") return 0;
      bus.meter.getFloatTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      return peak;
    },

    // テスト用：音を、スピーカーに出さずに作ってみる（長さ・大きさの確認）
    //   raw：true なら、音割れ防止の部品を通さない（部品のはたらきを確かめるとき）
    render(name, seconds, raw) {
      const s = SOUNDS[name];
      if (!s || !OAC) return Promise.resolve(null);
      const rate = 44100;
      const c = new OAC(1, Math.ceil(rate * (seconds || s.len + 0.4)), rate);
      const out = raw ? c.destination : makeBus(c).input;
      if (s.loop) s.start(c, out);
      else s.make(c, out, 0.01);
      return c.startRendering();
    },
  };
})();
