/* ================================================================
   geo.js ― 公園で「気配」を探す仕組み（GPSヒント機能）の、判定の計算
   ----------------------------------------------------------------
   ・本編（index.html）と、テストページ（gps-test.html）の両方が読みこみます。
     どちらも data.js のあとに読みこみ、window.GEO で使います。
   ・このファイルには、設定値・公園の座標・表示の文を書きません。全部 data.js にあります。
       設定値            → SETTINGS の gps（半径・精度の上限・2回続けて など）
       公園と判定する点  → SETTINGS の gps の parks（どの点がどの公園か）
       座標              → SETTINGS の hidden（駅名と同じ「表示用に隠す」形）
       イーブイの文      → 公園で気配を探す場面（leafeon_search）の search
       ボタンの文字      → UI の searchButton など
   ・現在地は、保存も、外部への送信もしません。距離の計算は、この端末の中だけで行います。
   ================================================================ */

(() => {
  "use strict";

  // ==============================================================
  // 1. 表示用に隠す（engine.js の hide・unhide と同じ計算）
  // ==============================================================
  // 合言葉が engine.js と同じなので、🛠 →「表示用に隠す」で作った "~…" を、そのまま読める
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

  // ==============================================================
  // 2. 判定する点と距離
  // ==============================================================
  // 2点のあいだの距離（m）。地球を球として計算する（50 m の判定には十分な正確さ）
  function distance(lat1, lon1, lat2, lon2) {
    const R = 6371008.8;   // 地球の平均の半径（m）
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // "~…"（または平文の "12.345678,123.456789"）→ { lat, lon, plain }。読めないときは null
  //   plain：true なら、隠していない平文の座標（点検で知らせる）
  function parsePoint(raw) {
    const text = unhide(raw);
    const m = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
    return { lat, lon, plain: !String(raw).trim().startsWith("~") };
  }

  // data.js の SETTINGS.gps.parks（点は SETTINGS.hidden の名前）→ readParks で読める形（点は "~…" の文字）
  //   → { list: [{ id, label, points: ["~…"] }], problems: [文] }
  function parksFrom(list, hidden) {
    const box = hidden && typeof hidden === "object" ? hidden : {};
    const problems = [];
    const out = (Array.isArray(list) ? list : []).map((p, i) => {
      const label = p && p.label ? String(p.label) : (p && p.id) || `${i + 1}番目の公園`;
      const points = [];
      (p && Array.isArray(p.points) ? p.points : []).forEach((name, k) => {
        if (typeof name === "string" && box[name] != null) points.push(box[name]);
        else problems.push(`${label} の${k + 1}点目：「${name}」が、SETTINGS の hidden にありません。`);
      });
      return Object.assign({}, p, { label, points });
    });
    return { list: out, problems };
  }

  // 公園の一覧（点は "~…" の文字）を読む → { parks: [{ id, label, draft, points: [{ lat, lon }] }], problems: [文] }
  function readParks(list) {
    const parks = [];
    const problems = [];
    const ids = new Set();
    (Array.isArray(list) ? list : []).forEach((p, i) => {
      const id = p && p.id ? String(p.id) : "";
      const label = p && p.label ? String(p.label) : id || `${i + 1}番目の公園`;
      if (!id) { problems.push(`${label}：id がありません。`); return; }
      if (ids.has(id)) { problems.push(`${label}：id「${id}」が、ほかの公園と同じです。`); return; }
      ids.add(id);
      const raws = Array.isArray(p.points) ? p.points : [];
      const points = [];
      raws.forEach((raw, k) => {
        const pt = parsePoint(raw);
        if (!pt) problems.push(`${label} の${k + 1}点目：座標として読めません。`);
        else {
          if (pt.plain) problems.push(`${label} の${k + 1}点目：座標が隠されていません（"~" で始まる形にしてください）。`);
          points.push({ lat: pt.lat, lon: pt.lon });
        }
      });
      if (!points.length) { problems.push(`${label}：判定する点がありません。`); return; }
      parks.push({ id, label, draft: Boolean(p.draft), points });
    });
    return { parks, problems };
  }

  // いちばん近い判定点 → { park（id）, label, point（何点目か。0から）, distance }。公園がなければ null
  function nearest(parks, lat, lon) {
    let best = null;
    for (const p of parks) {
      p.points.forEach((pt, k) => {
        const d = distance(lat, lon, pt.lat, pt.lon);
        if (!best || d < best.distance) best = { park: p.id, label: p.label, point: k, distance: d };
      });
    }
    return best;
  }

  // ==============================================================
  // 3. 1回の読み取りを分ける（範囲内・範囲外・精度不足）
  // ==============================================================
  //   in  ：精度が上限以内で、判定点まで半径以内
  //   out ：精度が上限以内で、半径より遠い。
  //         または精度は粗いが、誤差の分を引いても半径より遠い（はっきり外にいる）
  //   poor：精度が粗く、範囲内か範囲外かを決められない
  function kindOf(dist, accuracy, cfg) {
    const acc = Number.isFinite(accuracy) ? accuracy : Infinity;
    if (acc <= cfg.accuracy) return dist <= cfg.radius ? "in" : "out";
    return dist - acc > cfg.radius ? "out" : "poor";
  }

  // 位置1つ → { kind, park, label, point, distance, accuracy }（公園がなければ park は null）
  function classify(parks, lat, lon, accuracy, cfg) {
    const near = nearest(parks, lat, lon);
    if (!near) return { kind: kindOf(Infinity, accuracy, cfg), park: null, label: "", point: -1, distance: Infinity, accuracy };
    return Object.assign({ kind: kindOf(near.distance, accuracy, cfg), accuracy }, near);
  }

  // ==============================================================
  // 4. 結果を決める（2回続けて同じなら決める）
  // ==============================================================
  //   found：まだ数えていない公園で、範囲内が streak 回続いた（いちばん近い公園が同じであること）
  //   already：もう数えた公園で、範囲内が streak 回続いた
  //   none ：範囲外が streak 回続いた（監視モード〔watch〕では決めない）
  //   finish() は、時間切れのときの結果：
  //     unclear（範囲内が一度でもあった・精度不足だけだった・古い位置だけが届いた）
  //     / none（範囲外だけだった）/ noReading（位置が1つも来なかった）
  //   found：もう数えた公園の id の一覧
  //
  //   feed(obs, now) の obs は classify の結果に ts（測った時刻）を足したもの。now は届いた時刻
  //   次の読み取りは数えずに { skip } を返す（判定に使わない。記録に残すのは呼ぶ側）：
  //     stale：古い位置（staleAfter より前に測った）
  //     close：続けて同じになるが、前の読み取りから minGap たっていない（ほぼ同じ読み取りを2回数えないため）
  //            ちがう結果（範囲内のあとの範囲外など）は、近くても数える（そこから数え直す）
  function judge(cfg, found, opts) {
    const done = new Set(Array.isArray(found) ? found : []);
    const watch = Boolean(opts && opts.watch);
    const need = Math.max(1, Number(cfg.streak) || 1);
    const gap = Math.max(0, Number(cfg.minGap) || 0);
    let run = { kind: "", park: null, n: 0, ts: NaN };
    let readings = 0;       // 判定に使った読み取り
    let stale = 0;          // 古いので数えなかった読み取り
    let close = 0;          // 前の読み取りに近すぎるので数えなかった読み取り
    let sawIn = false;
    let lastGood = null;    // 精度が足りた（in・out）最後の読み取り
    let best = Infinity;    // いちばん良かった精度（m）
    return {
      feed(obs, now) {
        const at = Number.isFinite(now) ? now : Date.now();
        if (isStale(obs.ts, at, cfg)) {
          stale += 1;
          return { skip: "stale", age: at - obs.ts };
        }
        const same = run.kind === obs.kind && (obs.kind !== "in" || run.park === obs.park);
        // 測った時刻が分からないときは、間隔を確かめずに数える
        const since = obs.ts - run.ts;
        if (same && gap > 0 && since < gap) {
          close += 1;
          return { skip: "close", since };
        }
        readings += 1;
        if (Number.isFinite(obs.accuracy)) best = Math.min(best, obs.accuracy);
        if (obs.kind === "in") sawIn = true;
        if (obs.kind !== "poor") lastGood = obs;
        run = same ? { kind: run.kind, park: run.park, n: run.n + 1, ts: obs.ts } : { kind: obs.kind, park: obs.park, n: 1, ts: obs.ts };
        // ちょうど streak 回になったときだけ決める（監視モードで、同じ知らせを何度も出さないため）
        if (run.n !== need) return null;
        if (obs.kind === "in") return Object.assign({ result: done.has(obs.park) ? "already" : "found" }, obs);
        if (obs.kind === "out" && !watch) return Object.assign({ result: "none" }, obs);
        return null;
      },
      finish() {
        // 新しい位置が1つも来ず、古い位置だけが届いたときは、「気配なし」にしない
        if (!readings) return stale ? { result: "unclear", best, sawIn: false, lastGood: null, staleOnly: true, stale } : { result: "noReading" };
        if (lastGood && !sawIn) return Object.assign({ result: "none" }, lastGood, { best });
        return { result: "unclear", best, sawIn, lastGood };
      },
      run: () => Object.assign({}, run, { need }),
      counts: () => ({ readings, stale, close }),
    };
  }

  // 「気配を見つけたことにする」を出すか。続けて見つからなかった回数（misses）を、結果ごとに進める
  //   found・reached・manual（手動で数を増やした）→ 0 にもどす
  //   none・unclear → 1 増やす。manualAfter 回に達したら出す
  //   already → そのまま（失敗にも成功にも数えない）
  //   error（拒否・取得失敗・時間切れ）→ 回数はそのままで、1回目から出す
  //   → { misses（新しい回数）, manual（ボタンを出すか） }
  function missStep(misses, result, cfg) {
    const n = Math.max(0, Math.floor(Number(misses) || 0));
    const after = Math.max(1, Math.floor(Number(cfg.manualAfter) || 1));
    if (result === "found" || result === "reached" || result === "manual") return { misses: 0, manual: false };
    if (result === "none" || result === "unclear") return { misses: n + 1, manual: n + 1 >= after };
    if (result === "error") return { misses: n, manual: true };
    return { misses: n, manual: false };
  }

  // ==============================================================
  // 5. 表示する文を選ぶ（文は data.js の場面の search）
  // ==============================================================
  // n公園目に見つけたときの文：found は { first, more, reached }
  //   1公園目は first、途中は more（必要な数が4以上でも、すべて more）、必要な数に達したら reached
  function hintFor(n, cfg, found) {
    const t = found || {};
    const need = Math.max(1, Number(cfg.need) || 1);
    if (n >= need) return t.reached || "";
    return (n <= 1 ? t.first : t.more) || "";
  }

  // 文を { text, note } の形にする（文だけのときは、"…" と書いてもよい）
  function textOf(x) {
    if (x == null) return { text: "", note: "" };
    if (typeof x === "string") return { text: x, note: "" };
    return { text: x.text || "", note: x.note || "" };
  }

  // 結果 d に合う文 → { text, note }。n は見つけた数（手動で増やした分も入れる）
  //   精度がとても低い（poorAccuracy 以上）ときの「位置がはっきりしない」は、poor の文にする
  //   エラーは、拒否（code 1）→ denied、位置情報を使えないページ（code 0）→ unsupported、
  //   取得失敗（code 2）・時間切れ（code 3）→ failed
  function lineFor(d, n, cfg, texts) {
    const t = texts || {};
    const r = d && d.result;
    if (r === "found" || r === "reached" || r === "manual") return { text: hintFor(n, cfg, t.found), note: "" };
    if (r === "already" || r === "none") return textOf(t[r]);
    if (r === "unclear") return textOf(Number.isFinite(d.best) && d.best >= Number(cfg.poorAccuracy) ? t.poor : t.unclear);
    if (r === "error") return textOf(d.code === 1 ? t.denied : d.code === 0 ? t.unsupported : t.failed);
    return { text: "", note: "" };
  }

  // 測った時刻 ts が、いま（now）より staleAfter より前なら、古い位置（数えない）
  //   時計のずれで ts が先になったときは、新しい位置として扱う
  function isStale(ts, now, cfg) {
    const limit = Number(cfg.staleAfter) || 0;
    return limit > 0 && Number.isFinite(ts) && now - ts > limit;
  }

  // ==============================================================
  // 6. 位置を測る（本編の「気配を探す」と、テストページで共通）
  // ==============================================================
  // track(o)：位置を測り続ける。結果は決めない（決めるのは check と、テストページ）
  //   o.cfg      ：設定値（SETTINGS.gps）
  //   o.geo      ：navigator.geolocation
  //   o.limit    ：true なら時間を区切る。最初の位置（または返事）が届いてから timeout のあいだ測り、
  //                何も届かなければ firstWait で打ち切る。新しい位置が pokeAfter 来ないときは、1回取りにいく。
  //                false なら区切らない（テストページの監視モード）
  //   o.onPosition(r)        ：位置が届いた（同じ位置が2回届いたときは、2回目は onDuplicate）
  //                            r = { lat, lon, accuracy, ts（測った時刻）, at（届いた時刻）, source（"watch"・"get"） }
  //                            古くない位置なら、呼ぶ側が fresh() を呼ぶ（取りにいく時刻の計算に使う）
  //   o.onError(err, source, fatal)：エラー。fatal は拒否（code 1）で、測るのを止めたとき
  //   o.onTimeUp({ answered, unavailable })：時間切れ（answered：位置か返事が届いた / unavailable：取得失敗があった）
  //   o.onTick()、o.onPoke()：0.5秒ごと／取りにいったとき（表示と記録のため）
  //   → { stop(), fresh(), info() }
  function track(o) {
    const started = Date.now();
    const cfg = o.cfg || {};
    const geo = o.geo;
    const limit = Boolean(o.limit);
    const timeout = Number(cfg.timeout) || 15000;
    const firstWait = Number(cfg.firstWait) || 60000;
    const pokeAfter = Number(cfg.pokeAfter) || 3000;
    const call = (name, ...args) => { if (typeof o[name] === "function") o[name](...args); };
    const opts = (withTimeout) => Object.assign(
      { enableHighAccuracy: cfg.highAccuracy !== false, maximumAge: Number(cfg.maximumAge) || 0 },
      withTimeout ? { timeout } : {});
    const seen = new Set();
    let alive = true;
    let first = 0;        // 最初の位置（または返事）が届いた時刻
    let lastNew = 0;      // 最後に新しい位置が届いた時刻
    let lastPoke = 0;
    let poking = false;
    let unavailable = false;
    let fresh = 0;        // 届いた新しい位置の数
    let timer = null;
    let ticker = null;
    let watchId = null;

    function stop() {
      if (!alive) return;
      alive = false;
      if (watchId != null) geo.clearWatch(watchId);
      clearTimeout(timer);
      clearInterval(ticker);
    }
    function timeUp() {
      if (!alive) return;
      const info = { answered: Boolean(first), unavailable };
      stop();
      call("onTimeUp", info);
    }
    // 最初の位置（または返事）が届いたら、そこから timeout のあいだ測る（許可の確認に答える時間は入れない）
    function firstResponse() {
      if (first) return;
      first = Date.now();
      lastNew = first;
      if (limit) {
        clearTimeout(timer);
        timer = setTimeout(timeUp, timeout);
      }
    }
    function onPos(pos, source) {
      if (!alive) return;
      firstResponse();
      const c = pos.coords;
      const r = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, ts: pos.timestamp, at: Date.now(), source };
      // 同じ位置が2回届いても、2回とは数えない（「2回続けて」を、別々の読み取りで数えるため）
      const key = [r.ts, r.lat, r.lon, r.accuracy].join("|");
      if (seen.has(key)) {
        call("onDuplicate", r);
        return;
      }
      seen.add(key);
      call("onPosition", r);
    }
    function onErr(err, source) {
      if (!alive) return;
      const code = err && err.code;
      if (code === 1) {
        stop();
        call("onError", err, source, true);
        return;
      }
      call("onError", err, source, false);
      firstResponse();
      if (code === 2) unavailable = true;
      // 新しい位置が1つも来ないまま、測る仕組みが時間切れを知らせてきたら、そこで終わる
      if (code === 3 && source === "watch" && !fresh && limit) timeUp();
    }
    function tick() {
      if (!alive) return;
      const now = Date.now();
      // 新しい位置がしばらく来ないときは、こちらから1回取りにいく（時間を区切るときだけ）
      if (limit && first && !poking && now - Math.max(lastNew, lastPoke) > pokeAfter) {
        poking = true;
        lastPoke = now;
        call("onPoke");
        const remain = Math.max(1000, first + timeout - now);
        geo.getCurrentPosition(
          (pos) => { poking = false; onPos(pos, "get"); },
          (err) => { poking = false; onErr(err, "get"); },
          Object.assign(opts(false), { timeout: remain }));
      }
      call("onTick");
    }

    watchId = geo.watchPosition((pos) => onPos(pos, "watch"), (err) => onErr(err, "watch"), opts(limit));
    if (limit) timer = setTimeout(timeUp, firstWait);
    ticker = setInterval(tick, 500);
    const api = {
      stop,
      fresh() {
        fresh += 1;
        lastNew = Date.now();
      },
      // left：残りの秒数（最初の位置か返事が届く前は null）
      info: () => ({
        alive, first, fresh, unavailable, started,
        left: first ? Math.max(0, Math.ceil((first + timeout - Date.now()) / 1000)) : null,
      }),
    };
    setTimeout(tick, 0);
    return api;
  }

  // check(o)：1回の確認（本編の「気配を探す」とテストページの「現在地を確認」）
  //   o.cfg・o.geo：track と同じ / o.parks：readParks の公園 / o.found：もう数えた公園の id
  //   o.onDone(d)：結果（found・already・none・unclear・error）。1回だけ呼ぶ
  //   o.onLog(kind, info)：記録用（kind：dup・stale・fresh・close・reading・error・poke・timeup）
  //   o.onTick(info)：0.5秒ごと（info：track の info と、run：いま続いている回数）
  //   → { stop() }（止めると、onDone は呼ばない）
  function check(o) {
    const cfg = o.cfg || {};
    const j = judge(cfg, o.found, {});
    const log = (kind, info) => { if (typeof o.onLog === "function") o.onLog(kind, info || {}); };
    let done = false;
    let t = null;
    const finish = (d) => {
      if (done) return;
      done = true;
      if (t) t.stop();
      o.onDone(d);
    };
    t = track({
      cfg, geo: o.geo, limit: true,
      onDuplicate: (r) => log("dup", { r }),
      onPosition(r) {
        const obs = Object.assign(classify(o.parks, r.lat, r.lon, r.accuracy, cfg), { ts: r.ts });
        const d = j.feed(obs, r.at);
        if (d && d.skip === "stale") {
          log("stale", { r, obs, age: d.age });
          return;
        }
        t.fresh();
        log("fresh", { r, obs });
        if (d && d.skip === "close") {
          log("close", { r, obs, since: d.since });
          return;
        }
        log("reading", { r, obs, run: j.run() });
        if (d) finish(d);
      },
      onError(err, source, fatal) {
        log("error", { err, source });
        if (fatal) finish({ result: "error", code: 1 });
      },
      onTimeUp(info) {
        if (done) return;
        let d = j.finish();
        if (d.result === "noReading") d = { result: "error", code: info.unavailable ? 2 : 3, noAnswer: !info.answered };
        log("timeup", { d });
        finish(d);
      },
      onPoke: () => log("poke"),
      onTick: () => { if (!done && typeof o.onTick === "function") o.onTick(Object.assign(t.info(), { run: j.run() })); },
    });
    return {
      stop() {
        done = true;
        t.stop();
      },
    };
  }

  // 「やめる」を出すか：測り始めてから cancelAfter たっても、位置も返事も届いていない
  //   押したときは、時間切れと同じ扱いにする（CANCELLED の結果。取得失敗・時間切れの文と案内）
  function cancelable(info, cfg) {
    const after = Number(cfg.cancelAfter) || 15000;
    return Boolean(info && !info.first && Date.now() - info.started >= after);
  }
  const cancelled = () => ({ result: "error", code: 3, noAnswer: true, cancelled: true });

  // この端末・このページで位置情報を使えるか（https:// で開いた公開ページなど）
  function usable(nav, win) {
    return Boolean(nav && nav.geolocation) && (!win || win.isSecureContext !== false);
  }

  window.GEO = {
    hide, unhide, distance, parsePoint, parksFrom, readParks, nearest, kindOf, classify,
    judge, missStep, hintFor, lineFor, isStale, track, check, usable, cancelable, cancelled,
  };
})();
