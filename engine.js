/* ================================================================
   engine.js ― ゲームを動かす仕組み
   ----------------------------------------------------------------
   ふだんは編集しなくて大丈夫です。
     ・会話、選択肢、合言葉、カード、画面の文字を変える → data.js
     ・夢の部屋の地図を変える                         → room.js
     ・第1部で歩く地図・2-7 の家全体の地図を変える → house.js
     ・1-3 の戦いの技・数値・セリフを変える      → data.js（BATTLES・MOVES）
   ※ このファイルには文章を書きません。画面に出る文章は data.js にまとめます。
   ================================================================ */
(() => {
  "use strict";

  // ==============================================================
  // 1. 準備：data.js / room.js が読み込めたか確認する
  // ==============================================================
  const app = document.getElementById("app");
  const tryGet = (fn) => {
    try { return fn(); } catch (e) { return undefined; }
  };

  const S = tryGet(() => SETTINGS);
  const CHARS = tryGet(() => CHARACTERS);
  const SCN = tryGet(() => SCENES);
  const KEYS = tryGet(() => KEYWORDS) || {};
  const PARTY = tryGet(() => EIGHT) || [];
  const TX = tryGet(() => UI) || {};
  const PZ = tryGet(() => PUZZLE);
  const RM = tryGet(() => ROOM);
  const HS = tryGet(() => HOUSE);
  const BT = tryGet(() => BATTLES) || {};
  const MV = tryGet(() => MOVES) || {};
  const RP = tryGet(() => REPLAY) || [];   // クリアしたなかまへ戻るメニュー（設計書 第11節）
  const BN = tryGet(() => BONUS) || {};    // クリア後のおたのしみ（設計書 第11節。PCのみ）
  // 音を鳴らす仕組み（sound.js）。読み込めなかったときは、音なしで遊べるようにする
  const SND = window.SOUND || {
    init() {}, play: () => false, preview() {}, ambient() {}, setMode() {}, isOn: () => false, setOn() {},
    has: () => false, isLoop: () => false, isShort: () => false, names: () => [], label: () => "",
    bgm() {}, primeBgm() {}, hasBgm: () => false, bgmNames: () => [], bgmLabel: () => "", previewBgm() {}, bgmDetail: () => ({}),
    state: () => ({ supported: false, context: "none", on: false, mode: "off", ambient: null, bgm: null, bgmPlaying: null }),
  };

  if (!S || !CHARS || !SCN) {
    showLoadError();
    return;
  }

  const query = new URLSearchParams(location.search);
  const hashQuery = new URLSearchParams(location.hash.replace(/^#/, ""));
  const DEBUG = query.has("debug") || hashQuery.has("debug");
  const TOUCH = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  // PCで index.html を直接開いたとき（file://）。公開したページ（iPhone など）では false
  //   data.js の条件「pcDirect」（4-6 の終わりの画面の「友情出演」など）に使う
  const PC_DIRECT = location.protocol === "file:";

  // ==============================================================
  // 2. 小さな道具
  // ==============================================================

  // HTMLの部品を作る：el("button", { class: "btn", text: "OK" })
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style") node.style.cssText = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

  // 文章の { } を置きかえる
  //   {name}          → 主人公の名前（遊ぶ人が入力したもの）
  //   {friend1} など  → 遊ぶ前にこのPCで入れておく呼び名（SETTINGS.local）
  //   {station} など  → SETTINGS.hidden に「表示用に隠す」形で書いた文字
  function fill(t) {
    return String(t == null ? "" : t).replace(/\{(\w+)\}/g, (whole, key) => {
      // 名前を入れる前（「はじめから」のあと）に、おたのしみを遊んだときは、クリア後の記録の名前を使う
      if (key === "name") return state.name || (state.finished && hasBonus() && bonusRec.name) || S.defaultName || "";
      if (LOCAL[key]) return localText(key);
      const hidden = S.hidden && S.hidden[key];
      return hidden ? unhide(hidden) : whole;
    });
  }

  // キャラクターの表示名（{friend1} のような呼び名も置きかえる）
  const charName = (c) => fill((c && c.name) || "");

  // 画面の文字（data.js の UI）を取り出す。{n} などは vars の値に置きかえる
  function T(key, vars) {
    const s = TX[key] == null ? key : String(TX[key]);
    return fill(vars ? s.replace(/\{(\w+)\}/g, (whole, k) => (k in vars ? String(vars[k]) : whole)) : s);
  }

  // 会話の行の {guess} などを、vars の値に置きかえる（1-1 の名前の確認の呼び名）。{name} などは、表示するときに置きかえる
  function withVars(lines, vars) {
    const rep = (s) => String(s == null ? "" : s).replace(/\{(\w+)\}/g, (whole, k) => (k in vars ? String(vars[k]) : whole));
    return toArray(lines).map((ln) => (ln && typeof ln === "object" ? { ...ln, text: rep(ln.text) } : rep(ln)));
  }

  // 表示用に隠す：駅名など、ページに直接書きたくない文字を読めない形にする（元に戻せる）
  // data.js では "~" で始まる文字として書く（SETTINGS.hidden）
  const HIDE_KEY = "eevee-dream";
  function hide(s) {
    const bytes = new TextEncoder().encode(String(s));
    let bin = "";
    bytes.forEach((b, i) => { bin += String.fromCharCode(b ^ HIDE_KEY.charCodeAt(i % HIDE_KEY.length)); });
    return "~" + btoa(bin);
  }
  function unhide(s) {
    const str = String(s == null ? "" : s);
    if (!str.startsWith("~")) return str;
    try {
      const bin = atob(str.slice(1));
      const bytes = Uint8Array.from(bin, (ch, i) => ch.charCodeAt(0) ^ HIDE_KEY.charCodeAt(i % HIDE_KEY.length));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) { return ""; }
  }

  // 条件つきの行・選択肢
  //   { if: "indoor" } はその条件のときだけ、{ unless: "indoor" } はそうでないときだけ出す
  //   条件の名前は、set で記録したもの（state.flags）か、SETTINGS の true / false
  //   pcDirect は、PCで index.html を直接開いたとき（4-6 の終わりの画面の「友情出演」）
  function flagOn(name) {
    if (name === "pcDirect") return PC_DIRECT;
    return state.flags.includes(name) || S[name] === true;
  }
  function visible(item) {
    return visibleWith(item, flagOn);
  }
  // on：条件の名前が入っているかを調べる関数（戦いの点検で、仲間がいる・いないを両方調べるため）
  function visibleWith(item, on) {
    if (!item || typeof item !== "object") return true;
    if (item.if != null && !toArray(item.if).every(on)) return false;
    if (item.unless != null && toArray(item.unless).some(on)) return false;
    return true;
  }

  // 答えの比較用：ひらがな/カタカナ・全角/半角・空白・記号のちがいをなくす
  function norm(s) {
    return String(s == null ? "" : s)
      .normalize("NFKC")
      .replace(/[\s　]/g, "")
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[!?。、,.・「」『』"'〜~]/g, "")
      .toLowerCase();
  }

  // 答えを読めない形（暗号）にする：駅名など、ページに書きたくない答え用
  // data.js では answers: ["#1a2b3c4d"] のように「#」で始めて書く
  function secret(s) {
    const t = "eevee:" + norm(s);
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return "#" + h.toString(16).padStart(8, "0");
  }

  function isAnswer(text, answers) {
    return toArray(answers).some((a) => {
      const s = String(a == null ? "" : a).trim();
      return s.startsWith("#") ? s.toLowerCase() === secret(text) : norm(s) === norm(text);
    });
  }

  // 仲間からもらう言葉（最後の謎で使う。文字は光らせない）
  function wordNode(w, cls) {
    return el("span", { class: "word" + (cls ? " " + cls : ""), text: String(w == null ? "" : w) });
  }

  // 入力欄（名前を入れるときは、長すぎないようにする）
  function inputField(spec, cls, enter) {
    return el("input", {
      type: "text", class: cls,
      placeholder: fill(spec.placeholder || T(spec.name ? "namePlaceholder" : "inputPlaceholder")),
      maxlength: spec.name ? 12 : null,
      autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
      enterkeyhint: enter, "aria-label": fill(spec.prompt || T("inputPrompt")),
      // value：最初から入れておく文字（最終章を終えたPCで遊び直す 2-4 の名前。data.js の REPLAY の name）
      value: spec.value ? String(spec.value) : null,
    });
  }

  // 話し手の名前（または ID）→ キャラクターID
  const nameToId = {};
  for (const [id, c] of Object.entries(CHARS)) {
    nameToId[id] = id;
    if (c && c.name) nameToId[c.name] = id;
  }

  // 演出の行か（文は出さない）。data.js の lines に、次のように書く
  //   { house: { … } }        家全体の地図を変える（2-7 の地図が広がる演出など）
  //   { puzzle: "answer" }    最後の謎の答えの列を、上から1字ずつ光らせる（正解したあとだけ）
  //   { sound: "音の名前" }    音を1回鳴らす（sound.js の音）
  //   { ambient: "wind" }     くり返す音（環境音）を始める。null で止める
  //   { bgm: "final" }        曲（BGM）を切りかえる。null で止める（その場面のあいだだけ。PCの場面だけ）
  //   wait: ミリ秒             演出のあと、次の行まで待つ（地図が広がるたびの「一拍」など）
  //   文の行に sound を書くと、その文を出すときに鳴らす：{ text: "グレイシア：…", sound: "ice" }
  const isEffect = (ln) => Boolean(ln) && typeof ln === "object" && (ln.house !== undefined || ln.puzzle !== undefined
    || (ln.text == null && !ln.who
      && (ln.sound !== undefined || ln.ambient !== undefined || ln.bgm !== undefined || ln.wait !== undefined)));

  // "イーブイ：こんにちは" → { who: "eevee", text: "こんにちは" }
  // { if: "indoor", text: "イーブイ：…" } のような条件つきの行も、同じように読む
  function parseLine(line) {
    if (line && typeof line === "object") {
      if (line.who) return { who: CHARS[line.who] ? line.who : null, text: fill(line.text) };
      return parseLine(line.text);
    }
    const s = String(line == null ? "" : line);
    const m = s.match(/^([^：:「」\n]{1,12})[：:]([\s\S]*)$/);
    if (m && nameToId[m[1].trim()]) {
      return { who: nameToId[m[1].trim()], text: fill(m[2].trim()) };
    }
    const suspect = m && /^[ぁ-んァ-ヶー一-龠a-zA-Z]{1,8}$/.test(m[1].trim()) ? m[1].trim() : null;
    return { who: null, text: fill(s.replace(/^[：:]/, "")), suspect };
  }

  // 会話の1行を、画面に出す形にする（演出の行は { effect }、文の行は parseLine と、鳴らす音 sound・光らせる仲間 glow・光らない仲間を暗くする dim・
  // その行のあいだ出す絵 image）
  function toLine(ln) {
    if (isEffect(ln)) return { effect: ln };
    const p = parseLine(ln);
    if (ln && typeof ln === "object" && ln.sound) p.sound = ln.sound;
    if (ln && typeof ln === "object" && ln.glow !== undefined) p.glow = toArray(ln.glow);
    if (ln && typeof ln === "object" && ln.dim) p.dim = true;
    if (ln && typeof ln === "object" && typeof ln.image === "string" && ln.image.trim()) p.image = ln.image.trim();
    return p;
  }

  // 場面の会話に出てくる話し手（最大3人。声だけの人物は除く）
  function speakersOf(lines) {
    const ids = [];
    for (const ln of toArray(lines).filter(visible)) {
      const who = parseLine(ln).who;
      if (who && who !== "hero" && !CHARS[who].voice && !ids.includes(who)) ids.push(who);
    }
    return ids.slice(0, 3);
  }

  // PCだけで使うイラスト（data.js の SETTINGS.pcArt のフォルダの画像）
  //   PCで index.html を直接開いたとき（file://）だけ使う。公開したページ（iPhone）では読みこまない。
  //   メッセージ画面（chat）でも使わない。探すのは、CHARACTERS に art（画像の名前）を書いたキャラクターだけ
  //   画像が見つからなければ、絵文字のまま
  const ART_DIR = location.protocol === "file:" && S.pcArt ? encodeURI(String(S.pcArt).replace(/[\\/]+$/, "")) : "";
  const ART_TYPES = ["png", "webp", "jpg", "jpeg"];
  const artLook = {};                          // キャラクターID → 探した結果（見つかれば画像の場所、なければ ""）
  const artCount = { hit: 0, miss: 0, type: "" };  // 見つかった数・見つからなかった数・見つかった画像の種類
  let artQueue = Promise.resolve();            // 画像は1人ずつ順番に探す
  function findArt(id) {
    if (!artLook[id]) {
      // 1枚も見つからないまま2人分見つからなければ、フォルダがないと考えて、もう探さない
      // （見つからない画像は、開発者ツールの Console にエラーとして出るため、増やさない）
      artLook[id] = artQueue = artQueue.then(() => (!artCount.hit && artCount.miss >= 2 ? "" : probeArt(id)));
    }
    return artLook[id];
  }
  function probeArt(id) {
    const name = encodeURIComponent(String(CHARS[id].art));
    // 前に見つかった画像の種類（png など）から先にためす
    const types = artCount.type ? [artCount.type, ...ART_TYPES.filter((t) => t !== artCount.type)] : ART_TYPES;
    return new Promise((resolve) => {
      const img = new Image();
      let i = 0;
      img.onload = () => {
        artCount.hit += 1;
        artCount.type = artCount.type || types[i];
        resolve(img.src);
      };
      img.onerror = () => {
        i += 1;
        if (i < types.length) {
          img.src = `${ART_DIR}/${name}.${types[i]}`;
        } else {
          artCount.miss += 1;
          resolve("");
        }
      };
      img.src = `${ART_DIR}/${name}.${types[0]}`;
    });
  }
  function withArt(node, id) {
    const c = CHARS[id];
    if (!ART_DIR || !c || !c.art || c.voice || currentView === "chat") return node;
    findArt(id).then((src) => {
      if (!src) return;
      node.replaceChildren(el("img", { class: "art", src, alt: "", draggable: "false" }));
      node.classList.add("has-art");
    });
    return node;
  }

  // 名前の確認（1-1。data.js の input の check）に使う一覧：pc-images/name.js（書き方は name.sample.js）
  //   PCで index.html を直接開いたとき（file://）だけ読みこむ。公開したページ（iPhone）では読みこまない。
  //   結果：{ list, status, call }。status は "ok"（使える）/ "none"（ファイルがない）/ "empty"（NAME_LIST がない・names が空）/ "off"（直接開いていない）
  //   list が null のときは、名前を確認せずに進む
  //   call：強いモード（おたのしみ）で、パパが呼ぶ呼び名（NAME_LIST の call。技の名前「○○ちゃーん」の○○）。なければ ""
  let nameLoad = null;
  let callLoaded = "";
  function loadNames() {
    if (!nameLoad) {
      nameLoad = new Promise((resolve) => {
        if (!ART_DIR) { resolve({ list: null, status: "off", call: "" }); return; }
        const s = document.createElement("script");
        s.onload = () => {
          const raw = tryGet(() => NAME_LIST);
          const list = readNames(raw);
          const call = raw && typeof raw === "object" && typeof raw.call === "string" ? raw.call.trim() : "";
          callLoaded = call;
          resolve({ list, status: list ? "ok" : "empty", call });
        };
        s.onerror = () => resolve({ list: null, status: "none", call: "" });
        s.src = `${ART_DIR}/name.js`;
        document.head.append(s);
      });
    }
    return nameLoad;
  }
  // パパが呼ぶ呼び名（name.js の call）。読みこみが終わっていないときや、ないときは ""
  const nameCall = () => callLoaded;
  // name.js の NAME_LIST を、比べやすい形にそろえる（names が1つもなければ null）
  //   names：下の名前の一覧 / family：名字の一覧（名字＋名前でも通す）/ guess：「もしかして」で聞く呼び名（なければ names の1つ目）
  function readNames(raw) {
    if (!raw || typeof raw !== "object") return null;
    const words = (v) => toArray(v).map((w) => String(w == null ? "" : w).trim()).filter((w) => norm(w));
    const names = words(raw.names);
    if (!names.length) return null;
    const family = words(raw.family);
    const guess = words(raw.guess)[0] || names[0];
    return { names: names.map(norm), family: family.map(norm), guess, counts: { names: names.length, family: family.length } };
  }
  // 入れた名前が、一覧にあるか（空白を除き、カタカナはひらがなにそろえて比べる。名字＋名前でも通す）
  function nameListed(list, text) {
    const t = norm(text);
    if (!t) return false;
    return list.names.includes(t) || list.family.some((f) => list.names.some((g) => f + g === t));
  }

  // ==============================================================
  // 3. 記録（セーブ）：端末ごとに自動保存
  // ==============================================================
  const SAVE_KEY = S.saveKey || "eevee-xmas-save";
  const storage = {
    load() {
      try {
        const data = JSON.parse(localStorage.getItem(SAVE_KEY));
        return data && typeof data === "object" ? data : null;
      } catch (e) { return null; }
    },
    save(data) {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境でも遊べる */ }
      if (data && data.finished === true) keepBonus(data);
    },
    clear() {
      try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 何もしない */ }
    },
  };
  // クリア後の記録（おたのしみ）：進み具合の記録とは別の保存名に置く
  //   「はじめから」で進み具合の記録を消しても、こちらは残す（おたのしみ・強いモード・パパ・なかまの場面へ）
  //   中身：finished（最終章を終えた）・cleared（クリアした仲間）・counts（強いモードの負けた回数など）・name（主人公の名前）
  //   進み具合の記録を保存するとき、最終章を終えていれば、ここにも足していく（減らさない）
  const BONUS_KEY = SAVE_KEY + "-bonus";
  const bonusStore = {
    load() {
      try {
        const data = JSON.parse(localStorage.getItem(BONUS_KEY));
        return data && typeof data === "object" ? data : {};
      } catch (e) { return {}; }
    },
    save(data) {
      try { localStorage.setItem(BONUS_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境でも遊べる */ }
    },
    clear() {
      try { localStorage.removeItem(BONUS_KEY); } catch (e) { /* 何もしない */ }
    },
  };
  let bonusRec = bonusStore.load();
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const unionList = (a, b) => Array.from(new Set(strList(a).concat(strList(b))));
  // 回数は、多いほうを残す（減らさない）
  function maxCounts(a, b) {
    const out = {};
    for (const src of [a, b]) {
      if (!src || typeof src !== "object") continue;
      for (const [k, v] of Object.entries(src)) {
        const n = Math.floor(Number(v));
        if (n > 0 && !(out[k] >= n)) out[k] = n;
      }
    }
    return out;
  }
  function keepBonus(st) {
    const b = bonusRec;
    bonusRec = {
      finished: true,
      cleared: unionList(b.cleared, st.cleared),
      counts: maxCounts(b.counts, st.counts),
      // 遊び直し（なかまの場面へ）で入れた名前は使わない（遊ぶ前の名前。REPLAY の name）
      name: (typeof keptName(st) === "string" && keptName(st)) || (typeof b.name === "string" ? b.name : ""),
    };
    bonusStore.save(bonusRec);
  }
  const hasBonus = () => bonusRec.finished === true;
  // 遊び直しの前の名前（遊び直しのあいだは state.main.name に覚えておく）
  const keptName = (st) => (st.main && typeof st.main.name === "string" ? st.main.name : st.name);
  // 遊ぶ前に、このPCで入れておく呼び名（data.js の SETTINGS.local。友達の呼び名など）
  //   公開ページに書かないため、この端末のブラウザだけに記録する。記録（セーブ）を消しても残る
  const LOCAL = S.local || {};
  const LOCAL_KEY = SAVE_KEY + "-local";
  const localStore = {
    load() {
      try {
        const data = JSON.parse(localStorage.getItem(LOCAL_KEY));
        return data && typeof data === "object" ? data : {};
      } catch (e) { return {}; }
    },
    save(data) {
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境でも遊べる */ }
    },
  };
  const localValues = localStore.load();
  // 入れていないときは default の呼び名（"~" で始まるときは「表示用に隠す」形なので、元にもどす）
  const localDefault = (key) => unhide((LOCAL[key] && LOCAL[key].default) || "");
  function localText(key) {
    const v = String(localValues[key] == null ? "" : localValues[key]).trim();
    return v || localDefault(key);
  }
  // プレゼントの場所（4-5。家全体の地図のマス {x, y}）。遊ぶ前に、このPCで決めておく（🛠 →「遊ぶ前の準備」）
  function presentAt() {
    const m = String(localValues.presentAt || "").match(/^(\d+),(\d+)$/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }
  // 音の ON/OFF（この端末のブラウザに記録する。記録（セーブ）を消しても残る）
  //   記録がないときは、data.js の SETTINGS.sound（はじめの設定）。曲（BGM）の一覧は SETTINGS.bgm
  SND.init({ key: SAVE_KEY + "-sound", on: S.sound !== false, bgm: S.bgm });
  // 場面で鳴らす曲（data.js の場面の bgm）。曲はPCの場面だけ（iPhone の場面と第3部では鳴らさない）
  const sceneBgm = (sc) => (!sc || sc.mode === "chat" || sc.mute ? null : sc.bgm || null);
  // 入力欄（全体）の正解音・不正解音（data.js の SETTINGS.inputSound）
  const inputSound = (kind) => {
    const name = S.inputSound && S.inputSound[kind];
    if (name) SND.play(name);
  };

  // name：主人公の名前 / flags：set で記録した条件 / atEnd：章の終わりの画面にいる
  // walk：歩けるマップで最後にいた場所（{ scene, map, x, y, dir }）
  // parks・parkManual・parkMisses：公園で気配を探す（GPSヒント機能）の記録
  //   見つけた公園の id・「気配を見つけたことにする」で増やした数・続けて見つからなかった回数（現在地は記録しない）
  // cleared：この端末で、言葉（give）を受けとった仲間（クリアした仲間。「なかまの場面へ」に出す）
  // main：「なかまの場面へ」で遊び直している間だけ、いちばん先まで進んだ所を覚えておく（MAIN_KEYS の項目）
  // finished：最終章を終えた（4-6 の終わりの画面を出した。data.js の end の complete）。タイトル画面に「おたのしみ」を出す
  // replayUntil：最終章を終えたあとの「なかまの場面へ」で、遊び直しを終える場面（data.js の REPLAY の until）。
  //   その場面へ進む所で、メニューへ戻る。遊び直していないときは null
  // replayWho：replayUntil のときに遊び直している仲間（REPLAY の detour・name を使うため）。遊び直していないときは null
  // counts：日をまたいでも数える回数（強いモードで、パパなしで負けた回数など。data.js の BATTLES の retreat の count）
  const freshState = () => ({
    scene: null, met: [], words: [], flags: [], name: "", chapter: "", bg: "", atEnd: false, walk: null,
    parks: [], parkManual: 0, parkMisses: 0,
    cleared: [], main: null, finished: false, replayUntil: null, replayWho: null, counts: {},
  });
  let state = freshState();
  let gen = 0;            // 場面が変わるたびに増える番号（古いタイマーを無効にする）
  let currentView = "";

  // 公園で気配を探す（GPSヒント機能）。判定の計算は geo.js（window.GEO）、設定値と公園は data.js の SETTINGS.gps
  //   geo.js を読み込めなかったときや、位置情報を使えない端末（PCなど）でも、「気配を見つけたことにする」で進める
  const GEO = window.GEO || null;
  const PARK = S.gps || {};
  let parkCache = null;
  function parkList() {
    if (!parkCache) parkCache = GEO ? GEO.readParks(GEO.parksFrom(PARK.parks, S.hidden).list).parks : [];
    return parkCache;
  }
  const parkNeed = () => Math.max(1, Math.floor(Number(PARK.need) || 1));
  // 見つけた数：公園で見つけた数（今の公園の一覧にあるものだけ）＋「気配を見つけたことにする」で増やした数
  const parkCount = () => state.parks.filter((id) => parkList().some((p) => p.id === id)).length + state.parkManual;
  function clearParks() {
    state.parks = [];
    state.parkManual = 0;
    state.parkMisses = 0;
  }

  // ==============================================================
  // 4. 画面の部品
  // ==============================================================
  const titleScreen = el("section", { class: "screen title-screen bg-title" });
  const keywordScreen = el("section", { class: "screen keyword-screen bg-title" });
  const endScreen = el("section", { class: "screen end-screen" });
  const novel = buildNovel();
  const chat = buildChat();
  const overlay = el("div", { class: "overlay", role: "dialog", "aria-modal": "true" });
  const toastBox = el("div", { class: "toast-box", "aria-live": "polite" });
  // はじめの演出（1-1。data.js の場面の intro）で、画面を暗くする幕。演出のあいだは、クリックで飛ばせる
  //   intro：演出の途中だけ { skip, ready, … }（下の playIntro）
  let intro = null;
  const veil = el("div", { class: "veil", "aria-hidden": "true", onclick: () => { if (intro) intro.skip(); } });
  app.append(titleScreen, keywordScreen, novel.root, chat.root, endScreen, overlay, toastBox, veil);

  const views = { title: titleScreen, keyword: keywordScreen, novel: novel.root, chat: chat.root, end: endScreen };
  function show(name) {
    for (const [key, node] of Object.entries(views)) node.classList.toggle("active", key === name);
    currentView = name;
  }

  function setBg(node, bg) {
    for (const cls of [...node.classList]) if (cls.startsWith("bg-")) node.classList.remove(cls);
    if (bg) node.classList.add("bg-" + bg);
  }

  function metCount() {
    return PARTY.filter((id) => state.met.includes(id)).length;
  }
  function updateParty() {
    const label = `📖 ${metCount()}/${PARTY.length}`;
    novel.partyBtn.textContent = label;
    chat.partyBtn.textContent = label;
  }

  function toast(text) {
    while (toastBox.children.length >= 2) toastBox.firstChild.remove();
    const node = el("div", { class: "toast", text });
    toastBox.append(node);
    setTimeout(() => node.remove(), 2800);
  }

  // ==============================================================
  // 5. 物語画面（PC向け：下に会話の枠が出る形式）
  // ==============================================================
  function buildNovel() {
    const chapter = el("div", { class: "chapter" });
    const partyBtn = el("button", { class: "icon-btn", type: "button", "aria-label": "なかまノート", onclick: openParty });
    const menuBtn = el("button", { class: "icon-btn", type: "button", text: "≡", "aria-label": "メニュー", onclick: openMenu });
    const topbar = el("header", { class: "topbar" }, chapter, partyBtn, menuBtn);
    const chars = el("div", { class: "chars", "aria-hidden": "true" });
    const roomBox = el("div", { class: "room-wrap", hidden: true });
    const gridBox = el("div", { class: "grid-box", hidden: true });   // 氷の床・歩けるマップ
    const puzzleBox = el("div", { class: "puzzle-box", hidden: true });
    const battleBox = el("div", { class: "battle-box", hidden: true }); // 戦い
    const houseBox = el("div", { class: "house-box", hidden: true });   // 家全体の地図
    // 行の絵（data.js の行の image。4-3 の回想のイラスト。PCで直接開いたときだけ）と、絵を出す・消すときの暗転
    const pictureImg = el("img", { class: "stage-picture-img", alt: "", draggable: "false" });
    const picture = el("div", { class: "stage-picture", hidden: true, "aria-hidden": "true" }, pictureImg);
    const shade = el("div", { class: "stage-shade", "aria-hidden": "true" });
    const layer = el("div", { class: "stage-layer" });
    const draft = el("div", { class: "draft-badge", text: T("draft"), hidden: true });
    // クリックを待つ印（会話の枠を消しているとき。4-6 エピローグの最後のイラスト）
    const stageMark = el("div", { class: "stage-mark", text: "▼", hidden: true, "aria-hidden": "true" });
    const stage = el("div", { class: "stage" }, chars, roomBox, gridBox, puzzleBox, battleBox, houseBox, picture, shade, layer, draft, stageMark);
    const name = el("div", { class: "nameplate", hidden: true });
    const text = el("div", { class: "text" });
    const mark = el("div", { class: "next-mark", text: "▼", hidden: true, "aria-hidden": "true" });
    // バックログのボタン（会話の枠の左下）。押しても、文は進めない。入力欄の文字を選んだままにする（押したときに、入力欄から外さない）
    const logBtn = el("button", {
      class: "log-btn", type: "button", text: T("logButton"), title: T("logHelp"),
      onmousedown: (e) => e.preventDefault(),
      onclick: (e) => { e.stopPropagation(); openLog(); },
    });
    const box = el("div", { class: "textbox", tabindex: "0" }, name, text, mark, logBtn);
    const root = el("section", { class: "screen novel" }, topbar, stage, box);
    return { root, chapter, partyBtn, chars, roomBox, gridBox, puzzleBox, battleBox, houseBox, picture, pictureImg, shade, layer, draft, stageMark, stage, name, text, mark, box };
  }

  // 文字送りの短い音を鳴らさない文字（空白・句読点・「…」・かっこなど）
  const QUIET_CHAR = /[\s　、。，．,.・…‥！？!?「」『』（）()［］【】ー―〜~：:]/;

  // 文字を1文字ずつ表示する
  //   blip：文字送りの短い音の名前（data.js の SETTINGS.textSound）。2文字出すごとに1回鳴らす。
  //         行に自分の音（sound）があるときは、その音が聞こえるように、呼ぶ側が渡さない
  function typeInto(node, text, done, blip) {
    const chars = Array.from(text);
    const speed = Number(S.textSpeed) || 0;
    let i = 0;
    let said = 0;   // 音を数えた文字の数
    let timer = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      node.textContent = text;
      if (done) done();
    };
    if (!speed || chars.length === 0) {
      finish();
      return { skip() {}, cancel() {} };
    }
    node.textContent = "";
    timer = setInterval(() => {
      i += 1;
      node.textContent = chars.slice(0, i).join("");
      if (blip && !QUIET_CHAR.test(chars[i - 1]) && said++ % 2 === 0) SND.play(blip);
      if (i >= chars.length) finish();
    }, speed);
    return { skip: finish, cancel() { finished = true; clearInterval(timer); } };
  }

  // auto：話し手のいない行を、自動で次へ進めるまでの時間（戦いの文）。onLine：行を出すたびに呼ぶ
  // exploreNext：地図を調べ終えたあと、先へ進む関数 / house：家全体の地図（2-7・4-3・4-5）
  // picture：いま出している行の絵（画像の場所。出していなければ ""）/ picTimer：絵を出す・消すときの暗転の時計
  const NV = { lines: [], idx: 0, then: null, hold: true, typer: null, mode: "idle", shown: [], auto: 0, onLine: null, autoTimer: null, exploreNext: null, house: null, glow: false, picture: "", picTimer: null };

  // ---- バックログ（PC。設計書 第11節）：今の場面で出た文を、あとから一覧で読みかえす ----
  //   場面が変わるたびに空にする（runScene）。記録するのは、画面に出た文・選んだ答え・入れた答え・もらった言葉
  //   { who, text }：文（who がなければ地の文）/ { picked }：選んだ・入れた答え
  const BACKLOG = [];
  const BACKLOG_MAX = 400;
  function logAdd(entry) {
    BACKLOG.push(entry);
    if (BACKLOG.length > BACKLOG_MAX) BACKLOG.splice(0, BACKLOG.length - BACKLOG_MAX);
  }
  // 文を出さずに待っている間（余韻・絵の暗転）の印。そのあいだは、ログを開けない（ログのボタンもうすくする）
  function setPausing(on) {
    novel.root.classList.toggle("pausing", Boolean(on));
  }

  // 選択肢・入力欄などを表示する（null で消す）
  // 表示中はキャラクターを上によせて、重ならないようにする
  function setLayer(node) {
    if (node) novel.layer.replaceChildren(node);
    else novel.layer.replaceChildren();
    novel.stage.classList.toggle("has-layer", Boolean(node) && !node.classList.contains("room-done"));
    // 最後の謎の枠・家の地図が、入力欄に隠れないように、入力欄の高さを伝える
    novel.stage.style.setProperty("--layer-h", node ? `${novel.layer.offsetHeight}px` : "0px");
    if (NV.house) NV.house.fit(true);
  }

  function charNode(id, i) {
    const c = CHARS[id];
    return el("div", { class: "char", "data-id": id, style: `--c:${c.color || "#999"};--i:${i}` },
      withArt(el("div", { class: "char-face", text: c.emoji || "？" }), id),
      el("div", { class: "char-name", text: charName(c) }));
  }

  // crowd：4匹以上を小さく並べて、1匹ずつ現れるようにする（最終章）
  function renderChars(ids, crowd) {
    NV.shown = ids.filter((id) => CHARS[id] && id !== "hero" && !CHARS[id].voice).slice(0, crowd ? 12 : 3);
    novel.chars.classList.toggle("crowd", Boolean(crowd));
    novel.chars.replaceChildren(...NV.shown.map(charNode));
  }

  // 地図・氷の床・歩けるマップ・最後の謎の枠・戦い・家の地図を表示しているか（そのときはキャラクターを出さない）
  const stageBusy = () => !novel.roomBox.hidden || !novel.gridBox.hidden || !novel.puzzleBox.hidden
    || !novel.battleBox.hidden || !novel.houseBox.hidden;

  // glow：光らせる仲間の配列（data.js の glow）。渡したときは、話し手のほかを暗くせず、その仲間だけを光らせる
  // dim：glow のとき、光らない仲間を暗くする（data.js の行の dim。暗さは glow のない場面と同じ .char.dim）
  function setSpeaker(who, glow, dim) {
    const c = who ? CHARS[who] : null;
    // 家の地図で appear のとき：話した仲間が、地図の上に現れる（4-3）
    if (c && NV.house) NV.house.appear(who);
    novel.name.hidden = !c || !c.name;
    if (c) {
      novel.name.textContent = who === "hero" ? fill("{name}") : charName(c);
      novel.name.style.setProperty("--c", c.color || "#999");
    }
    novel.box.classList.toggle("narration", !c);
    // 会話にだけ出てくるキャラクターも、空きがあれば表示する（声だけの人物は出さない）
    if (c && who !== "hero" && !c.voice && !stageBusy() && !NV.shown.includes(who) && NV.shown.length < 3) {
      NV.shown.push(who);
      novel.chars.append(charNode(who, NV.shown.length - 1));
    }
    for (const node of novel.chars.children) {
      node.classList.toggle("speaking", !glow && node.dataset.id === who);
      node.classList.toggle("dim", glow ? Boolean(dim) && !glow.includes(node.dataset.id)
        : Boolean(who) && node.dataset.id !== who);
      node.classList.toggle("glow", Boolean(glow) && glow.includes(node.dataset.id));
    }
  }

  // その行で光らせる仲間（行の glow。なければ、場面が glow: true のときだけ話す1匹）。null は今までどおり（話し手のほかを暗くする）
  function glowOf(ln) {
    if (ln.glow) return ln.glow;
    if (!NV.glow) return null;
    return ln.who && ln.who !== "hero" ? [ln.who] : [];
  }

  // ---- 行の絵（data.js の行の image。4-3 の回想のイラスト） ----
  //   PCで index.html を直接開いたとき（file://）だけ、pc-images の中の画像を探す。公開したページ（iPhone）では探さない。
  //   絵のある行のあいだは、ゲーム画面の部分（会話の枠より上）に、その絵を切り取らずに全体を収めて出す（余白は暗い色）。
  //   絵が変わる行（出す・別の絵にする・消す）では、暗転（場面の imageFade）をはさんでから、文を出す。
  //   画像が見つからない行は、絵を出さずに、今までどおり（glow の形）で進む
  const picFound = {};   // 画像の場所（data.js の image）→ 探した結果の Promise
  const picDone = {};    // 探し終えた結果（見つかれば画像の場所、なければ ""）
  function findPicture(path) {
    if (!picFound[path]) {
      picFound[path] = new Promise((resolve) => {
        const img = new Image();
        let timer = null;
        const done = (src) => {
          if (Object.prototype.hasOwnProperty.call(picDone, path)) return;
          clearTimeout(timer);
          picDone[path] = src;
          resolve(src);
        };
        img.onload = () => done(img.src);
        img.onerror = () => done("");
        timer = setTimeout(() => done(""), 4000);   // 4秒たっても読めなければ、ないものとして進む（止まらないように）
        // カタカナの名前も読めるように、フォルダ名・ファイル名を1つずつ URL の形にする
        img.src = `${ART_DIR}/${String(path).split("/").map(encodeURIComponent).join("/")}`;
      });
    }
    return picFound[path];
  }
  // その行で出す絵：見つかれば画像の場所、出さないときは ""、まだ探しているときは undefined
  function pictureOf(ln) {
    if (!ln.image || !ART_DIR || currentView !== "novel") return "";
    findPicture(ln.image);
    return Object.prototype.hasOwnProperty.call(picDone, ln.image) ? picDone[ln.image] : undefined;
  }
  // 幕（暗転・はじめの演出）の濃さを、ms かけて opacity にする。ms が 0 なら、途中の変化も止めて、すぐに変える
  //   （変化の途中で長さだけを 0 にしても、始まった変化は止まらないため）
  function fadeStyle(node, opacity, ms) {
    const len = Math.max(0, Number(ms) || 0);
    if (!len) {
      node.style.transitionProperty = "none";
      node.style.opacity = String(opacity);
      void node.offsetWidth;   // 変化をなくした状態を、画面に確定させる
      node.style.transitionProperty = "";
      return;
    }
    node.style.transitionDuration = `${len}ms`;
    node.style.opacity = String(opacity);
  }
  // 暗転の幕（ゲーム画面の部分だけ。会話の枠は暗くしない）。ms かけて、暗くする（on）・明るくもどす
  function setShade(on, ms) {
    fadeStyle(novel.shade, on ? 1 : 0, ms);
  }
  // 絵を入れかえる（"" で消して、いまの画面〔キャラクターの並び〕にもどす）
  function showPicture(src) {
    NV.picture = src || "";
    if (src) novel.pictureImg.src = src;
    else novel.pictureImg.removeAttribute("src");
    novel.picture.hidden = !src;
    novel.stage.classList.toggle("picture-mode", Boolean(src));
    novel.root.classList.toggle("picture-mode", Boolean(src));   // 会話の枠の影を、絵にかけないため（style.css）
  }
  // 絵が変わる行：暗くなる → 絵を入れかえる → 明るくなる → i 行目の文を出す
  //   暗転の長さは、場面の imageFade（ミリ秒。書かなければ 1000）。暗くなるのと明るくなるのに、半分ずつ使う。
  //   暗転のあいだは、クリック・Enter でも進まない（演出の行の wait と同じ）
  function swapPicture(i, src) {
    const token = gen;
    const lines = NV.lines;
    const sc = SCN[state.scene] || {};
    const half = (Number(sc.imageFade) >= 0 ? Number(sc.imageFade) : 1000) / 2;
    const alive = () => token === gen && NV.lines === lines && NV.mode === "pause";
    clearTimeout(NV.autoTimer);
    clearTimeout(NV.picTimer);
    if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
    NV.mode = "pause";
    setPausing(true);
    novel.mark.hidden = true;
    novel.text.textContent = "";   // 前の行の文は、暗くなり始めるときに消す
    setShade(true, half);
    NV.picTimer = setTimeout(() => {
      if (!alive()) return;
      showPicture(src);
      // 明るくなる前に、次の行の光り方にしておく（絵を消して、キャラクターの並びにもどるとき用）
      const ln = NV.lines[i];
      setSpeaker(ln.who, glowOf(ln), ln.dim);
      setShade(false, half);
      NV.picTimer = setTimeout(() => {
        NV.picTimer = null;
        if (!alive()) return;
        NV.mode = "talk";
        nvText(i);
      }, half);
    }, half);
  }
  // 行の絵を、まだ探しているとき：見つかるか、ないと分かるまで待ってから、i 行目を出す
  function waitPicture(i, ln) {
    const token = gen;
    const lines = NV.lines;
    clearTimeout(NV.autoTimer);
    NV.mode = "pause";
    setPausing(true);
    novel.mark.hidden = true;
    findPicture(ln.image).then(() => {
      if (token !== gen || NV.lines !== lines || NV.mode !== "pause") return;
      NV.mode = "talk";
      nvText(i);
    });
  }
  // 場面に入るとき：絵と暗転を片づける
  function clearPicture() {
    clearTimeout(NV.picTimer);
    NV.picTimer = null;
    setShade(false, 0);
    showPicture("");
  }

  // 演出の行（data.js の { house: … } など）を行う。文は出さない
  function runEffect(fx) {
    if (fx.house !== undefined) showHouse(fx.house, true);
    if (fx.puzzle === "answer") revealAnswer();
    if (fx.sound) SND.play(fx.sound);
    if (fx.ambient !== undefined) SND.ambient(fx.ambient || null);
    // 曲の切りかえ（2-7 の家具に変わる瞬間に止める、4-3 で8匹がそろったら最終章の曲）。PCの場面だけ（mute の場面は鳴らさない）
    if (fx.bgm !== undefined && currentView === "novel") {
      const sc = SCN[state.scene];
      SND.bgm(sc && sc.mute ? null : fx.bgm || null);
    }
  }

  function nvShow(i) {
    // 演出の行は、すぐに行って次の行へ
    //   wait を書いた演出は、その時間だけ待ってから次の行を出す（一拍置く。待つ間は、クリックしても進まない）
    let wait = 0;
    while (i < NV.lines.length && NV.lines[i].effect) {
      runEffect(NV.lines[i].effect);
      wait += Math.max(0, Number(NV.lines[i].effect.wait) || 0);
      i += 1;
    }
    if (wait > 0) {
      const token = gen;
      const lines = NV.lines;
      const alive = () => token === gen && NV.lines === lines && NV.mode === "pause";
      clearTimeout(NV.autoTimer);
      NV.mode = "pause";
      setPausing(true);   // 余韻（4-3）などのあいだは、ログを開けない
      novel.mark.hidden = true;
      // 次の文の行に絵（image）があるときは、絵を出す暗転（場面の imageFade）も、待つ時間の中に数える
      //   （4-3 の余韻：イラストがあるときも、ないときも、最初の文が出るまでを wait の長さにそろえる）
      //   絵が見つからなかったときは、残りの時間を待ってから文を出す
      const next = NV.lines[i];
      const sc = SCN[state.scene] || {};
      const fade = next && next.image && ART_DIR && currentView === "novel"
        ? Math.min(wait, Number(sc.imageFade) >= 0 ? Number(sc.imageFade) : 1000) : 0;
      const go = () => {
        if (!alive()) return;
        NV.mode = "talk";
        nvText(i);
      };
      NV.autoTimer = setTimeout(() => {
        if (!alive()) return;
        const pic = fade ? pictureOf(next) : "";
        if (!fade || pic === undefined || pic !== NV.picture) { go(); return; }
        NV.autoTimer = setTimeout(go, fade);
      }, wait - fade);
      return;
    }
    nvText(i);
  }

  // i 行目の文を出す（1文字ずつ）
  function nvText(i) {
    if (i >= NV.lines.length) {
      finishSay();
      return;
    }
    NV.idx = i;
    const ln = NV.lines[i];
    // 行の絵（data.js の image。PCで直接開いたときだけ）：絵が変わる行では、暗転をはさんでから文を出す
    const pic = pictureOf(ln);
    if (pic === undefined) { waitPicture(i, ln); return; }
    if (pic !== NV.picture) { swapPicture(i, pic); return; }
    // 文のある行が、もう残っていなければ最後の行（うしろの演出は、ここで行う）
    const last = !NV.lines.slice(i + 1).some((l) => !l.effect);
    if (last) for (const l of NV.lines.slice(i + 1)) runEffect(l.effect);
    const token = gen;
    const lines = NV.lines;
    let doneNow = false;
    clearTimeout(NV.autoTimer);
    setPausing(false);
    setSpeaker(ln.who, glowOf(ln), ln.dim);
    logAdd({ who: ln.who, text: ln.text });   // バックログに残す（今の場面で出た文）
    if (ln.sound) SND.play(ln.sound);
    if (NV.onLine) NV.onLine(i);
    novel.mark.hidden = true;
    if (NV.typer) NV.typer.cancel();
    const blip = ln.sound ? null : S.textSound;   // 行に自分の音があるときは、文字送りの音を鳴らさない
    const handle = typeInto(novel.text, ln.text, () => {
      doneNow = true;
      NV.typer = null;
      if (token !== gen) return;
      if (last && !NV.hold) finishSay();
      else {
        novel.mark.hidden = false;
        // 戦いの文（話し手のいない行）は、少し待つと自動で次へ進む
        if (NV.auto && !ln.who) {
          NV.autoTimer = setTimeout(() => {
            if (token === gen && NV.lines === lines && NV.idx === i && NV.mode === "talk") nvAdvance();
          }, NV.auto);
        }
      }
    }, blip);
    if (!doneNow) NV.typer = handle;
  }

  function finishSay() {
    clearTimeout(NV.autoTimer);
    setPausing(false);
    NV.mode = "idle";
    novel.mark.hidden = true;
    const then = NV.then;
    NV.then = null;
    if (then) then();
  }

  // クリック（タップ）で次へ
  //   from："stage"（絵のところ）/ "box"（会話の枠）/ "key"（Enter・スペース）
  function nvAdvance(from) {
    if (currentView !== "novel") return;
    // ログ・メニューなどを開いている間は進めない（戦いの文の自動送りも、閉じてからクリックで進む）
    if (overlay.classList.contains("open")) return;
    if (NV.mode === "explore" && NV.typer) { NV.typer.skip(); return; }
    // 地図を調べ終えたあとは、会話の枠（または Enter）でも先へ進める（絵のところは、調べまちがいがあるので進まない）
    if (NV.mode === "explore" && NV.exploreNext && from !== "stage") { NV.exploreNext(); return; }
    // 文のあとの演出（finale。4-6 エピローグ）：雪と絵のあいだは進まない。そのあとは、クリック・Enter で先へ
    if (NV.mode === "finale") { if (NV.finaleNext) NV.finaleNext(); return; }
    if (NV.mode !== "talk") return;
    if (NV.typer) { NV.typer.skip(); return; }
    if (NV.lines.slice(NV.idx + 1).some((l) => !l.effect)) nvShow(NV.idx + 1);
    else finishSay();
  }

  const NovelView = {
    enter(sc) {
      show("novel");
      novel.chapter.textContent = state.chapter;
      setBg(novel.stage, state.bg);
      novel.draft.hidden = !sc.draft;
      setLayer(null);
      novel.text.textContent = "";
      novel.mark.hidden = true;
      NV.mode = "idle";
      NV.dark = sc.room === "dark";
      NV.glow = Boolean(sc.glow);
      NV.grid = null;
      NV.battle = null;
      NV.exploreNext = null;
      NV.finaleNext = null;
      setPausing(false);
      novel.root.classList.remove("finale");   // 文のあとの演出（finale）で消した会話の枠を、もとにもどす
      novel.stageMark.hidden = true;
      if (NV.house) NV.house.stop();
      NV.house = null;
      clearPicture();
      GRID.key = null;
      novel.gridBox.hidden = true;
      novel.gridBox.replaceChildren();
      novel.puzzleBox.hidden = true;
      novel.puzzleBox.replaceChildren();
      novel.battleBox.hidden = true;
      novel.battleBox.replaceChildren();
      novel.houseBox.hidden = true;
      novel.houseBox.replaceChildren();
      novel.stage.classList.remove("walk-mode", "house-mode");
      const prevCrowd = NV.crowd || "";
      NV.crowd = "";
      novel.chars.classList.remove("crowd", "settled");
      if (sc.battle) {
        // 戦い（data.js の BATTLES）。仲間をえらぶ戦いでは、えらぶまで主人公だけを並べる
        novel.chars.replaceChildren();
        NV.shown = [];
        novel.roomBox.hidden = true;
        novel.roomBox.replaceChildren();
        novel.battleBox.hidden = false;
        const b = battleOf(sc.battle);
        if (b) NV.battle = renderBattle(novel.battleBox, battleNeedsPick(b) ? battleOf(sc.battle, flagOn, []) : b);
        else novel.battleBox.replaceChildren(el("div", { class: "room-missing", text: `data.js の BATTLES に「${sc.battle}」がありません。` }));
      } else if (sc.house) {
        // 家全体の地図（house.js）。地図の変化は、lines の { house: … } で行う
        novel.chars.replaceChildren();
        NV.shown = [];
        novel.roomBox.hidden = true;
        novel.roomBox.replaceChildren();
        showHouse(sc.house, false);
      } else if (sc.ice || sc.walk) {
        // 氷の床のパズル・歩けるマップ（house.js の地図）
        novel.chars.replaceChildren();
        NV.shown = [];
        novel.roomBox.hidden = true;
        novel.roomBox.replaceChildren();
        novel.gridBox.hidden = false;
        const spec = gridSpec(sc);
        if (spec) NV.grid = renderGrid(novel.gridBox, spec);
        else novel.gridBox.replaceChildren(el("div", { class: "room-missing", text: "house.js の地図を読み込めませんでした。" }));
      } else if (sc.room) {
        novel.chars.replaceChildren();
        NV.shown = [];
        novel.roomBox.hidden = false;
        renderRoom(novel.roomBox, null, NV.dark);
      } else if (sc.puzzle) {
        novel.chars.replaceChildren();
        NV.shown = [];
        novel.roomBox.hidden = true;
        novel.roomBox.replaceChildren();
        novel.puzzleBox.hidden = false;
        renderPuzzle(novel.puzzleBox);
      } else {
        novel.roomBox.hidden = true;
        novel.roomBox.replaceChildren();
        const ids = sc.show ? toArray(sc.show) : speakersOf(sc.lines);
        const crowd = Boolean(sc.show) && ids.length > 3;
        renderChars(ids, crowd);
        // 同じ仲間が続けて並ぶ場面では、もう一度1匹ずつ現れる動きをしない
        if (crowd) {
          NV.crowd = ids.join(",");
          novel.chars.classList.toggle("settled", NV.crowd === prevCrowd);
        }
      }
      setSnow(novel.stage, Boolean(sc.snow));
      setSpeaker(null);
    },

    // lines を順に表示し、終わったら then を呼ぶ
    // hold が true なら、最後の行のあとにもう一度クリックを待つ
    // opts.auto：話し手のいない行を、自動で次へ進めるまでの時間 / opts.onLine(i)：i 行目を出すときに呼ぶ
    say(lines, then, hold = true, opts) {
      clearTimeout(NV.autoTimer);
      // 絵を入れかえている途中なら、やめて暗転を消す（新しい行で、もう一度決める）
      if (NV.picTimer) { clearTimeout(NV.picTimer); NV.picTimer = null; setShade(false, 0); }
      NV.lines = toArray(lines).filter(visible).map(toLine);
      // 行の絵（image）は、先に探しはじめておく（場面のはじめの余韻のあいだに、見つかるかが分かる）
      if (ART_DIR) for (const l of NV.lines) if (l.image) findPicture(l.image);
      NV.then = then;
      NV.hold = hold;
      NV.auto = (opts && opts.auto) || 0;
      NV.onLine = (opts && opts.onLine) || null;
      setLayer(null);
      if (!NV.lines.length) {
        NV.mode = "idle";
        if (then) then();
        return;
      }
      NV.mode = "talk";
      nvShow(0);
    },

    choices(list, onPick) {
      novel.mark.hidden = true;
      const box = el("div", { class: "choices" },
        list.map((c) => el("button", {
          class: "choice", type: "button", text: fill(c.text),
          onclick: (e) => { e.stopPropagation(); setLayer(null); logAdd({ picked: fill(c.text) }); onPick(c); },
        })));
      setLayer(box);
    },

    input(spec, onSubmit, onHint, onSkip, onBack) {
      novel.mark.hidden = true;
      const field = inputField(spec, "text-input", "done");
      const form = el("form", {
        class: "input-panel",
        onsubmit: (e) => {
          e.preventDefault();
          const value = field.value.trim();
          if (!value) return;
          field.blur();
          setLayer(null);
          logAdd({ picked: value });
          // 前の文を消しておく（正解のあとの演出の間に、まちがえたときの返事などが残らないように）
          novel.text.textContent = "";
          setSpeaker(null);
          onSubmit(value);
        },
        onclick: (e) => e.stopPropagation(),
      },
        el("div", { class: "input-prompt", text: fill(spec.prompt || T("inputPrompt")) }),
        field,
        el("div", { class: "input-buttons" },
          onBack ? el("button", {
            type: "button", class: "btn ghost input-back", text: spec.backText ? fill(spec.backText) : T("inputBack"),
            onclick: () => { setLayer(null); onBack(); },
          }) : null,
          onSkip ? el("button", {
            type: "button", class: "btn ghost", text: fill(spec.skip.text || T("skip")),
            onclick: () => { setLayer(null); onSkip(); },
          }) : null,
          onHint ? el("button", {
            type: "button", class: "btn", text: T("hint"),
            onclick: () => { setLayer(null); onHint(); },
          }) : null,
          el("button", { type: "submit", class: "btn primary", text: T("submit") })));
      setLayer(form);
      if (!TOUCH) field.focus({ preventScroll: true });
    },

    // 言葉を手に入れたときのカード（とじると先へ進む）
    reveal(id, then) {
      const c = CHARS[id] || {};
      novel.mark.hidden = true;
      logAdd({ who: null, text: `${T("wordGet")}　${T("wordFrom", { who: charName(c) })}「${c.word || ""}」` });
      openOverlay(el("div", { class: "panel word-panel", style: `--c:${c.color || "#ccc"}` },
        el("div", { class: "word-get", text: T("wordGet") }),
        el("div", { class: "word-from" },
          withArt(el("span", { class: "word-avatar", text: c.emoji || "？", "aria-hidden": "true" }), id),
          T("wordFrom", { who: charName(c) })),
        wordNode(c.word, "big"),
        el("p", { class: "panel-note", text: T("wordNote") }),
        el("button", { class: "btn primary", type: "button", text: T("ok"), onclick: closeOverlay })), then);
    },

    // 文のあとの演出（data.js の場面の finale。4-6 エピローグ）
    //   1. 会話の枠をゆっくり消して、雪をふらせる（いまの画面〔9匹が並ぶ画面〕のまま）
    //   2. snow ミリ秒たったら、暗転（fade ミリ秒）をはさんで、最後のイラスト（image）に切りかえる
    //      絵は、PCで直接開いて、画像があるときだけ。ないときは、9匹が並ぶ画面のまま
    //   3. クリック・Enter を待ってから then（終わりの画面）。1と2のあいだは、クリックしても進まない
    finale(sc, then) {
      const f = sc.finale && typeof sc.finale === "object" ? sc.finale : {};
      const token = gen;
      const alive = () => token === gen && NV.mode === "finale";
      const snowMs = Number(f.snow) >= 0 ? Number(f.snow) : 3000;
      const half = (Number(f.fade) >= 0 ? Number(f.fade) : 1000) / 2;
      const image = typeof f.image === "string" ? f.image.trim() : "";
      const found = image && ART_DIR ? findPicture(image) : Promise.resolve("");
      clearTimeout(NV.autoTimer);
      clearTimeout(NV.picTimer);
      if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
      NV.mode = "finale";
      NV.finaleNext = null;
      setSpeaker(null);
      novel.text.textContent = "";
      novel.mark.hidden = true;
      novel.root.classList.add("finale");   // 会話の枠を、ゆっくり消す（style.css の .novel.finale）
      setSnow(novel.stage, true);
      // クリック・Enter を待つ（画面の右下に ▼ を出す）
      const ready = () => {
        NV.picTimer = null;
        if (!alive()) return;
        novel.stageMark.hidden = false;
        NV.finaleNext = () => {
          NV.finaleNext = null;
          novel.stageMark.hidden = true;
          NV.mode = "idle";
          then();
        };
      };
      NV.picTimer = setTimeout(() => {
        found.then((src) => {
          if (!alive()) return;
          if (!src) { ready(); return; }
          setShade(true, half);
          NV.picTimer = setTimeout(() => {
            if (!alive()) return;
            showPicture(src);
            setShade(false, half);
            // 絵が出たあと、少し間を置いてから、クリックを受けつける（文を読み進めていた勢いで、飛ばさないように）
            NV.picTimer = setTimeout(ready, half + 800);
          }, half);
        });
      }, snowMs);
    },

    // 地図を調べる
    //   光る場所を調べると、先へ進むボタンが出る。会話の枠のクリック・Enter・光る場所をもう一度押しても進む
    explore(sc, onDone) {
      NV.mode = "explore";
      novel.mark.hidden = true;
      setSpeaker(null);
      const dark = NV.dark;
      const token = gen;
      novel.text.textContent = fill(sc.exploreText || (RM && RM.exploreText) || T("explore"));
      const needFind = Boolean(RM) && RM.requireFind !== false && (RM.items || []).some((it) => it.shine);
      let found = !needFind;
      let shineSeen = false;   // 光る場所を、一度調べたか
      const proceed = () => {
        if (token !== gen || NV.mode !== "explore") return;
        if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
        NV.mode = "idle";
        NV.exploreNext = null;
        setLayer(null);
        renderRoom(novel.roomBox, null, dark);
        onDone();
      };
      const showDone = () => {
        NV.exploreNext = proceed;
        if (novel.layer.querySelector(".room-done")) return;
        setLayer(el("button", {
          class: "btn primary room-done", type: "button", text: sc.roomDone || T("roomDone"),
          onclick: (e) => {
            e.stopPropagation();
            proceed();
          },
        }));
      };
      renderRoom(novel.roomBox, (item) => {
        if (item.shine && shineSeen && found) { proceed(); return; }
        if (item.shine) shineSeen = true;
        if (NV.typer) NV.typer.cancel();
        let doneNow = false;
        // 暗い部屋では、家具の名前がはっきりしない文章にする
        const said = dark
          ? item.dark || (item.shine ? T("darkShine") : T("darkDefault", { item: item.name || "" }))
          : item.text || item.name || "";
        logAdd({ who: null, text: fill(said) });
        const handle = typeInto(novel.text, fill(said), () => {
          doneNow = true;
          NV.typer = null;
        }, S.textSound);
        if (!doneNow) NV.typer = handle;
        if (item.shine) found = true;
        if (found) showDone();
      }, dark);
      if (found) showDone();
    },

    // 氷の床のパズル：クリアしたら onClear、あきらめたら onSkip
    ice(sc, onClear, onSkip) {
      const spec = sc.ice;
      const ice = iceOf(sc);
      const view = NV.grid;
      if (!view || !ice.start) return;
      const best = iceBest(ice);
      const token = gen;
      let pos = { x: ice.start.x, y: ice.start.y };
      let moves = 0;
      let resets = 0;
      let busy = false;
      let done = false;
      NV.mode = "ice";
      novel.mark.hidden = true;
      setSpeaker(null);
      const help = fill(spec.help || T("iceHelp"));
      const status = () => { novel.text.textContent = `${help}\n${T("iceCount", { n: moves })}`; };
      const names = { up: "上へすべる", left: "左へすべる", right: "右へすべる", down: "下へすべる" };
      const pad = padNode(names, (d) => move(d));
      const skipBox = el("div", { class: "grid-skip" });
      const controls = el("div", { class: "grid-controls", onclick: (e) => e.stopPropagation() },
        pad,
        el("button", { type: "button", class: "btn grid-reset", text: T("iceReset"), onclick: () => reset() }),
        skipBox);
      view.side.replaceChildren(controls);
      status();

      const finish = () => {
        done = true;
        GRID.key = null;
        controls.remove();
      };
      const showSkip = () => {
        if (!onSkip || skipBox.childNodes.length) return;
        if (resets < (spec.skip.after == null ? 2 : spec.skip.after)) return;
        skipBox.append(el("button", {
          type: "button", class: "btn ghost", text: fill(spec.skip.text || T("iceSkip")),
          onclick: () => { finish(); onSkip(); },
        }));
      };
      showSkip();   // skip の after が 0 なら、はじめから出す
      const reset = () => {
        if (busy || done) return;
        pos = { x: ice.start.x, y: ice.start.y };
        moves = 0;
        resets += 1;
        view.place(pos.x, pos.y, 0);
        status();
        showSkip();
      };
      const bump = () => {
        view.face.classList.remove("bump");
        void view.face.offsetWidth;
        view.face.classList.add("bump");
      };
      // 氷の床の音（data.js の SETTINGS.iceSound の slide・bump）
      const iceSound = (kind, opts) => {
        const name = S.iceSound && S.iceSound[kind];
        if (name) SND.play(name, false, opts);
      };
      const move = (dir) => {
        if (busy || done || token !== gen) return;
        const r = iceSlide(ice, pos.x, pos.y, dir);
        if (!r.steps && !r.goal) { bump(); iceSound("bump"); return; }
        moves += 1;
        busy = true;
        const ms = r.steps * 90;
        view.place(r.x, r.y, ms);
        pos = { x: r.x, y: r.y };
        status();
        if (r.steps) iceSound("slide", { len: ms / 1000 });   // すべる長さに合わせて鳴らす
        setTimeout(() => {
          busy = false;
          if (token !== gen) return;
          if (!r.goal) { iceSound("bump"); return; }          // 岩か壁にぶつかって止まった
          finish();
          view.board.classList.add("cleared");
          // 最短でクリアしたら「最短記録」の音（ice の recordSound。挑戦の床だけに書いてある）
          if (moves <= best && spec.recordSound) SND.play(spec.recordSound);
          novel.text.textContent = moves <= best
            ? T("iceBest", { n: moves })
            : T("iceClear", { n: moves, best });
          setTimeout(() => { if (token === gen) onClear(); }, 1200);
        }, ms + 40);
      };

      // スマホ：盤面をスワイプしてもすべれる
      onSwipe(view.board, (d) => move(d));
      GRID.key = (e) => {
        const dir = KEY_DIRS[e.key];
        if (!dir) return false;
        move(dir);
        return true;
      };
    },

    // 歩けるマップ：矢印キーで1マスずつ歩き、Enter・スペースで目の前を調べる
    //   人物・出入口で起きることは、data.js の場面の events に書く
    walk(sc) {
      const view = NV.grid;
      const m = lookMap(sc.walk, "nature");
      if (!view || !m) return;
      const token = gen;
      const blocked = itemCells(m);
      const pos = Object.assign({}, NV.walkPos);
      // ついてくる仲間（data.js の follow）。自分が1マス歩くと、自分がいたマスへ来る（道はふさがない）
      const follower = NV.walkFollow ? Object.assign({}, NV.walkFollow) : null;
      let busy = false;
      view.board.classList.add("walking");
      novel.stage.classList.add("walk-mode");   // 選択肢を、地図にかからない場所に出す

      const events = () => toArray(sc.events).filter((ev) => eventOn(sc, ev));
      // そのマスにいる人物・調べられる場所（同じマスに何個も書いたときは、条件に合う最初のもの）
      const eventAt = (x, y) => events().find((ev) => !ev.door && eventCells(ev).some((p) => p.x === x && p.y === y)) || null;
      const doorEvent = (id) => events().find((ev) => ev.door === id) || null;
      const inside = (x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h;
      const save = () => {
        state.walk = { scene: state.scene, map: sc.walk, x: pos.x, y: pos.y, dir: pos.dir };
        if (follower) state.walk.follow = [follower.x, follower.y];
        storage.save(state);
      };
      // (x, y) にあるもの：{ ev }（人物・出入口の出来事）か { text }（家具やかべを調べた文章）
      const targetAt = (x, y) => {
        if (!inside(x, y)) {
          const e = edgeAt(m, x, y);
          if (!e) return null;
          const ev = e.id ? doorEvent(e.id) : null;
          if (ev) return { ev };
          return e.text || e.name ? { text: e.text || T("walkThing", { item: fill(e.name) }) } : null;
        }
        const ev = eventAt(x, y);
        if (ev) return { ev };
        const it = itemAt(m, x, y);
        return it ? { text: it.text || T("walkThing", { item: fill(it.name || "") }) } : null;
      };
      const frontOf = () => ({ x: pos.x + DIRS[pos.dir][0], y: pos.y + DIRS[pos.dir][1] });
      // 目の前に調べられるものがあれば、印をつける
      const markFront = () => {
        const f = frontOf();
        view.setFront(NV.mode === "walk" && targetAt(f.x, f.y) ? f : null);
      };
      const helpText = () => [
        T(TOUCH ? "walkHelpTouch" : "walkHelp"),
        sc.goal ? T("walkGoal", { goal: fill(sc.goal) }) : "",
      ].filter(Boolean).join("\n");

      // 集まった仲間（data.js の team）を、画面の横に出す
      const team = el("div", { class: "grid-team", hidden: !sc.team });
      const showTeam = () => {
        const ids = teamIds(sc);
        team.replaceChildren(
          el("div", { class: "grid-team-title", text: T("walkTeam") }),
          el("div", { class: "grid-team-list" },
            ids.length
              ? ids.map((id) => withArt(el("span", { class: "grid-team-face", style: `--c:${CHARS[id].color || "#ccc"}`, title: charName(CHARS[id]), text: CHARS[id].emoji || "？" }), id))
              : el("span", { class: "grid-team-none", text: T("walkTeamNone") })));
      };

      const resume = () => {
        if (token !== gen) return;
        NV.mode = "walk";
        view.setNpcs(walkNpcs(sc));
        if (sc.team) showTeam();
        setSpeaker(null);
        novel.mark.hidden = true;
        novel.text.textContent = helpText();
        markFront();
      };
      // 出来事：セリフ（say）を出してから、条件を記録（set）し、選択肢（choices）か、次の場面（next）へ
      const act = (ev) => {
        save();
        NV.mode = "talk";
        view.setFront(null);
        const choices = toArray(ev.choices).filter(visible);
        NovelView.say(toArray(ev.say), () => {
          if (token !== gen) return;
          setFlags(ev);
          storage.save(state);
          if (choices.length) ask(choices);
          else if (ev.next) runScene(ev.next);
          else resume();
        }, !choices.length);
      };
      // 選択肢：選んだものの返事（reply）を出して、条件を記録（set）し、next があればその場面へ。なければ歩くのにもどる
      const ask = (choices) => {
        NovelView.choices(choices, (c) => {
          if (token !== gen) return;
          setFlags(c);
          storage.save(state);
          NovelView.say(toArray(c.reply), () => {
            if (token !== gen) return;
            if (c.next) runScene(c.next);
            else resume();
          }, true);
        });
      };
      // 家具やかべを調べたときの文章
      const tell = (text) => {
        NV.mode = "talk";
        view.setFront(null);
        NovelView.say([text], resume, true);
      };
      const bump = () => {
        view.face.classList.remove("bump");
        void view.face.offsetWidth;
        view.face.classList.add("bump");
      };
      // repeat：キーを押しっぱなしにしたときの連続入力（人物に何度も話しかけないようにする）
      const move = (dir, repeat) => {
        if (NV.mode !== "walk" || busy || token !== gen) return;
        pos.dir = dir;
        view.place(pos.x, pos.y, 0, dir);
        const nx = pos.x + DIRS[dir][0];
        const ny = pos.y + DIRS[dir][1];
        if (!inside(nx, ny)) {
          // かべの出入口：通りぬけると、その出入口の出来事が起きる
          const e = edgeAt(m, nx, ny);
          const ev = e && e.id ? doorEvent(e.id) : null;
          if (ev && (!repeat || (ev.next && !ev.say))) { act(ev); return; }
          bump();
          markFront();
          save();
          return;
        }
        const ev = eventAt(nx, ny);
        if (ev && ev.npc) {
          // 人物にぶつかったら、話しかける
          if (repeat) bump();
          else act(ev);
          markFront();
          return;
        }
        if (blocked.has(xy(nx, ny))) {
          bump();
          markFront();
          save();
          return;
        }
        if (follower) {
          follower.x = pos.x;
          follower.y = pos.y;
          view.placeFollower(pos.x, pos.y, STEP_MS);
        }
        pos.x = nx;
        pos.y = ny;
        busy = true;
        view.setFront(null);
        view.place(nx, ny, STEP_MS, dir);
        save();
        setTimeout(() => {
          busy = false;
          if (token === gen && NV.mode === "walk") markFront();
        }, STEP_MS + 10);
      };
      const examine = () => {
        if (NV.mode !== "walk" || busy || token !== gen) return;
        const f = frontOf();
        let t = targetAt(f.x, f.y);
        // 目の前に、ついてくる仲間がいるとき（「イーブイだ。」）
        if (!t && follower && follower.x === f.x && follower.y === f.y) t = { text: T("walkThing", { item: charName(CHARS[follower.who]) }) };
        if (!t) {
          // 目の前に何もないときは、となりの人物・場所を調べる（向きを合わせなくてもよい）
          for (const d of Object.keys(DIRS)) {
            const nx = pos.x + DIRS[d][0];
            const ny = pos.y + DIRS[d][1];
            const ev = inside(nx, ny) ? eventAt(nx, ny) : null;
            if (!ev) continue;
            pos.dir = d;
            view.place(pos.x, pos.y, 0, d);
            t = { ev };
            break;
          }
        }
        if (!t) {
          novel.text.textContent = `${T("walkNothing")}\n${helpText()}`;
          return;
        }
        if (t.ev) act(t.ev);
        else tell(t.text);
      };

      const names = { up: "上へ歩く", left: "左へ歩く", right: "右へ歩く", down: "下へ歩く" };
      const pad = padNode(names, (d) => move(d, false), el("button", {
        type: "button", class: "grid-btn look", text: T("walkLook"),
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); examine(); },
      }));
      view.side.replaceChildren(team, el("div", { class: "grid-controls", onclick: (e) => e.stopPropagation() }, pad));
      onSwipe(view.board, (d) => move(d, false));
      GRID.key = (e) => {
        const dir = KEY_DIRS[e.key];
        // 人物と話している間（会話の文・選択肢）の ↑キーは、歩くのに使わない（バックログを開く）
        if (dir && e.key === "ArrowUp" && NV.mode !== "walk") return false;
        if (dir) {
          move(dir, e.repeat);
          return true;
        }
        if ((e.key === "Enter" || e.key === " ") && NV.mode === "walk") {
          if (!e.repeat) examine();
          return true;
        }
        return false;
      };
      save();
      resume();
    },

    // 戦い：（仲間をえらぶ →）戦う仲間それぞれのコマンドを選ぶ → 1ターン分の出来事を順に見せる → 勝つまでくり返す
    //   負けたら、ヒント（lose）を出して、その戦いの最初からやり直す（仲間も、えらび直せる）
    battle(sc, onWin) {
      const def = BT[sc.battle];
      if (!def || !NV.battle || !battleOf(sc.battle)) return;
      const token = gen;
      const alive = () => token === gen;
      let losses = 0;
      let hitSaid = false;   // 相手に初めて当たったときのセリフ（hitSay）を出したか。やり直しても2回目からは出さない
      let pick = null;       // えらんだ仲間（leader 以外）。えらばない戦いでは null
      let b = null;
      let ui = NV.battle;
      let st = null;
      // 技の音（MOVES の sound）は、その技の文を出すときに鳴らす
      const play = (steps, then) => {
        const line = (s) => (s.sound ? Object.assign(typeof s.text === "object" ? Object.assign({}, s.text) : { text: s.text }, { sound: s.sound }) : s.text);
        NovelView.say(steps.map(line), then, true, {
          auto: Math.max(0, Number(S.battleAuto) || 0),
          onLine: (i) => { if (alive()) ui.show(steps[i]); },
        });
      };
      // あきらめるボタン（skip.after 回負けると出す）
      const skipButton = () => {
        const skip = def.skip && def.skip.next && losses >= (def.skip.after == null ? 2 : def.skip.after) ? def.skip : null;
        return skip ? el("button", {
          type: "button", class: "btn ghost bt-skip", text: fill(skip.text || T("battleSkip")),
          onclick: (e) => {
            e.stopPropagation();
            GRID.key = null;
            ui.menu.replaceChildren();
            NovelView.say(toArray(skip.reply), () => runScene(skip.next), true);
          },
        }) : null;
      };
      // 負けたら、戦いを終えて、retreat の next の場面（強いモードの、仲間を集める所）へもどる
      //   ヒント（retreat の hint）：条件に合うとき（パパが仲間にいないとき）だけ、負けた回数を数えて、回数に合うセリフを出す
      //   回数は state.counts に残す（日をまたいでも数える）。回数が並べたセリフより多いときは、最後のセリフを毎回出す
      const retreat = () => {
        const rt = def.retreat;
        const h = rt.hint && typeof rt.hint === "object" && visible(rt.hint) ? rt.hint : null;
        let hint = [];
        if (h && toArray(h.lines).length) {
          const key = String(h.count || sc.battle);
          const n = (Number(state.counts[key]) || 0) + 1;
          state.counts[key] = n;
          storage.save(state);
          const list = toArray(h.lines);
          hint = toArray(list[Math.min(n, list.length) - 1]);
        }
        GRID.key = null;
        ui.menu.replaceChildren();
        NovelView.say([...hint, ...toArray(rt.lines)], () => { if (alive()) runScene(rt.next); }, true);
      };
      // 戦いを始める（仲間をえらぶ戦いなら、先にえらぶ）
      const begin = () => {
        if (!alive()) return;
        const base = battleOf(sc.battle);
        if (battleNeedsPick(base)) choose(base);
        else start(null);
      };
      // 仲間をえらぶ：えらべる仲間から choose 人（leader は、かならず戦う）。数字のキーでも選べる
      const choose = (base) => {
        // 前の戦いの残りのハートが見えないように、主人公だけの画面に描き直す
        ui = renderBattle(novel.battleBox, battleOf(sc.battle, flagOn, []));
        NV.battle = ui;
        NV.mode = "battle";
        setSpeaker(null);
        novel.mark.hidden = true;
        novel.text.textContent = T("battleChoose", { n: base.choose });
        let sel = toArray(pick).filter((id) => base.candidates.includes(id));
        const ok = el("button", {
          type: "button", class: "btn primary bt-pick-ok",
          onclick: (e) => {
            e.stopPropagation();
            if (sel.length !== base.choose) return;
            GRID.key = null;
            start(sel.slice());
          },
        });
        const cards = base.candidates.map((id, i) => el("button", {
          type: "button", class: "bt-pick", "data-id": id, style: `--c:${(CHARS[id] && CHARS[id].color) || "#ccc"}`,
          onmousedown: (e) => e.preventDefault(),
          onclick: (e) => { e.stopPropagation(); toggle(id); },
        },
          el("span", { class: "bt-cmd-key", text: String(i + 1), "aria-hidden": "true" }),
          withArt(el("span", { class: "bt-pick-face", text: (CHARS[id] && CHARS[id].emoji) || "？" }), id),
          el("span", { class: "bt-pick-name", text: whoName(id) }),
          el("span", { class: "bt-pick-moves", text: battleMovesOf(def, id).map(moveName).join("・") })));
        const update = () => {
          for (const c of cards) c.classList.toggle("on", sel.includes(c.dataset.id));
          ok.disabled = sel.length !== base.choose;
          ok.textContent = sel.length === base.choose ? T("battleChooseOk") : T("battleChooseLeft", { n: base.choose - sel.length });
        };
        const toggle = (id) => {
          if (sel.includes(id)) sel = sel.filter((x) => x !== id);
          else if (sel.length < base.choose) sel.push(id);
          update();
        };
        ui.root.classList.add("picking");   // えらんでいる間は、仲間の列をかくして、相手を大きく見せる
        ui.menu.replaceChildren(
          el("div", { class: "bt-pick-note", text: T("battleChooseNote", { leader: whoName(base.leader) }) }),
          el("div", { class: "bt-picks" }, cards),
          el("div", { class: "bt-menu-foot" }, ok, skipButton()));
        update();
        GRID.key = (e) => {
          const n = Number(e.key);
          if (n >= 1 && n <= cards.length) {
            if (!e.repeat) toggle(base.candidates[n - 1]);
            return true;
          }
          if (e.key === "Enter" && sel.length === base.choose) {
            if (!e.repeat) ok.click();
            return true;
          }
          return false;
        };
      };
      // えらんだ仲間で、戦いの画面を作り直して始める
      const start = (ids) => {
        pick = ids;
        b = battleOf(sc.battle, flagOn, ids);
        ui = renderBattle(novel.battleBox, b);
        NV.battle = ui;
        st = Object.assign(battleStart(b), { hitSaid });
        ask();
      };
      // ターンの始め：ヒントがあれば、ニンフィアが話してから、コマンドを選ぶ
      const ask = () => {
        if (!alive()) return;
        ui.show({ st });
        const hint = battleHintAt(b, st.turn);
        if (hint.length) NovelView.say(hint, () => command(0, []), true);
        else command(0, []);
      };
      // i 番目の仲間のコマンドを選ぶ（commands のない仲間は、さくせんで動くので、とばす）
      //   数字のキーで選ぶ。矢印キーで選んで Enter でもよい。Backspace（または Esc）で、ひとつ前の仲間にもどる
      const command = (i, picks) => {
        if (!alive()) return;
        while (i < b.members.length && !b.members[i].commands.length) { picks[i] = null; i += 1; }
        if (i >= b.members.length) { turn(picks); return; }
        const m = b.members[i];
        const first = b.members.findIndex((x) => x.commands.length);
        let back = -1;
        for (let k = i - 1; k >= 0; k--) if (b.members[k].commands.length) { back = k; break; }
        NV.mode = "battle";
        setSpeaker(null);
        novel.mark.hidden = true;
        novel.text.textContent = T("battleAsk", { who: whoName(m.who) });
        ui.show({ st, choosing: m.who, picks });
        const choosePick = (id) => {
          GRID.key = null;
          const next = picks.slice(0, i);
          next[i] = id;
          command(i + 1, next);
        };
        const goBack = back >= 0 ? () => { GRID.key = null; command(back, picks.slice(0, back)); } : null;
        const buttons = m.commands.map((id, k) => el("button", {
          type: "button", class: "bt-cmd",
          onmousedown: (e) => e.preventDefault(),
          onclick: (e) => { e.stopPropagation(); choosePick(id); },
        },
          el("span", { class: "bt-cmd-key", text: String(k + 1), "aria-hidden": "true" }),
          el("span", { class: "bt-cmd-name", text: moveName(id) }),
          MV[id].note ? el("span", { class: "bt-cmd-note", text: fill(MV[id].note) }) : null));
        const skip = i === first ? skipButton() : null;
        const foot = goBack || skip ? el("div", { class: "bt-menu-foot" },
          goBack ? el("button", {
            type: "button", class: "btn ghost bt-back", text: T("battleBack"),
            onclick: (e) => { e.stopPropagation(); goBack(); },
          }) : null,
          skip) : null;
        ui.menu.replaceChildren(...[el("div", { class: "bt-cmds" }, buttons), foot].filter(Boolean));
        GRID.key = (e) => {
          const n = Number(e.key);
          if (n >= 1 && n <= buttons.length) {
            if (!e.repeat) buttons[n - 1].click();
            return true;
          }
          if ((e.key === "Backspace" || e.key === "Escape") && goBack) {
            if (!e.repeat) goBack();
            return true;
          }
          const dir = KEY_DIRS[e.key];
          if (!dir) return false;
          const at = buttons.indexOf(document.activeElement);
          const step = dir === "up" || dir === "left" ? -1 : 1;
          const next = at < 0 ? 0 : (at + step + buttons.length) % buttons.length;
          if (buttons[next]) buttons[next].focus({ preventScroll: true });
          return true;
        };
      };
      const turn = (picks) => {
        NV.mode = "talk";
        ui.menu.replaceChildren();
        // 乱数を使うのは、技の fail（強いモードのパパの「スマホに夢中」）だけ
        const r = battleTurn(b, st, picks, false, Math.random);
        play(r.steps, () => {
          if (!alive()) return;
          st = r.state;
          hitSaid = st.hitSaid;
          if (st.won) {
            onWin();
            return;
          }
          if (st.lost) {
            if (def.retreat && def.retreat.next) {
              retreat();
              return;
            }
            losses += 1;
            const lose = toArray(def.lose);
            const hint = lose.length ? toArray(lose[Math.min(losses, lose.length) - 1]) : [];
            NovelView.say([...hint, T("battleRetry", { n: b.hearts })], begin, true);
            return;
          }
          ask();
        });
      };
      begin();
    },

    proceed(cb) { cb(); },
  };

  // ==============================================================
  // 升目の地図：氷の床のパズル（data.js の ice）と、歩けるマップ（data.js の walk）
  //   地図の形・家具・かべの出入口は house.js、人物と出来事は data.js の events に書く
  //   氷の床の map の文字：. 氷 / # 岩 / S スタート / G ゴール（ぶつかるとクリア）
  //   すべり出すと、岩・かべ・ゴールにぶつかるまで止まれない
  // ==============================================================
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const KEY_DIRS = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right",
  };
  const GRID = { key: null };   // 矢印キーなどで動かすための入り口（氷の床・歩けるマップ）
  const STEP_MS = 120;          // 1マス歩くのにかける時間（ミリ秒）
  const ARROWS = { up: "↑", left: "←", right: "→", down: "↓" };
  // かべの出入口・窓の絵（house.js の edges の kind。icon を書けば、そちらを使う）
  const EDGE_ICON = { door: "🚪", thicket: "🌹", icedoor: "🧊" };
  const xy = (x, y) => x + "," + y;

  function parseIce(spec) {
    const rows = toArray(spec && spec.map).map((r) => Array.from(String(r)));
    const w = Math.max(0, ...rows.map((r) => r.length));
    const ice = { w, h: rows.length, rock: new Set(), start: null, goal: null, starts: 0, goals: 0 };
    rows.forEach((r, y) => {
      for (let x = 0; x < w; x++) {
        const ch = r[x] || "#";
        if (ch === "#") ice.rock.add(xy(x, y));
        else if (ch === "S") { ice.start = { x, y }; ice.starts += 1; }
        else if (ch === "G") { ice.goal = { x, y }; ice.goals += 1; }
      }
    });
    return ice;
  }

  // 場面の氷の床。歩けるマップ（walk）の上なら、地図の家具のマスも岩と同じく止まる
  function iceOf(sc) {
    const ice = parseIce(sc.ice);
    const m = sc.walk ? lookMap(sc.walk, "nature") : null;
    if (m) for (const key of itemCells(m)) ice.rock.add(key);
    return ice;
  }

  // (x, y) から dir へすべったときに止まる場所。goal：ゴールにぶつかったか
  function iceSlide(ice, x, y, dir) {
    const [dx, dy] = DIRS[dir];
    let steps = 0;
    for (;;) {
      const nx = x + dx;
      const ny = y + dy;
      if (ice.goal && nx === ice.goal.x && ny === ice.goal.y) return { x, y, steps, goal: true };
      if (nx < 0 || ny < 0 || nx >= ice.w || ny >= ice.h || ice.rock.has(xy(nx, ny))) return { x, y, steps, goal: false };
      x = nx;
      y = ny;
      steps += 1;
    }
  }

  // 最短で何回すべればクリアできるか（たどりつけないときは -1）
  function iceBest(ice) {
    if (!ice.start || !ice.goal) return -1;
    const seen = new Set([xy(ice.start.x, ice.start.y)]);
    let layer = [ice.start];
    for (let n = 1; layer.length; n++) {
      const nextLayer = [];
      for (const p of layer) {
        for (const dir of Object.keys(DIRS)) {
          const r = iceSlide(ice, p.x, p.y, dir);
          if (r.goal) return n;
          const key = xy(r.x, r.y);
          if (!seen.has(key)) { seen.add(key); nextLayer.push(r); }
        }
      }
      layer = nextLayer;
    }
    return -1;
  }

  // house.js の地図を、見た目（"nature" 夢の中 / "home" 本当の家）を選んでまとめる
  // 片方の見た目しか書いていない家具・出入口は、もう片方では出さない（出入口の id は残す）
  function lookMap(id, look) {
    const m = HS && HS.maps && HS.maps[id];
    if (!m || !(m.w > 0) || !(m.h > 0)) return null;
    const base = m[look] || {};
    return {
      id, w: m.w, h: m.h, view: m.view, name: base.name || "", floor: base.floor || "", wall: base.wall || "",
      items: toArray(m.items).filter((it) => it && it[look]).map((it) =>
        Object.assign({ x: it.x || 0, y: it.y || 0, w: it.w || 1, h: it.h || 1 }, it[look])),
      edges: toArray(m.edges).filter((e) => e && (e[look] || e.id)).map((e) =>
        Object.assign({ side: e.side, cells: toArray(e.cells), id: e.id }, e[look] || {})),
    };
  }

  // 家具のあるマス（通れないマス）
  function itemCells(m) {
    const cells = new Set();
    for (const it of m.items) {
      for (let x = it.x; x < it.x + it.w; x++) for (let y = it.y; y < it.y + it.h; y++) cells.add(xy(x, y));
    }
    return cells;
  }
  function itemAt(m, x, y) {
    for (let i = m.items.length - 1; i >= 0; i--) {
      const it = m.items[i];
      if (x >= it.x && y >= it.y && x < it.x + it.w && y < it.y + it.h) return it;
    }
    return null;
  }

  // 部屋のすぐ外のマス (x, y) にある、かべの出入口・窓（なければ null）
  function edgeAt(m, x, y) {
    let side = "";
    let i = -1;
    if (x === -1 && y >= 0 && y < m.h) { side = "left"; i = y; }
    else if (x === m.w && y >= 0 && y < m.h) { side = "right"; i = y; }
    else if (y === -1 && x >= 0 && x < m.w) { side = "top"; i = x; }
    else if (y === m.h && x >= 0 && x < m.w) { side = "bottom"; i = x; }
    if (!side) return null;
    return m.edges.find((e) => e.side === side && e.cells.includes(i)) || null;
  }

  // events の npc と at を、マスの一覧にする
  //   1人なら npc: "sylveon", at: [6, 5]、何人もなら npc: ["a", "b"], at: [[1, 2], [3, 4]]
  function eventCells(ev) {
    if (!ev || ev.at == null) return [];
    const ids = toArray(ev.npc);
    const list = Array.isArray(ev.at[0]) ? ev.at : [ev.at];
    return list.map((p, i) => ({ x: Number(p[0]), y: Number(p[1]), id: ids.length ? ids[Math.min(i, ids.length - 1)] : null }));
  }

  // 集まった仲間（data.js の team のうち、条件に合うもの）
  function teamIds(sc) {
    return toArray(sc.team).filter((t) => t && visible(t)).flatMap((t) => toArray(t.who)).filter((id) => CHARS[id]);
  }

  // 歩けるマップの出来事が、いま起きるか（if・unless と、need：集まった仲間が何人以上か）
  function eventOn(sc, ev) {
    if (!ev || typeof ev !== "object" || !visible(ev)) return false;
    return ev.need == null || teamIds(sc).length >= Number(ev.need);
  }

  // いま出ている人物（同じマスに何人も書いたときは、条件に合う最初の1人）
  function walkNpcs(sc) {
    const out = [];
    const used = new Set();
    for (const ev of toArray(sc.events)) {
      if (!ev || !ev.npc || ev.hidden || !eventOn(sc, ev)) continue;   // hidden：姿を見せない人物（強いモードのパパ）
      for (const p of eventCells(ev)) {
        if (used.has(xy(p.x, p.y)) || !CHARS[p.id]) continue;
        used.add(xy(p.x, p.y));
        out.push(p);
      }
    }
    return out;
  }

  // 歩き始める場所：同じ地図で歩いた記録があれば、その場所から（会話のあとや、つづきから）
  function walkStart(sc) {
    const m = lookMap(sc.walk, "nature");
    const w = state.walk;
    if (m && w && w.map === sc.walk && Number.isInteger(w.x) && Number.isInteger(w.y)
      && w.x >= 0 && w.y >= 0 && w.x < m.w && w.y < m.h
      && !itemCells(m).has(xy(w.x, w.y)) && !walkNpcs(sc).some((p) => p.x === w.x && p.y === w.y)) {
      return { x: w.x, y: w.y, dir: DIRS[w.dir] ? w.dir : "down" };
    }
    const s = toArray(sc.start);
    return { x: Number(s[0]) || 0, y: Number(s[1]) || 0, dir: DIRS[s[2]] ? s[2] : "down" };
  }

  // ついてくる仲間（data.js の follow）が、はじめにいる場所
  //   この場面で歩いた記録があれば、その場所から。なければ follow の at（自分のとなりのときだけ）。
  //   どちらでもなければ、自分と同じマス（自分のうしろにかくれていて、歩き出すと出てくる）
  function followStart(sc, pos) {
    const f = sc.follow;
    const m = lookMap(sc.walk, "nature");
    if (!f || !CHARS[f.who] || !m) return null;
    const near = (p) => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1])
      && p[0] >= 0 && p[1] >= 0 && p[0] < m.w && p[1] < m.h
      && Math.abs(p[0] - pos.x) + Math.abs(p[1] - pos.y) <= 1;
    const w = state.walk;
    const saved = w && w.scene === state.scene && w.map === sc.walk ? w.follow : null;
    const at = [saved, f.at].find(near);
    return { who: f.who, x: at ? at[0] : pos.x, y: at ? at[1] : pos.y };
  }

  // 場面を描くための材料をそろえる（地図がないときは null）
  function gridSpec(sc) {
    const m = sc.walk ? lookMap(sc.walk, "nature") : null;
    if (sc.walk && !m) return null;
    const extra = { opened: toArray(sc.open), frost: sc.frost || null };
    if (sc.ice) {
      const ice = iceOf(sc);
      const base = m || { w: ice.w, h: ice.h, items: [], edges: [], floor: "ice", wall: "" };
      return Object.assign({}, base, extra, {
        ring: Boolean(m), rocks: ice.rock,
        npcs: ice.goal ? [{ id: "glaceon", x: ice.goal.x, y: ice.goal.y, goal: true }] : [],
        player: ice.start ? { x: ice.start.x, y: ice.start.y } : null,
      });
    }
    NV.walkPos = walkStart(sc);
    NV.walkFollow = followStart(sc, NV.walkPos);
    return Object.assign({}, m, extra, {
      ring: true, npcs: walkNpcs(sc), player: NV.walkPos, who: sc.player, follow: NV.walkFollow,
    });
  }

  // 升目の地図を描く。地図のまわりの1マスは、かべ（出入口・窓）
  function renderGrid(container, spec) {
    const R = spec.ring ? 1 : 0;
    const bw = spec.w + R * 2;
    const bh = spec.h + R * 2;
    const box = (x, y, w, h) =>
      `left:${((x + R) / bw) * 100}%;top:${((y + R) / bh) * 100}%;width:${(w / bw) * 100}%;height:${(h / bh) * 100}%`;
    const frost = spec.frost ? toArray(spec.frost) : null;
    const frosty = (x, y) => frost && x >= frost[0] && y >= frost[1] && x < frost[0] + frost[2] && y < frost[1] + frost[3];
    const board = el("div", {
      class: `grid-board floor-${spec.floor || "ice"} wall-${spec.wall || "none"}` + (R ? " ringed" : ""),
      style: `--bw:${bw};--bh:${bh}`, role: "img", "aria-label": fill(spec.name || ""),
    });
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const x = bx - R;
        const y = by - R;
        if (x >= 0 && y >= 0 && x < spec.w && y < spec.h) {
          const rock = spec.rocks && spec.rocks.has(xy(x, y));
          board.append(el("div", { class: "tile" + (rock ? " rock" : "") + (frosty(x, y) ? " frost" : "") },
            rock ? el("span", { text: "🪨" }) : null));
          continue;
        }
        const e = edgeAt(spec, x, y);
        const kind = (e && e.kind) || "";
        const open = Boolean(e && e.id && spec.opened.includes(e.id));
        const icon = e && !open ? e.icon || EDGE_ICON[kind] : "";
        board.append(el("div", { class: "tile wall" + (kind ? " edge edge-" + kind : "") + (open ? " opened" : "") },
          icon ? el("span", { text: icon }) : null));
      }
    }
    for (const it of spec.items || []) {
      const small = it.w * it.h < 2;
      board.append(el("div", {
        class: "grid-item" + (it.look ? " look-" + it.look : "") + (small ? " small" : "") + (it.h > it.w ? " tall" : ""),
        style: `${box(it.x, it.y, it.w, it.h)};--c:${it.color || "#ddd"}`,
      },
        it.icon ? el("span", { class: "grid-icon", text: it.icon, "aria-hidden": "true" }) : null,
        it.name && !small ? el("span", { class: "grid-label", text: fill(it.name) }) : null));
    }
    const npcs = el("div", { class: "grid-npcs" });
    const front = el("div", { class: "grid-front", hidden: true });
    // 自分のコマ（data.js の場面の player。書かなければイーブイ）と、ついてくる仲間（follow）
    const faceOf = (id) => {
      const c = CHARS[id] || {};
      return withArt(el("span", { class: "grid-face", style: `--c:${c.color || "#ccc"}`, text: c.emoji || "●" }), id);
    };
    const face = faceOf(spec.who && CHARS[spec.who] ? spec.who : "eevee");
    const player = el("div", { class: "grid-player", "aria-hidden": "true" }, face);
    const follower = spec.follow ? el("div", { class: "grid-follower", "aria-hidden": "true" }, faceOf(spec.follow.who)) : null;
    board.append(npcs, front, ...(follower ? [follower] : []), player);
    // 縦に長い地図（house.js の view）は、縦 view マス分の窓から、自分のまわりだけを大きく見せる
    const rows = spec.view > 0 && spec.view < bh ? Math.round(spec.view) : 0;
    const frame = rows ? el("div", { class: "grid-window", style: `--bw:${bw};--rows:${rows}` }, board) : board;
    if (rows) board.classList.add("scrolling");
    const side = el("div", { class: "grid-side" });
    const wrap = el("div", { class: "grid-wrap" }, frame, side);
    container.replaceChildren(wrap);

    const at = (node, x, y) => {
      node.style.setProperty("--x", x + R);
      node.style.setProperty("--y", y + R);
    };
    // 窓の位置：自分が窓のまんなかに来るように動かす（地図の上と下の端では止める）
    const camera = (y, ms) => {
      if (!rows) return;
      const top = Math.max(0, Math.min(bh - rows, y + R - Math.floor(rows / 2)));
      board.style.setProperty("--cam", `${ms || 0}ms`);
      board.style.transform = `translateY(${((-top / bh) * 100).toFixed(4)}%)`;
    };
    const place = (x, y, ms, dir) => {
      player.style.setProperty("--t", `${ms || 0}ms`);
      at(player, x, y);
      if (dir) player.dataset.dir = dir;
      camera(y, ms);
    };
    const placeFollower = (x, y, ms) => {
      if (!follower) return;
      follower.style.setProperty("--t", `${ms || 0}ms`);
      at(follower, x, y);
    };
    const setNpcs = (list) => {
      npcs.replaceChildren(...list.map((n) => {
        const c = CHARS[n.id] || {};
        const node = el("div", { class: "grid-npc" + (n.goal ? " goal" : ""), style: `--c:${c.color || "#ccc"}` },
          withArt(el("span", { text: c.emoji || "？" }), n.id));
        at(node, n.x, n.y);
        return node;
      }));
    };
    const setFront = (cell) => {
      front.hidden = !cell;
      if (cell) at(front, cell.x, cell.y);
    };
    setNpcs(spec.npcs || []);
    if (spec.player) place(spec.player.x, spec.player.y, 0, spec.player.dir);
    if (spec.follow) placeFollower(spec.follow.x, spec.follow.y, 0);
    return { wrap, board, side, player, face, place, placeFollower, setNpcs, setFront };
  }

  // 矢印のボタン（真ん中に center を置ける）。押してもボタンに焦点が移らないようにする
  //   （焦点が移ると、スペースキーでボタンが押されてしまうため）
  function padNode(labels, onMove, center) {
    return el("div", { class: "grid-pad" },
      Object.keys(ARROWS).map((d) => el("button", {
        type: "button", class: "grid-btn " + d, text: ARROWS[d], "aria-label": labels[d],
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); onMove(d); },
      })),
      center || null);
  }

  // スマホ：盤面をスワイプした向きに動く
  function onSwipe(node, onMove) {
    let t0 = null;
    node.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      t0 = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    node.addEventListener("touchend", (e) => {
      if (!t0) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - t0.x;
      const dy = t.clientY - t0.y;
      t0 = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      onMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
    });
  }

  // 夢の部屋の地図を描く（onPick があれば、家具をタップできる）
  // dark が true なら、暗い部屋（家具は影だけ、光る場所はリングの光）にする
  function renderRoom(container, onPick, dark) {
    if (!RM) {
      container.replaceChildren(el("div", { class: "room-missing", text: "room.js を読み込めませんでした。" }));
      return;
    }
    const cols = RM.cols || 10;
    const rows = RM.rows || 8;
    const room = el("div", {
      class: "room" + (onPick ? " interactive" : "") + (dark ? " dark" : ""),
      style: `--cols:${cols};--rows:${rows};--floor:${RM.floor || "#f2e6cf"}`,
      role: "group", "aria-label": dark ? "暗い部屋" : "夢の部屋の地図",
    });
    for (const it of RM.items || []) {
      const pct = (v, total) => `${(v / total) * 100}%`;
      // wall: true は、部屋の外（出窓のまわりなど）をぬりつぶすだけ。調べられない
      if (it.wall) {
        room.append(el("div", {
          class: "room-wall", "aria-hidden": "true",
          style: `left:${pct(it.x, cols)};top:${pct(it.y, rows)};width:${pct(it.w, cols)};height:${pct(it.h, rows)}`,
        }));
        continue;
      }
      // 形に合わせて文字の並べ方を変える（細長い家具でも名前が切れないように）
      const shape = it.w <= 1 && it.h <= 1 ? " tiny"
        : it.h <= 1 && it.w >= 2 ? " wide"
          : it.w <= 1 && it.h >= 2 ? " tall" : "";
      const btn = el("button", {
        type: "button",
        class: "room-item" + shape + (it.shine ? " shine" : ""),
        style: `left:${pct(it.x, cols)};top:${pct(it.y, rows)};width:${pct(it.w, cols)};height:${pct(it.h, rows)};--c:${it.color || "#ddd"}`,
        disabled: !onPick,
        "aria-label": dark ? (it.shine ? "リングの光" : "暗くて見えないもの") : it.name,
      },
        it.icon && !dark ? el("span", { class: "room-icon", text: it.icon, "aria-hidden": "true" }) : null,
        dark ? null : el("span", { class: "room-label", text: it.name }));
      if (onPick) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          for (const n of room.querySelectorAll(".picked")) n.classList.remove("picked");
          btn.classList.add("picked");
          onPick(it);
        });
      }
      room.append(btn);
    }
    container.replaceChildren(room);
  }

  // 最後の謎の枠を描く（data.js の PUZZLE。表示するだけで、答えは入力欄で受ける）
  //   □：言葉が入るマス　・：マスなし　それ以外：最初から書いてある文字（「ー」など）
  //   answerColumn の列には色をつける
  function renderPuzzle(container) {
    if (!PZ) {
      container.replaceChildren();
      return;
    }
    const rows = toArray(PZ.rows).map((r) => Array.from(String(r)));
    const cols = Math.max(0, ...rows.map((r) => r.length));
    const answer = Number(PZ.answerColumn) || 0;
    const grid = el("div", { class: "puzzle-grid", style: `--cols:${cols};--rows:${rows.length}`, role: "img", "aria-label": fill(PZ.note || "") });
    rows.forEach((r) => {
      for (let x = 0; x < cols; x++) {
        const ch = r[x] || "・";
        const none = ch === "・" || ch === " " || ch === "　";
        grid.append(el("div", {
          class: "pz-cell" + (none ? " none" : "") + (!none && x + 1 === answer ? " answer" : ""),
        }, none || ch === "□" ? null : ch));
      }
    });
    container.replaceChildren(el("div", { class: "puzzle-wrap" },
      grid,
      PZ.note ? el("p", { class: "puzzle-note", text: fill(PZ.note) }) : null));
  }

  // 最後の謎：答えの列を、上から1字ずつ光らせる（data.js の { puzzle: "answer" }。正解したあとだけ使う）
  //   空いているマスには、PUZZLE の answer の字を入れる（「ー」のように、はじめから書いてある字はそのまま）
  const ANSWER_STEP = 260;   // 1字ごとの間（ミリ秒）
  function revealAnswer() {
    if (!PZ || novel.puzzleBox.hidden) return;
    const letters = Array.from(String(PZ.answer || ""));
    const token = gen;
    [...novel.puzzleBox.querySelectorAll(".pz-cell.answer")].forEach((cell, k) => {
      setTimeout(() => {
        if (token !== gen) return;
        if (!cell.textContent && letters[k]) cell.textContent = letters[k];
        cell.classList.add("lit");
      }, k * ANSWER_STEP);
    });
  }

  // 雪をふらせる（data.js の場面の snow。エピローグ）。parent の中に、雪の層を入れる（on が false なら消す）
  //   雪の位置・大きさ・速さは、決まった並び（黄金比）でばらす（乱数は使わない）
  const SNOW_FLAKES = 42;
  function setSnow(parent, on) {
    for (const old of parent.querySelectorAll(".snow-layer")) old.remove();
    if (!on) return;
    const flakes = Array.from({ length: SNOW_FLAKES }, (_, i) => {
      const a = (i * 0.6180339887) % 1;
      const b = (i * 0.4142135624 + 0.3) % 1;
      return el("i", { style: `--x:${(a * 100).toFixed(2)}%;--s:${(3 + b * 5).toFixed(1)}px;--d:${(7 + b * 7).toFixed(2)}s;`
        + `--delay:${(-a * 14).toFixed(2)}s;--sway:${((b - 0.5) * 50).toFixed(0)}px;--o:${(0.55 + b * 0.4).toFixed(2)}` });
    });
    parent.prepend(el("div", { class: "snow-layer", "aria-hidden": "true" }, flakes));
  }

  // ==============================================================
  // 戦い（data.js の BATTLES・MOVES。1-3 ニンフィアの花畑）
  //   毎ターン、戦う仲間それぞれのコマンドを選ぶ。相手は actions のとおりに動く
  //   1ターン分の出来事を先に計算してから（battleTurn）、画面で1つずつ見せる
  //   数値は固定で、乱数は使わない（同じ選び方なら、いつも同じ結果になる）
  // ==============================================================
  // 主人公は、入力した名前で表示する
  const whoName = (id) => (id === "hero" ? fill("{name}") : charName(CHARS[id]));

  // 戦いの文の { } を置きかえる（{who} 技を使った人・{move} 技の名前・{n} 数など。{name} なども）
  function btText(s, vars) {
    return fill(String(s == null ? "" : s).replace(/\{(\w+)\}/g, (whole, k) => (vars && k in vars ? String(vars[k]) : whole)));
  }
  // 文の一覧を、条件（if・unless）で選んでから置きかえる（sound を書いた行は、音の名前も残す）
  function btLines(lines, vars) {
    return toArray(lines).filter(visible).map((ln) => {
      if (!ln || typeof ln !== "object") return btText(ln, vars);
      const text = btText(ln.text, vars);
      if (!ln.who && !ln.sound) return text;
      return Object.assign({ text }, ln.who ? { who: ln.who } : {}, ln.sound ? { sound: ln.sound } : {});
    });
  }

  // 戦う仲間の候補（party。名前だけ書いたものも { who } にそろえる）
  function battleParty(def) {
    const list = toArray(def && def.party)
      .map((p) => (typeof p === "string" ? { who: p } : p))
      .filter((p) => p && p.who && CHARS[p.who]);
    if (def && def.leader && CHARS[def.leader] && !list.some((p) => p.who === def.leader)) list.unshift({ who: def.leader });
    return list;
  }
  // その仲間が使える技（コマンド。なければ、さくせんの技）
  function battleMovesOf(def, id) {
    const p = battleParty(def).find((x) => x.who === id) || {};
    const cmds = toArray(p.commands).filter((c) => MV[c]);
    return cmds.length ? cmds : toArray(p.tactics).map((t) => (typeof t === "string" ? t : t && t.move)).filter((m) => MV[m]);
  }

  // 戦いのデータを、動く順番の一覧（members）にまとめる
  //   last：相手の最後の何個のハートは、決め技（finish の技）でしか減らないか
  //   on  ：条件の名前が入っているかを調べる関数（点検では、全員が仲間になったものとして調べる）
  //   pick：えらんだ仲間（leader 以外の名前の一覧）。書かなければ、えらべる仲間の上から choose 人
  //   choose を書いた戦いでは、party のうち条件（if・unless）のある人からえらぶ。そのうち条件に合う人が「えらべる仲間」。
  //   条件のない人（強いモードの合体戦のイーブイ・ニンフィア）は、えらばずに、いつも戦う。
  //   えらべる仲間が choose 人より少ないとき（テスト用メニューでとんだときなど）は、条件のある全員からえらべる
  function battleOf(id, on = flagOn, pick = null) {
    const def = BT[id];
    if (!def || typeof def !== "object") return null;
    const all = battleParty(def);
    const choose = Math.max(0, Math.floor(Number(def.choose) || 0));
    const others = all.filter((p) => p.who !== def.leader);
    const optional = choose ? others.filter((p) => p.if != null || p.unless != null) : others;
    const fixed = others.filter((p) => !optional.includes(p));
    let can = optional.filter((p) => visibleWith(p, on));
    if (choose && can.length < choose) can = optional;
    const chosen = !choose ? can : pick ? can.filter((p) => pick.includes(p.who)) : can.slice(0, choose);
    const members = all.filter((p) => p.who === def.leader || fixed.includes(p) || chosen.includes(p)).map((p) => ({
      who: p.who,
      leader: p.who === def.leader,
      commands: toArray(p.commands).filter((c) => MV[c]),
      tactics: toArray(p.tactics).map((t) => (typeof t === "string" ? { move: t } : t)).filter((t) => t && t.move),
    }));
    const e = def.enemy || {};
    return {
      id, def, members, choose,
      candidates: can.map((p) => p.who),
      leader: def.leader,
      hearts: Math.max(1, Math.floor(Number(def.hearts) || 1)),
      foes: toArray(e.who).filter((w) => CHARS[w]),
      enemy: e,
      foeHearts: Math.max(1, Math.floor(Number(e.hearts) || 1)),
      last: Math.max(0, Math.floor(Number(e.last) || 0)),
      weak: toArray(e.weak),
      actions: toArray(e.actions).filter((a) => a && typeof a === "object"),
    };
  }
  // 仲間をえらんでから戦うか（えらべる仲間が、choose 人より多いとき）
  const battleNeedsPick = (b) => Boolean(b) && b.choose > 0 && b.candidates.length > b.choose;
  // turn ターン目の相手の行動（actions を上から順にくり返す）
  const battleAction = (b, turn) => (b.actions.length ? b.actions[(Math.max(1, turn) - 1) % b.actions.length] : null);

  // 戦いの始め（ハートは満タン）
  //   charged：力をためている仲間（名前 → 倍率）/ hitSaid：hitSay（初めて当たったときのセリフ）を出したか
  function battleStart(b) {
    return { turn: 1, hearts: b.hearts, foe: b.foeHearts, cheer: 0, cheerLeft: 0, charged: {}, won: false, lost: false, hitSaid: false };
  }

  // さくせん（commands のない仲間）：上から順に調べて、条件に合った最初の技（合うものがなければ、動かない）
  //   hearts: 2 → ハートが2以下のとき / cheer: false → 力アップが切れているとき（true は、力アップ中）
  //   foe: 3 → 相手のハートが3以下のとき
  function pickTactic(m, st) {
    for (const t of m.tactics) {
      if (t.hearts != null && !(st.hearts <= Number(t.hearts))) continue;
      if (t.foe != null && !(st.foe <= Number(t.foe))) continue;
      if (t.cheer === false && st.cheerLeft > 0) continue;
      if (t.cheer === true && !(st.cheerLeft > 0)) continue;
      if (MV[t.move]) return t.move;
    }
    return null;
  }

  // 攻撃の技の強さ（点検で「いちばん強い攻撃」を選ぶため）
  //   主人公の攻撃を強くする技（boost。強いモードのパパ）は、攻撃の次に選ぶ（防ぐ技よりは先）
  const attackValue = (b, id) => {
    const mv = MV[id];
    if (mv && mv.kind === "boost") return 0;
    if (!mv || mv.kind !== "attack") return -1;
    return (Number(mv.power) || 0) * Math.max(1, Number(mv.hits) || 1) * (b.weak.includes(mv.type) ? 2 : 1);
  };

  // 技の名前（コマンドのボタンと、技を使ったときの文）
  //   {call} は、PCだけの pc-images/name.js の call（強いモードのパパが呼ぶ呼び名）。
  //   呼び名がないとき（name.js がない・call がない・公開ページ）は、技の noCall を使う（書かなければ {call} を {name} にする）
  function moveName(id) {
    const mv = MV[id] || {};
    const raw = String(mv.name || id || "");
    if (!raw.includes("{call}")) return fill(raw);
    const call = nameCall();
    if (!call) return fill(mv.noCall || raw.split("{call}").join("{name}"));
    return fill(raw.split("{call}").join(call));
  }

  // 1ターン分の出来事を計算する（画面には出さない）
  //   picks：戦う仲間それぞれが選んだ技の名前（members と同じ順番。さくせんで動く仲間の分は null）
  //   quiet：true なら文を作らない（点検で、何度も計算するため）
  //   rand：技の fail（強いモードのパパの「スマホに夢中」）に使う乱数（0 以上 1 未満）。
  //         書かなければ、いつも起こらない（点検で、最短のターン数を数えるとき）。乱数を使うのは、この fail だけ
  //   返り値：{ state：ターンのあとの状態, steps：画面に出す文と、そのときの状態（st）・動き（fx）の一覧 }
  function battleTurn(b, st0, picks, quiet, rand) {
    const luck = typeof rand === "function" ? rand : () => 1;
    const st = Object.assign({}, st0, { charged: Object.assign({}, st0.charged) });
    const e = b.enemy;
    const steps = [];
    const snap = () => ({ turn: st.turn, hearts: st.hearts, foe: st.foe, cheerLeft: st.cheerLeft, charged: Object.assign({}, st.charged) });
    const enemy = quiet || !b.foes.length ? "" : whoName(b.foes[0]);
    const vars = (extra) => Object.assign({ enemy }, extra);
    const narration = (t) => typeof t === "string" && !parseLine(t).who;
    // 1つの動きの文を steps に入れる。最初の2つがどちらも地の文なら、1つの枠に2行で出す
    const act = (parts) => {
      const list = parts.filter((p) => p && p.text);
      for (let i = 0; i < list.length; i++) {
        const p = Object.assign({}, list[i]);
        const q = list[i + 1];
        if (i === 0 && q && narration(p.text) && narration(q.text)) {
          p.text = `${p.text}\n${q.text}`;
          p.st = q.st;
          p.fx = q.fx || p.fx;
          p.target = q.target || p.target;
          p.sound = p.sound || q.sound;
          i += 1;
        }
        steps.push(p);
      }
    };

    // 仲間の番（party の上から順。ただし、このターンの最初に動く技〔MOVES の first〕を選んだ仲間が、先に動く）
    let boost = 0;           // てだすけの倍率（次に動く仲間に効く）
    let guardBig = null;     // big の行動（ふぶきなど）を防ぐ技（大技でない攻撃には効かないので、そのときは技の miss を出す）
    let guardAll = null;     // 相手の攻撃を、すべて防ぐ技（強いモードのパパの「におう立ち」など）
    const powerUp = {};      // このターンだけの攻撃の倍率（boost の技。仲間 → 倍率）
    const picked = (i) => (b.members[i].commands.length ? toArray(picks)[i] : null);
    const first = (i) => Boolean(picked(i) && MV[picked(i)] && MV[picked(i)].first);
    const order = b.members.map((m, i) => i);
    const turnOrder = [...order.filter(first), ...order.filter((i) => !first(i))];
    for (let k = 0; k < turnOrder.length && !st.won; k++) {
      const i = turnOrder[k];
      const m = b.members[i];
      const id = m.commands.length ? picked(i) : pickTactic(m, st);
      const mv = id ? MV[id] : null;
      const charge = st.charged[m.who] || 0;
      delete st.charged[m.who];   // ためた力は、次に動いたときに使う（攻撃でなければ消える）
      if (!mv) continue;
      const times = boost || 1;
      boost = 0;
      const power = Math.max(0, Number(mv.power) || 0);
      const parts = [];
      const add = (text, extra) => { if (!quiet && text) parts.push(Object.assign({ text, st: snap(), actor: m.who }, extra)); };
      const v = quiet ? null : vars({ who: whoName(m.who), move: moveName(id), n: power });
      // fail：ときどき、技の代わりに何もしない（強いモードのパパの「スマホに夢中」。rate は起こる割合）
      if (mv.fail && typeof mv.fail === "object" && luck() < Number(mv.fail.rate)) {
        if (!quiet) {
          for (const ln of btLines(mv.fail.text, v)) add(ln);
          act(parts);
        }
        continue;
      }
      if (!quiet) {
        // 技の音（MOVES の sound）は、技の名前の文といっしょに鳴らす（数値を変えても、同じ技なら同じ音）
        add(mv.text ? btText(mv.text, v) : T("battleUse", v), { fx: mv.ribbon ? "ribbon" : "", sound: mv.sound || "" });
        // てだすけで強くなるのは、攻撃・回復・力アップだけ（防ぐ技などでは、倍の文を出さない）
        if (times > 1 && ["attack", "heal", "cheer"].includes(mv.kind)) add(T("battleBoost", { n: times }));
        for (const ln of btLines(mv.say, v)) add(ln);
      }
      if (mv.kind === "attack") {
        const weak = b.weak.includes(mv.type);
        // finish（決め技）は、残りのハートを全部へらす。ほかの技では、相手の最後の last 個のハートはへらせない（よけられる）
        const up = mv.finish ? 1 : powerUp[m.who] || 1;   // このターンだけの倍率（boost）
        const dmg = mv.finish ? st.foe
          : (power + st.cheer) * Math.max(1, Number(mv.hits) || 1) * (weak ? 2 : 1) * times * (charge || 1) * up;
        const dealt = Math.max(0, Math.min(dmg, st.foe - (mv.finish ? 0 : Math.min(st.foe, b.last))));
        st.foe -= dealt;
        if (!quiet) {
          if (dealt > 0 || dmg <= 0) {
            if (charge > 1) add(T("battleCharged", { n: charge }));
            if (up > 1) add(T("battlePowered", { n: up }));
            if (weak) add(T("battleWeak"));
            add(T("battleFoeDamage", vars({ n: dealt })), { fx: st.foe > 0 ? "hit" : "" });
          } else {
            add(e.dodge ? btText(e.dodge, v) : T("battleDodge", v), { fx: "guard" });
          }
        }
        if (st.foe <= 0) {
          st.won = true;
          if (!quiet) {
            const lines = btLines(e.break, v);
            (lines.length ? lines : [T("battleWin", v)]).forEach((ln, k) => add(ln, { actor: k ? "" : m.who, fx: k ? "" : "break" }));
          }
        } else if (dealt > 0 && !st.hitSaid) {
          st.hitSaid = true;
          if (!quiet) for (const ln of btLines(e.hitSay, v)) add(ln, { actor: "" });
        }
      } else if (mv.kind === "heal") {
        const n = Math.min(b.hearts - st.hearts, power * times);
        if (n > 0) st.hearts += n;
        if (!quiet) add(n > 0 ? T("battleHeal", { n }) : T("battleHealFull"), { fx: n > 0 ? "heal" : "" });
      } else if (mv.kind === "cheer") {
        st.cheer = power * times;
        st.cheerLeft = Math.max(1, Number(mv.turns) || 1);
        if (!quiet) add(T("battleCheer", { n: st.cheerLeft }), { fx: "cheer" });
      } else if (mv.kind === "help") {
        // てだすけ：次に動く仲間（このターンの動く順で）の技を強くする
        const next = turnOrder.slice(k + 1).map((x) => b.members[x]).find((x) => x.commands.length || x.tactics.length);
        if (next) boost = Math.max(2, power);
        if (!quiet) add(next ? T("battleHelp", { target: whoName(next.who), n: boost }) : T("battleHelpNone"), next ? { target: next.who, fx: "help" } : {});
      } else if (mv.kind === "boost") {
        // このターンだけ、target（主人公）の攻撃を power 倍にする（強いモードのパパ。first と組み合わせると、かならず間に合う）
        const target = b.members.some((x) => x.who === mv.target) ? mv.target : null;
        if (target) powerUp[target] = (powerUp[target] || 1) * Math.max(1, power);
        if (!quiet && !toArray(mv.say).length) add(target ? T("battlePower", { target: whoName(target), n: Math.max(1, power) }) : T("battleHelpNone"));
      } else if (mv.kind === "guard") {
        if (mv.all) guardAll = mv;
        else guardBig = mv;
        if (!quiet && !toArray(mv.say).length) add(T("battleGuard"));
      } else if (mv.kind === "charge") {
        const n = Math.max(2, power || 2);
        st.charged[m.who] = n;
        if (!quiet) add(T("battleCharge", { who: whoName(m.who), n }), { fx: "charge" });
      }
      if (!quiet) act(parts);
    }

    // 相手の番：actions のとおりに動く（damage：ハートを減らす / big：防げる大技 / heal：自分のハートをもどす）
    if (!st.won) {
      const a = battleAction(b, st.turn);
      if (a) {
        const v = quiet ? null : vars({});
        const parts = [];
        const add = (text, extra) => { if (!quiet && text) parts.push(Object.assign({ text, st: snap() }, extra)); };
        if (!quiet && a.text) add(btText(a.text, v), { sound: a.sound || "" });
        const dmg = Math.max(0, Math.floor(Number(a.damage) || 0));
        if (dmg > 0 && (guardAll || (guardBig && a.big))) {
          // 防いだときの文：大技を「かまくら」などで防いだら、相手の行動の blocked。すべて防ぐ技なら、その技の blocked
          const byBig = Boolean(guardBig && a.big);
          const text = byBig && a.blocked ? btText(a.blocked, v)
            : !byBig && guardAll.blocked ? btText(guardAll.blocked, v)
              : T("battleBlocked");
          if (!quiet) add(text, { fx: "guard" });
        } else if (dmg > 0) {
          // 防ぐ技を使ったのに、大技ではないので防げなかったときは、その理由（技の miss）を出す
          if (!quiet && guardBig) for (const ln of btLines(guardBig.miss, v)) add(ln);
          st.hearts = Math.max(0, st.hearts - dmg);
          if (!quiet) add(T("battleDamage", { n: dmg }), { fx: "damage" });
          if (st.hearts <= 0) st.lost = true;
        }
        const heal = Math.max(0, Math.floor(Number(a.heal) || 0));
        if (!st.lost && heal > 0 && st.foe < b.foeHearts) {
          const n = Math.min(b.foeHearts - st.foe, heal);
          st.foe += n;
          if (!quiet) add(T("battleFoeHeal", vars({ n })), { fx: "regen" });
        }
        if (!st.lost && !quiet) for (const ln of btLines(a.after, v)) add(ln);
        if (!quiet) act(parts);
      }
      if (st.lost) {
        if (!quiet) act([{ text: T("battleLose"), st: snap(), fx: "lose" }]);
      } else if (st.cheerLeft > 0) {
        st.cheerLeft -= 1;
        if (!st.cheerLeft) {
          st.cheer = 0;
          if (!quiet) act([{ text: T("battleCheerEnd"), st: snap() }]);
        }
      }
      st.turn += 1;
    }
    return { state: st, steps };
  }

  // turn ターン目の始めに出すヒント（最後のヒントは、そのあとも2ターンごとにくり返す）
  function battleHintAt(b, turn) {
    const list = toArray(b.def.hints).filter((h) => h && Number(h.turn) > 0).sort((x, y) => x.turn - y.turn);
    if (!list.length) return [];
    const last = list[list.length - 1];
    const h = list.find((x) => Number(x.turn) === turn)
      || (turn > last.turn && (turn - last.turn) % 2 === 0 ? last : null);
    return h ? btLines(h.say, {}) : [];
  }

  // 1ターン分の選び方を全部ならべる（コマンドのある仲間の、技の組み合わせ）
  function battleJoint(b) {
    let out = [[]];
    for (const m of b.members) {
      const opts = m.commands.length ? m.commands : [null];
      const next = [];
      for (const p of out) for (const c of opts) next.push([...p, c]);
      out = next;
    }
    return out;
  }

  // 点検する仲間の組み合わせ
  //   仲間をえらぶ戦い：全員が仲間になったものとして、えらび方を全部 / そうでない戦い：仲間の条件（if）がいる・いない
  function battleTeams(id) {
    const def = BT[id];
    const b = battleOf(id, () => true);
    if (!b) return [];
    if (battleNeedsPick(b)) {
      const out = [];
      const rec = (s, cur) => {
        if (cur.length === b.choose) { out.push({ on: () => true, pick: cur.slice(), label: cur.map(whoName).join("・") }); return; }
        for (let i = s; i < b.candidates.length; i++) { cur.push(b.candidates[i]); rec(i + 1, cur); cur.pop(); }
      };
      rec(0, []);
      return out;
    }
    const conds = battleConds(def);
    if (!conds.length) return [{ on: () => true, pick: null, label: "" }];
    return [false, true].map((flag) => ({ on: () => flag, pick: null, label: `${condLabel(conds)}が${flag ? "いる" : "いない"}` }));
  }

  // 戦いの点検：コマンドの選び方を全部ためして、何ターンで勝てるか・負けるかを調べる
  //   team：battleTeams の1つ
  //   返り値：{ win：最短で勝てるターン数（勝てなければ 0）, path：そのときの選び方（ターンごと）,
  //            lose：最短で負けるターン数（負けることがなければ 0）,
  //            spam：全員が「いちばん強い攻撃」だけを選んだときの結果（{ win: true, turn: 3 } など）,
  //            guard：大技（big）が来るターンだけ防ぐ技を選び、ほかは「いちばん強い攻撃」を選んだときの結果
  //                   （防ぐ技を持つ仲間がいないときは null） }
  //   rand：技の fail（強いモードのパパの「スマホに夢中」）に使う数。書かなければ、いつも起こらないものとして調べる
  //         （() => 0 なら、いつも起こるものとして調べる）
  function battleCheck(id, team, limit = 12, rand) {
    const out = { win: 0, path: [], lose: 0, spam: null, guard: null };
    const b = battleOf(id, team.on, team.pick);
    if (!b) return out;
    const joint = battleJoint(b);
    const key = (s) => [s.hearts, s.foe, s.cheer, s.cheerLeft, Object.keys(s.charged).sort().map((k) => k + s.charged[k]).join(";"),
      b.actions.length ? (s.turn - 1) % b.actions.length : 0].join(",");
    let layer = [{ st: battleStart(b), path: [] }];
    const seen = new Set([key(layer[0].st)]);
    for (let n = 1; n <= limit && layer.length && !(out.win && out.lose); n++) {
      const next = [];
      for (const node of layer) {
        for (const picks of joint) {
          const r = battleTurn(b, node.st, picks, true, rand);
          if (r.state.won) {
            if (!out.win) { out.win = n; out.path = [...node.path, picks]; }
            continue;
          }
          if (r.state.lost) {
            if (!out.lose) out.lose = n;
            continue;
          }
          const k = key(r.state);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push({ st: r.state, path: [...node.path, picks] });
        }
      }
      layer = next;
    }
    // 考えずに、全員がいちばん強い攻撃だけを選んだとき
    const strong = b.members.map((m) => (m.commands.length ? m.commands.slice().sort((x, y) => attackValue(b, y) - attackValue(b, x))[0] : null));
    let s = battleStart(b);
    for (let n = 1; n <= limit; n++) {
      s = battleTurn(b, s, strong, true, rand).state;
      if (s.won || s.lost) { out.spam = { win: s.won, turn: n }; break; }
    }
    // 大技の予告があるターンだけ防ぐ（1-3 なら、ふぶきの前だけ かまくら）。ほかは いちばん強い攻撃
    const guards = b.members.map((m) => m.commands.find((c) => MV[c].kind === "guard") || null);
    if (guards.some(Boolean)) {
      s = battleStart(b);
      for (let n = 1; n <= limit; n++) {
        const a = battleAction(b, s.turn);
        s = battleTurn(b, s, strong.map((c, k) => (a && a.big && guards[k] ? guards[k] : c)), true, rand).state;
        if (s.won || s.lost) { out.guard = { win: s.won, turn: n }; break; }
      }
    }
    return { ...out, members: b.members.map((m) => m.who) };
  }

  // でたらめにコマンドを選んだとき、limit ターン以内に勝てる割合（%）。テスト用メニューの点検だけで使う
  //   毎回同じ結果になるように、決まった順番の数（疑似乱数）で選ぶ（ゲームの中では、技の fail のほかは乱数を使わない）
  //   技の fail（スマホに夢中）も、同じ数で起こす
  function battleRandom(id, team, trials = 400, limit = 15) {
    const b = battleOf(id, team.on, team.pick);
    if (!b) return 0;
    let seed = 20261224;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    let wins = 0;
    for (let t = 0; t < trials; t++) {
      let s = battleStart(b);
      for (let n = 1; n <= limit; n++) {
        const picks = b.members.map((m) => (m.commands.length ? m.commands[Math.floor(rnd() * m.commands.length)] : null));
        s = battleTurn(b, s, picks, true, rnd).state;
        if (s.won) { wins += 1; break; }
        if (s.lost) break;
      }
    }
    return Math.round((wins / trials) * 100);
  }

  // 戦いの画面を描く（相手と相手のハート・みんなのハート・仲間・コマンドの場所）
  //   show(step)：step.st（ハートなど）を画面に映し、step.fx の動きをつける
  //   step.choosing：コマンドを選んでいる仲間 / step.picks：選んだコマンド（仲間の下に小さく出す）
  function renderBattle(container, b) {
    const e = b.enemy;
    const face = (id) => withArt(el("div", { class: "bt-face", text: (CHARS[id] && CHARS[id].emoji) || "？" }), id);
    const color = (id) => (CHARS[id] && CHARS[id].color) || "#ccc";
    const turnNode = el("span", { class: "bt-turn" });
    const alertNode = el("span", { class: "bt-storm" });
    const info = el("div", { class: "bt-info" }, el("span", { class: "bt-title", text: fill(b.def.title || "") }), turnNode, alertNode);
    const foes = b.foes.map((id) => el("div", { class: "bt-foe", style: `--c:${color(id)}` },
      face(id), el("div", { class: "bt-name", text: whoName(id) })));
    const pips = Array.from({ length: b.foeHearts }, () => el("span", { class: "bt-pip", text: e.icon || "♥" }));
    const gauge = el("div", { class: "bt-gauge" + (pips.length > 10 ? " many" : "") }, el("span", { class: "bt-gauge-name", text: fill(e.label || T("battleFoeHearts")) }), pips);
    const foeBox = el("div", { class: "bt-foes" }, el("div", { class: "bt-foe-wrap" }, el("div", { class: "bt-foe-row" }, foes), gauge));
    const hearts = Array.from({ length: b.hearts }, () => el("span", { class: "bt-heart", text: "♥" }));
    const buff = el("span", { class: "bt-buff", hidden: true });
    const status = el("div", { class: "bt-status" },
      el("span", { class: "bt-hearts" }, el("span", { class: "bt-hearts-name", text: T("battleHearts") }), hearts), buff);
    const members = b.members.map((m) => el("div", {
      class: "bt-member" + (m.leader ? " leader" : ""), "data-id": m.who, style: `--c:${color(m.who)}`,
    }, face(m.who), el("div", { class: "bt-name", text: whoName(m.who) }), el("div", { class: "bt-plan" })));
    const row = el("div", { class: "bt-members" + (members.length > 5 ? " many" : "") }, members);
    const team = el("div", { class: "bt-team" }, status, row);
    const menu = el("div", { class: "bt-menu", onclick: (ev) => ev.stopPropagation() });
    const root = el("div", { class: "battle" }, info, foeBox, team, menu);
    container.replaceChildren(root);

    // 動きをつける（同じ動きが続いても、もう一度動く）。動き終わったら外して、ふだんの動きにもどす
    const timers = new Map();
    const flash = (node, cls) => {
      node.classList.remove(cls);
      void node.offsetWidth;
      node.classList.add(cls);
      clearTimeout(timers.get(node));
      timers.set(node, setTimeout(() => node.classList.remove(cls), 900));
    };
    const show = (step) => {
      const s = step.st || {};
      turnNode.textContent = T("battleTurn", { n: s.turn });
      // このターンの終わりの相手の行動に、予告（alert）があれば出す
      const a = battleAction(b, s.turn);
      alertNode.textContent = a && a.alert ? fill(a.alert) : "";
      pips.forEach((p, i) => p.classList.toggle("off", i >= s.foe));
      hearts.forEach((h, i) => h.classList.toggle("off", i >= s.hearts));
      buff.hidden = !(s.cheerLeft > 0);
      if (s.cheerLeft > 0) buff.textContent = T("battleCheerOn", { n: s.cheerLeft });
      members.forEach((n, k) => {
        const id = n.dataset.id;
        const charged = Boolean(s.charged && s.charged[id]);
        const mv = step.picks && step.picks[k] ? MV[step.picks[k]] : null;
        n.classList.toggle("acting", Boolean(step.actor) && id === step.actor);
        n.classList.toggle("helped", Boolean(step.target) && id === step.target);
        n.classList.toggle("choosing", Boolean(step.choosing) && id === step.choosing);
        n.classList.toggle("charged", charged);
        n.querySelector(".bt-plan").textContent = mv ? fill(mv.name || "") : charged ? T("battleChargeOn") : "";
      });
      const fx = step.fx || "";
      if (["hit", "break", "regen", "guard"].includes(fx)) flash(foeBox, "fx-" + fx);
      if (["damage", "heal", "cheer", "charge"].includes(fx)) flash(team, "fx-" + fx);
      if (fx === "damage") flash(root, "fx-shake");   // 攻撃を受けたら、画面をゆらす
      if (fx === "break") foeBox.classList.add("broken");
      if (fx === "lose") team.classList.add("lost");
      if (fx === "ribbon") ribbon.draw(step.actor);
    };
    // 決め技（MOVES の ribbon: true）：リボンが相手をつかまえてから、仲間を1人ずつ線でつなぐ
    const ribbon = battleRibbon(root, foes, members);
    show({ st: battleStart(b) });
    return { root, menu, show };
  }

  // 決め技のリボン：リボンを出した仲間（from）から、相手へ1本、仲間の列へ1本ずつ、線をのばす
  //   線は仲間の顔のうしろを通る（手をつないだように見せる）。画面の大きさが変わったら、描き直す
  function battleRibbon(root, foes, members) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "bt-ribbon");
    svg.setAttribute("aria-hidden", "true");
    root.prepend(svg);
    let from = null;
    let watch = null;
    // node のまんなかの位置（root の中で。持ち上がる動きの途中でもずれないように、動かす前の位置で数える）
    const centerOf = (node) => {
      let x = node.offsetWidth / 2;
      let y = node.offsetHeight / 2;
      let n = node;
      while (n && n !== root) {
        x += n.offsetLeft;
        y += n.offsetTop;
        n = n.offsetParent;
      }
      return n === root ? [x, y] : null;
    };
    // 点を順につなぐ線（仲間の間は、少したるませる）
    const chain = (pts, sag) => pts.reduce((d, p, i) => {
      if (!i) return `M${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      const q = pts[i - 1];
      return `${d} Q${((q[0] + p[0]) / 2).toFixed(1)} ${((q[1] + p[1]) / 2 + sag).toFixed(1)} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    }, "");
    const paint = (animate) => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (!from || !w || !h) return;
      const faces = members.map((n) => n.querySelector(".bt-face"));
      let k = members.findIndex((n) => n.dataset.id === from);
      if (k < 0) k = members.length - 1;
      const start = centerOf(faces[k]);
      if (!start) return;
      const size = faces[k].offsetWidth || 40;
      const paths = [];
      // 相手をつかまえる線：上へのびてから、相手のほうへ曲がる（少し外側へふくらませる）
      const foeFace = foes.length ? foes[0].querySelector(".bt-face") : null;
      const target = foeFace ? centerOf(foeFace) : null;
      const bulge = (start[0] >= (target ? target[0] : 0) ? 1 : -1) * size * 0.8;
      if (target) paths.push({ d: `M${start[0].toFixed(1)} ${start[1].toFixed(1)} Q${(start[0] + bulge).toFixed(1)} ${target[1].toFixed(1)} ${target[0].toFixed(1)} ${target[1].toFixed(1)}`, delay: 0, dur: 0.55 });
      // 仲間をつなぐ線：リボンを出した仲間から、左右へ1人ずつ（顔の下のほう＝手の高さを通り、間でたるませる）
      const hand = (p) => (p ? [p[0], p[1] + size * 0.3] : null);
      const left = [start, ...faces.slice(0, k).reverse().map(centerOf)].map(hand).filter(Boolean);
      const right = [start, ...faces.slice(k + 1).map(centerOf)].map(hand).filter(Boolean);
      for (const pts of [left, right]) if (pts.length > 1) paths.push({ d: chain(pts, size * 0.5), delay: 0.45, dur: 0.25 * (pts.length - 1) + 0.3 });
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.replaceChildren();
      for (const p of paths) {
        for (const cls of ["rb-band", "rb-shine"]) {
          const path = document.createElementNS(NS, "path");
          path.setAttribute("d", p.d);
          path.setAttribute("class", cls);
          svg.append(path);
          if (!animate) continue;
          const len = path.getTotalLength ? path.getTotalLength() : 0;
          if (!len) continue;
          path.style.setProperty("--len", len.toFixed(1));
          path.style.setProperty("--delay", `${p.delay}s`);
          path.style.setProperty("--dur", `${p.dur}s`);
          path.classList.add("draw");
        }
      }
    };
    return {
      draw(id) {
        from = id || from || "sylveon";
        // 動き（持ち上がる動き）が落ちついてから描く
        setTimeout(() => {
          if (!root.isConnected) return;
          paint(true);
          if (!watch && typeof ResizeObserver === "function") {
            let first = true;   // 見はり始めたときの1回目は、描いたばかりなので何もしない
            watch = new ResizeObserver(() => {
              if (first) { first = false; return; }
              if (!root.isConnected) { watch.disconnect(); return; }
              paint(false);
            });
            watch.observe(root);
          }
        }, 120);
      },
    };
  }

  // ==============================================================
  // 家全体の地図（2-7・4-3・4-5。house.js の部屋を、at の位置に並べて描く）
  //   見えていない部屋は、白い霧の中。見える部屋が増えると、地図が広がる（見える範囲に合わせて小さくなる）
  //   夢の部屋（息子さんの部屋）は、room.js の家具を使う（room.js の2マスを、1マスにまとめる）
  //   data.js の場面に house: { … } と書くと、この地図を出す。lines の { house: { … } } で地図を変える
  //     show：見せる部屋（"all" で全部）/ home：本当の家具の見た目にする部屋 / marks：会った仲間の印
  //     fog：家の外の霧 / star：プレゼントの星 / light：夢の部屋に光が集まる / tokens・appear：夢の部屋に仲間が現れる
  //     （appear が true なら話した仲間が増えていく。"one" なら話す1匹だけを出す。tokens で出した仲間は消えない）
  // ==============================================================
  const HOUSE_PAD = 1;   // 家のまわりに描く霧の幅（マス）

  // room.js の家具を、家全体の地図の大きさにする（k：room.js の何マスが、ここの1マスか）
  function roomItemsScaled(k) {
    return toArray(RM && RM.items).map((it) => ({
      x: it.x / k, y: it.y / k, w: it.w / k, h: it.h / k,
      name: it.wall ? "" : it.name, icon: it.icon, color: it.color, outside: Boolean(it.wall), shine: Boolean(it.shine),
    }));
  }

  // 家全体の地図に描く部屋（house.js の maps のうち、at があるもの）
  function houseRooms() {
    const out = [];
    for (const [id, m] of Object.entries((HS && HS.maps) || {})) {
      if (!m || !Array.isArray(m.at) || !(m.w > 0) || !(m.h > 0)) continue;
      const looks = {};
      for (const look of ["nature", "home"]) {
        if (!m[look]) continue;
        const lm = lookMap(id, look);
        if (m.room && RM) lm.items = roomItemsScaled((RM.cols || m.w) / m.w);   // 夢の部屋の家具は room.js
        looks[look] = lm;
      }
      if (!looks.nature && !looks.home) continue;
      out.push({ id, x: Number(m.at[0]) || 0, y: Number(m.at[1]) || 0, w: m.w, h: m.h, looks, room: Boolean(m.room) });
    }
    return out;
  }

  // プレゼントの星を出す場所（このPCで決めた場所。決めていなければ、リビングのまんなか【仮】）
  function presentSpot(rooms) {
    const p = presentAt();
    if (p) return { x: p.x + 0.5, y: p.y + 0.5, temp: false };
    const r = rooms.find((x) => x.id === "living") || rooms[0];
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2, temp: true } : null;
  }

  // 家全体の地図を描く
  //   spec：はじめの状態（show・home・marks など）/ opts.static：動かさず、家全体を見せる（メニューの地図・テスト用）
  //   opts.star：星の場所 { x, y }（書かなければ presentSpot）/ opts.fadeIn：ふわっと出す
  //   返り値：apply(fx, animate)（地図を変える）・fit(animate)（大きさを合わせる）・appear(who)・cellAt(x, y)・stop()
  function renderHouse(container, spec, opts = {}) {
    const rooms = houseRooms();
    const stub = { root: null, apply() {}, fit() {}, appear() {}, cellAt: () => null, stop() {} };
    if (!rooms.length) {
      container.replaceChildren(el("div", { class: "room-missing", text: "house.js の地図を読み込めませんでした。" }));
      return stub;
    }
    const P = HOUSE_PAD;
    const bx0 = Math.min(...rooms.map((r) => r.x)) - P;
    const by0 = Math.min(...rooms.map((r) => r.y)) - P;
    const bx1 = Math.max(...rooms.map((r) => r.x + r.w)) + P;
    const by1 = Math.max(...rooms.map((r) => r.y + r.h)) + P;
    const BW = bx1 - bx0;
    const BH = by1 - by0;
    const at = (x, y) => `left:${((x - bx0) / BW) * 100}%;top:${((y - by0) / BH) * 100}%`;
    const box = (x, y, w, h) => `${at(x, y)};width:${(w / BW) * 100}%;height:${(h / BH) * 100}%`;
    const board = el("div", { class: "hm-board" });
    const view = el("div", { class: "hm-view" + (opts.static ? " static" : "") + (opts.fadeIn ? " fade-in" : ""), role: "img", "aria-label": T("houseMapTitle") },
      el("div", { class: "hm-mist", "aria-hidden": "true" }), board);
    container.replaceChildren(view);

    // 部屋（見た目は2組。夢の見た目 nature と、本当の家具 home を重ねておき、切りかえる）
    const roomNode = {};
    for (const r of rooms) {
      roomNode[r.id] = el("div", { class: "hm-room hidden", "data-id": r.id, style: box(r.x, r.y, r.w, r.h) },
        ["nature", "home"].filter((k) => r.looks[k]).map((k) => houseLook(r, k)));
      board.append(roomNode[r.id]);
    }
    // 会った仲間の印（house.js の marks）
    const marks = Object.entries((HS && HS.marks) || {}).map(([id, mk]) => {
      const r = mk && rooms.find((x) => x.id === mk.map);
      if (!r || !CHARS[id]) return null;
      let cx = Number(mk.x) || 0;
      let cy = Number(mk.y) || 0;
      // shine: true は、room.js の光る場所（ブラッキーのぬいぐるみを置く場所）
      const it = mk.shine && r.room ? toArray(r.looks.home && r.looks.home.items).find((x) => x.shine) : null;
      if (it) { cx = it.x + it.w / 2; cy = it.y + it.h / 2; }
      const node = el("div", { class: "hm-mark", "data-id": id, "data-map": r.id, style: `${at(r.x + cx, r.y + cy)};--c:${CHARS[id].color || "#ccc"}` },
        withArt(el("span", { class: "hm-mark-face", text: CHARS[id].emoji || "？" }), id));
      board.append(node);
      return node;
    }).filter(Boolean);
    // 夢の部屋に集まる仲間（4-3）と、光
    const dream = rooms.find((r) => r.room) || rooms[0];
    const tokens = [];
    const tokenBox = el("div", { class: "hm-tokens" });
    const light = el("div", { class: "hm-light", style: at(dream.x + dream.w / 2, dream.y + dream.h / 2), "aria-hidden": "true" },
      Array.from({ length: 12 }, (_, i) => el("i", { style: `--a:${i * 30}deg;--d:${(i % 4) * 0.18}s` })));
    // プレゼントの星
    const spot = opts.star !== undefined ? opts.star : presentSpot(rooms);
    const star = el("div", { class: "hm-star" + (spot && spot.temp ? " temp" : ""), style: spot ? at(spot.x, spot.y) : "", "aria-hidden": "true" },
      el("span", { class: "hm-star-icon", text: "★" }),
      spot && spot.temp ? el("span", { class: "hm-star-temp", text: T("houseStarTemp") }) : null);
    board.append(light, tokenBox, star);   // 光は、仲間のうしろに

    const st = { shown: new Set(), home: new Set(), marks: false, fog: false, star: false, light: false, appear: false };
    const fixed = new Set();   // tokens で出した仲間（appear: "one" でも消さない）
    const ids = (v) => (v === "all" ? rooms.map((r) => r.id) : toArray(v)).filter((id) => roomNode[id]);
    const update = () => {
      for (const r of rooms) {
        roomNode[r.id].classList.toggle("hidden", !st.shown.has(r.id));
        // 夢の見た目がない部屋（トイレなど）と夢の部屋は、いつも本当の見た目
        roomNode[r.id].classList.toggle("home", st.home.has(r.id) || !r.looks.nature);
      }
      let k = 0;
      for (const n of marks) {
        const on = st.marks && st.shown.has(n.dataset.map) && (opts.static || state.met.includes(n.dataset.id));
        n.classList.toggle("on", on);
        if (on) n.style.setProperty("--i", k++);
      }
      star.classList.toggle("on", Boolean(st.star && spot));
      light.classList.toggle("on", st.light);
      view.classList.toggle("fog", st.fog);
    };
    // 夢の部屋に、仲間を1人ずつ置く（イーブイはまんなか、ほかは輪になって並ぶ）
    //   場所は、はじめて現れた順に決める（一度消えて、また現れても同じ場所）
    const placeToken = (node, i) => {
      const cx = dream.x + dream.w / 2;
      const cy = dream.y + dream.h / 2;
      const angle = ((i - 0.5) / 8) * Math.PI * 2 - Math.PI / 2;   // 真上をさけて、部屋の名前にかからないようにする
      const x = i === 0 ? cx : cx + Math.cos(angle) * dream.w * 0.36;
      const y = i === 0 ? cy : cy + Math.sin(angle) * dream.h * 0.33;
      node.setAttribute("style", `${at(x, y)};--c:${(CHARS[node.dataset.id] && CHARS[node.dataset.id].color) || "#ccc"}`);
    };
    // 消えた仲間を、もう一度出す（pop をつけ直して、また現れる動きにする）
    const showToken = (node, animate) => {
      node.classList.remove("gone", "pop");
      if (animate) {
        void node.offsetWidth;
        node.classList.add("pop");
      }
    };
    const hideToken = (node) => {
      node.classList.remove("pop");
      node.classList.add("gone");
    };
    const addToken = (id, animate) => {
      if (!CHARS[id]) return;
      const old = tokens.find((n) => n.dataset.id === id);
      if (old) {
        if (old.classList.contains("gone")) showToken(old, animate);
        return;
      }
      const node = el("div", { class: "hm-token" + (animate ? " pop" : ""), "data-id": id },
        withArt(el("span", { class: "hm-mark-face", text: CHARS[id].emoji || "？" }), id));
      // イーブイは、いつもまんなか（0番）
      const i = id === "eevee" ? 0 : tokens.filter((n) => n.dataset.id !== "eevee").length + 1;
      placeToken(node, i);
      tokens.push(node);
      tokenBox.append(node);
    };

    // 見えている部屋に合わせて、地図の大きさと位置を決める（animate：なめらかに動かす）
    const fit = (animate) => {
      const vw = view.clientWidth;
      const vh = view.clientHeight;
      if (!vw || !vh) return;
      const cell = Math.min(vw / BW, vh / BH);
      board.style.width = `${BW * cell}px`;
      board.style.height = `${BH * cell}px`;
      board.style.setProperty("--cell", `${cell}px`);
      const shown = rooms.filter((r) => st.shown.has(r.id));
      let x0 = bx0;
      let y0 = by0;
      let x1 = bx1;
      let y1 = by1;
      if (!opts.static && shown.length && !st.fog) {
        x0 = Math.min(...shown.map((r) => r.x)) - 0.5;
        y0 = Math.min(...shown.map((r) => r.y)) - 0.5;
        x1 = Math.max(...shown.map((r) => r.x + r.w)) + 0.5;
        y1 = Math.max(...shown.map((r) => r.y + r.h)) + 0.5;
      }
      const s = Math.min(vw / ((x1 - x0) * cell), vh / ((y1 - y0) * cell), 3);
      const tx = (vw - (x1 - x0) * cell * s) / 2 - (x0 - bx0) * cell * s;
      const ty = (vh - (y1 - y0) * cell * s) / 2 - (y0 - by0) * cell * s;
      const transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
      if (animate) {
        board.style.transform = transform;
      } else {
        board.classList.add("no-anim");
        board.style.transform = transform;
        void board.offsetWidth;
        board.classList.remove("no-anim");
      }
    };
    const apply = (fx, animate) => {
      const f = fx && typeof fx === "object" ? fx : {};
      if (!animate) board.classList.add("no-anim");
      for (const id of ids(f.show)) st.shown.add(id);
      for (const id of ids(f.home)) { st.home.add(id); st.shown.add(id); }
      for (const key of ["marks", "fog", "star", "light"]) if (f[key] != null) st[key] = Boolean(f[key]);
      if (f.appear != null) st.appear = f.appear === "one" ? "one" : Boolean(f.appear);
      for (const id of toArray(f.tokens)) {
        fixed.add(id);
        addToken(id, animate);
      }
      update();
      fit(animate);
      if (!animate) {
        void board.offsetWidth;
        board.classList.remove("no-anim");
      }
    };
    // 話した仲間が、夢の部屋に現れる（appear のとき）
    //   appear: "one" のときは、次の1匹が現れるときに、前の1匹を消す（tokens で出した仲間は消さない）
    const appear = (who) => {
      if (!st.appear || who === "hero" || !CHARS[who] || CHARS[who].voice) return;
      if (st.appear === "one" && !fixed.has(who)) {
        for (const n of tokens) if (n.dataset.id !== who && !fixed.has(n.dataset.id)) hideToken(n);
      }
      addToken(who, true);
    };
    // 画面の (clientX, clientY) にある、家全体の地図のマス（テスト用メニューで、プレゼントの場所を決めるため）
    const cellAt = (cx, cy) => {
      const rect = board.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const x = Math.floor(((cx - rect.left) / rect.width) * BW + bx0);
      const y = Math.floor(((cy - rect.top) / rect.height) * BH + by0);
      return rooms.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) ? { x, y } : null;
    };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => fit(false)) : null;
    if (ro) ro.observe(view);
    apply(spec, false);
    return { root: view, apply, fit, appear, cellAt, stop: () => { if (ro) ro.disconnect(); } };
  }

  // 部屋の見た目1組（床・かべの色、家具、出入口と窓、部屋の名前）
  function houseLook(r, look) {
    const lm = r.looks[look];
    const pos = (x, y, w, h) => `left:${(x / r.w) * 100}%;top:${(y / r.h) * 100}%;width:${(w / r.w) * 100}%;height:${(h / r.h) * 100}%`;
    const node = el("div", { class: `hm-look ${look} hf-${lm.floor || "none"} hw-${lm.wall || "none"}` });
    for (const it of lm.items) {
      if (it.shine) continue;   // 光る場所（夢の中の目印）は、家の地図には描かない
      if (it.outside) {
        node.append(el("div", { class: "hm-outside", style: pos(it.x, it.y, it.w, it.h) }));
        continue;
      }
      const small = it.w * it.h < 1.5;
      node.append(el("div", {
        class: "hm-item" + (it.look ? " look-" + it.look : "") + (small ? " small" : "") + (it.h > it.w * 1.5 ? " tall" : ""),
        style: `${pos(it.x, it.y, it.w, it.h)};--c:${it.color || "#ddd"}`,
      },
        it.icon ? el("span", { class: "hm-icon", text: it.icon, "aria-hidden": "true" }) : null,
        it.name && !small ? el("span", { class: "hm-label", text: fill(it.name) }) : null));
    }
    for (const e of lm.edges) {
      if (!e.kind) continue;
      for (const c of e.cells) {
        const along = e.side === "top" || e.side === "bottom"
          ? `left:${(c / r.w) * 100}%;width:${(1 / r.w) * 100}%`
          : `top:${(c / r.h) * 100}%;height:${(1 / r.h) * 100}%`;
        node.append(el("div", { class: `hm-edge ${e.side} k-${e.kind}`, style: along }));
      }
    }
    if (lm.name) node.append(el("div", { class: "hm-name", text: fill(lm.name) }));
    return node;
  }

  // 物語画面に、家全体の地図を出す（もう出ていれば、spec のとおりに変える）
  function showHouse(spec, animate) {
    if (!HS) return;
    if (NV.house) {
      NV.house.apply(spec, animate);
      return;
    }
    novel.chars.replaceChildren();
    NV.shown = [];
    novel.houseBox.hidden = false;
    novel.stage.classList.add("house-mode");   // 選択肢を横に並べて、地図を大きく見せる
    NV.house = renderHouse(novel.houseBox, spec, { fadeIn: animate });
  }

  // ==============================================================
  // 6. メッセージ画面（iPhone向け：チャット形式）
  // ==============================================================
  function buildChat() {
    const title = el("div", { class: "chat-title" });
    const partyBtn = el("button", { class: "icon-btn dark", type: "button", "aria-label": "なかまノート", onclick: openParty });
    const menuBtn = el("button", { class: "icon-btn dark", type: "button", text: "≡", "aria-label": "メニュー", onclick: openMenu });
    const head = el("header", { class: "chat-head" }, title, partyBtn, menuBtn);
    const log = el("div", { class: "chat-log", role: "log", "aria-live": "polite" });
    const foot = el("div", { class: "chat-foot" });
    // 暗い窓（data.js の knock。2-7 のiPhone側）：画面を暗い窓だけにして、タップを待つ
    const knockText = el("p", { class: "knock-text" });
    const knock = el("div", { class: "chat-knock", role: "button", tabindex: "0", hidden: true },
      el("div", { class: "knock-window", "aria-hidden": "true" }, el("span", { class: "knock-moon", text: "🌙" })),
      knockText);
    const draft = el("div", { class: "draft-badge", text: T("draft"), hidden: true });
    const root = el("section", { class: "screen chat" }, head, log, foot, knock, draft);
    return { root, title, partyBtn, log, foot, knock, knockText, draft };
  }

  // skip：画面をタップ（Enter・スペース）したときにすること（「入力中…」の文をすぐ出す・次の文へ進む）
  // wait：文を出したあと、まだ読んでいるところ（次の文は、タップしてから出す。設計書 第11節）
  // last：最後に出したメッセージ（タップを待つ間、この文の終わりに ▼ を出す）
  // next：「つづける ▶」を出しているあいだだけ、それを押す関数（Enter・スペースで押す）
  const CV = { lastWho: undefined, chapter: "", skip: null, wait: false, last: null, next: null };

  function scrollChat() {
    requestAnimationFrame(() => { chat.log.scrollTop = chat.log.scrollHeight; });
  }

  function addMsg(ln) {
    let node;
    if (ln.kind === "chapter") {
      node = el("div", { class: "msg chapter" }, el("span", { text: ln.text }));
      CV.lastWho = undefined;
    } else if (!ln.who) {
      node = el("div", { class: "msg system" }, el("div", { class: "bubble", text: ln.text }));
      CV.lastWho = undefined;
    } else if (ln.who === "hero") {
      node = el("div", { class: "msg me" }, el("div", { class: "bubble", text: ln.text }));
      CV.lastWho = "hero";
    } else {
      const c = CHARS[ln.who] || {};
      const cont = CV.lastWho === ln.who;
      node = el("div", { class: "msg them" + (cont ? " cont" : ""), style: `--c:${c.color || "#999"}` },
        el("div", { class: "avatar", text: c.emoji || "？", "aria-hidden": "true" }),
        el("div", { class: "msg-body" },
          cont ? null : el("div", { class: "who", text: charName(c) }),
          el("div", { class: "bubble", text: ln.text })));
      CV.lastWho = ln.who;
    }
    chat.log.append(node);
    if (ln.kind !== "chapter") CV.last = node;
    scrollChat();
    return node;
  }

  // タップを待ってから next を呼ぶ（iPhone の文は、自動では次へ進めない）
  //   待っている間は、最後のメッセージの終わりに小さな ▼ を出す
  function chatWaitTap(next) {
    const token = gen;
    for (const m of chat.log.querySelectorAll(".chat-more")) m.remove();
    const host = CV.last && CV.last.isConnected ? CV.last.querySelector(".bubble, .word-card") : null;
    const mark = host ? el("span", { class: "chat-more", text: "▼", "aria-hidden": "true" }) : null;
    if (mark) host.append(mark);
    scrollChat();
    CV.skip = () => {
      CV.skip = null;
      if (mark) mark.remove();
      if (token !== gen) return;
      CV.wait = false;
      next();
    };
  }

  function addTyping(who) {
    const c = CHARS[who] || {};
    const node = el("div", { class: "msg them typing", style: `--c:${c.color || "#999"}`, "aria-hidden": "true" },
      el("div", { class: "avatar", text: c.emoji || "？" }),
      el("div", { class: "msg-body" }, el("div", { class: "bubble" }, el("i"), el("i"), el("i"))));
    chat.log.append(node);
    scrollChat();
    return node;
  }

  const ChatView = {
    enter(sc) {
      const continuing = currentView === "chat";
      show("chat");
      if (!continuing) {
        chat.log.replaceChildren();
        CV.lastWho = undefined;
        CV.chapter = "";
        CV.wait = false;
        CV.last = null;
      }
      for (const m of chat.log.querySelectorAll(".chat-more")) m.remove();
      chat.title.textContent = fill(sc.chatTitle || S.chatTitle || T("chatTitle"));
      chat.draft.hidden = !sc.draft;
      chat.foot.replaceChildren();
      chat.knock.hidden = true;
      chat.root.classList.remove("knocking");
      if (state.chapter && state.chapter !== CV.chapter) {
        CV.chapter = state.chapter;
        addMsg({ who: null, text: state.chapter, kind: "chapter" });
      }
    },

    // メッセージを1つずつ表示する（演出の行は、メッセージ画面では使わない）
    //   前の文のあとは、タップしてから次の文を出す（自動では進めない。設計書 第11節「iPhoneの文の送り方」）
    //   次の文は「入力中…」を出してから表示する。その途中でタップすると、すぐに文を出す
    //   最後の文のあとは、すぐに then（選択肢・入力欄・「つづける」のボタンなど。そこで止まる）
    say(lines, then) {
      const items = toArray(lines).filter((ln) => visible(ln) && !isEffect(ln)).map(toLine);
      const token = gen;
      chat.foot.replaceChildren();
      let i = 0;
      const step = () => {
        if (token !== gen) return;
        if (i >= items.length) {
          CV.skip = null;
          if (then) then();
          return;
        }
        if (CV.wait) chatWaitTap(type);
        else type();
      };
      const type = () => {
        if (token !== gen) return;
        const ln = items[i];
        i += 1;
        const speaking = Boolean(ln.who) && ln.who !== "hero";
        const typing = speaking ? addTyping(ln.who) : null;
        const len = Array.from(ln.text).length;
        const wait = !S.textSpeed ? 0 : speaking ? Math.min(900, 300 + len * 12) : 250;
        let timer = null;
        let done = false;
        const finish = () => {
          if (done || token !== gen) return;
          done = true;
          clearTimeout(timer);
          CV.skip = null;
          if (typing) typing.remove();
          addMsg(ln);
          if (ln.sound) SND.play(ln.sound);
          CV.wait = true;
          step();
        };
        CV.skip = finish;
        timer = setTimeout(finish, wait);
      };
      step();
    },

    choices(list, onPick) {
      chat.foot.replaceChildren(el("div", { class: "quick" },
        list.map((c) => el("button", {
          type: "button", class: "quick-btn", text: fill(c.text),
          onclick: () => {
            chat.foot.replaceChildren();
            CV.wait = false;   // 選んだら、返事はすぐに出す
            addMsg({ who: "hero", text: fill(c.say || c.text) });
            onPick(c);
          },
        }))));
      scrollChat();
    },

    input(spec, onSubmit, onHint, onSkip, onBack) {
      const field = inputField(spec, "chat-text", "send");
      const form = el("form", {
        class: "chat-form",
        onsubmit: (e) => {
          e.preventDefault();
          const value = field.value.trim();
          if (!value) return;
          field.blur();
          chat.foot.replaceChildren();
          CV.wait = false;
          addMsg({ who: "hero", text: value });
          onSubmit(value);
        },
      }, field, el("button", { type: "submit", class: "send-btn", text: T("send") }));
      const skipText = onSkip ? fill(spec.skip.text || T("skip")) : "";
      // null を渡すと「null」という文字が出てしまうので、使う部品だけを並べる
      chat.foot.replaceChildren(...[
        spec.prompt ? el("div", { class: "foot-prompt", text: fill(spec.prompt) }) : null,
        form,
        onHint || onSkip || onBack ? el("div", { class: "foot-links" },
          onBack ? el("button", {
            type: "button", class: "hint-btn", text: spec.backText ? fill(spec.backText) : T("inputBack"),
            onclick: () => {
              chat.foot.replaceChildren();
              CV.wait = false;
              onBack();
            },
          }) : null,
          onHint ? el("button", {
            type: "button", class: "hint-btn", text: T("chatHint"),
            onclick: () => {
              chat.foot.replaceChildren();
              CV.wait = false;
              addMsg({ who: "hero", text: T("chatHintSay") });
              onHint();
            },
          }) : null,
          onSkip ? el("button", {
            type: "button", class: "hint-btn", text: "🏳 " + skipText,
            onclick: () => {
              chat.foot.replaceChildren();
              CV.wait = false;
              addMsg({ who: "hero", text: skipText });
              onSkip();
            },
          }) : null) : null,
      ].filter(Boolean));
      scrollChat();
      if (!TOUCH) field.focus({ preventScroll: true });
    },

    // 言葉を手に入れたときの、特別なメッセージ（前の文のあとは、タップしてから出す）
    reveal(id, then) {
      const c = CHARS[id] || {};
      const token = gen;
      const put = () => {
        if (token !== gen) return;
        CV.lastWho = undefined;
        const node = el("div", { class: "msg word-msg", style: `--c:${c.color || "#ccc"}` },
          el("div", { class: "word-card" },
            el("div", { class: "word-get", text: T("wordGetChat", { who: charName(c) }) }),
            wordNode(c.word, "big"),
            el("div", { class: "word-note", text: T("wordNote") })));
        chat.log.append(node);
        CV.last = node;
        CV.wait = true;   // このあとに文が続くときは、タップしてから出す
        scrollChat();
        then();
      };
      if (CV.wait) chatWaitTap(put);
      else put();
    },

    // 「つづける ▶」のボタン。Enter・スペースでも押せる（PC。下のキーの受け口の CV.next）
    //   ボタンを出しているあいだは、入力欄も選択肢も出ていないので、Enter がぶつからない。
    //   キーを押しっぱなしにしたときの連続入力では押さない（前の文を送った Enter で、うっかり進まないように）
    proceed(cb) {
      const token = gen;
      const go = () => {
        CV.next = null;
        if (token !== gen) return;
        chat.foot.replaceChildren();
        CV.wait = false;
        cb();
      };
      const btn = el("button", { type: "button", class: "next-btn", text: T("next"), onclick: go });
      chat.foot.replaceChildren(btn);
      CV.next = () => { if (btn.isConnected) go(); };
      CV.next.btn = btn;
      scrollChat();
    },

    // 暗い窓（data.js の knock）：画面は暗い窓と文だけにして、入力欄などは出さない。
    //   画面をタップ（Enter・スペース）すると、窓を閉じて then（次の場面へ）
    knock(sc, then) {
      const token = gen;
      const text = fill(sc.knock);
      chat.foot.replaceChildren();
      chat.knockText.textContent = text;
      chat.knock.setAttribute("aria-label", text);
      chat.knock.hidden = false;
      chat.root.classList.add("knocking");
      const go = () => {
        CV.skip = null;
        chat.knock.onclick = null;
        if (token !== gen) return;
        chat.knock.hidden = true;
        chat.root.classList.remove("knocking");
        CV.wait = false;
        CV.lastWho = undefined;   // 窓が開いたあとの最初の文には、名前と顔をもう一度出す
        then();
      };
      CV.skip = go;
      chat.knock.onclick = go;
      if (!TOUCH) chat.knock.focus({ preventScroll: true });
    },

    // 公園で気配を探す（data.js の search。3-1 と 3-2 のあいだ）
    //   「気配を探す」→ 位置を測る（geo.js の check）→ イーブイの文（と小さな案内）→ またボタン
    //   必要な数に達したら、そのヒントのあとに「つづける ▶」を出し、done（次の場面へ）
    //   見つけた数や必要な数は、画面に出さない。測っている間に場面が変わったら、結果を捨てる
    search(sc, done) {
      const token = gen;
      const texts = sc.search || {};
      const need = parkNeed();
      const manualAfter = Math.max(1, Math.floor(Number(PARK.manualAfter) || 1));
      const hint = (n) => (GEO ? GEO.hintFor(n, PARK, texts.found) : "");
      // イーブイの文を出し（前の文のあとでも、タップを待たずに出す）、案内があれば、その下に小さく出す
      const speak = (msg, then) => {
        CV.wait = false;
        this.say(msg.text ? [msg.text] : [], () => {
          if (token !== gen) return;
          if (msg.note) {
            const node = el("div", { class: "msg system search-note" }, el("div", { class: "bubble", text: fill(msg.note) }));
            chat.log.append(node);
            scrollChat();
          }
          then();
        });
      };
      const reached = () => this.proceed(done);
      const buttons = (manual) => {
        chat.foot.replaceChildren(el("div", { class: "search-buttons" },
          el("button", { type: "button", class: "next-btn", text: T("searchButton"), onclick: start }),
          manual ? el("button", { type: "button", class: "quick-btn", text: T("searchManual"), onclick: addManual }) : null));
        scrollChat();
      };
      // 結果のあと：数と、続けて見つからなかった回数を記録して、文を出す
      const result = (d) => {
        if (token !== gen) return;
        if (d.result === "found" && !state.parks.includes(d.park)) state.parks.push(d.park);
        const n = parkCount();
        const kind = d.result === "found" && n >= need ? "reached" : d.result;
        const step = GEO ? GEO.missStep(state.parkMisses, kind, PARK) : { misses: state.parkMisses, manual: true };
        state.parkMisses = step.misses;
        storage.save(state);
        const msg = GEO ? GEO.lineFor(d, n, PARK, texts) : { text: texts.unsupported && texts.unsupported.text, note: texts.unsupported && texts.unsupported.note };
        speak(msg, kind === "reached" ? reached : () => buttons(step.manual));
      };
      function start() {
        chat.foot.replaceChildren(el("div", { class: "foot-prompt search-wait", text: T("searchWait") }));
        CV.wait = false;
        const typing = CHARS.eevee ? addTyping("eevee") : null;
        let ended = false;
        const finish = (d) => {
          if (ended) return;
          ended = true;
          if (typing) typing.remove();
          result(d);
        };
        if (!GEO || !GEO.usable(navigator, window)) {
          setTimeout(() => { if (token === gen) finish({ result: "error", code: 0 }); }, 600);
          return;
        }
        let run = null;
        run = GEO.check({
          cfg: PARK, geo: navigator.geolocation, parks: parkList(), found: state.parks,
          onTick: (info) => {
            if (!run) return;
            if (token !== gen) {
              run.stop();
              if (typing) typing.remove();
              return;
            }
            // 位置も返事も届かないまま、しばらくたったら「やめる」を出す（押すと、時間切れと同じ扱い）
            if (!chat.foot.querySelector(".search-cancel") && GEO.cancelable(info, PARK)) {
              chat.foot.append(el("button", {
                type: "button", class: "quick-btn search-cancel", text: T("searchCancel"),
                onclick: () => { run.stop(); finish(GEO.cancelled()); },
              }));
              scrollChat();
            }
          },
          onDone: (d) => { if (token === gen) finish(d); },
        });
      }
      // 「気配を見つけたことにする」：数を1つ増やす（公園名も番号も出さない）
      function addManual() {
        state.parkManual += 1;
        if (GEO) state.parkMisses = GEO.missStep(state.parkMisses, "manual", PARK).misses;
        else state.parkMisses = 0;
        storage.save(state);
        const n = parkCount();
        speak({ text: hint(n) }, n >= need ? reached : () => buttons(false));
      }
      // はじめ（「つづきから」を含む）：見つけていれば、最後に出たヒントの文をもう一度出す
      const n = parkCount();
      const manual = state.parkMisses >= manualAfter;
      if (n >= need) speak({ text: hint(n) }, reached);
      else if (n > 0) speak({ text: hint(n) }, () => buttons(manual));
      else buttons(manual);
    },
  };

  // ==============================================================
  // 7. 場面の進め方（どちらの画面でも共通）
  // ==============================================================
  // data.js の中で、その場面より前に書かれた一番近い値（章の名前・背景）
  function inherited(id, key) {
    let value = "";
    for (const [sid, sc] of Object.entries(SCN)) {
      if (sc && sc[key]) value = sc[key];
      if (sid === id) break;
    }
    return value;
  }

  // jump：合言葉やテスト用メニューで、途中の場面へ直接とんだとき
  // opts.intro：はじめの演出（playIntro）から始めるとき。会話の文は、演出が終わってから出す（opts.intro.ready）
  // opts.bgmFade：場面の曲を始めるときのフェードの長さ（ミリ秒。はじめの演出で、小さい音から始めるため）
  function runScene(id, jump = false, opts = null) {
    // 合言葉・テスト用メニュー・強いモードで場面へとんだら、遊び直し（なかまの場面へ）の終わりの印は消す
    if (jump && !(opts && opts.replay)) {
      state.replayUntil = null;
      state.replayWho = null;
    }
    // 最終章を終えたあとの遊び直し：その場面へ進む所で、代わりの場面へ進む（REPLAY の detour。シャワーズの浴室）
    const row = state.replayUntil ? replayRow(state.replayWho) : null;
    if (row && row.detour && typeof row.detour === "object" && SCN[row.detour[id]]) id = row.detour[id];
    const sc = SCN[id];
    if (!sc) {
      toast(T("noScene", { id }));
      return;
    }
    // 最終章を終えたあとの「なかまの場面へ」：終える場面（REPLAY の until）へ進む所で、メニューへ戻る
    if (state.replayUntil && id === state.replayUntil) {
      endReplay();
      return;
    }
    // ほかの方法で場面へ進んだら（テスト用メニューなど）、はじめの演出はやめる
    if (intro && !(opts && opts.intro === intro)) stopIntro();
    gen += 1;
    GRID.key = null;
    closeOverlay();
    if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
    clearTimeout(NV.autoTimer);
    CV.skip = null;
    CV.next = null;
    // 歩いている途中の場面にもどったとき（会話のあと・つづきから）は、はじめの会話をくり返さない
    const backToWalk = Boolean(walking(sc) && state.walk && state.walk.scene === id);
    // 公園で気配を探す場面は、1つでも見つけていたら、はじめの会話を出さない（最後のヒントの文から）
    const skipLines = backToWalk || Boolean(sc.search && parkCount() > 0);
    state.scene = id;
    state.atEnd = false;
    BACKLOG.length = 0;   // バックログは、今の場面で出た文だけ
    // 遊び直し（なかまの場面へ）で、いちばん先まで進んだ所に追いついたら、ふつうの記録にもどす
    //   おたのしみの場面（data.js の bonus: true。強いモード）では、追いついたことにしない（「つづきから」の場所を変えない）
    //   最終章を終えたあとの遊び直し（replayUntil がある）では、追いついたことにしない
    //   （「はじめから」のあとは、遊び直す場面が今の所より先にあるため。終えたら、今の所へもどす）
    if (state.main && !sc.bonus && !state.replayUntil && sceneOrder(id) >= sceneOrder(state.main.scene)) state.main = null;
    state.chapter = sc.chapter || (jump ? inherited(id, "chapter") : state.chapter);
    state.bg = sc.bg || (jump ? inherited(id, "bg") : state.bg);
    applyMeet(sc);
    setFlags(sc);
    // 3-0：公園で見つけた記録を空にする（合言葉で始め直したとき用）
    //   遊び直し（なかまの場面へ）の途中では消さない（いちばん先まで進んだ所の記録を減らさないため）
    if (sc.parkReset === true && !state.main) clearParks();
    storage.save(state);
    if (DEBUG) debugNow(id);
    // 音の鳴らし方：第3部（mute）は鳴らさない。iPhone の場面（chat）は短い通知音だけ。PCの場面は全部
    //   くり返す音（ambient）と曲（bgm）は、場面ごとに決める（同じ音・曲が続く場面では、鳴らしたまま）
    SND.setMode(sc.mute ? "off" : sc.mode === "chat" ? "short" : "full");
    SND.ambient(sc.ambient || null);
    SND.bgm(sceneBgm(sc), opts && opts.bgmFade);
    const view = sc.mode === "chat" ? ChatView : NovelView;
    view.enter(sc);
    // 選択肢・入力・クイズがある場面は、最後の行のあとすぐに表示する
    // （地図を調べる・歩く・氷の床の場面は、最後の行を読み終えてから始める）
    const waitsForPlayer = Boolean(hasChoices(sc) || sc.input || sc.quiz);
    const start = () => view.say(skipLines ? [] : sc.lines, () => afterLines(sc, view), !waitsForPlayer);
    if (opts && opts.intro) opts.intro.ready(start);
    else start();
  }

  // room: "look" は地図を見せるだけ（調べない）
  const explorable = (sc) => Boolean(sc.room) && sc.room !== "look";
  // walk があって ice がない場面は、歩けるマップ
  const walking = (sc) => Boolean(sc.walk) && !sc.ice && sc.mode !== "chat";
  // 条件に合う選択肢が1つでもあるか
  const hasChoices = (sc) => toArray(sc.choices).some(visible);

  function afterLines(sc, view) {
    const next = () => giveWord(sc, view, () => leave(sc, view));
    // 戦い：勝つと、言葉（give）を受けとってから next の場面へ
    if (sc.battle && view === NovelView) {
      view.battle(sc, next);
      return;
    }
    if (sc.ice && view === NovelView) {
      const skip = sc.ice.skip && sc.ice.skip.next ? sc.ice.skip : null;
      view.ice(sc,
        () => view.say(toArray(sc.ice.clear), next, true),
        skip ? () => view.say(toArray(skip.reply), () => runScene(skip.next), true) : null);
      return;
    }
    // 歩けるマップ：次の場面へは、events の出来事（next）で進む
    if (walking(sc) && view === NovelView) {
      view.walk(sc);
      return;
    }
    if (explorable(sc) && view === NovelView) {
      view.explore(sc, next);
      return;
    }
    // おまけクイズ：終わったら、言葉（give）を受けとってから、そのまま next の場面へ（「つづける」のボタンは出さない）
    if (sc.quiz) {
      runQuiz(sc, view, () => giveWord(sc, view, () => (sc.next ? runScene(sc.next) : leave(sc, view))));
      return;
    }
    next();
  }

  // ---- おまけクイズ（場面の quiz。3-1 サンダース） ----
  //   1問ずつ、選択肢を出す。正解でも不正解でも解説を出して、次の問題へ進む（ヒント・答え直しはない）
  //   最後に「○問中○問正解だ！」と、正解数に合ったセリフを出す
  //   "~" で始まる文字は「表示用に隠す」形（unhide で元にもどす）
  // 解説の頭の「答えは○○だ！」（正解したときは、ここを省いて補足にする）
  const QUIZ_HEAD = /^((?:[^：:「」\n]{1,12}[：:])?)答えは[^！!\n]*[！!][\s　]*/;
  // クイズの文の1行：名前のない文は、quiz の who のセリフにする。vars は {n} {total} の置きかえ
  function quizLine(qz, ln, vars) {
    const obj = ln && typeof ln === "object" ? ln : { text: ln };
    let text = unhide(obj.text);
    if (vars) text = text.replace(/\{(\w+)\}/g, (whole, k) => (k in vars ? String(vars[k]) : whole));
    const line = { ...obj, text };
    if (!obj.who && !parseLine(text).who && qz.who) line.who = qz.who;
    return line;
  }
  const quizLines = (qz, lines, vars) => toArray(lines)
    .filter((ln) => ln != null && unhide(ln && typeof ln === "object" ? ln.text : ln) !== "")
    .map((ln) => quizLine(qz, ln, vars));
  // 出す問題（if・unless の条件に合うもの）
  const quizQuestions = (qz, on = flagOn) => toArray(qz.questions).filter((q) => visibleWith(q, on));
  // 正解数のセリフ（出した問題の数 total ごとの範囲 count から選ぶ）
  function quizResult(qz, total, n) {
    return toArray(qz.results).find((r) => {
      const range = r && r.count && r.count[total];
      return Array.isArray(range) && n >= Number(range[0]) && n <= Number(range[1]);
    });
  }
  // 正解したときの補足（plus。なければ、explain の頭の「答えは○○だ！」を省いた残り）
  function quizPlus(q) {
    if (q.plus != null) return toArray(q.plus);
    return toArray(q.explain).map((ln, i) => {
      if (i > 0) return ln;
      const obj = ln && typeof ln === "object" ? ln : { text: ln };
      return { ...obj, text: unhide(obj.text).replace(QUIZ_HEAD, "$1") };
    });
  }

  function runQuiz(sc, view, then) {
    const qz = sc.quiz;
    const qs = quizQuestions(qz);
    const total = qs.length;
    const token = gen;
    const praise = toArray(qz.correct);
    let score = 0;
    const ask = (i) => {
      if (token !== gen) return;
      if (i >= total) {
        const result = quizResult(qz, total, score);
        view.say(quizLines(qz, [qz.score, result && result.text], { n: score, total }), then, true);
        return;
      }
      const q = qs[i];
      const list = toArray(q.choices).map((c, k) => {
        const obj = c && typeof c === "object" ? c : { text: c };
        return { text: unhide(obj.text), reply: obj.reply, index: k + 1 };
      });
      view.say(quizLines(qz, [...toArray(q.before), ...toArray(q.ask)]), () => {
        if (token !== gen) return;
        view.choices(list, (c) => {
          const ok = c.index === Number(q.answer);
          let lines;
          if (ok) {
            inputSound("correct");
            lines = [praise.length ? praise[score % praise.length] : null, ...quizPlus(q)];
            score += 1;
          } else {
            inputSound("wrong");
            lines = [...(c.reply != null ? toArray(c.reply) : toArray(qz.wrong)), ...toArray(q.explain)];
          }
          view.say(quizLines(qz, [...lines, ...toArray(q.after)]), () => ask(i + 1), false);
        });
      }, false);
    };
    ask(0);
  }

  // set: "indoor" → 条件の名前を記録する / unset: "indoor" → 消す（場面にも選択肢にも書ける）
  function setFlags(item) {
    for (const f of toArray(item.set)) if (!state.flags.includes(f)) state.flags.push(f);
    for (const f of toArray(item.unset)) state.flags = state.flags.filter((x) => x !== f);
  }

  // give: "glaceon" → 会話のあとに、その仲間の言葉を手に入れる
  // afterWord：言葉を受けとったあとに続ける会話（選択肢・入力が続くときは、最後の行のあとすぐに出す）
  function giveWord(sc, view, then) {
    const id = typeof sc.give === "string" ? sc.give : null;
    if (!id || !CHARS[id] || !CHARS[id].word) {
      then();
      return;
    }
    if (!state.words.includes(id)) state.words.push(id);
    // この端末でクリアした仲間として記録する（合言葉の場面の give: [ ] では記録しない）
    if (!state.cleared.includes(id)) state.cleared.push(id);
    storage.save(state);
    const afterWord = () => view.say(sc.afterWord, then, !(hasChoices(sc) || sc.input));
    view.reveal(id, sc.afterWord ? afterWord : then);
  }

  function leave(sc, view) {
    if (hasChoices(sc)) return askChoice(sc, view);
    if (sc.input) return askInput(sc, view);
    if (sc.end) {
      if (view === ChatView) return view.proceed(() => showEnd(sc));
      // 文のあとの演出（finale。4-6 エピローグ）：雪と最後のイラストのあと、クリックで終わりの画面へ
      if (sc.finale) return view.finale(sc, () => showEnd(sc));
      return showEnd(sc);
    }
    // knock：暗い窓の画面で、タップを待ってから次の場面へ（メッセージ画面だけ。2-7 のiPhone側）
    if (sc.knock && sc.next && view === ChatView) return view.knock(sc, () => runScene(sc.next));
    // search：公園で気配を探す。必要な数に達したら、「つづける ▶」で次の場面へ（メッセージ画面だけ）
    if (sc.search && sc.next && view === ChatView) return view.search(sc, () => runScene(sc.next));
    if (sc.next) return view.proceed(() => runScene(sc.next));
    return undefined;
  }

  function askChoice(sc, view) {
    view.choices(toArray(sc.choices).filter(visible), (c) => {
      setFlags(c);
      storage.save(state);
      view.say(toArray(c.reply), () => (c.next ? runScene(c.next) : askChoice(sc, view)), Boolean(c.next));
    });
  }

  // misses：まちがえた回数（skip の「どうしてもわからない」を出すために数える）
  // hints ：ヒントを見た回数（ヒントは押すたびに1つずつ出す。最後のヒントは何度でも）
  function askInput(sc, view, misses = 0, hints = 0) {
    const spec = sc.input;
    const hintList = toArray(spec.hint);
    // hintAfter：まちがえた回数がこの数になるまで、ヒントのボタンを出さない（書かなければ、はじめから出す）
    const onHint = hintList.length && misses >= (Number(spec.hintAfter) || 0)
      ? () => view.say(toArray(hintList[Math.min(hints, hintList.length - 1)]), () => askInput(sc, view, misses, hints + 1), false)
      : null;
    const skip = spec.skip && spec.skip.next ? spec.skip : null;
    // 最終章を終えたあとの遊び直し（REPLAY の skipNow）では、まちがえる前から出す（PCでは、カードや鏡を見に行けないため）
    const replaying = state.replayUntil ? replayRow(state.replayWho) : null;
    const skipAfter = replaying && replaying.skipNow === true ? 0 : skip && skip.after == null ? 2 : skip && skip.after;
    const onSkip = skip && misses >= skipAfter
      ? () => view.say(toArray(skip.reply), () => runScene(skip.next), true)
      : null;
    // back：「もどる」ボタンで、その場面へもどる（選択肢を選び直せるように）
    const onBack = spec.back ? () => runScene(spec.back) : null;
    // 最終章を終えたあとの遊び直しで、名前の入力欄に名前を最初から入れておく（2-4 のブラッキー。REPLAY の name）
    //   pc-images/name.js の guess（なければ names の1つ目）。name.js がないとき（公開ページなど）は、今の名前 {name}
    const row = spec.name && state.replayUntil ? replayRow(state.replayWho) : null;
    if (row && row.name === true && !("value" in spec)) {
      const token = gen;
      loadNames().then(({ list }) => {
        if (token !== gen) return;
        const value = (list && list.guess) || fill("{name}");
        askInputWith(sc, view, Object.assign({}, spec, { value }), misses, hints, onHint, onSkip, onBack);
      });
      return;
    }
    askInputWith(sc, view, spec, misses, hints, onHint, onSkip, onBack);
  }
  function askInputWith(sc, view, spec, misses, hints, onHint, onSkip, onBack) {
    view.input(spec, (text) => {
      // name: true → 入力した文字を、主人公の名前として記録する（正解・不正解はない）
      if (spec.name) {
        const takeName = (name) => {
          state.name = Array.from(name).slice(0, 12).join("");
          storage.save(state);
          view.say(toArray(spec.correct), () => runScene(spec.next), true);
        };
        // check があれば、name.js の一覧と照らす（1-1。PCで直接開いたときだけ。name.js がなければ確認しない）
        if (!spec.check || view !== NovelView) {
          takeName(text);
          return;
        }
        const token = gen;
        loadNames().then(({ list }) => {
          if (token !== gen) return;
          if (!list || nameListed(list, text)) {
            takeName(text);   // 一覧で通ったときは、入れたとおりの表記を名前にする
            return;
          }
          const ck = spec.check;
          const miss = misses + 1;
          const every = Math.floor(Number(ck.after)) > 0 ? Math.floor(Number(ck.after)) : 3;
          const again = () => askInput(sc, view, miss, hints);
          if (ck.ask && miss % every === 0) {
            // 続けて一覧にない名前だったとき：name.js の呼び名で「もしかして」と聞く
            view.say(withVars(ck.ask, { guess: list.guess }), () => {
              if (token !== gen) return;
              view.choices([{ text: ck.yes || "うん", yes: true }, { text: ck.no || "ちがう" }], (c) => {
                if (c.yes) {
                  takeName(list.guess);
                  return;
                }
                // 「ちがう」：問いの文を消してから、名前の入力にもどる
                novel.text.textContent = "";
                setSpeaker(null);
                again();
              });
            }, false);
            return;
          }
          view.say(toArray(ck.wrong || T("wrong")), again, false);
        });
      } else if (isAnswer(text, spec.answers)) {
        inputSound("correct");   // 正解音（入力欄の全体。data.js の SETTINGS.inputSound）
        view.say(toArray(spec.correct), () => runScene(spec.next), true);
      } else {
        inputSound("wrong");     // 責めない軽い不正解音
        view.say(toArray(spec.wrong || T("wrong")), () => askInput(sc, view, misses + 1, hints), false);
      }
    }, onHint, onSkip, onBack);
  }

  function applyMeet(sc) {
    const list = toArray(sc.meet).filter((id) => CHARS[id]);
    const fresh = list.filter((id) => !state.met.includes(id));
    state.met.push(...fresh);
    // give が [ ] のときは、まとめて言葉を受けとる（途中の章から始めたとき用）
    if (Array.isArray(sc.give)) {
      for (const id of sc.give) if (CHARS[id] && CHARS[id].word && !state.words.includes(id)) state.words.push(id);
    }
    updateParty();
    // 1匹だけ新しく会ったときに、お知らせを出す
    if (typeof sc.meet === "string" && fresh.length) {
      const c = CHARS[sc.meet];
      toast(T("metToast", { emoji: c.emoji || "", who: charName(c), n: metCount(), total: PARTY.length }));
    }
  }

  // 章の終わりの画面（記録しておき、「つづきから」でこの画面にもどる）
  function showEnd(sc) {
    const e = sc.end || {};
    gen += 1;
    state.atEnd = true;
    if (e.complete === true) state.finished = true;   // 最終章を終えた記録（タイトル画面に「おたのしみ」を出す）
    storage.save(state);
    SND.setMode(sc.mute ? "off" : "short");   // 終わりの画面では、くり返す音（風など）を止める
    SND.ambient(null);
    SND.bgm(sceneBgm(sc));   // 曲は、その場面の曲のまま（エピローグの終わりの画面は、最終章の曲を続ける）
    setBg(endScreen, e.bg || state.bg || "night");
    // スタッフの名前（end の credits。4-6）。条件（if・unless。pcDirect は、PCで直接開いたとき）に合う行だけを出す
    const credits = toArray(e.credits).filter(visible)
      .map((ln) => fill(ln && typeof ln === "object" ? ln.text : ln)).filter((t) => t.trim());
    endScreen.replaceChildren(el("div", { class: "end-card" + (credits.length ? " has-credits" : "") },
      e.icon ? el("div", { class: "end-icon", text: e.icon, "aria-hidden": "true" }) : null,
      el("h2", { class: "end-title", text: fill(e.title || "") }),
      e.text ? el("p", { class: "end-text", text: fill(e.text) }) : null,
      credits.length ? el("div", { class: "end-credits" }, credits.map((t) => el("p", { class: "end-credit", text: t }))) : null,
      el("div", { class: "end-buttons" },
        e.map ? el("button", { class: "btn", type: "button", text: houseMapOn() ? T("endHouseMap") : T("endMap"), onclick: openMap }) : null,
        e.next ? el("button", { class: "btn primary", type: "button", text: fill(e.nextLabel || T("endNext")), onclick: () => runScene(e.next) }) : null,
        el("button", { class: "btn", type: "button", text: T("toTitle"), onclick: showTitle }))));
    // 雪（場面の snow か、end の snow。4-6 のエピローグの終わりの画面）
    setSnow(endScreen, Boolean(sc.snow || e.snow));
    show("end");
  }

  // ==============================================================
  // 8. 重ねて表示する画面（なかまノート・メニュー・地図・確認）
  // ==============================================================
  // onClose：とじたときに1回だけ呼ぶ（場面が変わったあとは呼ばない）
  let onOverlayClose = null;
  // 重ねて表示する画面が、自分で使うキー（回想ギャラリーの ←→ など）。使ったら true を返す。開くたびに空にする
  let overlayKey = null;
  // メニュー（≡）・なかまノートのボタンが選ばれたままだと、Enter でまた開いてしまう
  // （Esc で閉じたとき）。開くときと閉じるときに、選ばれた状態を外して、Enter を文を進めるのに使う
  function releaseFocus() {
    const a = document.activeElement;
    if (a && a !== document.body && !overlay.contains(a) && a.matches("button, a") && typeof a.blur === "function") a.blur();
  }
  function openOverlay(content, onClose) {
    overlayKey = null;
    overlay.replaceChildren(content);
    overlay.classList.add("open");
    releaseFocus();
    const token = gen;
    onOverlayClose = onClose ? () => { if (token === gen) onClose(); } : null;
  }
  function closeOverlay() {
    overlayKey = null;
    overlay.classList.remove("open");
    overlay.replaceChildren();
    releaseFocus();
    const cb = onOverlayClose;
    onOverlayClose = null;
    if (cb) cb();
  }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });

  // なかまノート：会った仲間ともらった言葉の一覧。まだ会っていない仲間は空らん
  function openParty() {
    const n = metCount();
    const got = PARTY.filter((id) => state.words.includes(id)).length;
    const cells = PARTY.map((id) => {
      const c = CHARS[id] || {};
      const met = state.met.includes(id);
      const hasWord = state.words.includes(id) && c.word;
      const slot = el("div", { class: "party-slot" + (met ? " met" : ""), style: met ? `--c:${c.color || "#ccc"}` : null, text: met ? c.emoji || "" : "" });
      return el("div", { class: "party-cell" + (met ? " met" : "") },
        met ? withArt(slot, id) : slot,
        el("div", { class: "party-info" },
          el("div", { class: "party-name", text: met ? charName(c) : "" }),
          hasWord ? wordNode(c.word, "party-word") : el("span", { class: "party-word none" })));
    });
    const note = got >= PARTY.length ? T("partyNoteAll") : n >= PARTY.length ? T("partyNoteMet") : T("partyNote");
    openOverlay(el("div", { class: "panel" },
      el("h2", { text: T("partyTitle", { n, total: PARTY.length }) }),
      el("div", { class: "party-grid" }, cells),
      el("p", { class: "panel-note", text: note }),
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })));
  }

  // ---- バックログ（PC。設計書 第11節）：今の場面で出た文の一覧 ----
  //   会話の枠の「ログ」ボタンか、↑キーで開く。Esc・「とじる」・外側のクリックで閉じると、もとの場面にもどる
  //   開けないとき：物語の画面（PC）でないとき・ほかの画面を重ねているとき・はじめの演出のあいだ・
  //   文を出さずに待っているあいだ（4-3 の余韻・絵の暗転など）・4-6 の文のあとの演出（雪と最後のイラスト）
  //   入力欄や選択肢が出ていても開ける。開いているあいだ、入力欄からは外す（Enter で答えが送られないように）。
  //   閉じたら、入力欄にもどす（入れかけの文字は、そのまま）
  function canOpenLog() {
    return currentView === "novel" && !intro && !overlay.classList.contains("open")
      && NV.mode !== "pause" && NV.mode !== "finale";
  }
  function logRow(x) {
    if (x.picked != null) return el("div", { class: "log-row picked", text: T("logPicked", { text: x.picked }) });
    const c = x.who ? CHARS[x.who] : null;
    const name = c ? (x.who === "hero" ? fill("{name}") : charName(c)) : "";
    return el("div", { class: "log-row" + (name ? "" : " narration"), style: c ? `--c:${c.color || "#999"}` : null },
      name ? el("span", { class: "log-name", text: name }) : null,
      el("span", { class: "log-text", text: x.text }));
  }
  function openLog() {
    if (!canOpenLog()) return;
    const a = document.activeElement;
    const back = a && ["INPUT", "TEXTAREA"].includes(a.tagName) ? a : null;
    if (back) back.blur();
    const list = el("div", { class: "log-list", tabindex: "-1" },
      BACKLOG.length ? BACKLOG.map(logRow) : el("p", { class: "log-empty", text: T("logEmpty") }));
    openOverlay(el("div", { class: "panel log-panel" },
      el("h2", { text: T("logTitle") }),
      el("p", { class: "panel-note", text: T("logNote") }),
      list,
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })),
    () => { if (back && back.isConnected) back.focus({ preventScroll: true }); });
    // いちばん新しい文が見えるようにする。↑↓キー・ホイールで、さかのぼって読める
    list.scrollTop = list.scrollHeight;
    list.focus({ preventScroll: true });
  }

  // 夢の部屋の地図は、部屋が明るくなってから（data.js の set: "roomMap"）メニューに出す
  // 2-7 で家全体の地図ができたら（set: "houseMap"）、家の地図に変わる
  const houseMapOn = () => Boolean(HS) && flagOn("houseMap");
  function openMenu() {
    openOverlay(el("div", { class: "panel" },
      el("h2", { text: T("menuTitle") }),
      el("button", { class: "btn", type: "button", text: T("menuParty"), onclick: openParty }),
      houseMapOn() || (RM && flagOn("roomMap"))
        ? el("button", { class: "btn", type: "button", text: houseMapOn() ? T("menuHouseMap") : T("menuMap"), onclick: openMap })
        : null,
      replayRows(state).some((r) => r.done)
        ? el("button", { class: "btn", type: "button", text: T("menuReplay"), onclick: () => openReplay(state) })
        : null,
      soundButton("btn"),
      el("button", { class: "btn", type: "button", text: T("menuToTitle"), onclick: showTitle }),
      el("p", { class: "panel-note", text: T("menuNote") }),
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })));
  }

  // 家全体の地図（2-7 のあと）。会った仲間の印と、プレゼントの星（4-5 で光ったあと）も出す
  function openHouseMap() {
    const box = el("div", { class: "map-box house-map" });
    let hv = null;
    openOverlay(el("div", { class: "panel map-panel house-panel" },
      el("h2", { text: T("houseMapTitle") }),
      box,
      el("p", { class: "map-caption", text: T("houseMapCaption") }),
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })), () => { if (hv) hv.stop(); });
    hv = renderHouse(box, { show: "all", home: "all", marks: true, fog: true, star: flagOn("presentOnMap") && flagOn("presentShown") }, { static: true });
  }

  function openMap() {
    if (houseMapOn()) {
      openHouseMap();
      return;
    }
    const caption = el("p", { class: "map-caption", text: T("mapCaption") });
    const box = el("div", { class: "map-box" });
    renderRoom(box, (it) => { caption.textContent = fill(it.text || it.name); });
    openOverlay(el("div", { class: "panel map-panel" },
      el("h2", { text: T("mapTitle") }),
      box,
      caption,
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })));
  }

  // ---- クリアしたなかまへ戻る（設計書 第11節。data.js の REPLAY） ----
  //  遊び直している間も、いちばん先まで進んだ所（state.main）は減らさない。
  //  「つづきから」は、いちばん先の所から再開する。遊び直しが、その所に追いついたら、ふつうの記録にもどる
  //  （追いついたかは、data.js の SCENES に書いた順番で決める）
  const SCENE_IDS = Object.keys(SCN);
  const sceneOrder = (id) => SCENE_IDS.indexOf(id);
  // 端末の分け方は、場面の mode で決める（"chat" は iPhone、ほかは PC）
  const deviceOf = (id) => (SCN[id] && SCN[id].mode === "chat" ? "phone" : "pc");
  // いちばん先まで進んだ所として覚えておく項目（なかまノートの言葉・会った仲間・名前は、いつも減らさない）
  const MAIN_KEYS = ["scene", "atEnd", "walk", "chapter", "bg", "flags"];
  function mainOf(st) {
    const m = {};
    for (const k of MAIN_KEYS) {
      const v = st[k];
      m[k] = Array.isArray(v) ? v.slice() : v && typeof v === "object" ? Object.assign({}, v) : v;
    }
    return m;
  }

  // 「なかまの場面へ」に並べる仲間：クリアした仲間が1匹でもいる端末の仲間（まだの仲間は done: false）
  //   ふつうは、その端末の仲間だけが並ぶ（PCの3匹か、iPhoneの5匹）
  //   最終章を終えたあと（PC）は、8匹とも並べる（「ただいま」で8匹と会った記録を持つため。設計書 第11節）
  //     合言葉やテスト用メニューで最終章へとび、PCの3匹の言葉をこの端末で受けとっていなくても、3匹を並べる
  function replayRows(st) {
    const cleared = toArray(st && st.cleared);
    const finished = Boolean(st && st.finished);
    const rows = RP.filter((r) => r && CHARS[r.who] && SCN[r.scene])
      .map((r) => {
        const device = deviceOf(r.scene);
        return { r, device, done: finished || cleared.includes(r.who) };
      });
    const devices = new Set(rows.filter((x) => x.done).map((x) => x.device));
    return rows.filter((x) => devices.has(x.device));
  }
  // 遊び直している仲間の REPLAY の行（state.replayWho）。なければ null
  const replayRow = (who) => (who ? RP.find((r) => r && r.who === who) || null : null);
  // REPLAY の set に書いた条件（遊び直しのあいだだけ付ける）
  const REPLAY_SET = new Set(RP.flatMap((r) => toArray(r && r.set)));

  // st：並べるときに使う記録（タイトル画面では、この端末に保存した記録）
  // back：「◀ もどる」で開き直す画面（「おたのしみ」から開いたとき）
  function openReplay(st, back) {
    const cells = replayRows(st).map(({ r, done }) => {
      const c = CHARS[r.who];
      if (!done) {
        // まだクリアしていない仲間は「？」だけ（名前も絵も出さない）
        return el("div", { class: "party-cell replay-cell locked", "aria-label": T("replayLocked") },
          el("div", { class: "party-slot", text: T("replayLocked") }),
          el("div", { class: "party-info" },
            el("span", { class: "party-name" }),
            el("span", { class: "party-word none", text: T("replayLocked") })));
      }
      const slot = el("div", { class: "party-slot met", style: `--c:${c.color || "#ccc"}`, text: c.emoji || "" });
      return el("button", { class: "party-cell met replay-cell", type: "button", onclick: () => startReplay(r) },
        withArt(slot, r.who),
        el("div", { class: "party-info" },
          el("span", { class: "party-name", text: fill(r.label || "") }),
          el("span", { class: "party-word", text: charName(c) })));
    });
    openOverlay(el("div", { class: "panel" },
      el("h2", { text: T("replayTitle") }),
      el("p", { class: "panel-note pre", text: T("replayNote") }),
      el("div", { class: "party-grid" }, cells),
      back ? el("button", { class: "btn", type: "button", text: T("replayBack"), onclick: back }) : null,
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })));
  }

  // ---- クリア後のおたのしみ（設計書 第11節。PCのみ。data.js の BONUS） ----
  //   最終章を終えた記録（state.finished）があるとき、タイトル画面に出す
  //   中は「なかまの場面へ」（今の REPLAY）・「雪だるま戦・強いモード」・「回想ギャラリー」
  //   st：この端末に保存した記録（タイトル画面から開く）
  function openBonus(st) {
    const again = () => openBonus(st);
    const canReplay = replayRows(st).some((r) => r.done);
    const hard = bonusHard();
    openOverlay(el("div", { class: "panel bonus-panel" },
      el("h2", { text: T("bonusTitle") }),
      el("p", { class: "panel-note pre", text: T("bonusNote") }),
      el("div", { class: "bonus-menu" },
        canReplay ? el("button", { class: "btn", type: "button", text: T("bonusReplay"), onclick: () => openReplay(st, again) }) : null,
        hard ? el("button", { class: "btn", type: "button", text: T("bonusHard"), onclick: startHard }) : null,
        el("button", { class: "btn", type: "button", text: T("bonusGallery"), onclick: () => openGallery(again) })),
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })));
  }

  // 雪だるま戦・強いモード（data.js の BONUS の hard）：始める場面（bonus: true の場面）。書いていなければ null
  const bonusHard = () => (BN.hard && SCN[BN.hard.scene] ? BN.hard : null);
  //   なかまの場面へと同じように、いちばん先まで進んだ所を覚えてから始める（「つづきから」は、その所から）
  //   仲間（友達とパパ）の条件は、始める場面の unset で消す（data.js）
  function startHard() {
    const h = bonusHard();
    if (!h) return;
    // タイトル画面から選んだときは、この端末に保存した記録で始める
    if (currentView === "title") loadState(storage.load());
    if (!state.main && state.scene && SCN[state.scene] && !SCN[state.scene].bonus) state.main = mainOf(state);
    state.atEnd = false;
    state.walk = null;   // 歩けるマップは、場面の最初の場所から
    currentView = "";
    runScene(h.scene, true);
  }

  // 回想ギャラリー：BONUS の gallery の絵のうち、見つかったものだけを並べる（PCで直接開いたときだけ探す）
  //   back：「◀ もどる」で開き直す画面（おたのしみ）
  const galleryList = () => toArray(BN.gallery)
    .filter((g) => g && typeof g.image === "string" && g.image.trim())
    .map((g) => ({ image: g.image.trim(), label: fill(g.label || "") }));
  function openGallery(back) {
    const items = galleryList();
    const grid = el("div", { class: "gallery-grid" }, el("p", { class: "panel-note", text: T("galleryLoading") }));
    const panel = el("div", { class: "panel gallery-panel" },
      el("h2", { text: T("galleryTitle") }),
      el("p", { class: "panel-note", text: T("galleryNote") }),
      grid,
      back ? el("button", { class: "btn", type: "button", text: T("replayBack"), onclick: back }) : null,
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay }));
    openOverlay(panel);
    Promise.all(items.map((g) => (ART_DIR ? findPicture(g.image) : Promise.resolve("")))).then((srcs) => {
      if (!panel.isConnected) return;   // 待っているあいだに、閉じた・ほかの画面にした
      const found = items.map((g, i) => Object.assign({ src: srcs[i] }, g)).filter((g) => g.src);
      if (!found.length) {
        grid.replaceChildren(el("p", { class: "panel-note pre", text: T("galleryEmpty") }));
        return;
      }
      grid.replaceChildren(...found.map((g, i) => el("button", {
        class: "gallery-cell", type: "button", onclick: () => openViewer(found, i, back),
      },
        el("img", { class: "gallery-thumb", src: g.src, alt: "", draggable: "false" }),
        el("span", { class: "gallery-label", text: g.label }))));
    });
  }
  // 1枚を大きく見る。←→キー（またはボタン）で、まえ・つぎの絵。「一覧へ」で、並べた画面にもどる
  function openViewer(found, start, back) {
    let at = start;
    const img = el("img", { class: "gallery-big", alt: "", draggable: "false" });
    const cap = el("p", { class: "gallery-cap" });
    const go = (step) => {
      at = (at + step + found.length) % found.length;
      img.src = found[at].src;
      cap.textContent = `${found[at].label}　${T("galleryCount", { n: at + 1, total: found.length })}`;
    };
    const many = found.length > 1;
    openOverlay(el("div", { class: "panel gallery-view" },
      el("div", { class: "gallery-frame" }, img),
      cap,
      el("div", { class: "panel-buttons" },
        many ? el("button", { class: "btn", type: "button", text: T("galleryPrev"), onclick: () => go(-1) }) : null,
        el("button", { class: "btn", type: "button", text: T("galleryList"), onclick: () => openGallery(back) }),
        many ? el("button", { class: "btn", type: "button", text: T("galleryNext"), onclick: () => go(1) }) : null),
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })));
    go(0);
    overlayKey = (e) => {
      if (e.key === "ArrowLeft" && many) { if (!e.repeat) go(-1); return true; }
      if (e.key === "ArrowRight" && many) { if (!e.repeat) go(1); return true; }
      return false;
    };
  }

  // 選んだ仲間の場面を、最初から始める
  //   最終章を終える前：終えたら、話の続きへそのまま進む
  //   最終章を終えたあと：REPLAY に until を書いた仲間（PCの3匹）は、終えたら「なかまの場面へ」のメニューへ戻る
  function startReplay(r) {
    // タイトル画面から選んだときは、この端末に保存した記録で始める
    if (currentView === "title") loadState(storage.load());
    // いちばん先まで進んだ所を覚えておく（遊び直しの途中で、また選んだときは、前に覚えた所のまま）
    if (!state.main && state.scene && SCN[state.scene]) state.main = mainOf(state);
    state.atEnd = false;
    state.walk = null;   // 歩けるマップは、場面の最初の場所から
    // その場面の中だけで使う条件は消してから始める（1-3 の友達など。data.js の REPLAY の unset）
    for (const f of toArray(r.unset)) state.flags = state.flags.filter((x) => x !== f);
    // 終える場面（最終章を終えたあとだけ）
    state.replayUntil = state.finished && r.until && SCN[r.until] && state.main ? r.until : null;
    state.replayWho = state.replayUntil ? r.who : null;
    // 最終章を終えたあとは、遊び直しで増えた言葉・会った仲間も、終えたときに元へもどす
    //   （「はじめから」のあとに遊び直しても、今の旅のなかまノートに、先の仲間が入らないように。遊ぶ前より減ることはない）
    //   名前も、遊ぶ前の名前を覚えておき、終えたら元へもどす（2-4 で名前を入れても、PCの名前は変わらない）
    if (state.replayUntil) {
      if (!Array.isArray(state.main.words)) state.main.words = state.words.slice();
      if (!Array.isArray(state.main.met)) state.main.met = state.met.slice();
      if (typeof state.main.name !== "string") state.main.name = state.name;
      // 遊び直すあいだだけの条件（REPLAY の set）：前に遊び直した仲間の条件は外し、この仲間の条件を付ける
      const before = toArray(state.main.flags);
      state.flags = state.flags.filter((f) => !REPLAY_SET.has(f) || before.includes(f));
      for (const f of toArray(r.set)) if (!state.flags.includes(f)) state.flags.push(f);
    }
    // メッセージ画面（iPhone）で選んだときも、前の会話を消してから始める
    currentView = "";
    runScene(r.scene, true, { replay: true });
  }

  // 遊び直しを終えて、「なかまの場面へ」のメニューへ戻る（最終章を終えたあと）
  //   いちばん先まで進んだ所にもどしてから保存する（なかまノートの言葉・会った仲間・名前は、そのまま）。
  //   メニューは、タイトル画面の上に開く（「◀ もどる」で、おたのしみ）
  function endReplay() {
    state.replayUntil = null;
    state.replayWho = null;
    if (state.main) {
      Object.assign(state, state.main);
      state.main = null;
    }
    storage.save(state);
    showTitle();
    const saved = normalized(storage.load());
    openReplay(saved, () => openBonus(saved));
  }

  function confirmBox(message, yesLabel, onYes) {
    openOverlay(el("div", { class: "panel" },
      el("p", { class: "panel-text", text: message }),
      el("div", { class: "panel-buttons" },
        el("button", { class: "btn", type: "button", text: T("cancel"), onclick: closeOverlay }),
        el("button", { class: "btn primary", type: "button", text: yesLabel, onclick: () => { closeOverlay(); onYes(); } }))));
  }

  // ==============================================================
  // 9. タイトル・合言葉
  // ==============================================================
  // 音の ON/OFF のボタン（メニューとタイトル画面）。押すたびに切りかわり、この端末に記録する
  //   ON にしたときは、確かめの短い音を1回鳴らす（第3部の場面では鳴らさない）
  function soundButton(cls) {
    const btn = el("button", { class: cls, type: "button" });
    const label = () => {
      btn.textContent = SND.isOn() ? T("soundOn") : T("soundOff");
      btn.setAttribute("aria-pressed", SND.isOn() ? "true" : "false");
    };
    btn.addEventListener("click", () => {
      SND.setOn(!SND.isOn());
      label();
      // iPhone では、音の準備が終わるまで少しかかるので、少し待ってから鳴らす
      if (SND.isOn()) setTimeout(() => SND.play("toggle"), 120);
    });
    label();
    return btn;
  }

  function showTitle() {
    stopIntro();
    gen += 1;
    GRID.key = null;
    if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
    clearTimeout(NV.autoTimer);
    CV.skip = null;
    CV.next = null;
    closeOverlay();
    SND.setMode("short");   // タイトルと合言葉の画面では、短い音（正解音など）だけ。曲は鳴らさない
    SND.ambient(null);
    SND.bgm(null);
    const save = storage.load();
    const canResume = Boolean(save && save.scene && SCN[save.scene]);
    // 「なかまの場面へ」は、この端末でクリアした仲間がいるときだけ出す
    //   最終章を終えた記録があるときは、代わりに「おたのしみ」を出す（「なかまの場面へ」は、その中に入る）
    const saved = save || hasBonus() ? normalized(save) : null;
    // 前の版の記録（クリア後の記録がまだない）：最終章を終えていれば、クリア後の記録を作っておく
    if (saved && saved.finished && !hasBonus()) keepBonus(saved);
    const finished = Boolean(saved && saved.finished);
    const canReplay = !finished && Boolean(saved && replayRows(saved).some((r) => r.done));
    // 記録があるときは「つづきから」をいちばん上にする（まちがえて最初からにしないように）
    titleScreen.replaceChildren(el("div", { class: "title-wrap" },
      el("div", { class: "title-deco", text: "✦　✧　✦", "aria-hidden": "true" }),
      el("h1", { class: "title-main", text: S.title || "" }),
      S.subtitle ? el("p", { class: "title-sub", text: S.subtitle }) : null,
      el("div", { class: "title-menu" },
        canResume ? el("button", { class: "btn primary", type: "button", text: T("resume"), onclick: () => resume(save) }) : null,
        el("button", { class: canResume ? "btn" : "btn primary", type: "button", text: T("newGame"), onclick: () => newGame(canResume) }),
        el("button", { class: "btn", type: "button", text: T("keywordButton"), onclick: showKeyword }),
        canReplay ? el("button", { class: "btn", type: "button", text: T("titleReplay"), onclick: () => openReplay(saved) }) : null,
        finished ? el("button", { class: "btn", type: "button", text: T("titleBonus"), onclick: () => openBonus(saved) }) : null,
        soundButton("btn ghost title-sound")),
      S.footer ? el("p", { class: "title-foot", text: S.footer }) : null));
    show("title");
  }

  function newGame(hasSave) {
    const go = () => {
      storage.clear();   // 進み具合の記録だけを消す（クリア後の記録 BONUS_KEY は残す）
      state = normalized(null);   // 最終章を終えた記録・クリアした仲間・回数は、クリア後の記録から引きつぐ
      updateParty();
      // はじめの場面に intro（はじめの演出）があれば、画面を暗くしてから始める（1-1 の森）
      if (SCN[S.start] && SCN[S.start].intro && SCN[S.start].mode !== "chat") playIntro(S.start);
      else runScene(S.start);
    };
    if (hasSave) confirmBox(hasBonus() ? T("confirmNewBonus") : T("confirmNew"), T("newGame"), go);
    else go();
  }

  // ---- はじめの演出（設計書 1-1。data.js の場面の intro） ----
  //   タイトルの「はじめから」で始めたときだけ行う（つづきから・なかまの場面へ・合言葉・テスト用メニューでは行わない）
  //   1. タイトルの画面が、dark ミリ秒かけて暗くなる
  //   2. 場面（森のマップ）が、appear ミリ秒かけて現れる。場面の曲も、同じ時間をかけて小さい音から始まる
  //   3. 場面の文（lines）を出す
  //   演出のあいだは、Enter・スペース・クリック（タップ）で飛ばせる（すぐにマップを出して、3 へ）
  const introMs = (v, d) => (v != null && Number(v) >= 0 ? Number(v) : d);
  function setVeil(opacity, ms) {
    fadeStyle(veil, opacity, ms);
  }
  function stopIntro() {
    if (!intro) return;
    clearTimeout(intro.timer);
    intro = null;
    veil.classList.remove("on");
    setVeil(0, 0);
  }
  function playIntro(id) {
    const spec = SCN[id].intro || {};
    const dark = introMs(spec.dark, 2000);
    const appear = introMs(spec.appear, 2000);
    stopIntro();
    gen += 1;   // タイトルの画面のタイマーなどを止める
    // 「はじめから」のボタンが選ばれたままだと、Enter でもう一度押されてしまうので、外しておく
    if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();
    const it = { phase: "dark", timer: null, begin: null, skipping: false };
    intro = it;
    // 曲は、森のマップが現れるときに始める。クリックの処理の中で、先に音を出さずに準備しておく（sound.js の primeBgm）
    const song = sceneBgm(SCN[id]);
    if (song) SND.primeBgm(song);
    // 1. 暗くする（幕を透明から黒へ）
    veil.classList.add("on");
    setVeil(0, 0);
    void veil.offsetWidth;   // 透明な状態を確定してから、暗くし始める
    setVeil(1, dark);
    // 演出を終えて、場面の文を出す
    const finish = () => {
      if (intro !== it) return;
      intro = null;
      clearTimeout(it.timer);
      veil.classList.remove("on");
      setVeil(0, 0);
      if (it.begin) it.begin();
    };
    // 2. 幕のうしろで場面を出してから、幕を少しずつ透明にする（曲も小さい音から）
    const reveal = () => {
      if (intro !== it) return;
      it.phase = "appear";
      runScene(id, false, { intro: it, bgmFade: it.skipping ? 0 : appear });
    };
    // runScene から呼ばれる（start：場面の文を出す関数）
    it.ready = (start) => {
      it.begin = start;
      if (it.skipping) { finish(); return; }
      void veil.offsetWidth;
      setVeil(0, appear);
      it.timer = setTimeout(finish, appear);
    };
    // Enter・スペース・クリックで飛ばす
    it.skip = () => {
      if (intro !== it) return;
      it.skipping = true;
      clearTimeout(it.timer);
      if (it.phase === "dark") reveal();
      else finish();
    };
    it.timer = setTimeout(reveal, dark);
  }

  // 保存した記録を、ゲームで使える形にそろえる（足りない項目や、こわれた項目を直す）
  function normalized(save) {
    const st = Object.assign(freshState(), save || {});
    if (!Array.isArray(st.met)) st.met = [];
    if (!Array.isArray(st.words)) st.words = [];
    if (!Array.isArray(st.flags)) st.flags = [];
    if (typeof st.name !== "string") st.name = "";
    // 公園の記録がない古い記録は、初期値で補う
    st.parks = Array.isArray(st.parks) ? st.parks.filter((x) => typeof x === "string") : [];
    st.parkManual = Math.max(0, Math.floor(Number(st.parkManual) || 0));
    st.parkMisses = Math.max(0, Math.floor(Number(st.parkMisses) || 0));
    // 前の版の記録（cleared がない）：もらった言葉のうち、今いる端末の仲間をクリアしたとみなす
    //   （合言葉で引きついだ、もう一方の端末の仲間は入れない。端末は場面の mode で決める）
    if (!Array.isArray(save && save.cleared)) {
      st.cleared = SCN[st.scene]
        ? RP.filter((r) => r && SCN[r.scene] && st.words.includes(r.who) && deviceOf(r.scene) === deviceOf(st.scene)).map((r) => r.who)
        : [];
    }
    if (!st.main || typeof st.main !== "object" || !SCN[st.main.scene]) st.main = null;
    else if (!Array.isArray(st.main.flags)) st.main.flags = st.flags.slice();
    if (typeof st.replayUntil !== "string" || !SCN[st.replayUntil] || !st.main) st.replayUntil = null;
    if (!st.replayUntil || !replayRow(st.replayWho)) st.replayWho = null;
    // 数えている回数：0 以上の整数だけを残す
    const counts = {};
    if (st.counts && typeof st.counts === "object") {
      for (const [k, v] of Object.entries(st.counts)) if (Number(v) > 0) counts[k] = Math.floor(Number(v));
    }
    st.counts = counts;
    // 前の版の記録（finished がない）：最終章の終わりの画面（end の complete）にいれば、終えたとみなす
    if (typeof (save && save.finished) !== "boolean") {
      const doneAt = (m) => Boolean(m && m.atEnd && SCN[m.scene] && SCN[m.scene].end && SCN[m.scene].end.complete === true);
      st.finished = doneAt(st) || doneAt(st.main);
    }
    // クリア後の記録（「はじめから」でも消さない）を合わせる
    if (hasBonus()) {
      st.finished = true;
      st.cleared = unionList(st.cleared, strList(bonusRec.cleared).filter((w) => CHARS[w]));
      st.counts = maxCounts(st.counts, bonusRec.counts);
    }
    return st;
  }

  function loadState(save) {
    state = normalized(save);
    updateParty();
  }

  // 章の終わりの画面で止めていたときは、その画面から再開する
  // 場面に resume（data.js）を書いたときは、その場面から再開する（2-7 のiPhone側：入力欄ではなく、暗い窓から）
  // 「なかまの場面へ」で遊び直している途中なら、いちばん先まで進んだ所から再開する
  function resume(save) {
    loadState(save);
    state.replayUntil = null;
    state.replayWho = null;
    if (state.main) {
      Object.assign(state, state.main);
      state.main = null;
    }
    const sc = SCN[state.scene];
    if (state.atEnd && sc && sc.end) showEnd(sc);
    else runScene(sc && sc.resume && SCN[sc.resume] ? sc.resume : state.scene);
  }

  // KEYWORDS は「場面の名前: [合言葉, …]」。# で始まる合言葉は暗号として比べる
  function findKeyword(text) {
    if (!norm(text)) return null;
    for (const [id, words] of Object.entries(KEYS)) {
      if (isAnswer(text, words)) return id;
    }
    return null;
  }

  // 合言葉の場面から始める（なかまノートの記録は引きつぐ）
  function startFrom(id) {
    loadState(storage.load());
    runScene(id, true);
  }

  function showKeyword() {
    gen += 1;
    closeOverlay();
    const field = el("input", {
      type: "text", class: "text-input", placeholder: T("keywordPlaceholder"),
      autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
      enterkeyhint: "done", "aria-label": T("keywordTitle"),
    });
    const msg = el("p", { class: "kw-msg", "aria-live": "polite" });
    const form = el("form", {
      class: "kw-form",
      onsubmit: (e) => {
        e.preventDefault();
        const id = findKeyword(field.value);
        if (id) {
          inputSound("correct");
          msg.textContent = T("keywordOk");
          field.blur();
          const token = gen;
          setTimeout(() => { if (token === gen) startFrom(id); }, 800);
        } else {
          if (field.value.trim()) inputSound("wrong");
          msg.textContent = field.value.trim() ? T("keywordWrong") : T("keywordEmpty");
          field.classList.remove("shake");
          void field.offsetWidth;
          field.classList.add("shake");
        }
      },
    }, field, el("button", { class: "btn primary", type: "submit", text: T("keywordSubmit") }));
    keywordScreen.replaceChildren(el("div", { class: "kw-wrap" },
      el("div", { class: "kw-icon", text: "🔑", "aria-hidden": "true" }),
      el("h2", { text: T("keywordTitle") }),
      el("p", { class: "kw-note", text: T("keywordNote") }),
      form,
      msg,
      el("button", { class: "btn ghost", type: "button", text: T("back"), onclick: showTitle })));
    show("keyword");
    if (!TOUCH) field.focus({ preventScroll: true });
  }

  // URL に ?key=合言葉 があれば、その場面から始める（QRコード用）
  function handleUrlKey() {
    const key = query.get("key") || hashQuery.get("key");
    if (!key) return false;
    const id = findKeyword(key);
    if (!id) return false;
    // アドレスから合言葉を消しておく（ページを開き直したときに、同じ場面へもどらないように）
    try {
      history.replaceState(null, "", location.pathname + (DEBUG ? "?debug" : ""));
    } catch (e) { /* 消せなくても遊べる */ }
    const save = storage.load();
    // 遊び直し（なかまの場面へ）の途中なら、いちばん先まで進んだ所とくらべる
    const at = save && save.main && save.main.scene ? save.main.scene : save && save.scene;
    if (at && SCN[at] && at !== id) {
      showTitle();
      openOverlay(el("div", { class: "panel" },
        el("div", { class: "kw-icon", text: "🔑", "aria-hidden": "true" }),
        el("p", { class: "panel-text", text: T("keywordReceived", { key }) }),
        el("div", { class: "panel-buttons column" },
          el("button", { class: "btn primary", type: "button", text: T("keywordResume"), onclick: () => resume(save) }),
          el("button", { class: "btn", type: "button", text: T("keywordStart"), onclick: () => startFrom(id) }))));
      return true;
    }
    startFrom(id);
    return true;
  }

  // ==============================================================
  // 10. data.js の点検（書きまちがいを見つける）
  // ==============================================================
  // ゲームが使う画面の文字（data.js の UI）。消してしまうと、文字の代わりに名前が出る
  const UI_KEYS = [
    "resume", "newGame", "keywordButton", "confirmNew", "cancel",
    "keywordTitle", "keywordNote", "keywordPlaceholder", "keywordSubmit", "keywordOk", "keywordWrong",
    "keywordEmpty", "keywordReceived", "keywordResume", "keywordStart", "back",
    "inputPrompt", "inputPlaceholder", "namePlaceholder", "submit", "send", "hint", "chatHint", "chatHintSay", "inputBack",
    "skip", "wrong", "next", "draft", "chatTitle", "searchButton", "searchWait", "searchManual", "searchCancel",
    "wordGet", "wordFrom", "wordGetChat", "wordNote", "ok", "metToast",
    "partyTitle", "partyNote", "partyNoteMet", "partyNoteAll", "close",
    "menuTitle", "menuParty", "menuMap", "menuHouseMap", "menuToTitle", "menuNote",
    "menuReplay", "titleReplay", "replayTitle", "replayNote", "replayLocked",
    "logButton", "logHelp", "logTitle", "logNote", "logEmpty", "logPicked",
    "replayBack", "titleBonus", "bonusTitle", "bonusNote", "bonusReplay", "bonusHard", "bonusGallery", "battlePower", "battlePowered",
    "galleryTitle", "galleryNote", "galleryLoading", "galleryEmpty", "galleryCount", "galleryPrev", "galleryNext", "galleryList",
    "mapTitle", "mapCaption", "explore", "roomDone", "darkDefault", "darkShine",
    "houseMapTitle", "houseMapCaption", "houseStarTemp",
    "iceHelp", "iceCount", "iceReset", "iceSkip", "iceBest", "iceClear",
    "walkHelp", "walkHelpTouch", "walkGoal", "walkLook", "walkNothing", "walkThing", "walkTeam", "walkTeamNone",
    "battleAsk", "battleUse", "battleBoost", "battleHelp", "battleHelpNone", "battleCheer", "battleCheerEnd",
    "battleHeal", "battleHealFull", "battleGuard", "battleBlocked", "battleCharge", "battleCharged", "battleChargeOn",
    "battleWeak", "battleFoeDamage", "battleFoeHeal", "battleFoeHearts", "battleWin",
    "battleDamage", "battleLose", "battleRetry", "battleTurn", "battleHearts", "battleCheerOn", "battleSkip",
    "battleChoose", "battleChooseNote", "battleChooseOk", "battleChooseLeft", "battleBack", "battleDodge",
    "endNext", "endMap", "endHouseMap", "toTitle", "noScene",
    "soundOn", "soundOff",
  ];
  // 戦いの文で使える { }（{name} などのほかに）
  const BATTLE_VARS = ["who", "move", "enemy", "target", "n"];
  // 家の地図の演出（{ house: … }）で使える項目
  const HOUSE_KEYS = ["show", "home", "marks", "fog", "star", "light", "tokens", "appear"];
  // 演出の行（文のない行）で使える項目
  const EFFECT_ITEM_KEYS = ["house", "puzzle", "sound", "ambient", "bgm", "wait", "if", "unless"];

  // 場面の会話に書かれた音（sound）の名前の一覧（文の行と演出の行。選択肢の返事・入力欄の返事・ヒントも）
  function sceneSounds(sc) {
    const inp = sc.input || {};
    const lists = [sc.lines, sc.afterWord, inp.correct, inp.wrong, ...toArray(inp.hint), inp.skip && inp.skip.reply,
      ...toArray(sc.choices).map((c) => c && c.reply)];
    const names = [];
    for (const list of lists) {
      for (const ln of toArray(list)) if (ln && typeof ln === "object" && ln.sound && !names.includes(ln.sound)) names.push(ln.sound);
    }
    return names;
  }

  function validate() {
    const errors = [];
    const warnings = [];
    const ids = new Set(Object.keys(SCN));
    const check = (target, where) => {
      if (target && !ids.has(target)) errors.push(`${where}：「${target}」という場面がありません。`);
    };
    // { } の置きかえ先があるか（{name} 以外は SETTINGS の local か hidden に書く）
    //   allow：そのほかに使える { }（戦いの文の {who} など）
    const checkText = (t, where, allow) => {
      String(t == null ? "" : t).replace(/\{(\w+)\}/g, (whole, key) => {
        if (key !== "name" && !LOCAL[key] && !(S.hidden && S.hidden[key]) && !toArray(allow).includes(key)) {
          errors.push(`${where}：「{${key}}」に入る文字が、SETTINGS の local にも hidden にもありません。`);
        }
        return whole;
      });
    };
    // 家の地図の演出（場面の house と、lines の { house: … }）
    const roomIds = new Set(houseRooms().map((r) => r.id));
    const checkHouseFx = (fx, where) => {
      if (!HS) {
        errors.push(`${where}：家の地図を使いますが、house.js を読み込めませんでした。`);
        return;
      }
      if (!fx || typeof fx !== "object") {
        errors.push(`${where}：house は { show: […] } のように書いてください。`);
        return;
      }
      for (const key of Object.keys(fx)) if (!HOUSE_KEYS.includes(key)) warnings.push(`${where}：house の「${key}」は使えません（${HOUSE_KEYS.join("・")}）。`);
      for (const key of ["show", "home"]) {
        if (fx[key] === "all") continue;
        for (const id of toArray(fx[key])) if (!roomIds.has(id)) errors.push(`${where}：house の ${key} の「${id}」という部屋が、house.js にありません（at のある部屋）。`);
      }
      for (const id of toArray(fx.tokens)) if (!CHARS[id]) errors.push(`${where}：house の tokens の「${id}」というキャラクターがいません。`);
      if (fx.appear != null && ![true, false, "one"].includes(fx.appear)) warnings.push(`${where}：house の appear は true・false・"one" のどれかにしてください。`);
    };
    // 音の名前（sound.js の音）。loop が true なら、くり返す音（場面の ambient）
    const soundOk = Boolean(window.SOUND);
    const checkSound = (name, where, loop) => {
      if (!soundOk || name == null || name === "") return;   // sound.js がないときは、下でまとめて1回だけ知らせる
      if (!SND.has(name)) errors.push(`${where}：「${name}」という音が、sound.js にありません（使える音：${SND.names().join("・")}）。`);
      else if (loop && !SND.isLoop(name)) errors.push(`${where}：「${name}」は1回だけ鳴らす音です。ambient には、くり返す音（${SND.names().filter(SND.isLoop).join("・")}）を書いてください。`);
      else if (!loop && SND.isLoop(name)) errors.push(`${where}：「${name}」はくり返す音です。場面の ambient か、{ ambient: "${name}" } に書いてください。`);
    };
    // 曲の名前（SETTINGS の bgm）
    const bgmNames = Object.keys(S.bgm || {});
    const checkBgm = (name, where) => {
      if (name == null || name === "") return;
      if (!bgmNames.includes(name)) errors.push(`${where}：「${name}」という曲が、SETTINGS の bgm にありません（使える曲：${bgmNames.join("・") || "なし"}）。`);
    };
    const checkLines = (lines, where, allow) => {
      toArray(lines).forEach((ln, i) => {
        const at = `${where} の${i + 1}行目`;
        if (isEffect(ln)) {
          if (ln.house !== undefined) checkHouseFx(ln.house, at);
          if (ln.puzzle !== undefined) {
            if (ln.puzzle !== "answer") errors.push(`${at}：puzzle には "answer"（答えの列を光らせる）だけを書けます。`);
            else if (!PZ || !PZ.answer) errors.push(`${at}：答えの列を光らせるには、PUZZLE に answer（答えの列の字）が必要です。`);
          }
          checkSound(ln.sound, at, false);
          if (ln.ambient) checkSound(ln.ambient, `${at} の ambient`, true);
          checkBgm(ln.bgm, `${at} の bgm`);
          if (ln.wait != null && !(Number(ln.wait) >= 0)) errors.push(`${at}：wait は、0 以上の数（ミリ秒）にしてください。`);
          for (const key of Object.keys(ln)) if (!EFFECT_ITEM_KEYS.includes(key)) warnings.push(`${at}：演出の行の「${key}」は使えません（${EFFECT_ITEM_KEYS.join("・")}）。`);
          return;
        }
        if (ln && typeof ln === "object" && !ln.who && ln.text == null) {
          errors.push(`${where} の${i + 1}行目に text（文章）がありません。`);
          return;
        }
        if (ln && typeof ln === "object") {
          checkSound(ln.sound, at, false);
          if (ln.wait != null) warnings.push(`${at}：wait は、文のない演出の行にだけ書けます（この行では使われません）。`);
          for (const g of toArray(ln.glow)) if (!CHARS[g]) errors.push(`${at} の glow：「${g}」というキャラクターがいません。`);
          if (ln.dim !== undefined && typeof ln.dim !== "boolean") errors.push(`${at} の dim は、true か false にしてください。`);
          // 行の絵（4-3 の回想のイラスト）：pc-images の中の場所（例："kaisou/グレイシア.png"）
          if (ln.image !== undefined && (typeof ln.image !== "string" || !ln.image.trim() || /^[\\/]|\.\./.test(ln.image.trim()))) {
            errors.push(`${at} の image は、"kaisou/グレイシア.png" のように、pc-images の中の画像の場所を書いてください。`);
          }
        }
        checkText(ln && typeof ln === "object" ? ln.text : ln, where, allow);
        const p = parseLine(ln);
        if (p.suspect) warnings.push(`${where} の${i + 1}行目：「${p.suspect}」という話し手がいないため、地の文として表示します。`);
      });
    };
    const checkAnswers = (answers, where) => {
      for (const a of toArray(answers)) {
        const s = String(a).trim();
        if (s.startsWith("#") && !/^#[0-9a-f]{8}$/i.test(s)) errors.push(`${where} の暗号「${s}」の形がおかしいようです（# と英数字8文字）。`);
      }
    };
    if (!ids.has(S.start)) errors.push(`SETTINGS の start：「${S.start}」という場面がありません。`);
    for (const [key, value] of Object.entries(S.hidden || {})) {
      if (!unhide(value)) errors.push(`SETTINGS の hidden の ${key}：「表示用に隠す」で作った文字（~ で始まる）を書いてください。`);
    }
    for (const key of Object.keys(LOCAL)) {
      const d = LOCAL[key] && LOCAL[key].default;
      if (d && String(d).startsWith("~") && !unhide(d)) errors.push(`SETTINGS の local の ${key}：default の「表示用に隠す」文字が読めません（🛠 →「表示用に隠す」で作り直してください）。`);
    }
    if (S.presentOnMap === true && HS && !presentAt()) {
      warnings.push("SETTINGS の presentOnMap が true ですが、このPCで、プレゼントの場所が決まっていません（🛠 →「遊ぶ前の準備」）。今は、リビングのまんなかに【仮】の星を出します。");
    }
    for (const [id, sc] of Object.entries(SCN)) {
      const at = `場面「${id}」`;
      if (!sc || typeof sc !== "object") {
        errors.push(`${at} の書き方がおかしいようです。`);
        continue;
      }
      check(sc.next, `${at} の next`);
      checkLines(sc.lines, at);
      if (sc.choices && !Array.isArray(sc.choices)) errors.push(`${at} の choices は [ ] で囲んでください。`);
      toArray(sc.choices).forEach((c, i) => {
        if (!c || !c.text) {
          errors.push(`${at} の選択肢${i + 1}に text（ボタンの文字）がありません。`);
          return;
        }
        if (!c.next && !c.reply) errors.push(`${at} の選択肢「${c.text}」に next も reply もありません。`);
        check(c.next, `${at} の選択肢「${c.text}」`);
        checkText(c.text, `${at} の選択肢`);
        checkLines(c.reply, `${at} の選択肢「${c.text}」の reply`);
      });
      if (sc.input) {
        const inp = sc.input;
        if (!inp.name && !toArray(inp.answers).length) errors.push(`${at} の input に answers（正解）がありません。`);
        if (!inp.next) errors.push(`${at} の input に next（正解したときの行き先）がありません。`);
        check(inp.next, `${at} の input`);
        checkAnswers(inp.answers, `${at} の input`);
        checkLines(inp.wrong, `${at} の input の wrong`);
        checkLines(inp.correct, `${at} の input の correct`);
        toArray(inp.hint).forEach((h) => checkLines(h, `${at} の input の hint`));
        if (inp.hintAfter != null && !(Number(inp.hintAfter) >= 0)) errors.push(`${at} の input の hintAfter は、0 以上の数にしてください。`);
        check(inp.back, `${at} の input の back`);
        checkText(inp.backText, `${at} の input の backText`);
        if (inp.backText != null && !inp.back) warnings.push(`${at} の input の backText：back（もどる場面）がないので、もどるボタンは出ません。`);
        if (inp.skip) {
          if (!inp.skip.next) errors.push(`${at} の skip に next（行き先）がありません。`);
          check(inp.skip.next, `${at} の skip`);
          checkLines(inp.skip.reply, `${at} の skip の reply`);
        }
        // 名前の確認（1-1。pc-images/name.js の一覧と照らす）
        if (inp.check != null) {
          const ck = inp.check;
          if (!ck || typeof ck !== "object") errors.push(`${at} の input の check は、{ wrong: "…", after: 3, ask: "…", yes: "うん", no: "ちがう" } の形で書いてください（forest_name を参照）。`);
          else {
            if (!inp.name) warnings.push(`${at} の input の check：名前の入力（name: true）でないので、使われません。`);
            if (sc.mode === "chat") warnings.push(`${at} の input の check：名前の確認はPCの場面だけです（メッセージ形式〔chat〕では確認しません）。`);
            checkLines(ck.wrong, `${at} の input の check の wrong`);
            checkLines(ck.ask, `${at} の input の check の ask`, ["guess"]);
            if (ck.after != null && !(Math.floor(Number(ck.after)) >= 1)) errors.push(`${at} の input の check の after は、1 以上の数にしてください。`);
            for (const key of ["yes", "no"]) if (ck[key] != null && typeof ck[key] !== "string") errors.push(`${at} の input の check の ${key} は、ボタンの文字（"うん" など）にしてください。`);
            if (!ck.ask) warnings.push(`${at} の input の check に ask がないので、続けてまちがえても「もしかして」とは聞きません。`);
          }
        }
      }
      if (sc.quiz) checkQuiz(sc, at, errors, warnings, checkLines, checkText);
      // 行の絵（image）と、暗転の長さ（imageFade）
      if (sc.imageFade !== undefined && !(Number(sc.imageFade) >= 0)) errors.push(`${at} の imageFade は、0 以上の数（ミリ秒）にしてください。`);
      if (sc.mode === "chat" && toArray(sc.lines).some((ln) => ln && typeof ln === "object" && ln.image !== undefined)) {
        warnings.push(`${at}：メッセージ形式（chat）では、行の絵（image）は出ません。`);
      }
      // はじめの演出（intro。1-1 の森）
      if (sc.intro !== undefined) {
        const it = sc.intro;
        if (!it || typeof it !== "object") errors.push(`${at} の intro は、{ dark: 2000, appear: 2000 } の形で書いてください。`);
        else {
          for (const key of ["dark", "appear"]) if (it[key] != null && !(Number(it[key]) >= 0)) errors.push(`${at} の intro の ${key} は、0 以上の数（ミリ秒）にしてください。`);
          for (const key of Object.keys(it)) if (!["dark", "appear"].includes(key)) warnings.push(`${at} の intro の「${key}」は使えません（dark・appear）。`);
        }
        if (id !== S.start) warnings.push(`${at} の intro：はじめの演出は、「はじめから」で始まる場面（SETTINGS の start：${S.start}）でだけ行います。`);
        if (sc.mode === "chat") warnings.push(`${at} の intro：メッセージ形式（chat）の場面では、はじめの演出は行いません。`);
      }
      if (sc.ice) {
        const raw = parseIce(sc.ice);
        const wm = sc.walk ? lookMap(sc.walk, "nature") : null;
        if (raw.starts !== 1) errors.push(`${at} の ice：S（スタート）を、ちょうど1つ書いてください。`);
        if (raw.goals !== 1) errors.push(`${at} の ice：G（ゴール）を、ちょうど1つ書いてください。`);
        if (wm && (raw.w !== wm.w || raw.h !== wm.h)) {
          errors.push(`${at} の ice：氷の床の大きさ（横${raw.w}×縦${raw.h}）が、地図「${sc.walk}」（横${wm.w}×縦${wm.h}）と合いません。`);
        } else if (raw.starts === 1 && raw.goals === 1) {
          // 最短の回数を自動で数えて、best に書いた回数と比べる
          const best = iceBest(iceOf(sc));
          if (best < 0) errors.push(`${at} の ice：この氷の床は、ゴールにたどりつけません。`);
          else if (sc.ice.best != null && best !== Number(sc.ice.best)) {
            warnings.push(`${at} の ice：最短は${best}回です（best には${sc.ice.best}回と書かれています）。`);
          }
        }
        if (!sc.next) errors.push(`${at} の ice には、next（クリアしたあとの行き先）が必要です。`);
        if (sc.ice.skip) check(sc.ice.skip.next, `${at} の ice の skip`);
        checkSound(sc.ice.recordSound, `${at} の ice の recordSound`, false);
        checkLines(sc.ice.clear, `${at} の ice の clear`);
        if (sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では、氷の床のパズルを表示できません。`);
      }
      // 暗い窓（knock。2-7 のiPhone側）と、「つづきから」で代わりに始める場面（resume）
      if (sc.knock != null) {
        checkText(sc.knock, `${at} の knock`);
        if (sc.mode !== "chat") warnings.push(`${at}：knock（暗い窓）は、メッセージ形式（chat）の場面でだけ使えます。`);
        if (!sc.next) errors.push(`${at} の knock には、next（タップしたあとの行き先）が必要です。`);
        if (sc.choices || sc.input || sc.end) errors.push(`${at}：knock（暗い窓）の場面では、choices・input・end は使えません（タップすると next へ進みます）。`);
      }
      check(sc.resume, `${at} の resume`);
      // 公園で気配を探す（search。GPSヒント機能）と、公園の記録を空にする（parkReset）
      if (sc.search != null) checkSearch(sc, at, errors, warnings, checkText);
      if (sc.parkReset !== undefined && typeof sc.parkReset !== "boolean") errors.push(`${at} の parkReset は、true か false にしてください。`);
      if (sc.walk) checkWalk(id, sc, at, errors, warnings, check, checkLines, checkText);
      if (sc.house) {
        checkHouseFx(sc.house, `${at} の house`);
        if (sc.battle || sc.walk || sc.ice || sc.room || sc.puzzle) errors.push(`${at}：house（家の地図）は、battle・walk・ice・room・puzzle と一緒には使えません。`);
      }
      if (sc.mode === "chat" && sc.house) warnings.push(`${at}：メッセージ形式（chat）では、家の地図を表示できません。`);
      if (sc.mode === "chat" && toArray(sc.lines).some(isEffect)) warnings.push(`${at}：メッセージ形式（chat）では、演出の行（{ house: … }・{ sound: … } など）は使われません。`);
      // 音とエフェクト（設計書 第13節）：ambient（くり返す音）・mute（鳴らさない）・snow（雪）
      if (sc.ambient) checkSound(sc.ambient, `${at} の ambient`, true);
      if (sc.ambient && (sc.mode === "chat" || sc.mute)) warnings.push(`${at}：${sc.mute ? "mute の場面" : "メッセージ形式（chat）の場面"}では、ambient（くり返す音）は鳴りません。`);
      checkBgm(sc.bgm, `${at} の bgm`);
      if (sc.bgm && (sc.mode === "chat" || sc.mute)) warnings.push(`${at}：${sc.mute ? "mute の場面" : "メッセージ形式（chat）の場面"}では、bgm（曲）は鳴りません（曲はPCの場面だけ）。`);
      if (sc.snow && sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では、雪（snow）を表示できません。`);
      for (const name of sceneSounds(sc)) {
        if (sc.mute) warnings.push(`${at}：mute の場面なので、音「${name}」は鳴りません。`);
        else if (sc.mode === "chat" && soundOk && SND.has(name) && !SND.isShort(name)) warnings.push(`${at}：メッセージ形式（chat）の場面では短い通知音だけが鳴るので、音「${name}」は鳴りません。`);
      }
      if (!sc.puzzle && [...toArray(sc.lines), ...toArray(sc.input && sc.input.correct)].some((ln) => isEffect(ln) && ln.puzzle !== undefined)) {
        warnings.push(`${at}：最後の謎の枠（puzzle: true）がない場面なので、答えの列を光らせる演出は表示されません。`);
      }
      if (sc.battle) {
        if (!BT[sc.battle]) errors.push(`${at} の battle：「${sc.battle}」という戦いが、BATTLES にありません。`);
        if (!sc.next) errors.push(`${at} の battle には、next（勝ったあとの行き先）が必要です。`);
        if (sc.choices || sc.input || sc.end || sc.walk || sc.ice || sc.room || sc.puzzle) {
          errors.push(`${at}：戦いの場面では、choices・input・end・walk・ice・room・puzzle は使えません。`);
        }
        if (sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では、戦いを表示できません。`);
      }
      for (const g of toArray(sc.give)) {
        if (!CHARS[g]) errors.push(`${at} の give：「${g}」というキャラクターがいません。`);
        else if (!CHARS[g].word) errors.push(`${at} の give：「${CHARS[g].name}」に word（言葉）が書かれていません。`);
      }
      if (sc.afterWord != null) {
        checkLines(sc.afterWord, `${at} の afterWord`);
        if (typeof sc.give !== "string") warnings.push(`${at} の afterWord：give に1匹の名前を書いた場面でないと、表示されません。`);
      }
      if (sc.end) {
        check(sc.end.next, `${at} の end`);
        checkText(sc.end.title, `${at} の end`);
        checkText(sc.end.text, `${at} の end`);
        // スタッフの名前（credits。4-6）：文の行と同じ書き方（{ if: "pcDirect", text: … } で、PCで直接開いたときだけ）
        //   「作：パパ」のような行は、話し手のセリフではなく、そのままの文として出す
        if (sc.end.credits !== undefined && !Array.isArray(sc.end.credits)) errors.push(`${at} の end の credits は [ ] で囲んでください。`);
        toArray(sc.end.credits).forEach((ln, i) => {
          const where = `${at} の end の credits の${i + 1}行目`;
          if (ln && typeof ln === "object" && ln.text == null) errors.push(`${where} に text（文章）がありません。`);
          else checkText(ln && typeof ln === "object" ? ln.text : ln, where);
        });
        if (sc.end.snow !== undefined && typeof sc.end.snow !== "boolean") errors.push(`${at} の end の snow は、true か false にしてください。`);
        if (sc.end.complete !== undefined && typeof sc.end.complete !== "boolean") errors.push(`${at} の end の complete は、true か false にしてください。`);
      }
      // 文のあとの演出（finale。4-6 エピローグ）：雪をふらせてから、最後のイラストに切りかえる
      if (sc.finale !== undefined) {
        const f = sc.finale;
        if (!f || typeof f !== "object") errors.push(`${at} の finale は、{ snow: 3000, image: "ending.png", fade: 1000 } の形で書いてください。`);
        else {
          for (const key of ["snow", "fade"]) if (f[key] != null && !(Number(f[key]) >= 0)) errors.push(`${at} の finale の ${key} は、0 以上の数（ミリ秒）にしてください。`);
          if (f.image !== undefined && (typeof f.image !== "string" || !f.image.trim() || /^[\\/]|\.\./.test(f.image.trim()))) {
            errors.push(`${at} の finale の image は、"ending.png" のように、pc-images の中の画像の場所を書いてください。`);
          }
          for (const key of Object.keys(f)) if (!["snow", "image", "fade"].includes(key)) warnings.push(`${at} の finale の「${key}」は使えません（snow・image・fade）。`);
        }
        if (!sc.end) warnings.push(`${at} の finale：end（終わりの画面）がない場面なので、使われません。`);
        if (sc.mode === "chat") warnings.push(`${at} の finale：メッセージ形式（chat）の場面では、使われません。`);
      }
      if (walking(sc)) {
        if (sc.next || sc.choices || sc.input || sc.end) {
          errors.push(`${at}：歩けるマップの場面では、next・choices・input・end は使えません（events の next で次の場面へ進みます）。`);
        }
      } else if (!sc.next && !sc.choices && !sc.input && !sc.end) {
        errors.push(`${at} に next・choices・input・end のどれもありません（行き止まりになります）。`);
      }
      if (sc.room && !RM) errors.push(`${at} は地図を使いますが、room.js を読み込めませんでした。`);
      if (sc.room && ![true, "dark", "look"].includes(sc.room)) errors.push(`${at} の room は、true・"dark"・"look" のどれかにしてください。`);
      if (sc.room && sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では地図を表示できません。`);
      if (sc.puzzle && !PZ) errors.push(`${at} は最後の謎の枠を使いますが、PUZZLE が見つかりません。`);
      if (sc.puzzle && sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では、最後の謎の枠を表示できません。`);
      for (const m of toArray(sc.meet)) if (!CHARS[m]) errors.push(`${at} の meet：「${m}」というキャラクターがいません。`);
      for (const m of toArray(sc.show)) if (!CHARS[m]) errors.push(`${at} の show：「${m}」というキャラクターがいません。`);
      // 仲間を光らせる演出（glow。最終章のイーブイの答え）
      const glowLines = toArray(sc.lines).filter((ln) => ln && typeof ln === "object" && !isEffect(ln) && ln.glow !== undefined);
      if (sc.glow !== undefined && typeof sc.glow !== "boolean") errors.push(`${at} の glow は、true か false にしてください。`);
      // dim は、glow の行（場面の glow: true か、行の glow）でだけ使う。glow のない行は、もともと話し手のほかを暗くする
      for (const ln of toArray(sc.lines)) {
        if (ln && typeof ln === "object" && !isEffect(ln) && ln.dim && !sc.glow && ln.glow === undefined) warnings.push(`${at}：dim は、glow の行にだけ書けます（glow のない行は、もともと話し手のほかを暗くします）。`);
      }
      if (sc.glow || glowLines.length) {
        if (sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では、仲間を光らせる演出（glow）は使われません。`);
        else if (sc.house || sc.battle || sc.ice || sc.walk || sc.room || sc.puzzle) warnings.push(`${at}：キャラクターを出さない場面（地図・戦い・枠など）なので、仲間を光らせる演出（glow）は使われません。`);
        else if (sc.show) {
          for (const ln of glowLines) {
            for (const g of toArray(ln.glow)) if (CHARS[g] && !toArray(sc.show).includes(g)) warnings.push(`${at} の glow：「${CHARS[g].name}」は show にいないので、光りません。`);
          }
        }
      }
    }
    for (const [id, words] of Object.entries(KEYS)) {
      check(id, `合言葉の「${id}」`);
      if (!toArray(words).length) errors.push(`合言葉の「${id}」に、合言葉が書かれていません。`);
      checkAnswers(words, `合言葉の「${id}」`);
    }
    // クリアしたなかまへ戻るメニュー（REPLAY）
    const replayWho = new Set();
    toArray(RP).forEach((r, i) => {
      const at = `REPLAY の${i + 1}番目`;
      if (!r || typeof r !== "object") {
        errors.push(`${at}：{ who: "glaceon", scene: "glaceon" } のように書いてください。`);
        return;
      }
      if (!CHARS[r.who]) errors.push(`${at}：「${r.who}」というキャラクターがいません。`);
      else if (!CHARS[r.who].word) warnings.push(`${at}：「${CHARS[r.who].name}」には言葉（word）がないので、クリアになりません。`);
      else if (!Object.values(SCN).some((sc) => sc && sc.give === r.who)) warnings.push(`${at}：「${CHARS[r.who].name}」の言葉を受けとる場面（give: "${r.who}"）がないので、クリアになりません。`);
      if (replayWho.has(r.who)) warnings.push(`${at}：「${r.who}」が2回書かれています。`);
      replayWho.add(r.who);
      if (!r.scene) errors.push(`${at}：始める場面（scene）が書かれていません。`);
      else check(r.scene, at);
      checkText(r.label, `${at} の label`);
      if (r.until !== undefined) {
        check(r.until, `${at} の until`);
        if (r.scene && r.until === r.scene) errors.push(`${at}：until（終える場面）が、始める場面と同じです。`);
        else if (SCN[r.until] && SCN[r.scene] && deviceOf(r.until) !== deviceOf(r.scene)) warnings.push(`${at}：until の場面「${r.until}」は、始める場面とちがう端末の場面です。`);
      }
      // 最終章を終えたあとの遊び直しだけで使う項目（set・detour・name）
      if (r.set !== undefined && !toArray(r.set).every((f) => typeof f === "string" && f)) errors.push(`${at}：set は、条件の名前（"indoor" など）で書いてください。`);
      if (r.detour !== undefined) {
        if (!r.detour || typeof r.detour !== "object" || Array.isArray(r.detour)) errors.push(`${at}：detour は、{ "進む場面": "代わりに進む場面" } のように書いてください。`);
        else for (const [from, to] of Object.entries(r.detour)) {
          check(from, `${at} の detour`);
          check(to, `${at} の detour`);
        }
      }
      if (r.skipNow !== undefined && typeof r.skipNow !== "boolean") errors.push(`${at}：skipNow は、true か false にしてください。`);
      if ((r.set !== undefined || r.detour !== undefined || r.name !== undefined || r.skipNow !== undefined) && r.until === undefined) warnings.push(`${at}：set・detour・name・skipNow は、until を書いた仲間だけで使います（最終章を終えたあとの遊び直し）。`);
      if (r.name !== undefined && typeof r.name !== "boolean") errors.push(`${at}：name は、true か false にしてください。`);
    });
    // クリア後のおたのしみ（BONUS）：強いモードの始める場面
    for (const [id, sc] of Object.entries(SCN)) {
      if (sc && sc.bonus !== undefined && typeof sc.bonus !== "boolean") errors.push(`場面「${id}」の bonus は、true か false にしてください。`);
    }
    if (BN.hard !== undefined) {
      const h = BN.hard;
      if (!h || typeof h !== "object" || !h.scene) errors.push("BONUS の hard は、{ scene: \"hard_start\" } のように、始める場面を書いてください。");
      else {
        check(h.scene, "BONUS の hard の scene");
        if (SCN[h.scene] && !SCN[h.scene].bonus) warnings.push(`BONUS の hard の scene：場面「${h.scene}」に bonus: true がないので、遊ぶと「つづきから」の場所が変わるかもしれません。`);
      }
    }
    // クリア後のおたのしみ（BONUS）：最終章を終えた記録を残す場面と、回想ギャラリーの絵
    if (!Object.values(SCN).some((sc) => sc && sc.end && sc.end.complete === true)) {
      warnings.push("end に complete: true を書いた場面がないので、最終章を終えた記録が残らず、タイトル画面に「おたのしみ」が出ません。");
    }
    if (BN.gallery !== undefined && !Array.isArray(BN.gallery)) errors.push("BONUS の gallery は [ ] で囲んでください。");
    toArray(BN.gallery).forEach((g, i) => {
      const at = `BONUS の gallery の${i + 1}番目`;
      if (!g || typeof g !== "object" || typeof g.image !== "string" || !g.image.trim() || /^[\\/]|\.\./.test(g.image.trim())) {
        errors.push(`${at}：{ image: "kaisou/グレイシア.png", label: "グレイシア" } のように、pc-images の中の画像の場所を書いてください。`);
        return;
      }
      checkText(g.label, `${at} の label`);
    });
    if (PZ) {
      const rows = toArray(PZ.rows).map((r) => Array.from(String(r)));
      const cols = Math.max(0, ...rows.map((r) => r.length));
      const answer = Number(PZ.answerColumn) || 0;
      if (answer < 1 || answer > cols) errors.push("PUZZLE の answerColumn（答えの列）が、枠の外です。");
      else {
        rows.forEach((r, i) => {
          if (!r[answer - 1] || r[answer - 1] === "・") warnings.push(`PUZZLE の${i + 1}行目は、答えの列にマスがありません。`);
        });
        // answer（正解したあとに、答えの列に上から入れる字）が、マスの数と、はじめから書いてある字に合うか
        if (PZ.answer != null) {
          const cells = rows.map((r) => r[answer - 1]).filter((ch) => ch && ch !== "・");
          const letters = Array.from(String(PZ.answer));
          if (letters.length !== cells.length) warnings.push(`PUZZLE の answer（${PZ.answer}）の字の数が、答えの列のマスの数（${cells.length}）と合いません。`);
          cells.forEach((ch, k) => {
            if (ch !== "□" && letters[k] && letters[k] !== ch) warnings.push(`PUZZLE の answer の${k + 1}字目「${letters[k]}」が、枠に書いてある「${ch}」と合いません。`);
          });
        }
      }
    }
    // 入力欄（全体）の正解音・不正解音
    for (const kind of ["correct", "wrong"]) if (S.inputSound && S.inputSound[kind]) checkSound(S.inputSound[kind], `SETTINGS の inputSound の ${kind}`, false);
    // 文字送りの短い音・氷の床の音
    checkSound(S.textSound, "SETTINGS の textSound", false);
    for (const kind of ["slide", "bump"]) if (S.iceSound && S.iceSound[kind]) checkSound(S.iceSound[kind], `SETTINGS の iceSound の ${kind}`, false);
    // 曲（BGM）のファイルと音量
    for (const [name, t] of Object.entries(S.bgm || {})) {
      const at = `SETTINGS の bgm の「${name}」`;
      if (!t || typeof t !== "object" || !t.file) errors.push(`${at}：file（曲のファイルの場所。例："bgm/bgm-dream.mp3"）を書いてください。`);
      else if (t.volume == null || !(Number(t.volume) >= 0 && Number(t.volume) <= 1)) errors.push(`${at}：volume（音量）は、0 から 1 までの数にしてください。`);
    }
    if (!soundOk) warnings.push("sound.js を読み込めませんでした。音は鳴りません（index.html に sound.js の行があるか確かめてください）。");
    for (const key of UI_KEYS) if (TX[key] == null) errors.push(`UI（画面の文字）の「${key}」が見つかりません。`);
    checkBattles(errors, warnings, check, checkLines, checkSound);
    if (RM) {
      const cols = RM.cols || 10;
      const rows = RM.rows || 8;
      for (const it of RM.items || []) {
        if (it.x < 0 || it.y < 0 || it.x + it.w > cols || it.y + it.h > rows) {
          warnings.push(`room.js の「${it.name}」が部屋の外にはみ出しています。`);
        }
      }
    }
    checkHouse(errors, warnings);
    if (Object.values(SCN).some((sc) => sc && sc.search != null)) checkGps(errors, warnings);
    return { errors, warnings };
  }

  // 公園で気配を探す場面（search）の点検
  const SEARCH_TEXTS = ["none", "unclear", "already", "denied", "failed", "poor", "unsupported"];
  const SEARCH_FOUND = ["first", "more", "reached"];
  function checkSearch(sc, at, errors, warnings, checkText) {
    const t = sc.search;
    if (!t || typeof t !== "object") {
      errors.push(`${at} の search は、{ found: { … }, none: "…", … } の形で書いてください（leafeon_search を参照）。`);
      return;
    }
    if (sc.mode !== "chat") warnings.push(`${at}：search（公園で気配を探す）は、メッセージ形式（chat）の場面でだけ使えます。`);
    if (!sc.next) errors.push(`${at} の search には、next（必要な数の公園で見つけたあとの行き先）が必要です。`);
    if (sc.choices || sc.input || sc.end || sc.knock) errors.push(`${at}：search の場面では、choices・input・end・knock は使えません（見つけ終わると next へ進みます）。`);
    const found = t.found && typeof t.found === "object" ? t.found : {};
    for (const key of SEARCH_FOUND) {
      if (!found[key]) errors.push(`${at} の search の found に、${key} の文がありません。`);
      else checkText(found[key], `${at} の search の found の ${key}`);
    }
    for (const key of SEARCH_TEXTS) {
      const v = t[key];
      const text = v && typeof v === "object" ? v.text : v;
      if (!text) errors.push(`${at} の search に、${key} の文がありません。`);
      else checkText(text, `${at} の search の ${key}`);
      if (v && typeof v === "object" && v.note != null) checkText(v.note, `${at} の search の ${key} の note`);
    }
    for (const key of Object.keys(t)) if (key !== "found" && !SEARCH_TEXTS.includes(key)) warnings.push(`${at} の search の「${key}」は使われません（found・${SEARCH_TEXTS.join("・")}）。`);
  }

  // 公園で気配を探す設定（SETTINGS の gps）の点検。公園の座標は SETTINGS の hidden
  function checkGps(errors, warnings) {
    if (!GEO) {
      errors.push("公園で気配を探す場面がありますが、geo.js を読み込めませんでした（index.html に geo.js の行があるか確かめてください）。");
      return;
    }
    if (!S.gps || typeof S.gps !== "object") {
      errors.push("SETTINGS に gps（公園で気配を探す設定）がありません。");
      return;
    }
    const g = S.gps;
    const num = (key, min, int) => {
      const v = g[key];
      if (typeof v !== "number" || !(v >= min) || (int && !Number.isInteger(v))) {
        errors.push(`SETTINGS の gps の ${key} は、${min} 以上の${int ? "整数" : "数"}にしてください。`);
      }
    };
    num("radius", 1); num("accuracy", 1); num("poorAccuracy", 1);
    num("streak", 1, true); num("need", 1, true); num("manualAfter", 1, true);
    num("timeout", 1000); num("firstWait", 1000); num("pokeAfter", 500); num("cancelAfter", 1000);
    num("minGap", 0); num("staleAfter", 0); num("maximumAge", 0);
    if (typeof g.highAccuracy !== "boolean") errors.push("SETTINGS の gps の highAccuracy は、true か false にしてください。");
    const from = GEO.parksFrom(g.parks, S.hidden);
    const read = GEO.readParks(from.list);
    for (const t of from.problems.concat(read.problems)) errors.push(`SETTINGS の gps の parks：${t}`);
    if (!read.parks.length) errors.push("SETTINGS の gps の parks に、公園がありません。");
    else if (read.parks.length < g.need) errors.push(`SETTINGS の gps：必要な公園の数（need：${g.need}）が、公園の数（${read.parks.length}）より多いです。`);
    // 判定の範囲が重なる公園（いちばん近い公園だけを数えるので、重なると、どちらか一方しか見つからないことがある）
    const pts = read.parks.flatMap((p) => p.points.map((pt) => ({ id: p.id, label: p.label, pt })));
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        if (pts[a].id === pts[b].id) continue;
        const d = GEO.distance(pts[a].pt.lat, pts[a].pt.lon, pts[b].pt.lat, pts[b].pt.lon);
        if (d < 2 * g.radius) warnings.push(`SETTINGS の gps の parks：${pts[a].label}と${pts[b].label}の点が ${Math.round(d)} m しか離れておらず、判定の範囲（半径 ${g.radius} m）が重なります。`);
      }
    }
  }

  // おまけクイズ（場面の quiz）の点検
  //   正解の番号・選択肢の数・「表示用に隠す」文字が読めるか・正解数のセリフが、どの正解数にも1つずつあるか
  function checkQuiz(sc, at, errors, warnings, checkLines, checkText) {
    const qz = sc.quiz;
    const where = `${at} の quiz`;
    if (!qz || typeof qz !== "object" || !toArray(qz.questions).length) {
      errors.push(`${where}：questions（問題）を [ ] で書いてください。`);
      return;
    }
    if (!sc.next) errors.push(`${where}：クイズのあとに進む next が必要です。`);
    if (hasChoices(sc) || sc.input || sc.end || sc.battle || sc.walk || sc.ice || sc.room || sc.knock != null) {
      errors.push(`${where}：クイズの場面では、choices・input・end・battle・walk・ice・room・knock は使えません。`);
    }
    if (qz.who && !CHARS[qz.who]) errors.push(`${where} の who：「${qz.who}」というキャラクターがいません。`);
    if (!toArray(qz.correct).length) warnings.push(`${where}：correct（正解のセリフ）がありません。`);
    // "~" の文字が読めるか（読めれば、元の文で { } と話し手を点検する）
    const plain = (t, w) => {
      const s = String(t == null ? "" : t);
      if (s.startsWith("~") && !unhide(s)) {
        errors.push(`${w}：「表示用に隠す」文字が読めません（🛠 →「表示用に隠す」で作り直してください）。`);
        return "";
      }
      return unhide(s);
    };
    const lines = (list, w, allow) => {
      const ok = toArray(list).map((ln) => {
        const obj = ln && typeof ln === "object" ? ln : { text: ln };
        return { ...obj, text: plain(obj.text, w) };
      });
      checkLines(ok, w, allow);
    };
    lines(qz.correct, `${where} の correct`);
    lines(qz.wrong, `${where} の wrong`);
    lines(qz.score, `${where} の score`, ["n", "total"]);
    toArray(qz.questions).forEach((q, i) => {
      const w = `${where} の${i + 1}問目`;
      if (!q || typeof q !== "object") {
        errors.push(`${w} の書き方がおかしいようです。`);
        return;
      }
      if (!toArray(q.ask).length) errors.push(`${w}：ask（問題）がありません。`);
      const choices = toArray(q.choices);
      if (choices.length < 2) errors.push(`${w}：choices（選択肢）を2つ以上書いてください。`);
      const n = Number(q.answer);
      if (!Number.isInteger(n) || n < 1 || n > choices.length) errors.push(`${w}：answer（正解は何番目か）は、1 から ${choices.length} までの数にしてください。`);
      if (!toArray(q.explain).length) errors.push(`${w}：explain（解説）がありません。`);
      lines(q.before, `${w} の before`);
      lines(q.ask, `${w} の ask`);
      lines(q.explain, `${w} の explain`);
      lines(q.plus, `${w} の plus`);
      lines(q.after, `${w} の after`);
      choices.forEach((c, k) => {
        const obj = c && typeof c === "object" ? c : { text: c };
        const text = plain(obj.text, `${w} の選択肢${k + 1}`);
        if (!text) errors.push(`${w} の選択肢${k + 1}に、文字がありません。`);
        checkText(text, `${w} の選択肢${k + 1}`);
        lines(obj.reply, `${w} の選択肢${k + 1}の reply`);
        if (obj.reply != null && k + 1 === n) warnings.push(`${w} の選択肢${k + 1}：正解の選択肢の reply は使われません（正解のときは correct と補足）。`);
      });
    });
    // 正解数のセリフ：条件（if・unless）の組み合わせごとに、出る問題の数を数えて、0問〜全問に1つずつあるか
    const names = [...new Set(toArray(qz.questions).flatMap((q) => [...toArray(q && q.if), ...toArray(q && q.unless)]))];
    const totals = new Set();
    for (let mask = 0; mask < 1 << names.length; mask += 1) {
      const on = (name) => Boolean(mask & (1 << names.indexOf(name)));
      totals.add(quizQuestions(qz, on).length);
    }
    toArray(qz.results).forEach((r, k) => lines(r && r.text, `${where} の results の${k + 1}つ目`));
    for (const total of totals) {
      for (let n = 0; n <= total; n += 1) {
        const hits = toArray(qz.results).filter((r) => {
          const range = r && r.count && r.count[total];
          return Array.isArray(range) && n >= Number(range[0]) && n <= Number(range[1]);
        });
        if (!hits.length) errors.push(`${where} の results：${total}問中${n}問正解のときのセリフがありません。`);
        else if (hits.length > 1) warnings.push(`${where} の results：${total}問中${n}問正解のときのセリフが、${hits.length}つあります（上のものを使います）。`);
      }
    }
  }

  // house.js の地図の点検（家具や出入口が、部屋からはみ出していないか・会った仲間の印の場所）
  function checkHouse(errors, warnings) {
    if (!HS) return;
    for (const [id, mk] of Object.entries(HS.marks || {})) {
      const at = `house.js の marks の「${id}」`;
      if (!CHARS[id]) errors.push(`${at}：「${id}」というキャラクターがいません。`);
      const m = mk && HS.maps && HS.maps[mk.map];
      if (!m || !Array.isArray(m.at)) errors.push(`${at}：map の「${mk && mk.map}」という部屋が、家全体の地図にありません（at のある部屋）。`);
      else if (!mk.shine && !(mk.x >= 0 && mk.y >= 0 && mk.x <= m.w && mk.y <= m.h)) warnings.push(`${at}：場所が、部屋の外です。`);
    }
    for (const [id, m] of Object.entries((HS && HS.maps) || {})) {
      const at = `house.js の「${id}」`;
      if (!m || !(m.w > 0) || !(m.h > 0)) {
        errors.push(`${at} に w・h（部屋の大きさ）がありません。`);
        continue;
      }
      if (m.view != null && !(Number(m.view) >= 3 && Number(m.view) <= m.h + 1)) {
        warnings.push(`${at} の view（歩くときに一度に見せる縦のマス数）は、3 から ${m.h + 1} までの数にしてください。`);
      }
      toArray(m.items).forEach((it, i) => {
        const name = (it && ((it.nature && it.nature.name) || (it.home && it.home.name))) || `${i + 1}番目の家具`;
        if (!it || it.x < 0 || it.y < 0 || it.x + (it.w || 1) > m.w || it.y + (it.h || 1) > m.h) {
          warnings.push(`${at} の「${name}」が、部屋の外にはみ出しています。`);
        }
      });
      const seen = new Set();
      toArray(m.edges).forEach((e, i) => {
        if (!e || !["top", "bottom", "left", "right"].includes(e.side)) {
          errors.push(`${at} の edges の${i + 1}番目：side は top・bottom・left・right のどれかにしてください。`);
          return;
        }
        const len = e.side === "top" || e.side === "bottom" ? m.w : m.h;
        if (toArray(e.cells).some((c) => !(c >= 0 && c < len))) warnings.push(`${at} の edges の${i + 1}番目：cells に、かべの長さをこえる数があります。`);
        if (e.id) {
          if (seen.has(e.id)) errors.push(`${at}：出入口の名前「${e.id}」が2つあります。`);
          seen.add(e.id);
        }
      });
    }
  }

  // 戦いの仲間の条件（party の if・unless）。仲間がいる・いないで結果が変わるので、両方を調べる
  function battleConds(def) {
    const conds = [];
    for (const p of toArray(def && def.party)) {
      if (!p || typeof p !== "object") continue;
      for (const f of [...toArray(p.if), ...toArray(p.unless)]) if (!conds.includes(f)) conds.push(f);
    }
    return conds;
  }
  const condLabel = (conds) => conds.map((f) => (CHARS[f] ? charName(CHARS[f]) : f)).join("・");

  // 戦いの点検（data.js の BATTLES・MOVES）：書きまちがいと、勝てるかどうか
  const MOVE_KINDS = ["attack", "help", "cheer", "heal", "guard", "charge", "boost"];
  function checkBattles(errors, warnings, check, checkLines, checkSound) {
    const used = new Set(Object.values(SCN).filter((sc) => sc && sc.battle).map((sc) => sc.battle));
    for (const [id, def] of Object.entries(BT)) {
      const at = `BATTLES の「${id}」`;
      if (!def || typeof def !== "object") {
        errors.push(`${at} の書き方がおかしいようです。`);
        continue;
      }
      if (!used.has(id)) warnings.push(`${at} は、どの場面でも使われていません（場面の battle）。`);
      if (!CHARS[def.leader]) errors.push(`${at} の leader：「${def.leader}」というキャラクターがいません。`);
      if (!(Number(def.hearts) >= 1)) errors.push(`${at} の hearts（みんなのハート）は、1 以上にしてください。`);
      toArray(def.party).forEach((p, i) => {
        const m = typeof p === "string" ? { who: p } : p;
        const where = `${at} の party の${i + 1}番目`;
        if (!m || !m.who) {
          errors.push(`${where} に who（仲間）がありません。`);
          return;
        }
        if (!CHARS[m.who]) errors.push(`${where}：「${m.who}」というキャラクターがいません。`);
        for (const c of toArray(m.commands)) if (!MV[c]) errors.push(`${where} の commands：「${c}」という技が、MOVES にありません。`);
        for (const t of toArray(m.tactics)) {
          const mv = typeof t === "string" ? t : t && t.move;
          if (!MV[mv]) errors.push(`${where} の tactics：「${mv}」という技が、MOVES にありません。`);
          for (const key of ["hearts", "foe"]) {
            if (t && typeof t === "object" && t[key] != null && !(Number(t[key]) >= 0)) errors.push(`${where} の tactics の ${key} は、0 以上の数にしてください。`);
          }
        }
        if (!toArray(m.commands).length && !toArray(m.tactics).length) warnings.push(`${where}（${charName(CHARS[m.who])}）には commands も tactics もないので、戦いでは動きません。`);
      });
      const choose = Number(def.choose) || 0;
      const others = battleParty(def).filter((p) => p.who !== def.leader && (p.if != null || p.unless != null));
      if (choose && choose > others.length) errors.push(`${at} の choose（えらぶ人数）が、party の条件（if）のある仲間の数（${others.length}人）より多いです。`);
      const e = def.enemy;
      if (!e || typeof e !== "object") {
        errors.push(`${at} に enemy（相手）がありません。`);
        continue;
      }
      const foes = toArray(e.who);
      if (!foes.length) errors.push(`${at} の enemy に who（相手のキャラクター）がありません。`);
      for (const f of foes) if (!CHARS[f]) errors.push(`${at} の enemy：「${f}」というキャラクターがいません。`);
      if (!(Number(e.hearts) >= 1)) errors.push(`${at} の enemy の hearts（相手のハート）は、1 以上にしてください。`);
      if (!toArray(e.actions).length) warnings.push(`${at} の enemy に actions（相手の行動）がないので、相手は何もしません。`);
      toArray(e.actions).forEach((a, i) => {
        const where = `${at} の enemy の actions の${i + 1}番目`;
        if (!a || typeof a !== "object") {
          errors.push(`${where} の書き方がおかしいようです。`);
          return;
        }
        for (const key of ["text", "blocked", "alert", "after"]) checkLines(a[key], `${where} の ${key}`, BATTLE_VARS);
        checkSound(a.sound, `${where} の sound`, false);
      });
      for (const key of ["hitSay", "break", "dodge"]) checkLines(e[key], `${at} の enemy の ${key}`, BATTLE_VARS);
      // last（決め技でしか減らないハート）があるのに、決め技（finish）を使える仲間がいない
      const finisher = battleParty(def).some((p) => [...toArray(p.commands), ...toArray(p.tactics).map((t) => (typeof t === "string" ? t : t && t.move))]
        .some((c) => MV[c] && MV[c].finish));
      if (Number(e.last) > 0 && !finisher) errors.push(`${at} の enemy の last（${e.last}）：決め技（MOVES の finish: true）を使える仲間がいないので、最後のハートが減りません。`);
      toArray(def.hints).forEach((h, i) => {
        if (!h || !(Number(h.turn) > 0)) errors.push(`${at} の hints の${i + 1}番目：turn（何ターン目に出すか）を書いてください。`);
        else checkLines(h.say, `${at} の hints`, BATTLE_VARS);
      });
      toArray(def.lose).forEach((l) => checkLines(l, `${at} の lose`, BATTLE_VARS));
      if (def.skip) {
        if (!def.skip.next) errors.push(`${at} の skip に next（行き先）がありません。`);
        check(def.skip.next, `${at} の skip`);
        checkLines(def.skip.reply, `${at} の skip の reply`);
      }
      // 負けたら戦いを終えて、ほかの場面へもどる（強いモード。retreat）
      if (def.retreat !== undefined) {
        const rt = def.retreat;
        if (!rt || typeof rt !== "object" || !rt.next) errors.push(`${at} の retreat は、{ next: "hard_start", lines: [ … ] } のように、もどる場面（next）を書いてください。`);
        else {
          check(rt.next, `${at} の retreat`);
          checkLines(rt.lines, `${at} の retreat の lines`, BATTLE_VARS);
          if (def.lose !== undefined || def.skip !== undefined) warnings.push(`${at}：retreat があるときは、lose と skip は使われません（負けたら、すぐに retreat の next へもどります）。`);
          if (rt.hint !== undefined) {
            const h = rt.hint;
            if (!h || typeof h !== "object" || !Array.isArray(h.lines) || !h.lines.length) errors.push(`${at} の retreat の hint は、{ count: "hardLose", lines: [[…], […]] } の形で書いてください。`);
            else {
              if (h.count !== undefined && (typeof h.count !== "string" || !h.count.trim())) errors.push(`${at} の retreat の hint の count は、名前（文字）で書いてください。`);
              h.lines.forEach((l, k) => checkLines(l, `${at} の retreat の hint の${k + 1}回目`, BATTLE_VARS));
            }
          }
        }
      }
      // どう選んでも勝てない戦いになっていないか（仲間をえらぶ戦いは、えらび方を全部）
      //   強いモード（hard: true）は、勝てない仲間の組み合わせがあってもよい。どの組み合わせでも勝てないときだけ知らせる
      const teams = battleTeams(id);
      const wins = teams.map((team) => battleCheck(id, team).win);
      if (def.hard) {
        if (teams.length && !wins.some(Boolean)) errors.push(`${at}：この戦いは、どの仲間の組み合わせでも勝てません。数値や技を見直してください。`);
      } else {
        teams.forEach((team, k) => {
          if (wins[k]) return;
          errors.push(`${at}：この戦いは、どう選んでも勝てません${team.label ? `（${team.label}）` : ""}。数値や技を見直してください。`);
        });
      }
      if (def.hard !== undefined && typeof def.hard !== "boolean") errors.push(`${at} の hard は、true か false にしてください。`);
    }
    for (const [id, mv] of Object.entries(MV)) {
      const at = `MOVES の「${id}」`;
      if (!mv || typeof mv !== "object") {
        errors.push(`${at} の書き方がおかしいようです。`);
        continue;
      }
      if (!mv.name) errors.push(`${at} に name（技の名前）がありません。`);
      if (!MOVE_KINDS.includes(mv.kind)) errors.push(`${at} の kind は、${MOVE_KINDS.join("・")} のどれかにしてください。`);
      checkLines(mv.text, `${at} の text`, BATTLE_VARS);
      checkLines(mv.say, `${at} の say`, BATTLE_VARS);
      checkLines(mv.miss, `${at} の miss`, BATTLE_VARS);
      checkLines(mv.blocked, `${at} の blocked`, BATTLE_VARS);
      checkSound(mv.sound, `${at} の sound`, false);
      // 強いモード（パパ）の技：このターンの最初に動く（first）・主人公を強くする（boost の target）・
      //   ときどき何もしない（fail）・呼び名がないときの技の名前（noCall）
      if (mv.first !== undefined && typeof mv.first !== "boolean") errors.push(`${at} の first は、true か false にしてください。`);
      if (mv.kind === "boost" && !CHARS[mv.target]) errors.push(`${at} の target：「${mv.target}」というキャラクターがいません（boost で強くする仲間。例："hero"）。`);
      if (mv.fail !== undefined) {
        const f = mv.fail;
        if (!f || typeof f !== "object" || !(Number(f.rate) >= 0 && Number(f.rate) <= 1)) errors.push(`${at} の fail は、{ rate: 1 / 3, text: "…" } の形で書いてください（rate は 0 から 1 までの数）。`);
        else checkLines(f.text, `${at} の fail の text`, BATTLE_VARS);
      }
      if (mv.noCall !== undefined) checkLines(mv.noCall, `${at} の noCall`, BATTLE_VARS);
      if (String(mv.name || "").includes("{call}") && mv.noCall === undefined) warnings.push(`${at}：name に {call} があるときは、呼び名がないときの名前（noCall）も書いてください（今は {call} を {name} にして出します）。`);
    }
  }

  // 歩けるマップの場面の点検：地図・人物・出入口と、そこへたどりつけるか
  function checkWalk(id, sc, at, errors, warnings, check, checkLines, checkText) {
    if (!HS) {
      errors.push(`${at} は歩けるマップを使いますが、house.js を読み込めませんでした。`);
      return;
    }
    const m = lookMap(sc.walk, "nature");
    if (!m) {
      errors.push(`${at} の walk：「${sc.walk}」という地図が、house.js にありません。`);
      return;
    }
    if (sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では、歩けるマップを表示できません。`);
    if (!walking(sc)) return;   // 氷の床の場面は、地図を見せるだけ
    const blocked = itemCells(m);
    const inside = (x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h;
    const s = toArray(sc.start);
    const start = { x: Number(s[0]) || 0, y: Number(s[1]) || 0 };
    if (!inside(start.x, start.y) || blocked.has(xy(start.x, start.y))) {
      errors.push(`${at} の start：[${start.x}, ${start.y}] は、歩ける場所ではありません。`);
    }
    // 自分のコマ（player）と、ついてくる仲間（follow）
    if (sc.player != null && !CHARS[sc.player]) errors.push(`${at} の player：「${sc.player}」というキャラクターがいません。`);
    if (sc.follow != null) {
      const f = sc.follow;
      const p = toArray(f && f.at);
      if (!f || !CHARS[f.who]) errors.push(`${at} の follow：who の「${f && f.who}」というキャラクターがいません。`);
      if (p.length && (!inside(Number(p[0]), Number(p[1])) || blocked.has(xy(Number(p[0]), Number(p[1]))))) {
        errors.push(`${at} の follow：at の [${p.join(", ")}] は、歩ける場所ではありません。`);
      } else if (p.length && Math.abs(Number(p[0]) - start.x) + Math.abs(Number(p[1]) - start.y) > 1) {
        warnings.push(`${at} の follow：at の [${p.join(", ")}] が、start のとなりではありません（はじめは自分と同じマスに出ます）。`);
      }
    }
    // 人物のマス（どの人物も、いるものとして調べる）
    const npcCells = new Set();
    const events = toArray(sc.events);
    events.forEach((ev, i) => {
      const where = `${at} の events の${i + 1}番目`;
      if (!ev || typeof ev !== "object") {
        errors.push(`${where} の書き方がおかしいようです。`);
        return;
      }
      for (const n of toArray(ev.npc)) if (!CHARS[n]) errors.push(`${where}：「${n}」というキャラクターがいません。`);
      if (ev.hidden !== undefined && typeof ev.hidden !== "boolean") errors.push(`${where} の hidden は、true か false にしてください。`);
      else if (ev.hidden && !ev.npc) warnings.push(`${where}：hidden（姿を見せない）は、人物（npc）の出来事にだけ使えます。`);
      if (ev.door) {
        if (!m.edges.some((e) => e.id === ev.door)) errors.push(`${where}：地図「${sc.walk}」に、出入口「${ev.door}」がありません（house.js の edges の id）。`);
      } else if (ev.at == null) {
        errors.push(`${where}：at（場所）か door（出入口）を書いてください。`);
      }
      for (const p of eventCells(ev)) {
        if (!inside(p.x, p.y)) errors.push(`${where}：場所 [${p.x}, ${p.y}] が、地図の外です。`);
        else if (blocked.has(xy(p.x, p.y))) { if (!ev.hidden) warnings.push(`${where}：場所 [${p.x}, ${p.y}] に家具があります。`); }
        else if (ev.npc) npcCells.add(xy(p.x, p.y));
      }
      if (!ev.say && !ev.next && !ev.choices) errors.push(`${where}：say（セリフ）か next（次の場面）を書いてください。`);
      check(ev.next, `${where} の next`);
      checkLines(ev.say, `${where} の say`);
      if (ev.choices && !Array.isArray(ev.choices)) errors.push(`${where} の choices は [ ] で囲んでください。`);
      toArray(ev.choices).forEach((c, k) => {
        if (!c || !c.text) {
          errors.push(`${where} の選択肢${k + 1}に text（ボタンの文字）がありません。`);
          return;
        }
        check(c.next, `${where} の選択肢「${c.text}」`);
        checkText(c.text, `${where} の選択肢`);
        checkLines(c.reply, `${where} の選択肢「${c.text}」の reply`);
      });
      if (ev.choices && ev.next) warnings.push(`${where}：choices があるときは、next は使われません（選択肢の next を使います）。`);
      if (ev.need != null) {
        if (!(Number(ev.need) >= 1)) errors.push(`${where} の need（集まった仲間の人数）は、1 以上の数にしてください。`);
        else if (!sc.team) errors.push(`${where} の need は、場面に team（集まった仲間）があるときだけ使えます。`);
        else if (Number(ev.need) > toArray(sc.team).flatMap((t) => toArray(t && t.who)).length) errors.push(`${where} の need（${ev.need}人）が、team の人数より多いです（行き止まりになります）。`);
      }
    });
    if (!events.some((ev) => ev && (ev.next || toArray(ev.choices).some((c) => c && c.next)))) {
      errors.push(`${at}：events に next（次の場面へ進む出来事）がありません（行き止まりになります）。`);
    }
    // たどりつけるマス（スタートから歩いて行ける所）
    const reach = new Set([xy(start.x, start.y)]);
    const queue = [start];
    while (queue.length) {
      const p = queue.shift();
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        const key = xy(nx, ny);
        if (!inside(nx, ny) || reach.has(key) || blocked.has(key) || npcCells.has(key)) continue;
        reach.add(key);
        queue.push({ x: nx, y: ny });
      }
    }
    const nextTo = (x, y) => Object.values(DIRS).some(([dx, dy]) => reach.has(xy(x + dx, y + dy)));
    events.forEach((ev, i) => {
      if (!ev || typeof ev !== "object") return;
      const where = `${at} の events の${i + 1}番目`;
      if (ev.door) {
        const e = m.edges.find((x) => x.id === ev.door);
        if (!e) return;
        const ok = e.cells.some((c) => {
          const cell = { top: [c, 0], bottom: [c, m.h - 1], left: [0, c], right: [m.w - 1, c] }[e.side];
          return cell && reach.has(xy(cell[0], cell[1]));
        });
        if (!ok) warnings.push(`${where}：出入口「${ev.door}」に、たどりつけないかもしれません。`);
      } else {
        const cells = eventCells(ev);
        if (cells.length && !cells.some((p) => nextTo(p.x, p.y))) warnings.push(`${where}：この場所に、たどりつけないかもしれません。`);
      }
    });
  }

  function showProblems(errors) {
    if (!errors.length) return;
    const banner = el("div", { class: "error-banner", role: "alert" },
      el("b", { text: `⚠ data.js に ${errors.length} 件の問題があります` }),
      el("ul", {}, errors.slice(0, 6).map((t) => el("li", { text: t }))),
      errors.length > 6 ? el("div", { text: `ほか ${errors.length - 6} 件（?debug をつけて開くと全部見られます）` }) : null);
    banner.append(el("button", { type: "button", class: "banner-close", text: "×", "aria-label": "とじる", onclick: () => banner.remove() }));
    app.append(banner);
  }

  // ==============================================================
  // 11. テスト用メニュー（URL の最後に ?debug をつけると表示）
  // ==============================================================
  let debugLabel = null;
  function debugNow(id) {
    if (debugLabel) debugLabel.textContent = `場面：${id}`;
  }

  function qrNode(text) {
    try {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const box = el("div", { class: "debug-qr" });
      box.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
      return box;
    } catch (e) {
      return el("div", { text: "（QRコードを作れませんでした）" });
    }
  }

  // 答えを入れると、data.js の answers に書く暗号を表示する
  function secretTool() {
    const field = el("input", { type: "text", class: "debug-input", placeholder: "答えを入力（例：駅名）", autocomplete: "off" });
    const out = el("code", { class: "debug-out", text: "" });
    const update = () => {
      const v = field.value.trim();
      out.textContent = v ? `"${secret(v)}",　← answers に貼りつける` : "";
    };
    field.addEventListener("input", update);
    return el("div", { class: "debug-kw" },
      field, out,
      el("p", { class: "debug-note", text: "漢字とひらがなは別の答えになります。「東京」と「とうきょう」のように、両方の暗号を書いてください。ひらがなとカタカナ、全角と半角のちがいは同じとみなします。" }));
  }

  // 文字を入れると、SETTINGS の hidden に書く「表示用に隠した文字」を表示する
  function hideTool() {
    const field = el("input", { type: "text", class: "debug-input", placeholder: "画面に出したい文字（例：駅名）", autocomplete: "off" });
    const out = el("code", { class: "debug-out", text: "" });
    field.addEventListener("input", () => {
      const v = field.value.trim();
      out.textContent = v ? `"${hide(v)}",　← hidden（または3-1のクイズ）に貼りつける` : "";
    });
    return el("div", { class: "debug-kw" },
      field, out,
      el("p", { class: "debug-note", text: "暗号とちがい、元の文字にもどせます（スキップしたときに駅名を見せるため）。ページをのぞいても、すぐには読めない形です。" }));
  }

  // 遊ぶ前に、このPCで入れておく呼び名（友達の呼び名など。data.js の SETTINGS.local）
  function localTool() {
    const keys = Object.keys(LOCAL);
    if (!keys.length) return el("p", { class: "debug-note", text: "（SETTINGS の local に、入れる呼び名がありません）" });
    return el("div", { class: "debug-kw" },
      keys.map((key) => {
        const field = el("input", {
          type: "text", class: "debug-input", value: localValues[key] || "",
          placeholder: localDefault(key), maxlength: 12, autocomplete: "off",
        });
        field.addEventListener("input", () => {
          localValues[key] = field.value.trim();
          localStore.save(localValues);
        });
        return el("label", { class: "debug-local" }, el("span", { text: (LOCAL[key] && LOCAL[key].label) || key }), field);
      }),
      el("p", { class: "debug-note", text: "空らんのときは、うすい字の呼び名（data.js の SETTINGS の local の default）で表示します。ちがう呼び名にしたいときだけ入れてください。このPCのブラウザだけに記録し、「記録（セーブ）を消す」でも消えません。" }));
  }

  // プレゼントの場所（4-5 で、家全体の地図に星を出す場所）。地図をクリックして決める。このPCのブラウザだけに記録する
  function presentTool() {
    if (!HS) return el("p", { class: "debug-note", text: "（house.js を読み込めませんでした）" });
    const box = el("div", { class: "debug-house" });
    const note = el("p", { class: "debug-note" });
    let hv = null;
    const draw = () => {
      if (hv) hv.stop();
      const p = presentAt();
      hv = renderHouse(box, { show: "all", home: "all", star: Boolean(p) }, { static: true, star: p ? { x: p.x + 0.5, y: p.y + 0.5 } : null });
      note.textContent = p
        ? `★の場所を記録しました（家全体の地図のマス ${p.x}, ${p.y}）。変えるときは、地図をもう一度クリックします。`
        : "まだ決まっていません。プレゼントを隠す場所を、地図でクリックしてください。";
    };
    box.addEventListener("click", (e) => {
      const c = hv && hv.cellAt(e.clientX, e.clientY);
      if (!c) return;
      localValues.presentAt = `${c.x},${c.y}`;
      localStore.save(localValues);
      draw();
    });
    draw();
    return el("div", { class: "debug-kw debug-present" },
      box, note,
      el("button", { type: "button", text: "場所を消す", onclick: () => { delete localValues.presentAt; localStore.save(localValues); draw(); } }),
      el("p", { class: "debug-note", text: "4-5 で星を出すのは、data.js の SETTINGS の presentOnMap が true のときだけです。このPCのブラウザだけに記録します（公開ページには書かれません）。遊ぶPC・遊ぶ開き方（直接開く／公開URL）で決めてください。" }));
  }

  // 氷の床の最短回数（自動で数えた回数と、data.js の best）
  function iceTool() {
    const rows = Object.entries(SCN).filter(([, sc]) => sc && sc.ice).map(([id, sc]) => {
      const raw = parseIce(sc.ice);
      const n = raw.starts === 1 && raw.goals === 1 ? iceBest(iceOf(sc)) : -1;
      const want = sc.ice.best == null ? "" : `（best：${sc.ice.best}回）`;
      return el("li", { class: n >= 0 && (sc.ice.best == null || n === Number(sc.ice.best)) ? "" : "debug-warn", text: `${id}：最短 ${n >= 0 ? n + "回" : "たどりつけない"}${want}` });
    });
    return rows.length ? el("ul", {}, rows) : el("p", { class: "debug-note", text: "（氷の床の場面はありません）" });
  }

  // 戦いの点検（コマンドの選び方を全部ためして、何ターンで勝てるか・負けるかを調べた結果）
  //   仲間をえらぶ戦いは、えらび方ごとに1行。「攻撃だけ」は、全員がいちばん強い攻撃だけを選んだとき
  //   強いモード（hard: true）は、仲間の組み合わせ（4人から3人の4通り）ごとに1行。勝てない組み合わせがあってもよい
  //     （設計書で想定済み。警告の色にせず「想定どおり」と出す。どの組み合わせでも勝てないときは、data.js の点検でエラー）
  //   技の fail（パパの「スマホに夢中」）がある組み合わせは、最短を「起こらないとき」で数え、「毎回起こるとき」も出す
  function battleTool() {
    const rows = [];
    for (const [sid, sc] of Object.entries(SCN)) {
      if (!sc || !sc.battle || !BT[sc.battle]) continue;
      const def = BT[sc.battle];
      for (const team of battleTeams(sc.battle)) {
        const r = battleCheck(sc.battle, team);
        const rate = battleRandom(sc.battle, team);
        const bt = battleOf(sc.battle, team.on, team.pick);
        const luck = Boolean(bt) && bt.members.some((m) => m.commands.some((c) => MV[c] && MV[c].fail));
        const bad = luck ? battleCheck(sc.battle, team, 12, () => 0) : null;
        const how = r.path.map((picks) => picks.filter(Boolean).map(moveName).join("・")).join(" → ");
        const result = (x) => (!x ? "決着がつかない" : x.win ? `${x.turn}ターンで勝つ` : `${x.turn}ターン目に負ける`);
        rows.push(el("li", {
          // 強いモードの勝てない組み合わせは、設計書で想定済み（すべての組み合わせで勝てなくてよい）なので、警告にしない
          class: r.win ? "" : def.hard ? "debug-expected" : "debug-error",
          text: `${sid}（${sc.battle}）${def.hard ? "［強いモード］" : ""}${team.label ? `［${team.label}］` : ""}：`
            + `${r.win ? `最短${r.win}ターンで勝てる${luck ? "（スマホに夢中にならなければ）" : ""}` : def.hard ? "勝てない（想定どおり：強いモードは、勝てない組み合わせがあってよい）" : "勝てない"}`
            + `${bad ? `／スマホに夢中が毎回だと${bad.win ? `最短${bad.win}ターン` : "勝てない"}` : ""}`
            + `／攻撃だけだと${result(r.spam)}`
            + `${r.guard ? `／大技の予告のときだけ防ぎ、あとは攻撃だと${result(r.guard)}` : ""}`
            + `／でたらめに選ぶと、15ターン以内に勝てるのは約${rate}%`,
          title: how,
        }));
      }
    }
    return rows.length
      ? el("div", {},
        el("p", { class: "debug-note", text: "行にマウスを乗せると、最短で勝てる選び方が出ます（ターンごと、仲間の順）。" }),
        el("ul", {}, rows))
      : el("p", { class: "debug-note", text: "（戦いの場面はありません）" });
  }

  // 音の試聴（設計書 第13節）。音が OFF でも、場面の決まり（第3部は鳴らさない など）があっても、ここでは鳴らす
  //   実物のPC・iPhoneで鳴り方を確かめるため。iPhone では、マナーモードを切ってから押す
  function soundTool() {
    if (!window.SOUND) return el("p", { class: "debug-note", text: "（sound.js を読み込めませんでした。index.html に sound.js の行があるか確かめてください）" });
    const info = el("p", { class: "debug-note" });
    const update = () => {
      const st = SND.state();
      info.textContent = `いまの設定：音 ${st.on ? "ON" : "OFF"}／鳴らし方 ${st.mode}（full：全部・short：短い音だけ・off：鳴らさない）`
        + `／再生の準備 ${st.context}${st.supported ? "" : "（この端末では音を使えません）"}／くり返す音 ${st.ambient || "なし"}`
        + `／曲 ${st.bgmPlaying ? SND.bgmLabel(st.bgmPlaying) : "なし"}${st.bgmVolumeOk === false ? "（この端末は曲の音量を変えられないので、曲は鳴らしません）" : ""}`;
    };
    const buttons = SND.names().map((name) => el("button", {
      type: "button", text: `▶ ${SND.label(name)}`, title: name,
      onclick: () => { SND.preview(name); setTimeout(update, 300); },
    }));
    // 曲（BGM）は8秒だけ鳴らして、場面の曲にもどる（効果音と大きさを比べるため）
    const songs = SND.bgmNames().map((name) => el("button", {
      type: "button", text: `▶ 曲：${SND.bgmLabel(name)}（8秒）`, title: name,
      onclick: () => { SND.previewBgm(name, 8); setTimeout(update, 300); },
    }));
    update();
    return el("div", { class: "debug-kw debug-sounds" },
      el("div", { class: "debug-row" }, buttons),
      songs.length ? el("div", { class: "debug-row" }, songs) : null,
      info,
      el("p", { class: "debug-note", text: "どの場面でどの音・曲を鳴らすかは、data.js の場面に書きます（README の「音とエフェクト」）。くり返す音（風）は4秒、曲は8秒で止まります。曲の音量は、data.js の SETTINGS の bgm の volume です。" }));
  }

  // PCだけのフォルダ（pc-images）の点検：名前の一覧（name.js）と、行の絵（image。4-3 の回想のイラスト）が読めるか
  //   名前そのものは表示しない（数だけ）。絵は、見つからない画像の名前を出す
  function pcFilesTool() {
    const box = el("div", { class: "debug-kw" });
    if (!ART_DIR) {
      box.append(el("p", { class: "debug-note", text: "PCで index.html を直接開いたときだけ使います（今の開き方では、pc-images を読みにいきません）。" }));
      return box;
    }
    const nameInfo = el("div", { text: "名前の一覧（name.js）：調べています……" });
    loadNames().then(({ list, status }) => {
      nameInfo.textContent = status === "ok"
        ? `名前の一覧（name.js）：読みこめた（名前 ${list.counts.names}つ・名字 ${list.counts.family}つ）。1-1で名前を確認します。`
          + `パパの呼び名（call）：${nameCall() ? "ある（強いモードの技の名前に使う）" : "ない（技の名前は「名前ーっ！」になる）"}。`
        : status === "empty"
          ? "名前の一覧（name.js）：ファイルはあるが、NAME_LIST の names が読めない（書きまちがいかもしれません。name.sample.js と見くらべてください）。名前は確認せずに進みます。"
          : `名前の一覧（name.js）：${ART_DIR}/name.js が見つからない。名前は確認せずに進みます。`;
    });
    // 行の絵（4-3 の回想のイラスト）と、文のあとの演出の絵（4-6 の最後のイラスト。場面の finale の image）
    const paths = [];
    for (const sc of Object.values(SCN)) {
      for (const ln of toArray(sc && sc.lines)) {
        const p = ln && typeof ln === "object" && typeof ln.image === "string" ? ln.image.trim() : "";
        if (p && !paths.includes(p)) paths.push(p);
      }
      const fp = sc && sc.finale && typeof sc.finale.image === "string" ? sc.finale.image.trim() : "";
      if (fp && !paths.includes(fp)) paths.push(fp);
    }
    // 回想ギャラリー（おたのしみ）の絵
    for (const g of galleryList()) if (!paths.includes(g.image)) paths.push(g.image);
    const picInfo = el("div", { text: paths.length ? "絵（image）：調べています……" : "絵（image）：data.js に書かれていません。" });
    if (paths.length) {
      Promise.all(paths.map(findPicture)).then((srcs) => {
        const missing = paths.filter((p, i) => !srcs[i]);
        picInfo.textContent = `絵（4-3 の回想・4-6 の最後のイラスト）：${paths.length}枚のうち ${paths.length - missing.length}枚が見つかった。`
          + (missing.length ? `見つからない画像（4-3 はその行を光らせる形、4-6 は9匹の並ぶ画面で進む）：${missing.join("・")}` : "");
      });
    }
    box.append(nameInfo, picInfo);
    return box;
  }

  function setupDebug(problems) {
    const base = location.href.split(/[?#]/)[0];
    const online = /^https?:$/.test(location.protocol);
    const select = el("select", { class: "debug-select" },
      Object.keys(SCN).map((id) => el("option", { value: id, text: id + (SCN[id].draft ? "（仮）" : "") })));
    // 暗号の合言葉（# で始まる）は、URLやQRコードにできないので、数だけ表示する
    const keyRows = Object.entries(KEYS).map(([id, words]) => {
      const plain = toArray(words).filter((w) => !String(w).trim().startsWith("#"));
      const hidden = toArray(words).length - plain.length;
      return el("div", { class: "debug-kw" },
        el("div", {}, el("b", { text: plain.join("・") || "（暗号のみ）" }), hidden ? `（ほかに暗号${hidden}つ）` : "", ` → ${id}`),
        plain.map((w) => {
          const url = `${base}?key=${encodeURIComponent(w)}`;
          return [
            el("a", { href: `${url}&debug`, text: `「${w}」でひらく` }),
            online && typeof qrcode === "function" ? qrNode(url) : null,
          ];
        }));
    });
    const panel = el("div", { class: "debug-panel", hidden: true },
      el("h3", { text: "🛠 テスト用メニュー（本番では表示されません）" }),
      el("div", { class: "debug-row" },
        select,
        el("button", { type: "button", text: "この場面へ", onclick: () => { panel.hidden = true; runScene(select.value, true); } })),
      el("div", { class: "debug-row" },
        el("button", { type: "button", text: "なかまと言葉を全部にする", onclick: () => { state.met = PARTY.slice(); state.words = PARTY.slice(); state.cleared = PARTY.slice(); storage.save(state); updateParty(); toast("なかまと言葉を全部そろえました（なかまの場面へは、PCとiPhoneの両方の仲間が出ます）"); } }),
        el("button", { type: "button", text: "記録（セーブ）を消す（おたのしみの記録も）", onclick: () => { storage.clear(); bonusStore.clear(); bonusRec = {}; state = freshState(); updateParty(); toast("記録を消しました（おたのしみの記録も消しました）"); } }),
        // クリア後のおたのしみを試すため（タイトル画面に「おたのしみ」が出る）
        el("button", { type: "button", text: "最終章を終えた記録をつける", onclick: () => { state.finished = true; storage.save(state); toast("最終章を終えた記録をつけました（タイトル画面に「おたのしみ」が出ます）"); } }),
        // 公園で気配を探す（GPSヒント機能）の記録だけを消す（見つけた公園・手動で増やした数・続けて見つからなかった回数）
        el("button", { type: "button", text: "気配の記録を消す", onclick: () => { clearParks(); storage.save(state); toast("気配の記録を消しました"); } })),
      el("h4", { text: "遊ぶ前の準備：友達の呼び名（ちがう呼び名にするときだけ。このPCだけに記録）" }),
      localTool(),
      el("h4", { text: "遊ぶ前の準備：プレゼントの場所（4-5。このPCだけに記録）" }),
      presentTool(),
      el("h4", { text: "遊ぶ前の準備：PCだけのフォルダ（pc-images の名前の一覧と、4-3 の回想・4-6 の最後のイラスト）" }),
      pcFilesTool(),
      el("h4", { text: "答えを暗号にする（駅名など、ページに書きたくない答え用）" }),
      secretTool(),
      el("h4", { text: "表示用に隠す（駅名・公園名を、画面には出したいとき用）" }),
      hideTool(),
      el("h4", { text: "合言葉（iPhoneでQRを読むと、その場面から始まる）" }),
      online ? null : el("p", { class: "debug-note", text: "※ QRコードは、インターネット上に公開したページで開いたときだけ表示されます。" }),
      keyRows,
      el("h4", { text: "氷の床の最短回数（自動で数えた結果）" }),
      iceTool(),
      el("h4", { text: "戦いの点検（コマンドの選び方を全部ためした結果）" }),
      battleTool(),
      el("h4", { text: "音の試聴（効果音は Web Audio の合成音。曲は bgm フォルダの mp3）" }),
      soundTool(),
      el("h4", { text: "data.js の点検結果" }),
      problems.errors.length || problems.warnings.length
        ? el("ul", {},
          problems.errors.map((t) => el("li", { class: "debug-error", text: t })),
          problems.warnings.map((t) => el("li", { class: "debug-warn", text: t })))
        : el("p", { text: "問題は見つかりませんでした。" }),
      el("button", { type: "button", text: "とじる", onclick: () => { panel.hidden = true; } }));
    const fab = el("button", { class: "debug-fab", type: "button", title: "テスト用メニュー", text: "🛠", onclick: () => { panel.hidden = !panel.hidden; } });
    debugLabel = el("div", { class: "debug-scene" });
    app.append(fab, debugLabel, panel);
  }

  // ==============================================================
  // 12. 操作（クリック・キーボード）
  // ==============================================================
  novel.box.addEventListener("click", () => nvAdvance("box"));
  novel.stage.addEventListener("click", (e) => {
    if (e.target.closest("button, input, form, a")) return;
    nvAdvance("stage");
  });
  chat.log.addEventListener("click", () => { if (CV.skip) CV.skip(); });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName ? e.target.tagName : "").toLowerCase();
    // はじめの演出（1-1）のあいだは、Enter・スペースで飛ばす。ほかのキーは使わない
    //   （「はじめから」のボタンが選ばれていても、もう一度押されないようにする）
    if (intro && !["input", "textarea", "select"].includes(tag)) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!e.repeat) intro.skip();
      }
      return;
    }
    if (overlay.classList.contains("open")) {
      if (overlayKey && overlayKey(e)) { e.preventDefault(); return; }
      if (e.key === "Escape") closeOverlay();
      return;
    }
    // 氷の床・歩けるマップ：矢印キー（または W A S D）で動く。歩けるマップでは Enter・スペースで調べる
    // （テスト用メニューなどの入力欄に文字を打っているときは、動かない）
    if (currentView === "novel" && GRID.key && !["input", "textarea", "select"].includes(tag) && GRID.key(e)) {
      e.preventDefault();
      return;
    }
    // バックログ（PC）：↑キーで開く（入力欄に文字を入れているとき〔漢字の変換など〕は、開かない。ボタンでは開ける）
    if (e.key === "ArrowUp" && currentView === "novel" && !["input", "textarea", "select"].includes(tag) && !e.isComposing) {
      e.preventDefault();
      if (!e.repeat) openLog();
      return;
    }
    if (["input", "textarea", "select", "button", "a"].includes(tag)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    if (currentView === "novel") {
      e.preventDefault();
      nvAdvance("key");
    } else if (currentView === "chat" && CV.next && CV.next.btn.isConnected) {
      // 「つづける ▶」（メッセージ画面）：Enter・スペースで押す。押しっぱなしの連続入力では押さない
      e.preventDefault();
      if (!e.repeat) CV.next();
    } else if (currentView === "chat" && CV.skip) {
      e.preventDefault();
      CV.skip();
    }
  });

  // ==============================================================
  // 13. 開始
  // ==============================================================
  const problems = validate();
  updateParty();
  // 名前の確認（1-1）の一覧は、先に読みこみはじめておく（PCで直接開いたときだけ。ないときは確認しない）
  //   強いモード（おたのしみ）のパパの技の名前（{call}）にも使う
  if (ART_DIR && (Object.values(SCN).some((sc) => sc && sc.input && sc.input.check)
    || Object.values(MV).some((mv) => mv && String(mv.name || "").includes("{call}")))) loadNames();
  showProblems(problems.errors);
  if (DEBUG) setupDebug(problems);
  if (!handleUrlKey()) showTitle();

  // --------------------------------------------------------------
  // data.js を読み込めなかったときの表示
  // --------------------------------------------------------------
  function showLoadError() {
    // ファイルを直接開いたときは、ブラウザが詳しい場所を隠す（"Script error."）ので表示しない
    const errs = (window.__loadErrors || [])
      .filter((e) => e && e.message && e.line)
      .map((e) => `${String(e.file || "").split("/").pop()} の ${e.line} 行目：${e.message}`);
    const box = document.createElement("div");
    box.className = "load-error";
    const h = document.createElement("h2");
    h.textContent = "⚠ シナリオを読み込めませんでした";
    const p = document.createElement("p");
    p.textContent = "data.js に、書きまちがいがあるかもしれません。直前に編集した場所で、次の点を確認してください。";
    const ul = document.createElement("ul");
    for (const t of [
      "行の終わりのカンマ「,」の付け忘れ",
      "かっこ「{ }」「[ ]」の閉じ忘れ",
      "文章を囲む「\"」の閉じ忘れ（文章の中で \" を使うときは \\\" と書く）",
      "ファイルの文字コードが UTF-8 になっているか",
    ]) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.append(li);
    }
    const detail = document.createElement(errs.length ? "pre" : "p");
    detail.textContent = errs.length
      ? errs.join("\n") + "\n（表示された行か、その1つ前の行に原因があることが多いです）"
      : "くわしい場所（何行目か）は、ブラウザの開発者ツールの「Console」に表示されます。\nWindows：F12キー ／ Mac：option + command + I";
    box.append(h, p, ul, detail);
    app.replaceChildren(box);
  }
})();
