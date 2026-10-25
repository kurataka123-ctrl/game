/* ================================================================
   engine.js ― ゲームを動かす仕組み
   ----------------------------------------------------------------
   ふだんは編集しなくて大丈夫です。
     ・会話、選択肢、合言葉、カード、画面の文字を変える → data.js
     ・夢の部屋の地図を変える                         → room.js
     ・第1部で歩く地図（家の部屋の形）を変える → house.js
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
    if (!item || typeof item !== "object") return true;
    if (item.if != null && !toArray(item.if).every(flagOn)) return false;
    if (item.unless != null && toArray(item.unless).some(flagOn)) return false;
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
  function localText(key) {
    const v = String(localValues[key] == null ? "" : localValues[key]).trim();
    return v || String((LOCAL[key] && LOCAL[key].default) || "");
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
    const layer = el("div", { class: "stage-layer" });
    const draft = el("div", { class: "draft-badge", text: T("draft"), hidden: true });
    const stage = el("div", { class: "stage" }, chars, roomBox, gridBox, puzzleBox, layer, draft);
    const name = el("div", { class: "nameplate", hidden: true });
    const text = el("div", { class: "text" });
    const mark = el("div", { class: "next-mark", text: "▼", hidden: true, "aria-hidden": "true" });
    const box = el("div", { class: "textbox", tabindex: "0" }, name, text, mark);
    const root = el("section", { class: "screen novel" }, topbar, stage, box);
    return { root, chapter, partyBtn, chars, roomBox, gridBox, puzzleBox, layer, draft, stage, name, text, mark, box };
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

  const NV = { lines: [], idx: 0, then: null, hold: true, typer: null, mode: "idle", shown: [] };

  // 選択肢・入力欄などを表示する（null で消す）
  // 表示中はキャラクターを上によせて、重ならないようにする
  function setLayer(node) {
    if (node) novel.layer.replaceChildren(node);
    else novel.layer.replaceChildren();
    novel.stage.classList.toggle("has-layer", Boolean(node) && !node.classList.contains("room-done"));
    // 最後の謎の枠が、入力欄に隠れないように、入力欄の高さを伝える
    novel.stage.style.setProperty("--layer-h", node ? `${novel.layer.offsetHeight}px` : "0px");
  }

  function charNode(id, i) {
    const c = CHARS[id];
    return el("div", { class: "char", "data-id": id, style: `--c:${c.color || "#999"};--i:${i}` },
      el("div", { class: "char-face", text: c.emoji || "？" }),
      el("div", { class: "char-name", text: charName(c) }));
  }

  // crowd：4匹以上を小さく並べて、1匹ずつ現れるようにする（最終章）
  function renderChars(ids, crowd) {
    NV.shown = ids.filter((id) => CHARS[id] && id !== "hero" && !CHARS[id].voice).slice(0, crowd ? 12 : 3);
    novel.chars.classList.toggle("crowd", Boolean(crowd));
    novel.chars.replaceChildren(...NV.shown.map(charNode));
  }

  // 地図・氷の床・歩けるマップ・最後の謎の枠を表示しているか（そのときはキャラクターを出さない）
  const stageBusy = () => !novel.roomBox.hidden || !novel.gridBox.hidden || !novel.puzzleBox.hidden;

  function setSpeaker(who) {
    const c = who ? CHARS[who] : null;
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

  function nvShow(i) {
    NV.idx = i;
    const ln = NV.lines[i];
    const last = i === NV.lines.length - 1;
    const token = gen;
    let doneNow = false;
    setSpeaker(ln.who);
    novel.mark.hidden = true;
    if (NV.typer) NV.typer.cancel();
    const handle = typeInto(novel.text, ln.text, () => {
      doneNow = true;
      NV.typer = null;
      if (token !== gen) return;
      if (last && !NV.hold) finishSay();
      else novel.mark.hidden = false;
    });
    if (!doneNow) NV.typer = handle;
  }

  function finishSay() {
    NV.mode = "idle";
    novel.mark.hidden = true;
    const then = NV.then;
    NV.then = null;
    if (then) then();
  }

  // クリック（タップ）で次へ
  function nvAdvance() {
    if (currentView !== "novel") return;
    if (NV.mode === "explore" && NV.typer) { NV.typer.skip(); return; }
    if (NV.mode !== "talk") return;
    if (NV.typer) { NV.typer.skip(); return; }
    if (NV.idx < NV.lines.length - 1) nvShow(NV.idx + 1);
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
      GRID.key = null;
      novel.gridBox.hidden = true;
      novel.gridBox.replaceChildren();
      novel.puzzleBox.hidden = true;
      novel.puzzleBox.replaceChildren();
      const prevCrowd = NV.crowd || "";
      NV.crowd = "";
      novel.chars.classList.remove("crowd", "settled");
      if (sc.ice || sc.walk) {
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
    say(lines, then, hold = true) {
      NV.lines = toArray(lines).filter(visible).map(parseLine);
      NV.then = then;
      NV.hold = hold;
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
          el("span", { class: "word-avatar", text: c.emoji || "？", "aria-hidden": "true" }),
          T("wordFrom", { who: charName(c) })),
        wordNode(c.word, "big"),
        el("p", { class: "panel-note", text: T("wordNote") }),
        el("button", { class: "btn primary", type: "button", text: T("ok"), onclick: closeOverlay })), then);
    },

    // 地図を調べる
    explore(sc, onDone) {
      NV.mode = "explore";
      novel.mark.hidden = true;
      setSpeaker(null);
      const dark = NV.dark;
      novel.text.textContent = fill(sc.exploreText || (RM && RM.exploreText) || T("explore"));
      const needFind = Boolean(RM) && RM.requireFind !== false && (RM.items || []).some((it) => it.shine);
      let found = !needFind;
      const showDone = () => {
        if (novel.layer.querySelector(".room-done")) return;
        setLayer(el("button", {
          class: "btn primary room-done", type: "button", text: sc.roomDone || T("roomDone"),
          onclick: (e) => {
            e.stopPropagation();
            if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
            NV.mode = "idle";
            setLayer(null);
            renderRoom(novel.roomBox, null, dark);
            onDone();
          },
        }));
      };
      renderRoom(novel.roomBox, (item) => {
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

      const events = () => toArray(sc.events).filter((ev) => ev && typeof ev === "object" && visible(ev));
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
        const ids = toArray(sc.team).filter((t) => t && visible(t)).flatMap((t) => toArray(t.who)).filter((id) => CHARS[id]);
        team.replaceChildren(
          el("div", { class: "grid-team-title", text: T("walkTeam") }),
          el("div", { class: "grid-team-list" },
            ids.length
              ? ids.map((id) => el("span", { class: "grid-team-face", style: `--c:${CHARS[id].color || "#ccc"}`, title: charName(CHARS[id]), text: CHARS[id].emoji || "？" }))
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
      // 出来事：セリフ（say）を出してから、条件を記録（set）し、次の場面（next）へ
      const act = (ev) => {
        save();
        NV.mode = "talk";
        view.setFront(null);
        NovelView.say(toArray(ev.say), () => {
          if (token !== gen) return;
          setFlags(ev);
          storage.save(state);
          if (ev.next) runScene(ev.next);
          else resume();
        }, true);
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

  // いま出ている人物（同じマスに何人も書いたときは、条件に合う最初の1人）
  function walkNpcs(sc) {
    const out = [];
    const used = new Set();
    for (const ev of toArray(sc.events)) {
      if (!ev || !ev.npc || !visible(ev)) continue;
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
    const face = el("span", { class: "grid-face", text: (CHARS.eevee && CHARS.eevee.emoji) || "●" });
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
          el("span", { text: c.emoji || "？" }));
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

    // 「入力中…」を出してから、メッセージを1つずつ表示する
    say(lines, then) {
      const items = toArray(lines).filter(visible).map(parseLine);
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
      chat.foot.replaceChildren(
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
          }) : null) : null);
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
        e.map ? el("button", { class: "btn", type: "button", text: T("endMap"), onclick: openMap }) : null,
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
      return el("div", { class: "party-cell" + (met ? " met" : "") },
        el("div", { class: "party-slot" + (met ? " met" : ""), style: met ? `--c:${c.color || "#ccc"}` : null, text: met ? c.emoji || "" : "" }),
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
  function openMenu() {
    openOverlay(el("div", { class: "panel" },
      el("h2", { text: T("menuTitle") }),
      el("button", { class: "btn", type: "button", text: T("menuParty"), onclick: openParty }),
      RM && flagOn("roomMap")
        ? el("button", { class: "btn", type: "button", text: T("menuMap"), onclick: openMap })
        : null,
      el("button", { class: "btn", type: "button", text: T("menuToTitle"), onclick: showTitle }),
      el("p", { class: "panel-note", text: T("menuNote") }),
      el("button", { class: "btn primary", type: "button", text: T("close"), onclick: closeOverlay })));
  }

  function openMap() {
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
    "menuTitle", "menuParty", "menuMap", "menuToTitle", "menuNote",
    "mapTitle", "mapCaption", "explore", "roomDone", "darkDefault", "darkShine",
    "iceHelp", "iceCount", "iceReset", "iceSkip", "iceBest", "iceClear",
    "walkHelp", "walkHelpTouch", "walkGoal", "walkLook", "walkNothing", "walkThing", "walkTeam", "walkTeamNone",
    "endNext", "endMap", "toTitle", "noScene",
  ];

  function validate() {
    const errors = [];
    const warnings = [];
    const ids = new Set(Object.keys(SCN));
    const check = (target, where) => {
      if (target && !ids.has(target)) errors.push(`${where}：「${target}」という場面がありません。`);
    };
    // { } の置きかえ先があるか（{name} 以外は SETTINGS の local か hidden に書く）
    const checkText = (t, where) => {
      String(t == null ? "" : t).replace(/\{(\w+)\}/g, (whole, key) => {
        if (key !== "name" && !LOCAL[key] && !(S.hidden && S.hidden[key])) {
          errors.push(`${where}：「{${key}}」に入る文字が、SETTINGS の local にも hidden にもありません。`);
        }
        return whole;
      });
    };
    const checkLines = (lines, where) => {
      toArray(lines).forEach((ln, i) => {
        if (ln && typeof ln === "object" && !ln.who && ln.text == null) {
          errors.push(`${where} の${i + 1}行目に text（文章）がありません。`);
          return;
        }
        checkText(ln && typeof ln === "object" ? ln.text : ln, where);
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
      if (sc.walk) checkWalk(id, sc, at, errors, warnings, check, checkLines);
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

  // house.js の地図の点検（家具や出入口が、部屋からはみ出していないか）
  function checkHouse(errors, warnings) {
    if (!HS) return;
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

  // 歩けるマップの場面の点検：地図・人物・出入口と、そこへたどりつけるか
  function checkWalk(id, sc, at, errors, warnings, check, checkLines) {
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
      if (!ev.say && !ev.next) errors.push(`${where}：say（セリフ）か next（次の場面）を書いてください。`);
      check(ev.next, `${where} の next`);
      checkLines(ev.say, `${where} の say`);
    });
    if (!events.some((ev) => ev && ev.next)) {
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
          placeholder: (LOCAL[key] && LOCAL[key].default) || "", maxlength: 12, autocomplete: "off",
        });
        field.addEventListener("input", () => {
          localValues[key] = field.value.trim();
          localStore.save(localValues);
        });
        return el("label", { class: "debug-local" }, el("span", { text: (LOCAL[key] && LOCAL[key].label) || key }), field);
      }),
      el("p", { class: "debug-note", text: "このPCのブラウザだけに記録します（公開ページには書かれません）。入力するとすぐに記録され、「記録（セーブ）を消す」でも消えません。遊ぶPC・遊ぶブラウザ（同じURL）で入れてください。空らんのときは、うすい字の呼び名で表示します。" }));
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
      el("h4", { text: "遊ぶ前の準備（友達の呼び名。このPCだけに記録）" }),
      localTool(),
      el("h4", { text: "答えを暗号にする（駅名など、ページに書きたくない答え用）" }),
      secretTool(),
      el("h4", { text: "表示用に隠す（駅名・公園名を、画面には出したいとき用）" }),
      hideTool(),
      el("h4", { text: "合言葉（iPhoneでQRを読むと、その場面から始まる）" }),
      online ? null : el("p", { class: "debug-note", text: "※ QRコードは、インターネット上に公開したページで開いたときだけ表示されます。" }),
      keyRows,
      el("h4", { text: "氷の床の最短回数（自動で数えた結果）" }),
      iceTool(),
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
  novel.box.addEventListener("click", nvAdvance);
  novel.stage.addEventListener("click", (e) => {
    if (e.target.closest("button, input, form, a")) return;
    nvAdvance();
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
      nvAdvance();
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
