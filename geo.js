/* ================================================================
   geo.js ― 公園で「気配」を探す仕組み（GPSヒント機能）
   ----------------------------------------------------------------
   ・今は、テストページ（gps-test.html）だけが読みこみます。
     本編（index.html）への組み込みは、あとで行います（第4段階）。
   ・設定値・公園の判定点・表示の文は、下の GEO_SETTINGS の1か所にまとめています。
   ・公園の座標は、平文では書きません。駅名・公園名と同じ「表示用に隠す」形
     （"~" で始まる文字）で書きます。engine.js と同じ方式なので、同じ文字を読めます。
     作り方：本編を ?debug 付きで開き、🛠 →「表示用に隠す」に「緯度,経度」の形
     （例：12.345678,123.456789）で入れて、出てきた "~…" を points に貼りつける。
   ・現在地は、保存も、外部への送信もしません。距離の計算は、この端末の中だけで行います。
   ================================================================ */

// ---------------- 設定値（あとで変えられる） ----------------
const GEO_SETTINGS = {
  radius: 50,          // 判定する点からの半径（m）。この内側を「範囲内」とする
  accuracy: 30,        // 位置の精度（accuracy）の上限（m）。これより粗い位置では、見つけたことにしない
  streak: 2,           // 範囲内（または範囲外）が何回続いたら、結果を決めるか
  minGap: 2000,        // 続けて数える読み取りの間隔（ミリ秒）。前の読み取りから、これ以上あとに測った位置だけ数える
                       // （近すぎる位置は、判定に使わない。iPhone は2つの位置を同時に届けることがある。10/31 の実機で確認）
  need: 3,             // 気配を見つける必要がある公園の数。この数に達したら、3-2（リーフィア）へ進む
  timeout: 15000,      // 1回の確認で、位置を測り続ける時間（ミリ秒）。最初の位置（または返事）が届いてから数える
  poorAccuracy: 300,   // 精度がこれより粗いときは、「正確な位置情報」がオフかもしれないと案内する（m）
  highAccuracy: true,  // enableHighAccuracy（GPS を使って、細かく測る）
  maximumAge: 0,       // 前に測った位置を使い回さない（ミリ秒）
  staleAfter: 10000,   // これより前に測った位置（ミリ秒）は、届いても数えない
                       // （maximumAge: 0 でも、iPhone は数十秒前の位置を届けることがある。10/31 の実機で確認）
  manualAfter: 3,      // 「気配を見つけたことにする」を出すまでに、続けて見つからなかった回数（気配なし・位置がはっきりしない）
                       // （エラーのときは、1回目から出す）

  // ---- 公園と、判定する点 ----
  //  points：判定する点（1〜3点）。どの点で見つけても、同じ1公園として数える
  //          （大きい公園は、入口ごとに点を書く）
  //  label ：テストページの表に出す名前（本編には出さない）。本当の公園名は書かない
  //  draft ：true は【仮】の点（座標をいただくまでの置き場所）。今は全部、本当の座標（10/31 にいただいた）
  parks: [
    { id: "parkA", label: "公園A", points: ["~VlBYUFwcVkBXTVxRVVhUVhxXRVQ="] },
    { id: "parkB", label: "公園B", points: ["~VlBYUFwcV0VTTVxRVVhUVh1UQFM="] },
    { id: "parkC", label: "公園C", points: ["~VlBYUFwfU0tQTVxRVVhUVh1cQlw="] },
    { id: "parkD", label: "公園D", points: ["~VlBYUFwdUUVcTVxRVVhUVhhWRF0="] },
    { id: "parkE", label: "公園E", points: ["~VlBYUF0VU0ZUTVxRVVhUVhlVSlQ="] },
    { id: "parkF", label: "公園F", points: ["~VlBYUF0aUUFRTVxRVVhUVhtWQV0="] },
    { id: "parkG", label: "公園G", points: ["~VlBYUFwcVkJXTVxRVVhUVhVTQFQ="] },
    { id: "parkH", label: "公園H", points: ["~VlBYUFweUkNcTVxRVVhUVhVXRVc="] },
    { id: "parkI", label: "公園I（入口3つ）", points: ["~VlBYUFwbV0dWTVxRVVhUVhtTQVY=", "~VlBYUFwZU0BRTVxRVVhUVhVQR1w=", "~VlBYUFwYVEVVTVxRVVhUVhtcSlM="] },
  ],

  // ---- 表示の文【仮】（設計書の側で決める） ----
  text: {
    // n公園目に見つけたとき（文が足りない分は、最後の文をくり返す）
    found: [
      "イーブイ：近くに草の気配がする！　リーフィア、このあたりを通ったんだ。",
      "イーブイ：また草の気配！　さっきより強くなってる。",
    ],
    reached: "イーブイ：すごく強い気配……すぐそこにいる！",           // 必要な数に達したとき
    none: "イーブイ：このあたりには、気配がないみたい。",               // 気配なし
    unclear: "イーブイ：気配がうまくつかめない。空の見える所で、もう一度ためしてみて。", // 位置がはっきりしない
    already: "イーブイ：ここの気配は、もう見つけた。ほかの公園を探してみよう。",       // もう数えた公園
  },
};


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

  // GEO_SETTINGS.parks の形の一覧を読む → { parks: [{ id, label, draft, points: [{ lat, lon }] }], problems: [文] }
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

  // n公園目に見つけたときの文（必要な数に達したら reached）
  function hintFor(n, cfg) {
    const t = cfg.text || {};
    if (n >= cfg.need) return t.reached || "";
    const list = Array.isArray(t.found) ? t.found : [];
    return list.length ? list[Math.min(Math.max(n, 1), list.length) - 1] : "";
  }

  // 測った時刻 ts が、いま（now）より staleAfter より前なら、古い位置（数えない）
  //   時計のずれで ts が先になったときは、新しい位置として扱う
  function isStale(ts, now, cfg) {
    const limit = Number(cfg.staleAfter) || 0;
    return limit > 0 && Number.isFinite(ts) && now - ts > limit;
  }

  window.GEO = { settings: GEO_SETTINGS, hide, unhide, distance, parsePoint, readParks, nearest, kindOf, classify, judge, missStep, hintFor, isStale };
})();
