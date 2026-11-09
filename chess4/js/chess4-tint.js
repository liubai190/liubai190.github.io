/*!
 * chess4-tint.js —— 四界大战 · 棋子运行时着色
 *
 * 为什么要运行时着色：棋子图是「浅木圆盘 + 外环 + 一个字的墨」一起烘死的位图，
 * 四家的盘面其实只有两套 ——
 *   r_ 组 = 粉盘（红方素材，也当右家用）
 *   b_ 组 = 黄盘（黑方素材，也当左家用）
 * 如果按颜色预烘，6 个候选色 × 2 组 × 7 枚 = 84 张图，还得进离线包；
 * 以后再加色更没边。所以把 _cc4_assets.py 里那套 recolor 算法
 * （「源像素 + a×(新墨 − 旧墨)」，只动字）搬到这里，颜色当参数传。
 *
 * 两条硬约束（2026-11-09 定的）：
 *   ① **只动字，盘面和外环一个像素都不碰。** 曾试过让外环跟着字色旋转，
 *      用户看到第一眼就说「外环不要，太丑了」，所以那段逻辑已整个删掉，
 *      别再往回调。
 *   ② 红、黑两家的墨色写死在素材里，不进调色范围（棋种约定，红了帅黑了将）。
 *
 * 模块接口：
 *   C4Tint.PALETTE / PRESETS / MIN_DE      常量
 *   C4Tint.palette(name)                   按色名取 {name, ink, ui}
 *   C4Tint.deltaE(hex1, hex2) / contrast(hex, bgRgb)
 *   C4Tint.build(imgs, done)               用已加载的 Image 建模型（异步回调）
 *   C4Tint.sheets(side, hex)               返回 7 张已着色的 canvas；未就绪时 null
 *   C4Tint.plate(side)                     该侧圆盘代表色（给色板标对比度用）
 */
(function () {
  'use strict';

  var TYPES = ['j', 's', 'x', 'c', 'm', 'p', 'z'];
  // 字形来源，按内部编号：0 红(下) / 1 黑(上) / 2 左家 / 3 右家
  var PREFIX = ['r_', 'b_', 'b_', 'r_'];
  var SIZE = 116;                          // 素材边长，与 PIECE=58 的 2 倍一致

  // 红、黑的墨色（与素材一致），只用于对比度计算与界面色
  var FIXED_INK = ['#a90200', '#0b0508'];
  var FIXED_UI = ['#d6503f', '#ffffff'];

  /*
   * 六个候选色。ink = 棋子上的字墨；ui = 界面上写色名用的提亮版。
   * 为什么分两套：面板是深木底（亮度 ~45），字墨直接搬上去看不见；
   * ui 色统一提到 L*=57、彩度收到 34，对深底对比度 4.78:1（原 --teal 是 6.48）。
   * ink 那列对自家圆盘的对比度见各条目注释，全部 ≥3.4（大字门槛 3:1）。
   */
  var PALETTE = [
    { name: '黄绿', ink: '#414500', ui: '#8c8c4e' },   // 对粉盘 5.0 / 对黄盘 6.4
    { name: '绿',   ink: '#005d32', ui: '#55966c' },   // 4.7 / 6.0
    { name: '青',   ink: '#00656b', ui: '#45949a' },   // 3.4 / 4.4
    { name: '蓝',   ink: '#00527b', ui: '#568dbb' },   // 3.8 / 4.9
    { name: '蓝紫', ink: '#504c90', ui: '#8981bc' },   // 5.3 / 6.8
    { name: '紫红', ink: '#6b2455', ui: '#b5749d' }    // 6.7 / 8.6
  ];

  // 四组预设。默认「青 · 紫红」（2026-11-09 用户定：「把四组预设"青 · 紫红"设成默认配色」）。
  var PRESETS = [
    { name: '黄绿 · 蓝紫', left: '黄绿', right: '蓝紫' },
    { name: '绿 · 紫红',   left: '绿',   right: '紫红' },
    { name: '黄绿 · 蓝',   left: '黄绿', right: '蓝' },
    { name: '青 · 紫红',   left: '青',   right: '紫红' }
  ];
  var DEFAULT_SCHEME = { left: '青', right: '紫红' };

  /*
   * 左右两家的色差门槛。现在这对（青 #008080 / 蓝 #1b536f）的 ΔE 是 28.9，
   * 用户的原话是「区分度不是很大」—— 所以取 28 作下限：比它还糊的搭配，
   * 另一侧的同名色直接划掉、点不动。
   */
  var MIN_DE = 28;

  // ------------------------------------------------------------ 颜色数学
  function hex2rgb(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function srgb2lin(v) {
    v = v / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function rgb2lab(rgb) {
    var r = srgb2lin(rgb[0]), g = srgb2lin(rgb[1]), b = srgb2lin(rgb[2]);
    var x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    var y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
    var z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    var d = 6 / 29;
    function f(t) { return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29; }
    var fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function deltaE(h1, h2) {
    var a = rgb2lab(hex2rgb(h1)), b = rgb2lab(hex2rgb(h2));
    return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2));
  }
  function relLum(rgb) {
    function f(v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function contrast(h, bgRgb) {
    var a = relLum(hex2rgb(h)), b = relLum(bgRgb);
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }
  function lum3(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  function byName(nm) {
    for (var i = 0; i < PALETTE.length; i++) if (PALETTE[i].name === nm) return PALETTE[i];
    return PALETTE[0];
  }

  // ------------------------------------------------------------ 模型
  var MODELS = {};          // 'r_' / 'b_' -> model
  var off = null, octx = null;

  function imgData(img) {
    if (!off) {
      off = document.createElement('canvas');
      off.width = off.height = SIZE;
      octx = off.getContext('2d', { willReadFrequently: true });
    }
    octx.clearRect(0, 0, SIZE, SIZE);
    octx.drawImage(img, 0, 0, SIZE, SIZE);
    return octx.getImageData(0, 0, SIZE, SIZE).data;
  }

  /**
   * 建一套字形模型。七个字的图都是同一个圆盘、同一圈外环，只有中间的字不同，
   * 所以「跨 7 枚逐像素取 max」拿到的就是不含字的底版（P/mx）。
   * 有了底版，字的浓度 a 就能从「原像素比底版暗多少」反推出来。
   */
  function buildModel(imgs, pref) {
    var datas = [], k;
    for (k = 0; k < TYPES.length; k++) datas.push(imgData(imgs[pref + TYPES[k]]));

    var NP = SIZE * SIZE, N = TYPES.length;
    var mx = new Float32Array(NP * 3);
    var alpha = new Uint8ClampedArray(NP);

    for (k = 0; k < N; k++) {
      var d = datas[k];
      for (var i = 0; i < NP; i++) {
        var o = i * 4;
        for (var c = 0; c < 3; c++) { var v = d[o + c]; if (v > mx[i * 3 + c]) mx[i * 3 + c] = v; }
      }
      if (k === 0) for (i = 0; i < NP; i++) alpha[i] = d[i * 4 + 3];
    }

    var Lmx = new Float32Array(NP);
    for (i = 0; i < NP; i++) Lmx[i] = lum3(mx[i * 3], mx[i * 3 + 1], mx[i * 3 + 2]);

    // 不透明像素 = 棋子本体；圆心与半径按 alpha>128 的外接圆估
    var solid = new Uint8Array(NP);
    var sx = 0, sy = 0, cnt = 0, x, y;
    for (y = 0; y < SIZE; y++) for (x = 0; x < SIZE; x++) {
      i = y * SIZE + x;
      if (alpha[i] > 200) solid[i] = 1;
      if (alpha[i] > 128) { sx += x; sy += y; cnt++; }
    }
    var cx = sx / cnt, cy = sy / cnt;

    var dist = new Float64Array(NP), tmp = [];
    for (y = 0; y < SIZE; y++) for (x = 0; x < SIZE; x++) {
      i = y * SIZE + x;
      dist[i] = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (alpha[i] > 128) tmp.push(dist[i]);
    }
    tmp.sort(function (a, b) { return a - b; });
    var R = tmp[Math.floor(tmp.length * 0.995)];

    // 按到圆心的距离分 64 档，每档取中位色 —— 得到「同心圆结构」的干净底版
    var NB = 64;
    var band = new Int32Array(NP);
    for (i = 0; i < NP; i++) band[i] = Math.min(NB - 1, Math.max(0, Math.floor(dist[i] / R * NB)));

    var bucket = [], b, c2;
    for (b = 0; b < NB; b++) bucket.push([[], [], []]);
    for (i = 0; i < NP; i++) {
      if (!solid[i]) continue;
      var bb = band[i];
      bucket[bb][0].push(mx[i * 3]); bucket[bb][1].push(mx[i * 3 + 1]); bucket[bb][2].push(mx[i * 3 + 2]);
    }
    var bandrgb = new Float32Array(NB * 3), good = [];
    for (b = 0; b < NB; b++) {
      if (bucket[b][0].length >= 12) {
        for (c2 = 0; c2 < 3; c2++) {
          var arr = bucket[b][c2].sort(function (p, q) { return p - q; });
          bandrgb[b * 3 + c2] = arr[arr.length >> 1];
        }
        good.push(b);
      }
    }
    for (b = 0; b < NB; b++) {
      if (bucket[b][0].length >= 12) continue;
      var best = good[0];
      for (var g = 0; g < good.length; g++) if (Math.abs(good[g] - b) < Math.abs(best - b)) best = good[g];
      for (c2 = 0; c2 < 3; c2++) bandrgb[b * 3 + c2] = bandrgb[best * 3 + c2];
    }
    // 半窗 2 档滑动中位，抹掉残余的档间跳变
    var sm = new Float32Array(NB * 3);
    for (b = 0; b < NB; b++) {
      for (c2 = 0; c2 < 3; c2++) {
        var win = [], kk;
        for (kk = Math.max(0, b - 2); kk <= Math.min(NB - 1, b + 2); kk++) win.push(bandrgb[kk * 3 + c2]);
        win.sort(function (p, q) { return p - q; });
        sm[b * 3 + c2] = win[win.length >> 1];
      }
    }
    for (i = 0; i < NB * 3; i++) bandrgb[i] = sm[i];

    // 补洞：比同档底版还暗 45 以上的像素是字，拿同档底版色填回去
    var P = mx.slice();
    for (i = 0; i < NP; i++) {
      if (!solid[i]) continue;
      var bi = band[i];
      var plateL = lum3(bandrgb[bi * 3], bandrgb[bi * 3 + 1], bandrgb[bi * 3 + 2]);
      if (Lmx[i] < plateL - 45) {
        P[i * 3] = bandrgb[bi * 3]; P[i * 3 + 1] = bandrgb[bi * 3 + 1]; P[i * 3 + 2] = bandrgb[bi * 3 + 2];
      }
    }

    /*
     * 旧墨：必须从「原图像素」里取内圈最暗的 2%，不能拿 P / mx 去取 ——
     * 那两样已经是盘面（字被填掉了），按它取最暗只会拿到盘面上最暗的一圈，
     * 算出来的旧墨是棕色的，整套着色就全偏了（10-09 踩过这个坑）。
     */
    var core = [];
    for (k = 0; k < N; k++) {
      var dk = datas[k];
      for (i = 0; i < NP; i++) {
        if (!solid[i] || dist[i] >= 0.78 * R) continue;
        var ok = i * 4;
        core.push([lum3(dk[ok], dk[ok + 1], dk[ok + 2]), dk[ok], dk[ok + 1], dk[ok + 2]]);
      }
    }
    core.sort(function (a, b2) { return a[0] - b2[0]; });
    var take = Math.max(30, Math.floor(core.length * 0.02));
    var ir = 0, ig = 0, ib = 0;
    for (k = 0; k < take; k++) { ir += core[k][1]; ig += core[k][2]; ib += core[k][3]; }
    var ink = [ir / take, ig / take, ib / take];

    // 盘面代表色：字所在那一圈的色环中位（0.28R ~ 0.68R）
    var lo = Math.floor(0.28 * NB), hi = Math.floor(0.68 * NB);
    var plate = [0, 0, 0];
    for (c2 = 0; c2 < 3; c2++) {
      var pr = [];
      for (b = lo; b <= hi; b++) pr.push(bandrgb[b * 3 + c2]);
      pr.sort(function (p, q) { return p - q; });
      plate[c2] = pr[pr.length >> 1];
    }

    return {
      datas: datas, P: P, alpha: alpha, solid: solid, band: band, dist: dist,
      NP: NP, ink: ink, plate: plate, R: R
    };
  }

  /**
   * 把模型里每个像素的字墨换成 hex。
   * a（这条像素有多「像个字」）由「底版亮度 − 原像素亮度」除以「底版亮度 − 旧墨亮度」得到，
   * 再乘一道「底版本身太暗的地方不算字」的闸门 g，避免把外环暗部也当成字。
   * 盘面与外环走不到这条分支（a 会被闸门压成 0），所以它们一个像素都不会变。
   */
  function tintModel(model, hex) {
    var datas = model.datas, solid = model.solid, P = model.P, NP = model.NP, ink = model.ink;
    var ni = hex2rgb(hex);
    var Lp = new Float32Array(NP), i;
    for (i = 0; i < NP; i++) Lp[i] = lum3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    var Link = lum3(ink[0], ink[1], ink[2]);
    var out = [];

    for (var k = 0; k < datas.length; k++) {
      var d = datas[k];
      var buf = new Uint8ClampedArray(d);
      for (i = 0; i < NP; i++) {
        if (!solid[i]) continue;
        var o = i * 4;
        var L = lum3(d[o], d[o + 1], d[o + 2]);
        var a = (Lp[i] - L) / Math.max(Lp[i] - Link, 40);
        a = Math.max(0, Math.min(1, a));
        a = Math.max(0, Math.min(1, (a - 0.10) / 0.90));
        a = a * a * (3 - 2 * a);                 // smoothstep，边缘过渡更自然
        var g = (Lp[i] - Link - 40) / 40;
        g = Math.max(0, Math.min(1, g));
        a *= g;
        if (a <= 0) continue;
        buf[o] = d[o] + a * (ni[0] - ink[0]);
        buf[o + 1] = d[o + 1] + a * (ni[1] - ink[1]);
        buf[o + 2] = d[o + 2] + a * (ni[2] - ink[2]);
      }
      out.push(buf);
    }
    return out;
  }

  var sheetCache = {};      // '2#00656b' -> canvas[]

  /**
   * 取某一侧的 7 张棋子图（按 TYPES 顺序，索引 0..6 对应 j/s/x/c/m/p/z）。
   * 返回 HTMLCanvasElement[]，可直接 drawImage。模型没建好时返回 null，
   * 调用方应当退回原图。
   */
  function sheets(side, hex) {
    if (side !== 2 && side !== 3) return null;   // 红黑不参与调色
    var model = MODELS[PREFIX[side]];
    if (!model) return null;
    var key = side + '#' + hex;
    var got = sheetCache[key];
    if (got) return got;
    var bufs = tintModel(model, hex);
    var arr = [];
    for (var i = 0; i < bufs.length; i++) {
      var cv = document.createElement('canvas');
      cv.width = cv.height = SIZE;
      cv.getContext('2d').putImageData(new ImageData(bufs[i], SIZE, SIZE), 0, 0);
      arr.push(cv);
    }
    sheetCache[key] = arr;
    return arr;
  }

  function plateOf(side) {
    var m = MODELS[PREFIX[side]];
    return m ? m.plate : [233, 171, 126];
  }

  var ready = false, lastError = '';

  /**
   * 用已经加载好的 Image 建模型。imgs 是 ui.js 里那个 { 'r_j': Image, ... } 字典。
   * 同步建（两张图 × 7 枚 × 1.3 万像素，实测量级是几十毫秒），建完回调。
   */
  function build(imgs, done) {
    try {
      MODELS.r_ = buildModel(imgs, 'r_');
      MODELS.b_ = buildModel(imgs, 'b_');
      ready = true;
      lastError = '';
    } catch (e) {
      ready = false;
      lastError = (e && (e.name + ': ' + e.message)) || String(e);
      if (window.console) console.warn('[chess4] 棋子模型构建失败，退回原始素材', e);
    }
    if (done) done(ready);
  }

  window.C4Tint = {
    PALETTE: PALETTE,
    PRESETS: PRESETS,
    DEFAULT_SCHEME: DEFAULT_SCHEME,
    MIN_DE: MIN_DE,
    FIXED_INK: FIXED_INK,
    FIXED_UI: FIXED_UI,
    palette: byName,
    deltaE: deltaE,
    contrast: contrast,
    hex2rgb: hex2rgb,
    plate: plateOf,
    sheets: sheets,
    build: build,
    error: function () { return lastError; },
    isReady: function () { return ready; }
  };
})();
