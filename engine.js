/* ================================================================
   engine.js ― ゲームを動かす仕組み
   ----------------------------------------------------------------
   ふだんは編集しなくて大丈夫です。
     ・会話、選択肢、合言葉、カードを変える → story.js
     ・夢の部屋の地図を変える               → room.js
   ================================================================ */
(() => {
  "use strict";

  // ==============================================================
  // 1. 準備：story.js / room.js が読み込めたか確認する
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
  const RM = tryGet(() => ROOM);

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
  const fill = (t) => String(t == null ? "" : t).replace(/\{name\}/g, S.playerName || "きみ");

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
  // story.js では answers: ["#1a2b3c4d"] のように「#」で始めて書く
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

  // 言葉 "ミステ【リ】ー" → 【 】の文字を光らせて表示する
  function wordNode(w, cls) {
    const parts = String(w == null ? "" : w).split(/【(.+?)】/);
    return el("span", { class: "word" + (cls ? " " + cls : "") },
      parts.map((p, i) => (i % 2 ? el("mark", { text: p }) : p)));
  }

  // 話し手の名前（または ID）→ キャラクターID
  const nameToId = {};
  for (const [id, c] of Object.entries(CHARS)) {
    nameToId[id] = id;
    if (c && c.name) nameToId[c.name] = id;
  }

  // "イーブイ：こんにちは" → { who: "eevee", text: "こんにちは" }
  function parseLine(line) {
    if (line && typeof line === "object") {
      return { who: CHARS[line.who] ? line.who : null, text: fill(line.text) };
    }
    const s = String(line == null ? "" : line);
    const m = s.match(/^([^：:「」\n]{1,12})[：:]([\s\S]*)$/);
    if (m && nameToId[m[1].trim()]) {
      return { who: nameToId[m[1].trim()], text: fill(m[2].trim()) };
    }
    const suspect = m && /^[ぁ-んァ-ヶー一-龠a-zA-Z]{1,8}$/.test(m[1].trim()) ? m[1].trim() : null;
    return { who: null, text: fill(s.replace(/^[：:]/, "")), suspect };
  }

  // 場面の会話に出てくる話し手（最大3人）
  function speakersOf(lines) {
    const ids = [];
    for (const ln of toArray(lines)) {
      const who = parseLine(ln).who;
      if (who && who !== "hero" && !ids.includes(who)) ids.push(who);
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
  const freshState = () => ({ scene: null, met: [], words: [], chapter: "", bg: "" });
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
    const layer = el("div", { class: "stage-layer" });
    const draft = el("div", { class: "draft-badge", text: "仮の内容", hidden: true });
    const stage = el("div", { class: "stage" }, chars, roomBox, layer, draft);
    const name = el("div", { class: "nameplate", hidden: true });
    const text = el("div", { class: "text" });
    const mark = el("div", { class: "next-mark", text: "▼", hidden: true, "aria-hidden": "true" });
    const box = el("div", { class: "textbox", tabindex: "0" }, name, text, mark);
    const root = el("section", { class: "screen novel" }, topbar, stage, box);
    return { root, chapter, partyBtn, chars, roomBox, layer, draft, stage, name, text, mark, box };
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
  }

  function charNode(id) {
    const c = CHARS[id];
    return el("div", { class: "char", "data-id": id, style: `--c:${c.color || "#999"}` },
      el("div", { class: "char-face", text: c.emoji || "？" }),
      el("div", { class: "char-name", text: c.name || "" }));
  }

  function renderChars(ids) {
    NV.shown = ids.filter((id) => CHARS[id] && id !== "hero").slice(0, 3);
    novel.chars.replaceChildren(...NV.shown.map(charNode));
  }

  function setSpeaker(who) {
    const c = who ? CHARS[who] : null;
    novel.name.hidden = !c || !c.name;
    if (c) {
      novel.name.textContent = c.name;
      novel.name.style.setProperty("--c", c.color || "#999");
    }
    novel.box.classList.toggle("narration", !c);
    // 会話にだけ出てくるキャラクターも、空きがあれば表示する
    if (c && who !== "hero" && novel.roomBox.hidden && !NV.shown.includes(who) && NV.shown.length < 3) {
      NV.shown.push(who);
      novel.chars.append(charNode(who));
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
      if (sc.room) {
        novel.chars.replaceChildren();
        NV.shown = [];
        novel.roomBox.hidden = false;
        renderRoom(novel.roomBox, null, NV.dark);
      } else {
        novel.roomBox.hidden = true;
        novel.roomBox.replaceChildren();
        renderChars(sc.show ? toArray(sc.show) : speakersOf(sc.lines));
      }
      setSpeaker(null);
    },

    // lines を順に表示し、終わったら then を呼ぶ
    // hold が true なら、最後の行のあとにもう一度クリックを待つ
    say(lines, then, hold = true) {
      NV.lines = toArray(lines).map(parseLine);
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
      const field = el("input", {
        type: "text", class: "text-input", placeholder: spec.placeholder || "ここに入力",
        autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
        enterkeyhint: "done", "aria-label": fill(spec.prompt || "答え"),
      });
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
        el("div", { class: "input-prompt", text: fill(spec.prompt || "答えを入力してね") }),
        field,
        el("div", { class: "input-buttons" },
          onSkip ? el("button", {
            type: "button", class: "btn ghost", text: fill(spec.skip.text || "どうしてもわからない"),
            onclick: () => { setLayer(null); onSkip(); },
          }) : null,
          onHint ? el("button", {
            type: "button", class: "btn", text: "ヒント",
            onclick: () => { setLayer(null); onHint(); },
          }) : null,
          el("button", { type: "submit", class: "btn primary", text: "けってい" })));
      setLayer(form);
      if (!TOUCH) field.focus({ preventScroll: true });
    },

    // 言葉を手に入れたときのカード（とじると先へ進む）
    reveal(id, then) {
      const c = CHARS[id] || {};
      novel.mark.hidden = true;
      openOverlay(el("div", { class: "panel word-panel", style: `--c:${c.color || "#ccc"}` },
        el("div", { class: "word-get", text: "✦ 言葉を手に入れた ✦" }),
        el("div", { class: "word-from" },
          el("span", { class: "word-avatar", text: c.emoji || "？", "aria-hidden": "true" }),
          `${c.name || ""}からの言葉`),
        wordNode(c.word, "big"),
        el("p", { class: "panel-note", text: "なかまノート（📖）に書きこまれた。" }),
        el("button", { class: "btn primary", type: "button", text: "OK", onclick: closeOverlay })), then);
    },

    // 地図を調べる
    explore(sc, onDone) {
      NV.mode = "explore";
      novel.mark.hidden = true;
      setSpeaker(null);
      const dark = NV.dark;
      novel.text.textContent = fill(sc.exploreText || (RM && RM.exploreText) || "気になる場所を調べてみよう。");
      const needFind = Boolean(RM) && RM.requireFind !== false && (RM.items || []).some((it) => it.shine);
      let found = !needFind;
      const showDone = () => {
        if (novel.layer.querySelector(".room-done")) return;
        setLayer(el("button", {
          class: "btn primary room-done", type: "button", text: sc.roomDone || "▶ つぎへ",
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
          ? item.dark || (item.shine ? "リングの形の光だ……！" : `暗くて、よく見えない。……${item.name}、かな？`)
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

    proceed(cb) { cb(); },
  };

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
    const draft = el("div", { class: "draft-badge", text: "仮の内容", hidden: true });
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
          cont ? null : el("div", { class: "who", text: c.name || "" }),
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
      chat.title.textContent = fill(sc.chatTitle || S.chatTitle || "メッセージ");
      chat.draft.hidden = !sc.draft;
      chat.foot.replaceChildren();
      if (state.chapter && state.chapter !== CV.chapter) {
        CV.chapter = state.chapter;
        addMsg({ who: null, text: state.chapter, kind: "chapter" });
      }
    },

    // 「入力中…」を出してから、メッセージを1つずつ表示する
    say(lines, then) {
      const items = toArray(lines).map(parseLine);
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
      const field = el("input", {
        type: "text", class: "chat-text", placeholder: spec.placeholder || "ここに入力",
        autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
        enterkeyhint: "send", "aria-label": fill(spec.prompt || "答え"),
      });
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
      }, field, el("button", { type: "submit", class: "send-btn", text: "送信" }));
      const skipText = onSkip ? fill(spec.skip.text || "どうしてもわからない") : "";
      chat.foot.replaceChildren(
        spec.prompt ? el("div", { class: "foot-prompt", text: fill(spec.prompt) }) : null,
        form,
        onHint || onSkip ? el("div", { class: "foot-links" },
          onHint ? el("button", {
            type: "button", class: "hint-btn", text: "💡 ヒントをもらう",
            onclick: () => {
              chat.foot.replaceChildren();
              addMsg({ who: "hero", text: "ヒントがほしい！" });
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
          el("div", { class: "word-get", text: `✦ ${c.name || ""}から 言葉をもらった ✦` }),
          wordNode(c.word, "big"),
          el("div", { class: "word-note", text: "なかまノート（📖）に書きこまれた" }))));
      scrollChat();
      setTimeout(() => { if (token === gen) then(); }, S.textSpeed ? 700 : 0);
    },

    proceed(cb) {
      chat.foot.replaceChildren(el("button", {
        type: "button", class: "next-btn", text: "つづける ▶",
        onclick: () => { chat.foot.replaceChildren(); cb(); },
      }));
      scrollChat();
    },
  };

  // ==============================================================
  // 7. 場面の進め方（どちらの画面でも共通）
  // ==============================================================
  // story.js の中で、その場面より前に書かれた一番近い値（章の名前・背景）
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
      toast(`場面「${id}」が見つかりません`);
      return;
    }
    gen += 1;
    closeOverlay();
    if (NV.typer) { NV.typer.cancel(); NV.typer = null; }
    CV.skip = null;
    state.scene = id;
    state.chapter = sc.chapter || (jump ? inherited(id, "chapter") : state.chapter);
    state.bg = sc.bg || (jump ? inherited(id, "bg") : state.bg);
    applyMeet(sc);
    storage.save(state);
    if (DEBUG) debugNow(id);
    const view = sc.mode === "chat" ? ChatView : NovelView;
    view.enter(sc);
    // 選択肢・入力・地図がある場面は、最後の行のあとすぐに表示する
    const waitsForPlayer = Boolean(sc.choices || sc.input || (sc.room && view === NovelView));
    view.say(sc.lines, () => afterLines(sc, view), !waitsForPlayer);
  }

  function afterLines(sc, view) {
    const next = () => giveWord(sc, view, () => leave(sc, view));
    if (sc.room && view === NovelView) {
      view.explore(sc, next);
      return;
    }
    next();
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
    if (sc.choices) return askChoice(sc, view);
    if (sc.input) return askInput(sc, view);
    if (sc.end) return view === ChatView ? view.proceed(() => showEnd(sc)) : showEnd(sc);
    if (sc.next) return view.proceed(() => runScene(sc.next));
    return undefined;
  }

  function askChoice(sc, view) {
    view.choices(toArray(sc.choices), (c) => {
      view.say(toArray(c.reply), () => (c.next ? runScene(c.next) : askChoice(sc, view)), Boolean(c.next));
    });
  }

  // misses：まちがえた回数（skip の「どうしてもわからない」を出すために数える）
  function askInput(sc, view, misses = 0) {
    const spec = sc.input;
    const onHint = spec.hint
      ? () => view.say(toArray(spec.hint), () => askInput(sc, view, misses), false)
      : null;
    const skip = spec.skip && spec.skip.next ? spec.skip : null;
    const onSkip = skip && misses >= (skip.after == null ? 2 : skip.after)
      ? () => view.say(toArray(skip.reply), () => runScene(skip.next), true)
      : null;
    view.input(spec, (text) => {
      if (isAnswer(text, spec.answers)) {
        view.say(toArray(spec.correct), () => runScene(spec.next), true);
      } else {
        view.say(toArray(spec.wrong || "……ちがうみたい。もう一度ためしてみよう。"), () => askInput(sc, view, misses + 1), false);
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
      toast(`${c.emoji || ""} ${c.name}が なかまノートに加わった！（${metCount()}/${PARTY.length}）`);
    }
  }

  // 章の終わりの画面
  function showEnd(sc) {
    const e = sc.end || {};
    gen += 1;
    setBg(endScreen, e.bg || state.bg || "night");
    endScreen.replaceChildren(el("div", { class: "end-card" },
      e.icon ? el("div", { class: "end-icon", text: e.icon, "aria-hidden": "true" }) : null,
      el("h2", { class: "end-title", text: fill(e.title || "") }),
      e.text ? el("p", { class: "end-text", text: fill(e.text) }) : null,
      el("div", { class: "end-buttons" },
        e.map ? el("button", { class: "btn", type: "button", text: "🗺 夢の部屋の地図を見る", onclick: openMap }) : null,
        e.next ? el("button", { class: "btn primary", type: "button", text: e.nextLabel || "つづける", onclick: () => runScene(e.next) }) : null,
        el("button", { class: "btn", type: "button", text: "タイトルへもどる", onclick: showTitle }))));
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

  function openParty() {
    const n = metCount();
    const got = PARTY.filter((id) => state.words.includes(id)).length;
    const cells = PARTY.map((id) => {
      const c = CHARS[id] || {};
      const met = state.met.includes(id);
      const hasWord = state.words.includes(id) && c.word;
      return el("div", { class: "party-cell" + (met ? " met" : "") },
        el("div", { class: "party-slot" + (met ? " met" : ""), style: met ? `--c:${c.color || "#ccc"}` : null, text: met ? c.emoji || "？" : "？" }),
        el("div", { class: "party-info" },
          el("div", { class: "party-name", text: met ? c.name : "？？？" }),
          hasWord ? wordNode(c.word, "party-word") : el("span", { class: "party-word none", text: "―" })));
    });
    const note = got >= PARTY.length
      ? "8つの言葉がそろった！　光っている文字に、注目……！"
      : n >= PARTY.length ? "8匹ぜんいんに会えた！" : "8匹ぜんいんに会えたら……？";
    openOverlay(el("div", { class: "panel" },
      el("h2", { text: `📖 なかまノート　${n} / ${PARTY.length}` }),
      el("div", { class: "party-grid" }, cells),
      el("p", { class: "panel-note", text: note }),
      el("button", { class: "btn primary", type: "button", text: "とじる", onclick: closeOverlay })));
  }

  function openMenu() {
    openOverlay(el("div", { class: "panel" },
      el("h2", { text: "メニュー" }),
      el("button", { class: "btn", type: "button", text: "📖 なかまノート", onclick: openParty }),
      RM && state.met.includes("espeon")
        ? el("button", { class: "btn", type: "button", text: "🗺 夢の部屋の地図", onclick: openMap })
        : null,
      el("button", { class: "btn", type: "button", text: "🏠 タイトルへもどる", onclick: showTitle }),
      el("p", { class: "panel-note", text: "記録は、この端末に自動で保存されます。" }),
      el("button", { class: "btn primary", type: "button", text: "とじる", onclick: closeOverlay })));
  }

  function openMap() {
    const caption = el("p", { class: "map-caption", text: "場所をタップ（クリック）すると、くわしく見られるよ。" });
    const box = el("div", { class: "map-box" });
    renderRoom(box, (it) => { caption.textContent = fill(it.text || it.name); });
    openOverlay(el("div", { class: "panel map-panel" },
      el("h2", { text: "🗺 夢の部屋の地図" }),
      box,
      caption,
      el("button", { class: "btn primary", type: "button", text: "とじる", onclick: closeOverlay })));
  }

  function confirmBox(message, yesLabel, onYes) {
    openOverlay(el("div", { class: "panel" },
      el("p", { class: "panel-text", text: message }),
      el("div", { class: "panel-buttons" },
        el("button", { class: "btn", type: "button", text: "やめる", onclick: closeOverlay }),
        el("button", { class: "btn primary", type: "button", text: yesLabel, onclick: () => { closeOverlay(); onYes(); } }))));
  }

  // ==============================================================
  // 9. タイトル・合言葉
  // ==============================================================
  function showTitle() {
    gen += 1;
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
        canResume ? el("button", { class: "btn primary", type: "button", text: "つづきから", onclick: () => resume(save) }) : null,
        el("button", { class: canResume ? "btn" : "btn primary", type: "button", text: "はじめから", onclick: () => newGame(canResume) }),
        el("button", { class: "btn", type: "button", text: "あいことばを入れる", onclick: showKeyword })),
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
    if (hasSave) confirmBox("さいしょから はじめますか？\nいまの記録は消えます。", "はじめから", go);
    else go();
  }

  function loadState(save) {
    state = Object.assign(freshState(), save || {});
    if (!Array.isArray(state.met)) state.met = [];
    if (!Array.isArray(state.words)) state.words = [];
    updateParty();
  }

  function resume(save) {
    loadState(save);
    runScene(state.scene);
  }

  function findKeyword(text) {
    const n = norm(text);
    if (!n) return null;
    for (const [word, id] of Object.entries(KEYS)) {
      if (norm(word) === n) return id;
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
      type: "text", class: "text-input", placeholder: "ここに合言葉を入力",
      autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
      enterkeyhint: "done", "aria-label": "合言葉",
    });
    const msg = el("p", { class: "kw-msg", "aria-live": "polite" });
    const form = el("form", {
      class: "kw-form",
      onsubmit: (e) => {
        e.preventDefault();
        const id = findKeyword(field.value);
        if (id) {
          msg.textContent = "✨ 合言葉が光った！";
          field.blur();
          const token = gen;
          setTimeout(() => { if (token === gen) startFrom(id); }, 800);
        } else {
          msg.textContent = field.value.trim() ? "……何も起こらない。合言葉がちがうみたい。" : "合言葉を入力してね。";
          field.classList.remove("shake");
          void field.offsetWidth;
          field.classList.add("shake");
        }
      },
    }, field, el("button", { class: "btn primary", type: "submit", text: "となえる" }));
    keywordScreen.replaceChildren(el("div", { class: "kw-wrap" },
      el("div", { class: "kw-icon", text: "🔑", "aria-hidden": "true" }),
      el("h2", { text: "あいことば" }),
      el("p", { class: "kw-note", text: "カードや画面で見つけた合言葉を入れてね。\nひらがな・カタカナ、どちらでもOK。" }),
      form,
      msg,
      el("button", { class: "btn ghost", type: "button", text: "もどる", onclick: showTitle })));
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
        el("p", { class: "panel-text", text: `合言葉「${key}」を受けとった！` }),
        el("div", { class: "panel-buttons column" },
          el("button", { class: "btn primary", type: "button", text: "前回のつづきから", onclick: () => resume(save) }),
          el("button", { class: "btn", type: "button", text: "この合言葉の場面からはじめる", onclick: () => startFrom(id) }))));
      return true;
    }
    startFrom(id);
    return true;
  }

  // ==============================================================
  // 10. story.js の点検（書きまちがいを見つける）
  // ==============================================================
  function validate() {
    const errors = [];
    const warnings = [];
    const ids = new Set(Object.keys(SCN));
    const check = (target, where) => {
      if (target && !ids.has(target)) errors.push(`${where}：「${target}」という場面がありません。`);
    };
    if (!ids.has(S.start)) errors.push(`SETTINGS の start：「${S.start}」という場面がありません。`);
    for (const [id, sc] of Object.entries(SCN)) {
      const at = `場面「${id}」`;
      if (!sc || typeof sc !== "object") {
        errors.push(`${at} の書き方がおかしいようです。`);
        continue;
      }
      check(sc.next, `${at} の next`);
      if (sc.choices && !Array.isArray(sc.choices)) errors.push(`${at} の choices は [ ] で囲んでください。`);
      toArray(sc.choices).forEach((c, i) => {
        if (!c || !c.text) {
          errors.push(`${at} の選択肢${i + 1}に text（ボタンの文字）がありません。`);
          return;
        }
        if (!c.next && !c.reply) errors.push(`${at} の選択肢「${c.text}」に next も reply もありません。`);
        check(c.next, `${at} の選択肢「${c.text}」`);
      });
      if (sc.input) {
        if (!toArray(sc.input.answers).length) errors.push(`${at} の input に answers（正解）がありません。`);
        if (!sc.input.next) errors.push(`${at} の input に next（正解したときの行き先）がありません。`);
        check(sc.input.next, `${at} の input`);
        for (const a of toArray(sc.input.answers)) {
          const s = String(a).trim();
          if (s.startsWith("#") && !/^#[0-9a-f]{8}$/i.test(s)) errors.push(`${at} の暗号の答え「${s}」の形がおかしいようです（# と英数字8文字）。`);
        }
        if (sc.input.skip) {
          if (!sc.input.skip.next) errors.push(`${at} の skip に next（行き先）がありません。`);
          check(sc.input.skip.next, `${at} の skip`);
        }
      }
      for (const g of toArray(sc.give)) {
        if (!CHARS[g]) errors.push(`${at} の give：「${g}」というキャラクターがいません。`);
        else if (!CHARS[g].word) errors.push(`${at} の give：「${CHARS[g].name}」に word（言葉）が書かれていません。`);
      }
      if (sc.end) check(sc.end.next, `${at} の end`);
      if (!sc.next && !sc.choices && !sc.input && !sc.end) {
        errors.push(`${at} に next・choices・input・end のどれもありません（行き止まりになります）。`);
      }
      if (sc.room && !RM) errors.push(`${at} は地図を使いますが、room.js を読み込めませんでした。`);
      if (sc.room && sc.mode === "chat") warnings.push(`${at}：メッセージ形式（chat）では地図を表示できません。`);
      for (const m of toArray(sc.meet)) if (!CHARS[m]) errors.push(`${at} の meet：「${m}」というキャラクターがいません。`);
      for (const m of toArray(sc.show)) if (!CHARS[m]) errors.push(`${at} の show：「${m}」というキャラクターがいません。`);
      toArray(sc.lines).forEach((ln, i) => {
        const p = parseLine(ln);
        if (p.suspect) warnings.push(`${at} の${i + 1}行目：「${p.suspect}」という話し手がいないため、地の文として表示します。`);
      });
    }
    for (const [word, id] of Object.entries(KEYS)) check(id, `合言葉「${word}」`);
    for (const id of PARTY) {
      const w = CHARS[id] && CHARS[id].word;
      if (w && !/【.+?】/.test(w)) warnings.push(`CHARACTERS の ${id} の言葉「${w}」に、光らせる文字の【 】がありません。`);
    }
    if (RM) {
      const cols = RM.cols || 10;
      const rows = RM.rows || 8;
      for (const it of RM.items || []) {
        if (it.x < 0 || it.y < 0 || it.x + it.w > cols || it.y + it.h > rows) {
          warnings.push(`room.js の「${it.name}」が部屋の外にはみ出しています。`);
        }
      }
    }
    return { errors, warnings };
  }

  function showProblems(errors) {
    if (!errors.length) return;
    const banner = el("div", { class: "error-banner", role: "alert" },
      el("b", { text: `⚠ story.js に ${errors.length} 件の問題があります` }),
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

  // 答えを入れると、story.js の answers に書く暗号を表示する
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

  function setupDebug(problems) {
    const base = location.href.split(/[?#]/)[0];
    const online = /^https?:$/.test(location.protocol);
    const select = el("select", { class: "debug-select" },
      Object.keys(SCN).map((id) => el("option", { value: id, text: id + (SCN[id].draft ? "（仮）" : "") })));
    const keyRows = Object.entries(KEYS).map(([word, id]) => {
      const url = `${base}?key=${encodeURIComponent(word)}`;
      return el("div", { class: "debug-kw" },
        el("div", {}, el("b", { text: word }), ` → ${id}`),
        el("a", { href: `${url}&debug`, text: "この合言葉でひらく" }),
        online && typeof qrcode === "function" ? qrNode(url) : null);
    });
    const panel = el("div", { class: "debug-panel", hidden: true },
      el("h3", { text: "🛠 テスト用メニュー（本番では表示されません）" }),
      el("div", { class: "debug-row" },
        select,
        el("button", { type: "button", text: "この場面へ", onclick: () => { panel.hidden = true; runScene(select.value, true); } })),
      el("div", { class: "debug-row" },
        el("button", { type: "button", text: "なかまと言葉を全部にする", onclick: () => { state.met = PARTY.slice(); state.words = PARTY.slice(); storage.save(state); updateParty(); toast("なかまと言葉を全部そろえました"); } }),
        el("button", { type: "button", text: "記録（セーブ）を消す", onclick: () => { storage.clear(); state = freshState(); updateParty(); toast("記録を消しました"); } })),
      el("h4", { text: "答えを暗号にする（駅名など、ページに書きたくない答え用）" }),
      secretTool(),
      el("h4", { text: "合言葉（iPhoneでQRを読むと、その場面から始まる）" }),
      online ? null : el("p", { class: "debug-note", text: "※ QRコードは、インターネット上に公開したページで開いたときだけ表示されます。" }),
      keyRows,
      el("h4", { text: "story.js の点検結果" }),
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
  // story.js を読み込めなかったときの表示
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
    p.textContent = "story.js に、書きまちがいがあるかもしれません。直前に編集した場所で、次の点を確認してください。";
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
