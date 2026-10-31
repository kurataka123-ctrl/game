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
  need: 3,             // 気配を見つける必要がある公園の数。この数に達したら、3-2（リーフィア）へ進む
  timeout: 15000,      // 1回の確認で、位置を測り続ける時間（ミリ秒）。最初の位置（または返事）が届いてから数える
  poorAccuracy: 300,   // 精度がこれより粗いときは、「正確な位置情報」がオフかもしれないと案内する（m）
  highAccuracy: true,  // enableHighAccuracy（GPS を使って、細かく測る）
  maximumAge: 0,       // 前に測った位置を使い回さない（ミリ秒）

  // ---- 公園と、判定する点 ----
  //  points：判定する点（1〜3点）。どの点で見つけても、同じ1公園として数える
  //          （大きい公園は、入口ごとに点を書く）
  //  label ：テストページの表に出す名前（本編には出さない）。本当の公園名は書かない
  //  draft ：true は【仮】の点。座標をいただくまでの置き場所で、赤道上の海の上にある（どこからも遠い）
  parks: [
    { id: "park1", label: "公園1（入口3つ）", draft: true, points: ["~VUtGVVUdVEJJUUNVVUZVVR0=", "~VUtGVVUdVEJJUUNVVUdVVR0=", "~VUtGVVUdVEJJUUNVVURVVR0="] },
    { id: "park2", label: "公園2", draft: true, points: ["~VUtGVFUdVEJJUUNVVUZVVR0="] },
    { id: "park3", label: "公園3", draft: true, points: ["~VUtGV1UdVEJJUUNVVUZVVR0="] },
    { id: "park4", label: "公園4", draft: true, points: ["~VUtGVlUdVEJJUUNVVUZVVR0="] },
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
  //     unclear（範囲内が一度でもあった・精度不足だけだった）/ none（範囲外だけだった）/ noReading（位置が1つも来なかった）
  //   found：もう数えた公園の id の一覧
  function judge(cfg, found, opts) {
    const done = new Set(Array.isArray(found) ? found : []);
    const watch = Boolean(opts && opts.watch);
    const need = Math.max(1, Number(cfg.streak) || 1);
    let run = { kind: "", park: null, n: 0 };
    let readings = 0;
    let sawIn = false;
    let lastGood = null;    // 精度が足りた（in・out）最後の読み取り
    let best = Infinity;    // いちばん良かった精度（m）
    return {
      feed(obs) {
        readings += 1;
        if (Number.isFinite(obs.accuracy)) best = Math.min(best, obs.accuracy);
        if (obs.kind === "in") sawIn = true;
        if (obs.kind !== "poor") lastGood = obs;
        const same = run.kind === obs.kind && (obs.kind !== "in" || run.park === obs.park);
        run = same ? { kind: run.kind, park: run.park, n: run.n + 1 } : { kind: obs.kind, park: obs.park, n: 1 };
        // ちょうど streak 回になったときだけ決める（監視モードで、同じ知らせを何度も出さないため）
        if (run.n !== need) return null;
        if (obs.kind === "in") return Object.assign({ result: done.has(obs.park) ? "already" : "found" }, obs);
        if (obs.kind === "out" && !watch) return Object.assign({ result: "none" }, obs);
        return null;
      },
      finish() {
        if (!readings) return { result: "noReading" };
        if (lastGood && !sawIn) return Object.assign({ result: "none" }, lastGood, { best });
        return { result: "unclear", best, sawIn, lastGood };
      },
      run: () => Object.assign({}, run, { need }),
    };
  }

  // n公園目に見つけたときの文（必要な数に達したら reached）
  function hintFor(n, cfg) {
    const t = cfg.text || {};
    if (n >= cfg.need) return t.reached || "";
    const list = Array.isArray(t.found) ? t.found : [];
    return list.length ? list[Math.min(Math.max(n, 1), list.length) - 1] : "";
  }

  window.GEO = { settings: GEO_SETTINGS, hide, unhide, distance, parsePoint, readParks, nearest, kindOf, classify, judge, hintFor };
})();
