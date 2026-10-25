// ================================================================
//  house.js ― 夢の舞台の地図（家の部屋を、升目にしたもの）
// ----------------------------------------------------------------
//  第1部で歩くマップ（氷の洞窟・花畑・小道・光の広場）と、
//  2-7 の「家全体の地図」（作る順番5で作る）に使います。
//
//  ※ 2026年10月25日にいただいた間取り図（家具を四角で描いたもの）から作りました。
//     家具の位置が分かる程度に、簡単にしています。
//     間取り図そのものは、このリポジトリに入れないでください。
//  ※ 図面を左へ90度回した向きです（room.js の夢の部屋と同じ向き）。
//     2-7 で家全体をつなぐとき、向きがそろっている必要があるためです。
//
//  【升目の決まり】
//    1マス ＝ およそ45cm（room.js の2マス分）。
//    x は左から右へ、y は上から下へ、0 から数えます。
//    w, h : 部屋の横幅と縦の長さ（マス）
//    at   : 家全体の地図での、部屋の左上の位置（2-7 で使う）
//
//  【見た目は2組】
//    nature : 第1部（夢の中）の見た目。自然のものに置きかえる
//    home   : 2-7 で正体が分かったときの見た目（本当の家具）
//    片方だけ書いた家具は、もう片方の見た目では出ません。
//    floor（床）と wall（かべ）は、見た目の種類の名前です（style.css で色を決める）。
//
//  【家具（items）】
//    x, y, w, h : 家具の左上の位置と大きさ（マス）。家具のマスは通れません
//    name / icon / color : 名前・絵文字・色
//    text  : 第1部で、目の前を調べたときの文章（書かなければ「〇〇だ。」）
//    look  : 特別な描き方（"stump" 切り株の年輪 / "fog" 霧）
//
//  【かべの出入口・窓（edges）】 書かなかった所は、ただのかべです
//    side  : top（上）/ bottom（下）/ left（左）/ right（右）
//    cells : その辺の何マス目か（上・下の辺は x、左・右の辺は y）
//    id    : 通り抜けられる出入口の名前。何が起きるかは data.js の events の door で決める
//    kind  : 見た目の種類（gate 木の門 / door 扉 / open 通り道 / cave 洞窟の入口 /
//            icedoor 氷の扉 / sun 日だまり / light 光のすき間 / fog 霧 / thicket いばら /
//            window 窓 / sliding ふすま / closet 物入れ）
//
//  人物（ニンフィアなど）を置く場所は、data.js の各場面の events に書きます。
// ================================================================
const HOUSE = {
  maps: {

    // ---- 1-1 はじまりの森（ベランダ） ----
    //  今は会話だけで、歩かない。2-7 の家全体の地図で使う
    forest: {
      at: [25, 0], w: 2, h: 13,
      nature: { name: "はじまりの森", floor: "grass", wall: "trees" },
      home:   { name: "ベランダ", floor: "balcony", wall: "wall" },
      edges: [
        { side: "left", cells: [2, 3, 4, 5],
          nature: { kind: "thicket", name: "いばらの茂み", text: "いばらの茂みだ。奥から、花の香りがする。" },
          home:   { kind: "window", name: "リビングの窓" } },
        { side: "left", cells: [8, 9, 10, 11], id: "washitsu",
          nature: { kind: "cave", name: "洞窟の入口", text: "ひんやりした風が吹いてくる。" },
          home:   { kind: "window", name: "和室の窓" } },
      ],
      items: [],
    },

    // ---- 1-2 氷の洞窟（和室） ----
    //  氷の床の岩は、パズルの都合で data.js の ice に書く（外形と出入口だけを和室に合わせる）
    washitsu: {
      at: [16, 7], w: 9, h: 6,
      nature: { name: "氷の洞窟", floor: "ice", wall: "icewall" },
      home:   { name: "和室", floor: "tatami", wall: "wall" },
      edges: [
        { side: "right", cells: [1, 2, 3, 4], id: "forest",
          nature: { kind: "cave", name: "洞窟の入口", text: "外の光が差しこんでいる。ここから入ってきた。" },
          home:   { kind: "window", name: "ベランダの窓" } },
        { side: "top", cells: [2, 3], id: "living",
          nature: { kind: "icedoor", name: "氷の扉", text: "氷でふさがれた戸口だ。向こうから、花の香りがする。" },
          home:   { kind: "sliding", name: "リビングとの間のふすま" } },
        { side: "top", cells: [4, 5],
          home:   { kind: "sliding", name: "リビングとの間のふすま" } },
        { side: "left", cells: [2, 3, 4, 5],
          home:   { kind: "closet", name: "押し入れ" } },
      ],
      items: [
        { x: 8, y: 5, w: 1, h: 1,
          nature: { name: "氷の柱", color: "#e3f6ff", text: "太い氷の柱だ。" },
          home:   { name: "柱", color: "#d6cec2" } },
        { x: 4, y: 4, w: 4, h: 2,
          home:   { name: "ピアノ", icon: "🎹", color: "#4a4a58" } },
      ],
    },

    // ---- 1-3 ニンフィアの花畑（リビング・ダイニング・キッチン） ----
    living: {
      at: [11, 0], w: 14, h: 7,
      nature: { name: "ニンフィアの花畑", floor: "flowers", wall: "hedge" },
      home:   { name: "リビング", floor: "wood", wall: "wall" },
      edges: [
        { side: "left", cells: [5, 6], id: "path",
          nature: { kind: "gate", name: "木の門", text: "生け垣のあいだの、木の門だ。" },
          home:   { kind: "door", name: "ろうかへのドア" } },
        { side: "bottom", cells: [7, 8], id: "washitsu",
          nature: { kind: "open", name: "洞窟への道", text: "ひんやりした風が吹いてくる。グレイシアの洞窟だ。" },
          home:   { kind: "sliding", name: "和室のふすま" } },
        { side: "bottom", cells: [9, 10],
          home:   { kind: "sliding", name: "和室のふすま" } },
        { side: "bottom", cells: [3],
          home:   { kind: "closet", name: "物入れ" } },
        { side: "right", cells: [2, 3, 4, 5],
          nature: { kind: "sun", name: "日だまり", text: "あたたかい光が差しこんでいる。" },
          home:   { kind: "window", name: "ベランダの窓" } },
      ],
      items: [
        { x: 0, y: 0, w: 1, h: 2,
          nature: { name: "氷のかたまり", icon: "🧊", color: "#d9f2ff", text: "大きな氷のかたまりだ。さわると、ひんやりする。" },
          home:   { name: "冷蔵庫", color: "#eef1f4" } },
        { x: 0, y: 2, w: 1, h: 3,
          nature: { name: "木の実の茂み", icon: "🍒", color: "#86b46a", text: "赤い木の実が、たくさんなっている。" },
          home:   { name: "キッチン", icon: "🍳", color: "#e9dcc8" } },
        { x: 3, y: 0, w: 2, h: 5,
          nature: { name: "小川", icon: "💧", color: "#a5dcf6", text: "冷たい水が、さらさら流れている。" },
          home:   { name: "流し台", icon: "🚰", color: "#d5dbe0" } },
        { x: 5, y: 2, w: 3, h: 2,
          nature: { name: "切り株", look: "stump", color: "#c49b64", text: "大きな切り株だ。年輪がくっきり見える。" },
          home:   { name: "テーブル", icon: "🍽️", color: "#c9a274" } },
        { x: 8, y: 0, w: 4, h: 2,
          nature: { name: "平たい大岩", icon: "🪨", color: "#b9bcc2", text: "平たくて大きな岩だ。上で遊べそうだ。" },
          home:   { name: "テレビ", icon: "📺", color: "#5b6270" } },
        { x: 9, y: 3, w: 3, h: 2,
          nature: { name: "切り株", look: "stump", color: "#c49b64", text: "低い切り株だ。まわりに花がたくさん咲いている。" },
          home:   { name: "テーブル", icon: "☕", color: "#c9a274" } },
        { x: 9, y: 5, w: 4, h: 2,
          nature: { name: "倒木", icon: "🪵", color: "#a8825a", text: "大きな木が倒れている。腰かけるのに、ちょうどよさそうだ。" },
          home:   { name: "ソファ", icon: "🛋️", color: "#b9a3d6" } },
        { x: 13, y: 0, w: 1, h: 1,
          nature: { name: "大きな木", icon: "🌳", color: "#7cb86a", text: "大きな木だ。" },
          home:   { name: "柱", color: "#d6cec2" } },
      ],
    },

    // ---- 小道（ろうかと玄関） ----
    //  「開かない扉」は、息子さんの部屋のドア（上の辺）。向かいが光の広場の門
    path: {
      at: [1, 5], w: 10, h: 2,
      nature: { name: "生け垣の小道", floor: "trail", wall: "hedge" },
      home:   { name: "ろうか", floor: "wood", wall: "wall" },
      edges: [
        { side: "right", cells: [0, 1], id: "living",
          nature: { kind: "gate", name: "花畑の門", text: "花畑へもどる門だ。" },
          home:   { kind: "door", name: "リビングのドア" } },
        { side: "top", cells: [7], id: "dream",
          nature: { kind: "door", name: "扉", text: "生け垣に、扉が一枚だけはまっている。" },
          home:   { kind: "door", name: "{name}の部屋のドア" } },
        { side: "bottom", cells: [7], id: "plaza",
          nature: { kind: "gate", name: "光のもれる門", text: "門のすき間から、やわらかな光がもれている。" },
          home:   { kind: "door", name: "洋室のドア" } },
        { side: "top", cells: [8],
          home:   { kind: "door", name: "トイレのドア" } },
        { side: "bottom", cells: [9],
          home:   { kind: "door", name: "洗面所のドア" } },
        { side: "left", cells: [0, 1],
          nature: { kind: "fog", name: "白い霧" },
          home:   { kind: "door", name: "玄関のドア" } },
      ],
      items: [
        { x: 0, y: 0, w: 2, h: 2,
          nature: { name: "白い霧", icon: "🌫️", look: "fog", color: "#f3f6fa", text: "白い霧が立ちこめていて、先が見えない。" } },
        { x: 0, y: 0, w: 2, h: 1,
          home:   { name: "くつ箱", icon: "👟", color: "#d8cbb6" } },
      ],
    },

    // ---- 1-4 光の広場（洋室） ----
    plaza: {
      at: [1, 7], w: 8, h: 6,
      nature: { name: "光の広場", floor: "light", wall: "rock" },
      home:   { name: "洋室", floor: "wood", wall: "wall" },
      edges: [
        { side: "top", cells: [7], id: "path",
          nature: { kind: "gate", name: "木の門", text: "小道へもどる門だ。" },
          home:   { kind: "door", name: "ろうかへのドア" } },
        { side: "left", cells: [1, 2, 3],
          nature: { kind: "light", name: "光のすき間", text: "岩のすき間から、やわらかな光が差しこんでいる。" },
          home:   { kind: "window", name: "出窓" } },
        { side: "right", cells: [2, 3, 4, 5],
          home:   { kind: "closet", name: "物入れ" } },
      ],
      items: [
        { x: 0, y: 0, w: 1, h: 1,
          nature: { name: "小さな水晶", icon: "💎", color: "#e8deff", text: "小さな水晶が、ほのかに光っている。" },
          home:   { name: "小タンス", color: "#d9c3a1" } },
        { x: 1, y: 0, w: 2, h: 1,
          nature: { name: "水晶", icon: "💎", color: "#e8deff", text: "大きな水晶だ。のぞきこむと、光がゆらめいた。" },
          home:   { name: "タンス", color: "#c9ab82" } },
        { x: 4, y: 0, w: 2, h: 1,
          nature: { name: "光るキノコ", icon: "🍄", color: "#f5e6ff", text: "キノコが、ぼんやり光っている。" },
          home:   { name: "棚", color: "#d1b48c" } },
        { x: 1, y: 5, w: 3, h: 1,
          nature: { name: "石碑", icon: "🪨", color: "#d3cfdc", text: "古い文字が、びっしり刻まれている。" },
          home:   { name: "本棚", icon: "📚", color: "#c9a274" } },
        { x: 4, y: 5, w: 2, h: 1,
          nature: { name: "光るキノコ", icon: "🍄", color: "#f5e6ff", text: "キノコが、ぼんやり光っている。" },
          home:   { name: "棚", color: "#d1b48c" } },
      ],
    },

    // ---- ここから下は、2-7 の家全体の地図だけで使う場所（第1部では歩かない） ----
    //  夢の部屋（息子さんの部屋）は room.js。家全体では at: [0, 0] の 9×5 マス
    //  （room.js の 18×10 マスを、2マスずつまとめた大きさ）
    toilet: {
      at: [9, 2], w: 2, h: 3,
      home: { name: "トイレ", floor: "tile", wall: "wall" },
      items: [ { x: 0, y: 0, w: 2, h: 1, home: { name: "トイレ", icon: "🚽", color: "#f4f6f8" } } ],
    },
    washroom: {
      at: [9, 7], w: 5, h: 2,
      home: { name: "洗面所", floor: "tile", wall: "wall" },
      edges: [ { side: "bottom", cells: [2, 3], home: { kind: "door", name: "浴室のドア" } } ],
      items: [
        { x: 0, y: 0, w: 1, h: 1, home: { name: "洗面台", icon: "🧼", color: "#eef3f6" } },
        { x: 4, y: 0, w: 1, h: 2, home: { name: "洗濯機", color: "#e3e8ec" } },
      ],
    },
    bath: {
      at: [11, 9], w: 3, h: 4,
      home: { name: "浴室", floor: "tile", wall: "wall" },
      items: [ { x: 0, y: 2, w: 3, h: 2, home: { name: "浴そう", icon: "🛁", color: "#cfe6f7" } } ],
    },
    closet1: { at: [9, 0], w: 2, h: 1, home: { name: "物入れ", floor: "closet", wall: "wall" } },
    closet2: { at: [9, 9], w: 2, h: 4, home: { name: "物入れ", floor: "closet", wall: "wall" } },
    closet3: { at: [14, 9], w: 2, h: 4, home: { name: "押し入れ", floor: "closet", wall: "wall" } },
    closet4: { at: [14, 7], w: 2, h: 2, home: { name: "物入れ", floor: "closet", wall: "wall" } },
  },
};
