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

  if (!S || !CHARS || !SCN) {
    showLoadError();
    return;
  }

  const query = new URLSearchParams(location.search);
  const hashQuery = new URLSearchParams(location.hash.replace(/^#/, ""));
  const DEBUG = query.has("debug") || hashQuery.has("debug");
  const TOUCH = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

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
      if (key === "name") return state.name || S.defaultName || "";
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
  function flagOn(name) {
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
    });
  }

  // 話し手の名前（または ID）→ キャラクターID
  const nameToId = {};
  for (const [id, c] of Object.entries(CHARS)) {
    nameToId[id] = id;
    if (c && c.name) nameToId[c.name] = id;
  }

  // 演出の行か：{ house: … }（2-7 の地図が広がる演出など。文は出さない）
  const isEffect = (ln) => Boolean(ln) && typeof ln === "object" && ln.house !== undefined;

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
    },
    clear() {
      try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 何もしない */ }
    },
  };
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

  // name：主人公の名前 / flags：set で記録した条件 / atEnd：章の終わりの画面にいる
  // walk：歩けるマップで最後にいた場所（{ scene, map, x, y, dir }）
  const freshState = () => ({ scene: null, met: [], words: [], flags: [], name: "", chapter: "", bg: "", atEnd: false, walk: null });
  let state = freshState();
  let gen = 0;            // 場面が変わるたびに増える番号（古いタイマーを無効にする）
  let currentView = "";

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
  app.append(titleScreen, keywordScreen, novel.root, chat.root, endScreen, overlay, toastBox);

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
    const layer = el("div", { class: "stage-layer" });
    const draft = el("div", { class: "draft-badge", text: T("draft"), hidden: true });
    const stage = el("div", { class: "stage" }, chars, roomBox, gridBox, puzzleBox, battleBox, houseBox, layer, draft);
    const name = el("div", { class: "nameplate", hidden: true });
    const text = el("div", { class: "text" });
    const mark = el("div", { class: "next-mark", text: "▼", hidden: true, "aria-hidden": "true" });
    const box = el("div", { class: "textbox", tabindex: "0" }, name, text, mark);
    const root = el("section", { class: "screen novel" }, topbar, stage, box);
    return { root, chapter, partyBtn, chars, roomBox, gridBox, puzzleBox, battleBox, houseBox, layer, draft, stage, name, text, mark, box };
  }

  // 文字を1文字ずつ表示する
  function typeInto(node, text, done) {
    const chars = Array.from(text);
    const speed = Number(S.textSpeed) || 0;
    let i = 0;
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
      if (i >= chars.length) finish();
    }, speed);
    return { skip: finish, cancel() { finished = true; clearInterval(timer); } };
  }

  // auto：話し手のいない行を、自動で次へ進めるまでの時間（戦いの文）。onLine：行を出すたびに呼ぶ
  // exploreNext：地図を調べ終えたあと、先へ進む関数 / house：家全体の地図（2-7・4-3・4-5）
  const NV = { lines: [], idx: 0, then: null, hold: true, typer: null, mode: "idle", shown: [], auto: 0, onLine: null, autoTimer: null, exploreNext: null, house: null };

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

  function setSpeaker(who) {
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
      node.classList.toggle("speaking", node.dataset.id === who);
      node.classList.toggle("dim", Boolean(who) && node.dataset.id !== who);
    }
  }

  // 演出の行（data.js の { house: … }）を行う。文は出さない
  function runEffect(fx) {
    if (fx.house !== undefined) showHouse(fx.house, true);
  }

  function nvShow(i) {
    // 演出の行は、すぐに行って次の行へ
    while (i < NV.lines.length && NV.lines[i].effect) {
      runEffect(NV.lines[i].effect);
      i += 1;
    }
    if (i >= NV.lines.length) {
      finishSay();
      return;
    }
    NV.idx = i;
    const ln = NV.lines[i];
    // 文のある行が、もう残っていなければ最後の行（うしろの演出は、ここで行う）
    const last = !NV.lines.slice(i + 1).some((l) => !l.effect);
    if (last) for (const l of NV.lines.slice(i + 1)) runEffect(l.effect);
    const token = gen;
    const lines = NV.lines;
    let doneNow = false;
    clearTimeout(NV.autoTimer);
    setSpeaker(ln.who);
    if (NV.onLine) NV.onLine(i);
    novel.mark.hidden = true;
    if (NV.typer) NV.typer.cancel();
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
    });
    if (!doneNow) NV.typer = handle;
  }

  function finishSay() {
    clearTimeout(NV.autoTimer);
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
    if (NV.mode === "explore" && NV.typer) { NV.typer.skip(); return; }
    // 地図を調べ終えたあとは、会話の枠（または Enter）でも先へ進める（絵のところは、調べまちがいがあるので進まない）
    if (NV.mode === "explore" && NV.exploreNext && from !== "stage") { NV.exploreNext(); return; }
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
      NV.grid = null;
      NV.battle = null;
      NV.exploreNext = null;
      if (NV.house) NV.house.stop();
      NV.house = null;
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
      setSpeaker(null);
    },

    // lines を順に表示し、終わったら then を呼ぶ
    // hold が true なら、最後の行のあとにもう一度クリックを待つ
    // opts.auto：話し手のいない行を、自動で次へ進めるまでの時間 / opts.onLine(i)：i 行目を出すときに呼ぶ
    say(lines, then, hold = true, opts) {
      clearTimeout(NV.autoTimer);
      NV.lines = toArray(lines).filter(visible).map((ln) => (isEffect(ln) ? { effect: ln } : parseLine(ln)));
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
          onclick: (e) => { e.stopPropagation(); setLayer(null); onPick(c); },
        })));
      setLayer(box);
    },

    input(spec, onSubmit, onHint, onSkip) {
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
          onSubmit(value);
        },
        onclick: (e) => e.stopPropagation(),
      },
        el("div", { class: "input-prompt", text: fill(spec.prompt || T("inputPrompt")) }),
        field,
        el("div", { class: "input-buttons" },
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
      openOverlay(el("div", { class: "panel word-panel", style: `--c:${c.color || "#ccc"}` },
        el("div", { class: "word-get", text: T("wordGet") }),
        el("div", { class: "word-from" },
          withArt(el("span", { class: "word-avatar", text: c.emoji || "？", "aria-hidden": "true" }), id),
          T("wordFrom", { who: charName(c) })),
        wordNode(c.word, "big"),
        el("p", { class: "panel-note", text: T("wordNote") }),
        el("button", { class: "btn primary", type: "button", text: T("ok"), onclick: closeOverlay })), then);
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
        const handle = typeInto(novel.text, fill(said), () => {
          doneNow = true;
          NV.typer = null;
        });
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
      const move = (dir) => {
        if (busy || done || token !== gen) return;
        const r = iceSlide(ice, pos.x, pos.y, dir);
        if (!r.steps && !r.goal) { bump(); return; }
        moves += 1;
        busy = true;
        const ms = r.steps * 90;
        view.place(r.x, r.y, ms);
        pos = { x: r.x, y: r.y };
        status();
        setTimeout(() => {
          busy = false;
          if (token !== gen || !r.goal) return;
          finish();
          view.board.classList.add("cleared");
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
      const play = (steps, then) => {
        NovelView.say(steps.map((s) => s.text), then, true, {
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
          el("span", { class: "bt-pick-moves", text: battleMovesOf(def, id).map((m) => fill(MV[m].name || m)).join("・") })));
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
          el("span", { class: "bt-cmd-name", text: fill(MV[id].name || id) }),
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
        const r = battleTurn(b, st, picks);
        play(r.steps, () => {
          if (!alive()) return;
          st = r.state;
          hitSaid = st.hitSaid;
          if (st.won) {
            onWin();
            return;
          }
          if (st.lost) {
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
      id, w: m.w, h: m.h, name: base.name || "", floor: base.floor || "", wall: base.wall || "",
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
      if (!ev || !ev.npc || !eventOn(sc, ev)) continue;
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
    return Object.assign({}, m, extra, { ring: true, npcs: walkNpcs(sc), player: NV.walkPos });
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
    const face = withArt(el("span", { class: "grid-face", text: (CHARS.eevee && CHARS.eevee.emoji) || "●" }), "eevee");
    const player = el("div", { class: "grid-player", "aria-hidden": "true" }, face);
    board.append(npcs, front, player);
    const side = el("div", { class: "grid-side" });
    const wrap = el("div", { class: "grid-wrap" }, board, side);
    container.replaceChildren(wrap);

    const at = (node, x, y) => {
      node.style.setProperty("--x", x + R);
      node.style.setProperty("--y", y + R);
    };
    const place = (x, y, ms, dir) => {
      player.style.setProperty("--t", `${ms || 0}ms`);
      at(player, x, y);
      if (dir) player.dataset.dir = dir;
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
    return { wrap, board, side, player, face, place, setNpcs, setFront };
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
  // 文の一覧を、条件（if・unless）で選んでから置きかえる
  function btLines(lines, vars) {
    return toArray(lines).filter(visible).map((ln) => {
      if (ln && typeof ln === "object") return ln.who ? { who: ln.who, text: btText(ln.text, vars) } : btText(ln.text, vars);
      return btText(ln, vars);
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
  //   on  ：条件の名前が入っているかを調べる関数（点検では、全員が仲間になったものとして調べる）
  //   pick：えらんだ仲間（leader 以外の名前の一覧）。書かなければ、えらべる仲間の上から choose 人
  //   choose を書いた戦いでは、party のうち条件（if）に合う人が「えらべる仲間」。
  //   えらべる仲間が choose 人より少ないとき（テスト用メニューでとんだときなど）は、全員からえらべる
  function battleOf(id, on = flagOn, pick = null) {
    const def = BT[id];
    if (!def || typeof def !== "object") return null;
    const all = battleParty(def);
    const choose = Math.max(0, Math.floor(Number(def.choose) || 0));
    const others = all.filter((p) => p.who !== def.leader);
    let can = others.filter((p) => visibleWith(p, on));
    if (choose && can.length < choose) can = others;
    const chosen = !choose ? can : pick ? can.filter((p) => pick.includes(p.who)) : can.slice(0, choose);
    const members = all.filter((p) => p.who === def.leader || chosen.includes(p)).map((p) => ({
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
  function pickTactic(m, st) {
    for (const t of m.tactics) {
      if (t.hearts != null && !(st.hearts <= Number(t.hearts))) continue;
      if (t.cheer === false && st.cheerLeft > 0) continue;
      if (t.cheer === true && !(st.cheerLeft > 0)) continue;
      if (MV[t.move]) return t.move;
    }
    return null;
  }

  // 攻撃の技の強さ（点検で「いちばん強い攻撃」を選ぶため）
  const attackValue = (b, id) => {
    const mv = MV[id];
    if (!mv || mv.kind !== "attack") return -1;
    return (Number(mv.power) || 0) * Math.max(1, Number(mv.hits) || 1) * (b.weak.includes(mv.type) ? 2 : 1);
  };

  // 1ターン分の出来事を計算する（画面には出さない）
  //   picks：戦う仲間それぞれが選んだ技の名前（members と同じ順番。さくせんで動く仲間の分は null）
  //   quiet：true なら文を作らない（点検で、何度も計算するため）
  //   返り値：{ state：ターンのあとの状態, steps：画面に出す文と、そのときの状態（st）・動き（fx）の一覧 }
  function battleTurn(b, st0, picks, quiet) {
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
          i += 1;
        }
        steps.push(p);
      }
    };

    // 仲間の番（party の上から順）
    let boost = 0;           // てだすけの倍率（次に動く仲間に効く）
    let guardBig = false;    // big の行動（ふぶきなど）を防ぐ
    let guardAll = false;    // 相手の攻撃を、すべて防ぐ
    for (let i = 0; i < b.members.length && !st.won; i++) {
      const m = b.members[i];
      const id = m.commands.length ? toArray(picks)[i] : pickTactic(m, st);
      const mv = id ? MV[id] : null;
      const charge = st.charged[m.who] || 0;
      delete st.charged[m.who];   // ためた力は、次に動いたときに使う（攻撃でなければ消える）
      if (!mv) continue;
      const times = boost || 1;
      boost = 0;
      const power = Math.max(0, Number(mv.power) || 0);
      const parts = [];
      const add = (text, extra) => { if (!quiet && text) parts.push(Object.assign({ text, st: snap(), actor: m.who }, extra)); };
      const v = quiet ? null : vars({ who: whoName(m.who), move: fill(mv.name || id) });
      if (!quiet) {
        add(mv.text ? btText(mv.text, v) : T("battleUse", v), { fx: mv.ribbon ? "ribbon" : "" });
        if (times > 1) add(T("battleBoost", { n: times }));
        for (const ln of btLines(mv.say, v)) add(ln);
      }
      if (mv.kind === "attack") {
        const weak = b.weak.includes(mv.type);
        const dmg = (power + st.cheer) * Math.max(1, Number(mv.hits) || 1) * (weak ? 2 : 1) * times * (charge || 1);
        st.foe = Math.max(0, st.foe - dmg);
        if (!quiet) {
          if (charge > 1) add(T("battleCharged", { n: charge }));
          if (weak) add(T("battleWeak"));
          add(T("battleFoeDamage", vars({ n: dmg })), { fx: st.foe > 0 ? "hit" : "" });
        }
        if (st.foe <= 0) {
          st.won = true;
          if (!quiet) {
            const lines = btLines(e.break, v);
            (lines.length ? lines : [T("battleWin", v)]).forEach((ln, k) => add(ln, { actor: k ? "" : m.who, fx: k ? "" : "break" }));
          }
        } else if (!st.hitSaid) {
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
        const next = b.members.slice(i + 1).find((x) => x.commands.length || x.tactics.length);
        if (next) boost = Math.max(2, power);
        if (!quiet) add(next ? T("battleHelp", { target: whoName(next.who), n: boost }) : T("battleHelpNone"), next ? { target: next.who, fx: "help" } : {});
      } else if (mv.kind === "guard") {
        if (mv.all) guardAll = true;
        else guardBig = true;
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
        if (!quiet && a.text) add(btText(a.text, v));
        const dmg = Math.max(0, Math.floor(Number(a.damage) || 0));
        if (dmg > 0 && (guardAll || (guardBig && a.big))) {
          if (!quiet) add(a.blocked ? btText(a.blocked, v) : T("battleBlocked"), { fx: "guard" });
        } else if (dmg > 0) {
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
  //            spam：全員が「いちばん強い攻撃」だけを選んだときの結果（{ win: true, turn: 3 } など） }
  function battleCheck(id, team, limit = 12) {
    const out = { win: 0, path: [], lose: 0, spam: null };
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
          const r = battleTurn(b, node.st, picks, true);
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
      s = battleTurn(b, s, strong, true).state;
      if (s.won || s.lost) { out.spam = { win: s.won, turn: n }; break; }
    }
    return { ...out, members: b.members.map((m) => m.who) };
  }

  // でたらめにコマンドを選んだとき、limit ターン以内に勝てる割合（%）。テスト用メニューの点検だけで使う
  //   毎回同じ結果になるように、決まった順番の数（疑似乱数）で選ぶ（ゲームの中では乱数を使わない）
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
        s = battleTurn(b, s, picks, true).state;
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
      if (fx === "break") {
        foeBox.classList.add("broken");
        row.classList.add("ribbon");
      }
      if (fx === "lose") team.classList.add("lost");
      if (fx === "ribbon") row.classList.add("ribbon");
    };
    show({ st: battleStart(b) });
    return { root, menu, show };
  }

  // ==============================================================
  // 家全体の地図（2-7・4-3・4-5。house.js の部屋を、at の位置に並べて描く）
  //   見えていない部屋は、白い霧の中。見える部屋が増えると、地図が広がる（見える範囲に合わせて小さくなる）
  //   夢の部屋（息子さんの部屋）は、room.js の家具を使う（room.js の2マスを、1マスにまとめる）
  //   data.js の場面に house: { … } と書くと、この地図を出す。lines の { house: { … } } で地図を変える
  //     show：見せる部屋（"all" で全部）/ home：本当の家具の見た目にする部屋 / marks：会った仲間の印
  //     fog：家の外の霧 / star：プレゼントの星 / light：夢の部屋に光が集まる / tokens・appear：夢の部屋に仲間が現れる
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
    const placeToken = (node, i) => {
      const cx = dream.x + dream.w / 2;
      const cy = dream.y + dream.h / 2;
      const angle = ((i - 0.5) / 8) * Math.PI * 2 - Math.PI / 2;   // 真上をさけて、部屋の名前にかからないようにする
      const x = i === 0 ? cx : cx + Math.cos(angle) * dream.w * 0.36;
      const y = i === 0 ? cy : cy + Math.sin(angle) * dream.h * 0.33;
      node.setAttribute("style", `${at(x, y)};--c:${(CHARS[node.dataset.id] && CHARS[node.dataset.id].color) || "#ccc"}`);
    };
    const addToken = (id, animate) => {
      if (!CHARS[id] || tokens.some((n) => n.dataset.id === id)) return;
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
      for (const key of ["marks", "fog", "star", "light", "appear"]) if (f[key] != null) st[key] = Boolean(f[key]);
      for (const id of toArray(f.tokens)) addToken(id, animate);
      update();
      fit(animate);
      if (!animate) {
        void board.offsetWidth;
        board.classList.remove("no-anim");
      }
    };
    // 話した仲間が、夢の部屋に現れる（appear のとき）
    const appear = (who) => {
      if (st.appear && who !== "hero" && CHARS[who] && !CHARS[who].voice) addToken(who, true);
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
    const draft = el("div", { class: "draft-badge", text: T("draft"), hidden: true });
    const root = el("section", { class: "screen chat" }, head, log, foot, draft);
    return { root, title, partyBtn, log, foot, draft };
  }

  const CV = { lastWho: undefined, chapter: "", skip: null };

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
    scrollChat();
    return node;
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
      }
      chat.title.textContent = fill(sc.chatTitle || S.chatTitle || T("chatTitle"));
      chat.draft.hidden = !sc.draft;
      chat.foot.replaceChildren();
      if (state.chapter && state.chapter !== CV.chapter) {
        CV.chapter = state.chapter;
        addMsg({ who: null, text: state.chapter, kind: "chapter" });
      }
    },

    // 「入力中…」を出してから、メッセージを1つずつ表示する（演出の行は、メッセージ画面では使わない）
    say(lines, then) {
      const items = toArray(lines).filter((ln) => visible(ln) && !isEffect(ln)).map(parseLine);
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
        const ln = items[i];
        i += 1;
        const speaking = Boolean(ln.who) && ln.who !== "hero";
        const typing = speaking ? addTyping(ln.who) : null;
        const len = Array.from(ln.text).length;
        const wait = !S.textSpeed ? 0 : speaking ? Math.min(1700, 500 + len * 28) : 450;
        let timer = null;
        let done = false;
        const finish = () => {
          if (done || token !== gen) return;
          done = true;
          clearTimeout(timer);
          CV.skip = null;
          if (typing) typing.remove();
          addMsg(ln);
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
            addMsg({ who: "hero", text: fill(c.say || c.text) });
            onPick(c);
          },
        }))));
      scrollChat();
    },

    input(spec, onSubmit, onHint, onSkip) {
      const field = inputField(spec, "chat-text", "send");
      const form = el("form", {
        class: "chat-form",
        onsubmit: (e) => {
          e.preventDefault();
          const value = field.value.trim();
          if (!value) return;
          field.blur();
          chat.foot.replaceChildren();
          addMsg({ who: "hero", text: value });
          onSubmit(value);
        },
      }, field, el("button", { type: "submit", class: "send-btn", text: T("send") }));
      const skipText = onSkip ? fill(spec.skip.text || T("skip")) : "";
      // null を渡すと「null」という文字が出てしまうので、使う部品だけを並べる
      chat.foot.replaceChildren(...[
        spec.prompt ? el("div", { class: "foot-prompt", text: fill(spec.prompt) }) : null,
        form,
        onHint || onSkip ? el("div", { class: "foot-links" },
          onHint ? el("button", {
            type: "button", class: "hint-btn", text: T("chatHint"),
            onclick: () => {
              chat.foot.replaceChildren();
              addMsg({ who: "hero", text: T("chatHintSay") });
              onHint();
            },
          }) : null,
          onSkip ? el("button", {
            type: "button", class: "hint-btn", text: "🏳 " + skipText,
            onclick: () => {
              chat.foot.replaceChildren();
              addMsg({ who: "hero", text: skipText });
              onSkip();
            },
          }) : null) : null,
      ].filter(Boolean));
      scrollChat();
      if (!TOUCH) field.focus({ preventScroll: true });
    },

    // 言葉を手に入れたときの、特別なメッセージ
    reveal(id, then) {
      const c = CHARS[id] || {};
      const token = gen;
      CV.lastWho = undefined;
      chat.log.append(el("div", { class: "msg word-msg", style: `--c:${c.color || "#ccc"}` },
        el("div", { class: "word-card" },
          el("div", { class: "word-get", text: T("wordGetChat", { who: charName(c) }) }),
          wordNode(c.word, "big"),
          el("div", { class: "word-note", text: T("wordNote") }))));
      scrollChat();
      setTimeout(() => { if (token === gen) then(); }, S.textSpeed ? 700 : 0);
    },

    proceed(cb) {
      chat.foot.replaceChildren(el("button", {
        type: "button", class: "next-btn", text: T("next"),
        onclick: () => { chat.foot.replaceChildren(); cb(); },
      }));
      scrollChat();
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
  function runScene(id, jump = false) {
    const sc = SCN[id];
    if (!sc) {
      toast(T("noScene", { id }));
      return;
    }
    gen += 1;
    GRID.key = null;
    closeOverlay();
    if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
    clearTimeout(NV.autoTimer);
    CV.skip = null;
    // 歩いている途中の場面にもどったとき（会話のあと・つづきから）は、はじめの会話をくり返さない
    const backToWalk = Boolean(walking(sc) && state.walk && state.walk.scene === id);
    state.scene = id;
    state.atEnd = false;
    state.chapter = sc.chapter || (jump ? inherited(id, "chapter") : state.chapter);
    state.bg = sc.bg || (jump ? inherited(id, "bg") : state.bg);
    applyMeet(sc);
    setFlags(sc);
    storage.save(state);
    if (DEBUG) debugNow(id);
    const view = sc.mode === "chat" ? ChatView : NovelView;
    view.enter(sc);
    // 選択肢・入力がある場面は、最後の行のあとすぐに表示する
    // （地図を調べる・歩く・氷の床の場面は、最後の行を読み終えてから始める）
    const waitsForPlayer = Boolean(hasChoices(sc) || sc.input);
    view.say(backToWalk ? [] : sc.lines, () => afterLines(sc, view), !waitsForPlayer);
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
    next();
  }

  // set: "indoor" → 条件の名前を記録する / unset: "indoor" → 消す（場面にも選択肢にも書ける）
  function setFlags(item) {
    for (const f of toArray(item.set)) if (!state.flags.includes(f)) state.flags.push(f);
    for (const f of toArray(item.unset)) state.flags = state.flags.filter((x) => x !== f);
  }

  // give: "glaceon" → 会話のあとに、その仲間の言葉を手に入れる
  function giveWord(sc, view, then) {
    const id = typeof sc.give === "string" ? sc.give : null;
    if (!id || !CHARS[id] || !CHARS[id].word) {
      then();
      return;
    }
    if (!state.words.includes(id)) state.words.push(id);
    storage.save(state);
    view.reveal(id, then);
  }

  function leave(sc, view) {
    if (hasChoices(sc)) return askChoice(sc, view);
    if (sc.input) return askInput(sc, view);
    if (sc.end) return view === ChatView ? view.proceed(() => showEnd(sc)) : showEnd(sc);
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
    const onHint = hintList.length
      ? () => view.say(toArray(hintList[Math.min(hints, hintList.length - 1)]), () => askInput(sc, view, misses, hints + 1), false)
      : null;
    const skip = spec.skip && spec.skip.next ? spec.skip : null;
    const onSkip = skip && misses >= (skip.after == null ? 2 : skip.after)
      ? () => view.say(toArray(skip.reply), () => runScene(skip.next), true)
      : null;
    view.input(spec, (text) => {
      // name: true → 入力した文字を、主人公の名前として記録する（正解・不正解はない）
      if (spec.name) {
        state.name = Array.from(text).slice(0, 12).join("");
        storage.save(state);
        view.say(toArray(spec.correct), () => runScene(spec.next), true);
      } else if (isAnswer(text, spec.answers)) {
        view.say(toArray(spec.correct), () => runScene(spec.next), true);
      } else {
        view.say(toArray(spec.wrong || T("wrong")), () => askInput(sc, view, misses + 1, hints), false);
      }
    }, onHint, onSkip);
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
    storage.save(state);
    setBg(endScreen, e.bg || state.bg || "night");
    endScreen.replaceChildren(el("div", { class: "end-card" },
      e.icon ? el("div", { class: "end-icon", text: e.icon, "aria-hidden": "true" }) : null,
      el("h2", { class: "end-title", text: fill(e.title || "") }),
      e.text ? el("p", { class: "end-text", text: fill(e.text) }) : null,
      el("div", { class: "end-buttons" },
        e.map ? el("button", { class: "btn", type: "button", text: houseMapOn() ? T("endHouseMap") : T("endMap"), onclick: openMap }) : null,
        e.next ? el("button", { class: "btn primary", type: "button", text: fill(e.nextLabel || T("endNext")), onclick: () => runScene(e.next) }) : null,
        el("button", { class: "btn", type: "button", text: T("toTitle"), onclick: showTitle }))));
    show("end");
  }

  // ==============================================================
  // 8. 重ねて表示する画面（なかまノート・メニュー・地図・確認）
  // ==============================================================
  // onClose：とじたときに1回だけ呼ぶ（場面が変わったあとは呼ばない）
  let onOverlayClose = null;
  function openOverlay(content, onClose) {
    overlay.replaceChildren(content);
    overlay.classList.add("open");
    const token = gen;
    onOverlayClose = onClose ? () => { if (token === gen) onClose(); } : null;
  }
  function closeOverlay() {
    overlay.classList.remove("open");
    overlay.replaceChildren();
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
  function showTitle() {
    gen += 1;
    GRID.key = null;
    if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
    clearTimeout(NV.autoTimer);
    CV.skip = null;
    closeOverlay();
    const save = storage.load();
    const canResume = Boolean(save && save.scene && SCN[save.scene]);
    // 記録があるときは「つづきから」をいちばん上にする（まちがえて最初からにしないように）
    titleScreen.replaceChildren(el("div", { class: "title-wrap" },
      el("div", { class: "title-deco", text: "✦　✧　✦", "aria-hidden": "true" }),
      el("h1", { class: "title-main", text: S.title || "" }),
      S.subtitle ? el("p", { class: "title-sub", text: S.subtitle }) : null,
      el("div", { class: "title-menu" },
        canResume ? el("button", { class: "btn primary", type: "button", text: T("resume"), onclick: () => resume(save) }) : null,
        el("button", { class: canResume ? "btn" : "btn primary", type: "button", text: T("newGame"), onclick: () => newGame(canResume) }),
        el("button", { class: "btn", type: "button", text: T("keywordButton"), onclick: showKeyword })),
      S.footer ? el("p", { class: "title-foot", text: S.footer }) : null));
    show("title");
  }

  function newGame(hasSave) {
    const go = () => {
      state = freshState();
      storage.clear();
      updateParty();
      runScene(S.start);
    };
    if (hasSave) confirmBox(T("confirmNew"), T("newGame"), go);
    else go();
  }

  function loadState(save) {
    state = Object.assign(freshState(), save || {});
    if (!Array.isArray(state.met)) state.met = [];
    if (!Array.isArray(state.words)) state.words = [];
    if (!Array.isArray(state.flags)) state.flags = [];
    if (typeof state.name !== "string") state.name = "";
    updateParty();
  }

  // 章の終わりの画面で止めていたときは、その画面から再開する
  function resume(save) {
    loadState(save);
    const sc = SCN[state.scene];
    if (state.atEnd && sc && sc.end) showEnd(sc);
    else runScene(state.scene);
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
          msg.textContent = T("keywordOk");
          field.blur();
          const token = gen;
          setTimeout(() => { if (token === gen) startFrom(id); }, 800);
        } else {
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
    if (save && save.scene && SCN[save.scene] && save.scene !== id) {
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
    "inputPrompt", "inputPlaceholder", "namePlaceholder", "submit", "send", "hint", "chatHint", "chatHintSay",
    "skip", "wrong", "next", "draft", "chatTitle",
    "wordGet", "wordFrom", "wordGetChat", "wordNote", "ok", "metToast",
    "partyTitle", "partyNote", "partyNoteMet", "partyNoteAll", "close",
    "menuTitle", "menuParty", "menuMap", "menuHouseMap", "menuToTitle", "menuNote",
    "mapTitle", "mapCaption", "explore", "roomDone", "darkDefault", "darkShine",
    "houseMapTitle", "houseMapCaption", "houseStarTemp",
    "iceHelp", "iceCount", "iceReset", "iceSkip", "iceBest", "iceClear",
    "walkHelp", "walkHelpTouch", "walkGoal", "walkLook", "walkNothing", "walkThing", "walkTeam", "walkTeamNone",
    "battleAsk", "battleUse", "battleBoost", "battleHelp", "battleHelpNone", "battleCheer", "battleCheerEnd",
    "battleHeal", "battleHealFull", "battleGuard", "battleBlocked", "battleCharge", "battleCharged", "battleChargeOn",
    "battleWeak", "battleFoeDamage", "battleFoeHeal", "battleFoeHearts", "battleWin",
    "battleDamage", "battleLose", "battleRetry", "battleTurn", "battleHearts", "battleCheerOn", "battleSkip",
    "battleChoose", "battleChooseNote", "battleChooseOk", "battleChooseLeft", "battleBack",
    "endNext", "endMap", "endHouseMap", "toTitle", "noScene",
  ];
  // 戦いの文で使える { }（{name} などのほかに）
  const BATTLE_VARS = ["who", "move", "enemy", "target", "n"];
  // 家の地図の演出（{ house: … }）で使える項目
  const HOUSE_KEYS = ["show", "home", "marks", "fog", "star", "light", "tokens", "appear"];

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
    };
    const checkLines = (lines, where, allow) => {
      toArray(lines).forEach((ln, i) => {
        if (isEffect(ln)) {
          checkHouseFx(ln.house, `${where} の${i + 1}行目`);
          return;
        }
        if (ln && typeof ln === "object" && !ln.who && ln.text == null) {
          errors.push(`${where} の${i + 1}行目に text（文章）がありません。`);
          return;
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
        if (inp.skip) {
          if (!inp.skip.next) errors.push(`${at} の skip に next（行き先）がありません。`);
          check(inp.skip.next, `${at} の skip`);
          checkLines(inp.skip.reply, `${at} の skip の reply`);
        }
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
        checkLines(sc.ice.clear, `${at} の ice の clear`);
        if (sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では、氷の床のパズルを表示できません。`);
      }
      if (sc.walk) checkWalk(id, sc, at, errors, warnings, check, checkLines, checkText);
      if (sc.house) {
        checkHouseFx(sc.house, `${at} の house`);
        if (sc.battle || sc.walk || sc.ice || sc.room || sc.puzzle) errors.push(`${at}：house（家の地図）は、battle・walk・ice・room・puzzle と一緒には使えません。`);
      }
      if (sc.mode === "chat" && (sc.house || toArray(sc.lines).some(isEffect))) warnings.push(`${at}：メッセージ形式（chat）では、家の地図を表示できません。`);
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
      if (sc.end) {
        check(sc.end.next, `${at} の end`);
        checkText(sc.end.title, `${at} の end`);
        checkText(sc.end.text, `${at} の end`);
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
    }
    for (const [id, words] of Object.entries(KEYS)) {
      check(id, `合言葉の「${id}」`);
      if (!toArray(words).length) errors.push(`合言葉の「${id}」に、合言葉が書かれていません。`);
      checkAnswers(words, `合言葉の「${id}」`);
    }
    if (PZ) {
      const rows = toArray(PZ.rows).map((r) => Array.from(String(r)));
      const cols = Math.max(0, ...rows.map((r) => r.length));
      const answer = Number(PZ.answerColumn) || 0;
      if (answer < 1 || answer > cols) errors.push("PUZZLE の answerColumn（答えの列）が、枠の外です。");
      else {
        rows.forEach((r, i) => {
          if (!r[answer - 1] || r[answer - 1] === "・") warnings.push(`PUZZLE の${i + 1}行目は、答えの列にマスがありません。`);
        });
      }
    }
    for (const key of UI_KEYS) if (TX[key] == null) errors.push(`UI（画面の文字）の「${key}」が見つかりません。`);
    checkBattles(errors, warnings, check, checkLines);
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
    return { errors, warnings };
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
  const MOVE_KINDS = ["attack", "help", "cheer", "heal", "guard", "charge"];
  function checkBattles(errors, warnings, check, checkLines) {
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
        }
        if (!toArray(m.commands).length && !toArray(m.tactics).length) warnings.push(`${where}（${charName(CHARS[m.who])}）には commands も tactics もないので、戦いでは動きません。`);
      });
      const choose = Number(def.choose) || 0;
      const others = battleParty(def).filter((p) => p.who !== def.leader);
      if (choose && choose > others.length) errors.push(`${at} の choose（えらぶ人数）が、party の仲間の数（${others.length}人）より多いです。`);
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
      });
      for (const key of ["hitSay", "break"]) checkLines(e[key], `${at} の enemy の ${key}`, BATTLE_VARS);
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
      // どう選んでも勝てない戦いになっていないか（仲間をえらぶ戦いは、えらび方を全部）
      for (const team of battleTeams(id)) {
        if (battleCheck(id, team).win) continue;
        errors.push(`${at}：この戦いは、どう選んでも勝てません${team.label ? `（${team.label}）` : ""}。数値や技を見直してください。`);
      }
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
      if (ev.door) {
        if (!m.edges.some((e) => e.id === ev.door)) errors.push(`${where}：地図「${sc.walk}」に、出入口「${ev.door}」がありません（house.js の edges の id）。`);
      } else if (ev.at == null) {
        errors.push(`${where}：at（場所）か door（出入口）を書いてください。`);
      }
      for (const p of eventCells(ev)) {
        if (!inside(p.x, p.y)) errors.push(`${where}：場所 [${p.x}, ${p.y}] が、地図の外です。`);
        else if (blocked.has(xy(p.x, p.y))) warnings.push(`${where}：場所 [${p.x}, ${p.y}] に家具があります。`);
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
      out.textContent = v ? `"${hide(v)}",　← hidden に貼りつける` : "";
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
  function battleTool() {
    const rows = [];
    for (const [sid, sc] of Object.entries(SCN)) {
      if (!sc || !sc.battle || !BT[sc.battle]) continue;
      for (const team of battleTeams(sc.battle)) {
        const r = battleCheck(sc.battle, team);
        const rate = battleRandom(sc.battle, team);
        const how = r.path.map((picks) => picks.filter(Boolean).map((c) => fill((MV[c] && MV[c].name) || c)).join("・")).join(" → ");
        const spam = !r.spam ? "決着がつかない" : r.spam.win ? `${r.spam.turn}ターンで勝つ` : `${r.spam.turn}ターン目に負ける`;
        rows.push(el("li", {
          class: r.win ? "" : "debug-error",
          text: `${sid}（${sc.battle}）${team.label ? `［${team.label}］` : ""}：`
            + `${r.win ? `最短${r.win}ターンで勝てる` : "勝てない"}`
            + `／攻撃だけだと${spam}／でたらめに選ぶと、15ターン以内に勝てるのは約${rate}%`,
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
        el("button", { type: "button", text: "なかまと言葉を全部にする", onclick: () => { state.met = PARTY.slice(); state.words = PARTY.slice(); storage.save(state); updateParty(); toast("なかまと言葉を全部そろえました"); } }),
        el("button", { type: "button", text: "記録（セーブ）を消す", onclick: () => { storage.clear(); state = freshState(); updateParty(); toast("記録を消しました"); } })),
      el("h4", { text: "遊ぶ前の準備：友達の呼び名（ちがう呼び名にするときだけ。このPCだけに記録）" }),
      localTool(),
      el("h4", { text: "遊ぶ前の準備：プレゼントの場所（4-5。このPCだけに記録）" }),
      presentTool(),
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
    if (overlay.classList.contains("open")) {
      if (e.key === "Escape") closeOverlay();
      return;
    }
    const tag = (e.target && e.target.tagName ? e.target.tagName : "").toLowerCase();
    // 氷の床・歩けるマップ：矢印キー（または W A S D）で動く。歩けるマップでは Enter・スペースで調べる
    // （テスト用メニューなどの入力欄に文字を打っているときは、動かない）
    if (currentView === "novel" && GRID.key && !["input", "textarea", "select"].includes(tag) && GRID.key(e)) {
      e.preventDefault();
      return;
    }
    if (["input", "textarea", "select", "button", "a"].includes(tag)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    if (currentView === "novel") {
      e.preventDefault();
      nvAdvance("key");
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
