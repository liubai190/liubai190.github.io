/*!
 * ink-core.js —— 墨水屏模式（1 位色）公共模块
 *
 * 三个页面（DarkChess / ChessChess / ChineseChess）共用**逐字节相同**的这一份，
 * 改一份必须同步另外两份（和翻棋/串串香那对 CSS 一个规矩）。
 *
 * 为什么棋子要重绘而不是给旧 PNG 调色：
 *   旧棋子是烘焙图（高光、斜边、木纹环），去色之后高光变成白噪点、木纹变成灰雾，
 *   在 1 位色屏上比彩色更脏。
 *
 * 为什么字要走轮廓（glyphs.js）而不是 fillText：
 *   墨水屏设备（Boox / 海信这类 Android）一般只装了 Noto Sans CJK，
 *   没有楷体/宋体，fillText 出来的两边字重不可控，「空心字」更没法控制笔画粗细。
 *
 * 怎么省刷新面积（这是墨水屏最要命的一条）：
 *   墨水屏的残影按「像素变化」算，整屏重写一步就闪一下。
 *   这里用 clip 把本帧与上帧**涉及到的交点**框出来，
 *   绘制调用一个不少，但真正写进画布的像素只剩两个格子左右（约 5%）。
 *   所以调用方不要 clearRect，改成 clip 之后 fillRect 白色。
 */
(function () {
  'use strict';

  var KEY = 'graywood.ink';
  var TAU = Math.PI * 2;

  var cfg = null, on = false, prevPts = [];

  // 字：红方 帅仕相车马炮兵 / 黑方 将士象车马炮卒
  var CH = {
    r: { j: '帅', s: '仕', x: '相', c: '车', m: '马', p: '炮', z: '兵' },
    b: { j: '将', s: '士', x: '象', c: '车', m: '马', p: '炮', z: '卒' }
  };

  // ------------------------------------------------------------ 开关
  function load() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function save(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {} }

  /** 初始化。opts = { type:'flip'|'ccx'|'xiangqi', W, H, cell, piece, xy(i)->[x,y] } */
  function init(opts) {
    cfg = opts;
    var m = null;
    try { m = location.search.match(/[?&]ink=([01])(?=[&#]|$)/); } catch (e) {}
    if (m) save(m[1] === '1');          // URL 参数优先，并记住
    on = load();
    if (on) document.documentElement.classList.add('ink');
    return on;
  }

  function isOn() { return on; }

  /** 开关墨水屏。切换要整页重来：尺寸、背景、面板样式都变了，热切换只会留下半截旧像素 */
  function set(v) {
    save(!!v); on = !!v;
    try { location.reload(); } catch (e) {}
  }
  function toggle() { set(!on); }

  // ------------------------------------------------------------ 字形
  var pathCache = {};

  function pathOf(ch) {
    var G = window.INK_GLYPHS;
    if (!G || !G.g || !G.g[ch]) return null;
    if (!pathCache[ch]) {
      try { pathCache[ch] = new Path2D(G.g[ch].d); } catch (e) { return null; }
    }
    return pathCache[ch];
  }

  /** 画一个字。hollow = 只描边（空心字），fat = 实心字再描一圈当加粗 */
  function glyph(ctx, ch, cx, cy, size, hollow, lw, fat) {
    var p = pathOf(ch);
    if (!p) return;
    var b = window.INK_GLYPHS.g[ch].b;
    var w = Math.max(b[2] - b[0], b[3] - b[1]) || 1;   // 按墨迹长边归一，字与字视觉等大
    var k = size / w;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.translate(-(b[0] + b[2]) / 2, -(b[1] + b[3]) / 2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (hollow) {
      ctx.lineWidth = lw / k;
      ctx.strokeStyle = '#000';
      ctx.stroke(p);
    } else {
      ctx.fillStyle = '#000';
      ctx.fill(p);
      if (fat > 0) { ctx.lineWidth = fat / k; ctx.strokeStyle = '#000'; ctx.stroke(p); }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ 棋子
  /* 方案 C（2026-11-09 用户选定）：两方都是白底细环，靠字重区分 ——
     红方实心黑字，黑方空心字。全程没有大块实心色，墨水屏刷得动。 */
  function piece(ctx, name, cx, cy, d) {
    if (!name) return;
    var side = name.charAt(0) === 'b' ? 'b' : 'r';
    var t = name.charAt(2);
    var ch = CH[side] && CH[side][t];
    if (!ch) return;
    var r = d / 2 - 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = Math.max(1.3, d * 0.030);
    ctx.strokeStyle = '#000';
    ctx.stroke();
    var hollow = side === 'b';
    var gs = d * (hollow ? (cfg && cfg.hollow || 0.70) : (cfg && cfg.filled || 0.60));
    if (hollow) glyph(ctx, ch, cx, cy, gs, true, Math.max(0.95, d * 0.019), 0);
    else glyph(ctx, ch, cx, cy, gs, false, 0, Math.max(0, d * 0.007));
    ctx.restore();
  }

  /** 扣着的子：两方同款（暗棋的信息就藏在「不知道是谁的」里），所以只能有一个样子 */
  function back(ctx, cx, cy, d) {
    var r = d / 2 - 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = Math.max(1.3, d * 0.030);
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, 0, TAU);
    ctx.lineWidth = Math.max(1, d * 0.016);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, d * 0.075), 0, TAU);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------ 高亮（不能靠颜色，只能靠形状）
  function hlSel(ctx, cx, cy, d) {                 // 选中：棋子外一圈虚线
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1.2, d * 0.024);
    ctx.setLineDash([Math.max(3, d * 0.07), Math.max(3, d * 0.05)]);
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2 + Math.max(3.5, d * 0.07), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function hlLast(ctx, cx, cy, cell) {             // 上一步：细方框
    var s = cell * 0.41;
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.3;
    ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
    ctx.restore();
  }

  function hlDot(ctx, cx, cy, d) {                 // 可走的空格：实心小点
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2.6, d * 0.055), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function hlCap(ctx, cx, cy, d) {                 // 可吃：棋子外一圈粗虚线
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(2, d * 0.038);
    ctx.setLineDash([Math.max(4, d * 0.10), Math.max(3, d * 0.07)]);
    ctx.beginPath();
    ctx.arc(cx, cy, d * 0.60, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------ 棋盘（线全部代码画，不缩放位图）
  /* 位图缩放这条路走不通：翻棋在手机上要缩到 0.40 倍，
     原图 3px 的线只剩 1.2px，最近邻会断、插值又冒灰边（1 位色屏上灰边会抖成网点）。
     坐标全部照 img/board.png 量出来的位置。 */
  function line(ctx, x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  function boardFlip(ctx) {
    var G = 28.5, S = 104, i;
    ctx.lineWidth = 1.8;
    for (i = 0; i <= 8; i++) line(ctx, G + i * S, G, G + i * S, G + 4 * S);
    for (i = 0; i <= 4; i++) line(ctx, G, G + i * S, G + 8 * S, G + i * S);
    ctx.lineWidth = 2;
    ctx.strokeRect(14, 14, cfg.W - 28, cfg.H - 28);
  }

  function boardCcx(ctx) {
    var G = 66.5, S = 104, i;
    ctx.lineWidth = 1.8;
    for (i = 0; i <= 8; i++) line(ctx, G + i * S, G, G + i * S, G + 4 * S);
    for (i = 0; i <= 4; i++) line(ctx, G, G + i * S, G + 8 * S, G + i * S);
    // 外框必须让开最外圈棋子：串串香是落交点，边缘棋子有一半探到线外（半径 48）
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, cfg.W - 20, cfg.H - 20);
  }

  // 中象：河界那段最麻烦 —— 中间七条竖线在河界处断开，两边两条贯通
  function boardXiangqi(ctx) {
    var X0 = 29, Y0 = 67, S = 60, i, j;
    ctx.lineWidth = 1.6;
    for (j = 0; j <= 9; j++) line(ctx, X0, Y0 + j * S, X0 + 8 * S, Y0 + j * S);
    for (i = 0; i <= 8; i++) {
      if (i === 0 || i === 8) line(ctx, X0 + i * S, Y0, X0 + i * S, Y0 + 9 * S);
      else {
        line(ctx, X0 + i * S, Y0, X0 + i * S, Y0 + 4 * S);
        line(ctx, X0 + i * S, Y0 + 5 * S, X0 + i * S, Y0 + 9 * S);
      }
    }
    // 九宫
    line(ctx, X0 + 3 * S, Y0, X0 + 5 * S, Y0 + 2 * S);
    line(ctx, X0 + 5 * S, Y0, X0 + 3 * S, Y0 + 2 * S);
    line(ctx, X0 + 3 * S, Y0 + 7 * S, X0 + 5 * S, Y0 + 9 * S);
    line(ctx, X0 + 5 * S, Y0 + 7 * S, X0 + 3 * S, Y0 + 9 * S);
    // 星标：炮位（列 1、7，行 2、7）与兵位（列 0/2/4/6/8，行 3、6）
    var stars = [], r, c;
    for (r = 0; r < 2; r++) for (c = 0; c < 2; c++) stars.push([c ? 7 : 1, r ? 7 : 2]);
    for (r = 0; r < 2; r++) for (c = 0; c < 5; c++) stars.push([c * 2, r ? 6 : 3]);
    ctx.lineWidth = 1.4;
    for (i = 0; i < stars.length; i++) {
      var col = stars[i][0], row = stars[i][1];
      var cx = X0 + col * S, cy = Y0 + row * S;
      var sx, sy;
      for (sx = -1; sx <= 1; sx += 2) for (sy = -1; sy <= 1; sy += 2) {
        if (col === 0 && sx < 0) continue;      // 贴边的省掉朝外那一侧
        if (col === 8 && sx > 0) continue;
        // 拐角**贴着交点**（从 6 起），两条臂背离交点伸到 15.5。
        // 2026-11-10 用户指出原来画反了（拐角在外、开口朝里，像四个小括号朝中心张开）。
        // 照 board.png 量的：拐角距交点心 6、臂端 15.5（原图像素 12 / 31，按 2 倍折算）。
        line(ctx, cx + sx * 6, cy + sy * 6, cx + sx * 15.5, cy + sy * 6);
        line(ctx, cx + sx * 6, cy + sy * 6, cx + sx * 6, cy + sy * 15.5);
      }
    }
    // 外框
    ctx.lineWidth = 2;
    ctx.strokeRect(20.5, 58.5, 497, 557);
    // 河界文字：「楚河　汉界」（2026-11-09 用户定：恢复四个字，不用「界河」）
    var ty = Y0 + 4.5 * S, gsz = 40, gap = 31;
    glyph(ctx, '楚', 150 - gap, ty, gsz, false, 0, 0.8);
    glyph(ctx, '河', 150 + gap, ty, gsz, false, 0, 0.8);
    glyph(ctx, '汉', 388 - gap, ty, gsz, false, 0, 0.8);
    glyph(ctx, '界', 388 + gap, ty, gsz, false, 0, 0.8);
  }

  /** 白底 + 线。调用前请先 clip（没有脏区就直接全画） */
  function board(ctx) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cfg.W, cfg.H);
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'butt';
    if (cfg.type === 'ccx') boardCcx(ctx);
    else if (cfg.type === 'xiangqi') boardXiangqi(ctx);
    else boardFlip(ctx);
    ctx.restore();
  }

  // ------------------------------------------------------------ 脏矩形
  var forceAll = false;

  /** 下一次绘制强制整屏重画。重开、悔棋、切换模式这类「一大片一起变」的场合必须调，
   *  否则脏区只框了上一步和选中，整盘旧棋子会留在画布上。 */
  function dirtyAll() { forceAll = true; }

  /**
   * 把本帧与上帧涉及的交点框出来当 clip。返回 false 表示没脏区（调用方全画）。
   * force=true 时强制全屏重画（终局亮牌这种一大片一起变的场面）。
   * 注意：必须在 rotCtx() 之后调用 —— 旋转是画布里的坐标系变换，
   * 这里给的是**逻辑坐标**，转完自然落在正确位置。
   */
  function clip(ctx, pts, force) {
    if (!pts) pts = [];
    if (forceAll || force) { forceAll = false; prevPts = []; return false; }
    var all = {}, n = 0, i, k;
    for (i = 0; i < prevPts.length; i++) { k = prevPts[i]; if (!all[k]) { all[k] = 1; n++; } }
    for (i = 0; i < pts.length; i++) { k = pts[i]; if (!all[k]) { all[k] = 1; n++; } }
    prevPts = pts.slice();
    if (!n || !cfg || !cfg.xy) return false;
    var pad = Math.max(cfg.piece * 0.62, cfg.cell * 0.62) + 1;
    ctx.beginPath();
    for (k in all) {
      if (!all.hasOwnProperty(k)) continue;
      var p = cfg.xy(+k);
      if (!p) continue;
      // 边界往外取整：clip 边缘压在半个像素上时，那一格像素的落墨量会被剪掉一半，
      // 与整屏重画差一档灰度。1 位色屏上看不出来，但会让「增量帧 == 全量帧」自检永远差几个像素。
      var x0 = Math.floor(p[0] - pad), y0 = Math.floor(p[1] - pad);
      var x1 = Math.ceil(p[0] + pad), y1 = Math.ceil(p[1] + pad);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.clip();
    return true;
  }

  function reset() { prevPts = []; }

  window.INK = {
    init: init, isOn: isOn, set: set, toggle: toggle,
    glyph: glyph, piece: piece, back: back,
    hlSel: hlSel, hlLast: hlLast, hlDot: hlDot, hlCap: hlCap,
    board: board, clip: clip, reset: reset, dirtyAll: dirtyAll
  };
})();
