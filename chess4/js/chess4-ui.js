/*!
 * chess4-ui.js —— 四界大战（四人象棋）画布渲染 + 交互 + 音效
 * 依赖 chess4-core.js（规则 / 搜索）
 *
 * 棋盘：18 列 x 10 行；四方 红(下,玩家) 青(左) 黑(上) 蓝(右)，逆时针行棋。
 *
 * 关于军名（2026-10-09 起）：**界面上一律按颜色叫「红 蓝 黑 青」**，
 * 名字与棋子墨色一一对应（青军墨 = 水鸭色 #008080，蓝军墨 = #1b5370）。
 * 代码里的内部常量仍沿用素材来源的老名字（GREEN=青军 / YELLOW=蓝军，
 * 图名前缀 g_ / y_），因为青军（g_）的字形取自黑方素材、蓝军（y_）的字形取自红方素材，
 * 前缀改成色名反而更难对。**只有 SIDE_TXT 这一处决定屏幕上显示什么。**
 * 画布从不自己画盘面与线 —— img/board.png 里已经含标题带「象棋全图」和四方九宫，
 * 本文件只负责摆棋子、画高亮、收点击。
 */
(function () {
  'use strict';

  var G = window.C4;
  if (!G) { console.error('chess4-core.js 未加载'); return; }

  // ---- 几何：必须与 _cc4_assets.py / img/board.png 的烘焙尺寸严格一致 ----
  // 2026-10-09 第二轮（用户：「棋盘边界照着 apk 的改」「象棋全图往上抬」）：
  //   MX 29 → 48（旧值正好等于棋子半径，最外侧那一列棋子被切成平边）、
  //   MY 41 → 44、位图上下各加一条 16px 的金珠轨 RAIL，位图 1078x712 → 1116x750。
  var SPACE = 60, MX = 48, MY = 44, PIECE = 58;
  var RAIL = 16;                             // 上下金珠轨高度（位图里已经烘好）
  var TITLE_H = 90;
  var COLS = 18, ROWS = 10;
  var BW = (COLS - 1) * SPACE + 2 * MX;      // 1116
  var BH = (ROWS - 1) * SPACE + 2 * MY;      // 628
  var BMH = TITLE_H + RAIL + BH + RAIL;      // 750（含标题带与上下金珠轨）
  var W = BW, H = BMH;                       // 画布尺寸（位图铺满，不留边）
  var GY0 = TITLE_H + RAIL + MY;             // 第 0 行圆心 y

  var TYPES = ['j', 's', 'x', 'c', 'm', 'p', 'z'];
  var PREFIX = ['r_', 'b_', 'g_', 'y_'];     // 红 黑 青(g_) 蓝(y_)  —— 内部名沿用素材前缀
  /*
   * 屏幕上显示的军名。红、黑两家固定；左家（内部编号 2）、右家（3）跟着配色走，
   * 由 applyScheme() 改成当前选中的色名（2026-11-09 起可自选）。
   * 名字必须与棋子墨色一致 —— 这是 10-09 定下的口径（「名字喊什么颜色、字就得是什么颜色」）。
   */
  var SIDE_TXT = ['红', '黑', '青', '蓝'];

  // 当前配色：色名取自 C4Tint.PALETTE，默认「青 · 紫红」
  var TINT = window.C4Tint || null;
  var scheme = { left: '青', right: '紫红' };
  var SCHEME_KEY = 'c4.scheme.v1';

  // 三档难度：搜索深度 + 随机宽容度 + 时间上限
  // 四方是「一打三」的偏执搜索，分支 = 50^4 量级，深度 4 已经是秒级，不能再往上堆。
  var LEVELS = {
    1: { depth: 2, slack: 60, budget: 300 },
    2: { depth: 3, slack: 30, budget: 900 },
    3: { depth: 4, slack: 12, budget: 2800 }
  };
  var DEFAULT_LEVEL = 2;

  var ANIM_MS = 170;
  var AI_DELAY = 30;          // 最小让位：让「思考中」先画到屏上再跑同步搜索

  // 电脑落子节奏（秒）：每一方在出手前先等这么久，好让活人看清上一步走到哪了。
  // 单位是秒，存在 state 里（测试可以直接改 st.delay 用小数加速）。
  var DELAYS = [2, 3, 5, 7, 10];
  var DEFAULT_DELAY = 3;
  var MIN_DELAY = 0.06;       // 兜底：至少给一帧时间把「思考中」画出去

  // ------------------------------------------------------------ DOM
  function $(id) { return document.getElementById(id); }
  var canvas, ctx, elStatus, elLevels, elUndo, elMeta, elSides, elDelay;
  var elAIPick, elLevelField, elDelayField;
  var imgs = {}, boardImg = null;
  var soundOn = true, snd = {};
  var showDots = false;       // 「走法提示」开关，默认关（与上一版一致）
  var aiTimer = 0;            // 电脑等节奏的计时器（悔棋/重开要能把它撤掉）
  var gen = 0;                // 局面代次：重开后旧计时器一律作废

  // ------------------------------------------------------------ 状态
  var st = null;

  // ---------------------------------------------- 电脑参与方（2026-10-15 新增）
  // aiFlags[s] === true：第 s 方由电脑操控；false：真人（同机轮流操作）。
  // 默认 [红=人, 黑=电脑, 青=电脑, 蓝=电脑]，与上一版行为完全一致。
  // 可以勾 0~3 方电脑，也就是 4 / 3 / 2 / 1 人同机都能玩。
  // 不允许四方全勾成电脑 —— 那样就没人操作了（至少留一方真人）。
  //
  // 「你」这个称呼只在恰好一个真人时用；两个以上真人同机时一律按颜色叫，
  // 免得一方走完弹个「轮到你走」让另一个人误会。
  var aiFlags = [false, true, true, true];
  function isAI(s) { return !!aiFlags[s]; }
  function humanCount() {
    var n = 0;
    for (var i = 0; i < 4; i++) if (!aiFlags[i]) n++;
    return n;
  }
  function aiCount() {
    var n = 0;
    for (var i = 0; i < 4; i++) if (aiFlags[i]) n++;
    return n;
  }

  function newState() {
    var bd = G.initialBoard(), mvf = new Int8Array(G.NSQ);
    var s = {
      bd: bd, mvf: mvf,
      turn: G.RED,
      level: st ? st.level : DEFAULT_LEVEL,
      delay: st ? st.delay : DEFAULT_DELAY,
      sel: -1, ps: [], blocked: [],
      hist: [],
      keys: [G.stateKey(bd, mvf)],
      alive: [true, true, true, true],
      seen: new Set(),
      last: null,
      anim: null,
      busy: false,
      over: false,
      overText: '',
      hint: ''
    };
    s.seen.add(s.keys[0]);
    return s;
  }

  /** 撤掉「电脑还在等节奏」的计时器（悔棋 / 重新开始时用） */
  function cancelAI() {
    if (aiTimer) { window.clearTimeout(aiTimer); aiTimer = 0; }
    gen++;
    if (st) st.busy = false;
  }

  function aliveCount() {
    var n = 0;
    for (var i = 0; i < 4; i++) if (st.alive[i]) n++;
    return n;
  }

  // ------------------------------------------------------------ 资源
  function loadImages(cb) {
    var names = [], i;
    for (i = 0; i < 4; i++) {
      for (var k = 0; k < 7; k++) names.push(PREFIX[i] + TYPES[k]);
    }
    var total = names.length + 1, done = 0;
    function tick() { if (++done >= total) cb(); }
    names.forEach(function (n) {
      var im = new Image();
      im.onload = tick; im.onerror = tick;
      im.src = 'img/' + n + '.png';
      imgs[n] = im;
    });
    boardImg = new Image();
    boardImg.onload = tick; boardImg.onerror = tick;
    boardImg.src = 'img/board.png';
  }

  function pieceName(p) {
    return PREFIX[(p >> 3) & 3] + TYPES[(p & 7) - 1];
  }

  var dpr = 1, viewScale = 1;

  /**
   * 可用宽度：读 .wrap 的内容宽度（clientWidth 已含内边距，再扣掉左右 padding）。
   * 原来写死「视口宽 - 48」，一旦手机断点把 wrap 内边距改小，算出来就比容器宽，
   * 棋盘会横向溢出。2026-11-09 移动端适配时改掉。
   */
  function availWidth() {
    var el = document.querySelector('.wrap');
    var vw = document.documentElement.clientWidth || 1200;
    if (!el) return vw - 32;
    var cs = window.getComputedStyle(el);
    var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    // 两个来源取大：
    //   ① wrap 的内容宽 —— 手机上跟着断点后的内边距走（比写死 48 多出 20px）；
    //   ② 视口宽 - 32 —— 桌面上 wrap 有 max-width，而棋盘历来允许比它宽一点
    //      （串串香画布 964 > wrap 内容宽 912），取大才能保证桌面渲染与改前一致。
    return Math.max(el.clientWidth - pad, vw - 32);
  }

  // ------------------------------------------------------------ 旋转
  /* 2026-11-09：加「旋转」按钮，点一下顺时针 90 度，点满四下回原位。
     在 canvas 里转坐标系，不用 CSS transform —— CSS 旋转只改观感，布局盒还是老的
     横尺寸（横盘竖起来会横向溢出容器），点击坐标也得另算；canvas 里转完之后
     <canvas> 的宽高本身就是竖的，fitCanvas 与点击换算共用同一套数字。 */
  var ROT_KEY = 'graywood.chess4.rot';
  var rot = 0;                                  // 0/1/2/3 = 0/90/180/270 度
  function rotSwap() { return (rot & 1) === 1; }
  function lw() { return rotSwap() ? H : W; }    // 画布逻辑宽
  function lh() { return rotSwap() ? W : H; }    // 画布逻辑高
  /** 转坐标系。调用前必须已经 ctx.save()，由调用方 restore */
  function rotCtx() {
    if (rot === 1) { ctx.translate(H, 0); ctx.rotate(Math.PI / 2); }
    else if (rot === 2) { ctx.translate(W, H); ctx.rotate(Math.PI); }
    else if (rot === 3) { ctx.translate(0, W); ctx.rotate(-Math.PI / 2); }
  }
  /** 屏幕坐标 -> 棋盘逻辑坐标：先按实际渲染比例折回逻辑单位，再把旋转逆回去 */
  function toLogical(ev) {
    var r = canvas.getBoundingClientRect();
    var sx = (ev.clientX - r.left) * (lw() / r.width);
    var sy = (ev.clientY - r.top) * (lh() / r.height);
    if (rot === 1) return [sy, H - sx];
    if (rot === 2) return [W - sx, H - sy];
    if (rot === 3) return [W - sy, sx];
    return [sx, sy];
  }
  /** 这两页不默认转：中国象棋转 90 度之后红黑两家会跑到左右两侧，四界大战四方也各有
   *  各的方位 —— 都不是常规视角。只有两页翻棋在手机竖屏默认竖起来（白的口径 2026-11-09）。
   *  想要就自己点「旋转」，选过的角度会记住。 */
  function rotDefault() {
    return 0;
  }
  /** 记住上次转到的角度；从没手动转过就按设备给默认值 */
  function rotLoad() {
    var v = null;
    try { v = localStorage.getItem(ROT_KEY); } catch (e) {}
    if (v === null || v === '' || isNaN(+v)) return rotDefault();
    return ((+v % 4) + 4) % 4;
  }
  function rotTurn() {
    rot = (rot + 1) % 4;
    try { localStorage.setItem(ROT_KEY, String(rot)); } catch (e) {}
    fitCanvas();
    draw();
  }

  /**
   * 画布尺寸：逻辑坐标恒为 1116x750，位图按（视口缩放 x devicePixelRatio）渲染。
   * 面板已经从右侧挪到棋盘下方，所以纵向余量更紧 —— 按宽高都收。
   * 2026-11-09：手机竖屏只有 358px 可用，原来的 0.5 下限会让 1116 的盘溢出 200px，
   * 所以宽度改成硬约束（宁可小也不横溢），高度那档保留 0.62 下限免得看不清。
   */
  // ------------------------------------------------------------ 沉浸模式
  /* 2026-11-09：只留棋盘 —— 页头与面板整个 display:none，wrap 撑满视口把棋盘居中，
     左上角浮一个「✕ 退出」。退出按钮写在 body 下（不走 wrap 的 flex），不受布局影响。
     状态写 localStorage，与旋转同规矩：刷新后仍是沉浸（head 里有脚本提前打 class）。
     没动浏览器全屏 API：手机与 iframe 里 requestFullscreen 时灵时不灵，退出还得多一条同步。 */
  var IMM_KEY = 'graywood.chess4.imm';
  function immOn() { return document.documentElement.classList.contains('immersive'); }
  function immLoad() {
    try { return localStorage.getItem(IMM_KEY) === '1'; } catch (e) { return false; }
  }
  /** 开关沉浸模式；save=true 时记住这次选择（点按钮、按 Esc 都算） */
  function immSet(on, save) {
    on = !!on;
    document.documentElement.classList.toggle('immersive', on);
    var b = document.getElementById('immersive');
    if (b) { b.textContent = on ? '沉浸中' : '沉浸'; b.disabled = on; }
    if (save) { try { localStorage.setItem(IMM_KEY, on ? '1' : '0'); } catch (e) {} }
    if (on) { try { window.scrollTo(0, 0); } catch (e) {} }
    fitCanvas();
    draw();
  }

  function fitCanvas() {
    var top = canvas.getBoundingClientRect().top || 0;
    var availW = availWidth();
    // 沉浸时棋盘在视口里居中，「到页顶的距离」量法失效，按整屏算（上下各 8px 留白）
    var availH = immOn() ? (window.innerHeight || 900) - 16
                         : (window.innerHeight || 900) - top - 26;
    var cw = lw(), ch = lh();
    var sW = availW / cw, sH = availH / ch;
    var vs = Math.min(1, sW);
    if (vs > sH) vs = Math.max(0.62, sH);
    if (vs > sW) vs = sW;                       // 兜底：绝不横向溢出
    viewScale = vs;
    dpr = viewScale * Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = (cw * viewScale).toFixed(2) + 'px';
    canvas.style.height = (ch * viewScale).toFixed(2) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function px(c) { return MX + c * SPACE; }
  function py(r) { return GY0 + r * SPACE; }

  // ------------------------------------------------------------ 绘制
  /** 某一家棋子该用的字墨：红黑写死在素材里，左右两家取当前配色 */
  function sideColor(side) {
    if (side === 2) return TINT ? TINT.palette(scheme.left).ink : '#00656b';
    if (side === 3) return TINT ? TINT.palette(scheme.right).ink : '#6b2455';
    return null;
  }

  /**
   * 画一枚棋子。左家(2)、右家(3) 走运行时着色（底图 b_ / r_ 两套，字墨当参数传），
   * 红、黑两家直接用原图 —— 这两家的墨色是棋种约定，不参与调色。
   * 模型还没建好时退回原图，免得开局闪一下空白。
   */
  function drawPiece(p, cx, cy, alpha) {
    var side = (p >> 3) & 3, im = null;
    if (TINT && (side === 2 || side === 3)) {
      var arr = TINT.sheets(side, sideColor(side));
      if (arr) im = arr[(p & 7) - 1];
    }
    if (!im) im = imgs[pieceName(p)];
    if (!im) return;
    if (im.tagName === 'IMG' && (!im.complete || !im.naturalWidth)) return;
    var a = (alpha == null) ? 1 : alpha;
    if (a < 1) ctx.globalAlpha = a;
    ctx.drawImage(im, cx - PIECE / 2, cy - PIECE / 2, PIECE, PIECE);
    if (a < 1) ctx.globalAlpha = 1;
  }

  function drawRing(x, y, color, width, rMul, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(x, y, PIECE * (rMul || 0.52), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawFrame(i, color, width) {
    var x = px(G.colOf(i)), y = py(G.rowOf(i)), s = PIECE * 0.46;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1.5;
    ctx.strokeRect(x - s, y - s, s * 2, s * 2);
    ctx.restore();
  }

  function drawDot(i) {
    var x = px(G.colOf(i)), y = py(G.rowOf(i));
    ctx.save();
    if (st.bd[i]) {
      ctx.strokeStyle = 'rgba(198,52,38,.62)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, PIECE * 0.5 - 1, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(198,52,38,.40)';
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** 被「未动子不可吃」挡下的目标：虚线圈 + 一道斜杠 */
  function drawBlocked(i) {
    var x = px(G.colOf(i)), y = py(G.rowOf(i));
    drawRing(x, y, 'rgba(238,226,200,.72)', 2, 0.5, [4, 4]);
    ctx.save();
    ctx.strokeStyle = 'rgba(238,226,200,.72)';
    ctx.lineWidth = 2;
    var d = PIECE * 0.30;
    ctx.beginPath();
    ctx.moveTo(x - d, y + d); ctx.lineTo(x + d, y - d);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, lw(), lh());
    ctx.save();
    rotCtx();
    if (boardImg && boardImg.complete && boardImg.naturalWidth) {
      ctx.drawImage(boardImg, 0, 0, BW, BMH);
    } else {
      ctx.fillStyle = '#ddc38f';
      ctx.fillRect(0, 0, BW, BMH);
    }

    var c = st.anim, prog = 1, done = false;
    if (c) {
      prog = (performance.now() - c.t0) / c.dur;
      if (prog >= 1) { prog = 1; done = true; }
    }

    if (st.last) {
      drawFrame(st.last.from, 'rgba(120,110,90,.45)', 1.5);
      drawFrame(st.last.to, 'rgba(120,110,90,.45)', 1.5);
    }
    // 已经出局阵营的残子理论上已撤干净；万一有漏网的也画成半透明，别让玩家以为还在
    var skip = (c && !done) ? c.from : -1;
    for (var i = 0; i < G.NSQ; i++) {
      var p = st.bd[i];
      if (!p || i === skip) continue;
      var dead = st.alive[G.sideOf(p)] ? 1 : 0.35;
      drawPiece(p, px(G.colOf(i)), py(G.rowOf(i)), dead);
    }

    if (c && !done) {
      var e = prog * prog * (3 - 2 * prog);                 // smoothstep
      var f = c.from, t = c.to;
      drawPiece(c.p,
        px(G.colOf(f)) + (px(G.colOf(t)) - px(G.colOf(f))) * e,
        py(G.rowOf(f)) + (py(G.rowOf(t)) - py(G.rowOf(f))) * e);
    }
    if (done) st.anim = null;

    if (st.sel >= 0 && st.bd[st.sel]) {
      drawRing(px(G.colOf(st.sel)), py(G.rowOf(st.sel)), 'rgba(198,52,38,.85)', 2.5, 0.52);
      if (showDots) {
        for (var k = 0; k < st.ps.length; k++) drawDot(st.ps[k]);
        for (k = 0; k < st.blocked.length; k++) drawBlocked(st.blocked[k]);
      }
    }
    ctx.restore();                                // 收掉旋转变换
  }

  function tick() {
    draw();
    if (st && st.anim) requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ 界面文案
  function setStatus() {
    var t, cls = '', solo = (humanCount() === 1);
    if (st.over) { t = st.overText; cls = 'over'; }
    else if (st.hint) { t = st.hint; cls = 'hint'; }
    else if (st.busy) { t = SIDE_TXT[st.turn] + '方思考中'; cls = 'busy'; }
    else {
      var nm = SIDE_TXT[st.turn], chk = G.inCheck(st.bd, st.turn);
      if (isAI(st.turn)) {
        t = nm + '方走棋';
        if (chk) t = nm + '方被将军';
      } else if (solo) {
        t = '轮到你走（' + nm + '）';
        if (chk) t = '你被将军了！' + t;
      } else {
        // 两个以上真人同机：不能说「你」，按颜色喊
        t = '轮到' + nm + '方走';
        if (chk) t = '轮到' + nm + '方走（被将军）';
      }
    }
    elStatus.textContent = t;
    elStatus.className = 'status' + (cls ? ' ' + cls : '');
    elMeta.textContent = '第 ' + st.hist.length + ' 手';
    // 悔棋不因「电脑在等节奏」而禁用：点了会把电脑那手撤销掉
    elUndo.disabled = st.hist.length === 0;

    // 四家状态条（按行棋顺序 红->蓝->黑->青 排，别按内部编号排）
    var html = '';
    for (var k = 0; k < 4; k++) {
      var i = G.ORDER[k];
      var cl = 'side s' + i;
      if (!st.alive[i]) cl += ' dead';
      if (!st.over && st.alive[i] && st.turn === i) cl += ' now';
      var tag = isAI(i) ? '<i class="ai">电脑</i>' : (solo ? '（你）' : '');
      html += '<span class="' + cl + '">' + SIDE_TXT[i] + tag + '</span>';
    }
    elSides.innerHTML = html;
  }

  // ------------------------------------------------------------ 配色（2026-11-09）
  /*
   * 红、黑两家固定不动（棋种约定）；左家(2)、右家(3) 可在六个算过的深色里挑，
   * 也能一键切四组预设。默认「青 · 紫红」。
   *
   * 三条设计口径：
   *   ① 色名即军名 —— 状态条、电脑方勾选框、规则说明里的走子顺序全部跟着变；
   *   ② 另一侧跟它 ΔE 小于 28 的色直接划掉点不动（现状那对青/蓝是 28.9，
   *      用户说"区分度不是很大"，28 就是照着这个程度定的）；
   *   ③ 只换字墨，圆盘与外环是烘死的素材，一个像素不改。
   */
  function schemeOk(nm) {
    if (!TINT) return false;
    for (var i = 0; i < TINT.PALETTE.length; i++) if (TINT.PALETTE[i].name === nm) return true;
    return false;
  }

  function loadScheme() {
    try {
      var s = JSON.parse(window.localStorage.getItem(SCHEME_KEY) || 'null');
      if (s && schemeOk(s.left) && schemeOk(s.right)) {
        scheme.left = s.left;
        scheme.right = s.right;
      }
    } catch (e) { /* 隐私模式 / 存储被禁：用默认配色，不影响游戏 */ }
  }

  function saveScheme() {
    try {
      window.localStorage.setItem(SCHEME_KEY, JSON.stringify(scheme));
    } catch (e) { }
  }

  /** 把配色落到界面上：军名、四家标识色、勾选框色名、规则说明顺序，然后重画 */
  function applyScheme() {
    if (!TINT) return;
    var pl = TINT.palette(scheme.left), pr = TINT.palette(scheme.right);
    SIDE_TXT[2] = pl.name;
    SIDE_TXT[3] = pr.name;

    var root = document.documentElement.style;
    root.setProperty('--side-l', pl.ui);
    root.setProperty('--side-r', pr.ui);

    var i, tags = document.querySelectorAll('#aiPick .pn');
    for (i = 0; i < tags.length; i++) {
      var inp = tags[i].parentNode.querySelector('input');
      if (inp) tags[i].textContent = SIDE_TXT[+inp.getAttribute('data-side')];
    }
    var ords = document.querySelectorAll('.note [data-side]');
    for (i = 0; i < ords.length; i++) {
      ords[i].textContent = SIDE_TXT[+ords[i].getAttribute('data-side')];
    }

    var cl = $('curL'), cr = $('curR');
    if (cl) cl.textContent = pl.name;
    if (cr) cr.textContent = pr.name;

    renderPresets();
    renderPalette(2);
    renderPalette(3);
    saveScheme();
    if (st) { setStatus(); draw(); }
  }

  /**
   * 只在 URL 带 ?probe=1 时跑：把着色结果落到 body[data-probe]，
   * 给无头浏览器 dump-dom 核对用（正常访问完全不执行）。
   */
  function probeScheme() {
    var out = { ready: TINT.isReady(), err: TINT.error(), left: scheme.left, right: scheme.right, px: {} };
    [2, 3].forEach(function (side) {
      var tag = side === 2 ? 'L' : 'R';
      var arr = TINT.sheets(side, sideColor(side));
      if (!arr) { out.px[tag] = null; return; }
      var d = arr[0].getContext('2d').getImageData(0, 0, 116, 116).data;
      var best = null, bl = 1e9, i, o;
      for (i = 0; i < 116 * 116; i++) {
        o = i * 4;
        if (d[o + 3] < 200) continue;
        var x = i % 116, y = (i / 116) | 0;
        if (x < 38 || x > 78 || y < 28 || y > 88) continue;   // 只在中部找，避开外环
        var L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
        if (L < bl) { bl = L; best = [d[o], d[o + 1], d[o + 2]]; }
      }
      out.px[tag] = best
        ? '#' + best.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('')
        : null;
    });
    document.body.setAttribute('data-probe', JSON.stringify(out));
  }

  function renderPresets() {
    var box = $('schemePresets');
    if (!box || !TINT) return;
    box.innerHTML = '';
    TINT.PRESETS.forEach(function (p) {
      var li = TINT.palette(p.left), ri = TINT.palette(p.right);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset' + (p.left === scheme.left && p.right === scheme.right ? ' on' : '');
      b.title = p.name;
      b.innerHTML = '<span class="sw">' +
        '<i style="background:' + li.ink + '"></i>' +
        '<i style="background:' + ri.ink + '"></i></span>' +
        '<span class="nm">' + p.name + '</span>' +
        '<span class="de">ΔE ' + Math.round(TINT.deltaE(li.ink, ri.ink)) + '</span>';
      b.addEventListener('click', function () {
        scheme.left = p.left;
        scheme.right = p.right;
        applyScheme();
      });
      box.appendChild(b);
    });
  }

  function renderPalette(side) {
    var box = $(side === 2 ? 'palL' : 'palR');
    if (!box || !TINT) return;
    var mine = side === 2 ? scheme.left : scheme.right;
    var other = side === 2 ? scheme.right : scheme.left;
    var otherInk = TINT.palette(other).ink;
    var plate = TINT.plate(side);
    box.innerHTML = '';
    TINT.PALETTE.forEach(function (p) {
      var de = TINT.deltaE(p.ink, otherInk);
      var bad = de < TINT.MIN_DE;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell' + (p.name === mine ? ' on' : '') + (bad ? ' off' : '');
      b.disabled = bad;
      b.title = bad
        ? ('和另一侧的「' + other + '」太近：ΔE ' + Math.round(de) + '，至少要 ' + TINT.MIN_DE)
        : (p.name + ' · 与另一侧 ΔE ' + Math.round(de));
      b.innerHTML = '<span class="dot" style="background:' + p.ink + '"></span>' +
        '<span class="n">' + p.name + '</span>' +
        '<span class="cr">' + TINT.contrast(p.ink, plate).toFixed(2) + '</span>';
      b.addEventListener('click', function () {
        if (side === 2) scheme.left = p.name; else scheme.right = p.name;
        applyScheme();
      });
      box.appendChild(b);
    });
  }

  // ------------------------------------------------------------ 音效
  function initSound() {
    ['select', 'move', 'capture', 'check', 'win', 'lose'].forEach(function (n) {
      var a = $('snd-' + n);
      if (a) { a.volume = 0.85; snd[n] = a; }
    });
    var cb = $('sound');
    soundOn = cb ? cb.checked : true;
    if (cb) cb.addEventListener('change', function () { soundOn = cb.checked; });
  }
  function play(n) {
    if (!soundOn) return;
    var a = snd[n];
    if (!a) return;
    try { a.currentTime = 0; var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { }
  }

  function initDots() {
    var cb = $('dots');
    showDots = cb ? cb.checked : false;
    if (cb) cb.addEventListener('change', function () {
      showDots = cb.checked;
      if (st) draw();
    });
  }

  // ------------------------------------------------------------ 选子 / 走子
  // 着法按「当前该走的那一方」生成 —— 人机混排时当前方不一定是红方
  function legalFrom(sq) {
    var all = G.legalMoves(st.bd, st.mvf, st.turn), out = [];
    for (var i = 0; i < all.length; i++) if (G.moveFrom(all[i]) === sq) out.push(G.moveTo(all[i]));
    return out;
  }
  function blockedFrom(sq) {
    var all = G.blockedByRule(st.bd, st.mvf, st.turn), out = [];
    for (var i = 0; i < all.length; i++) if (G.moveFrom(all[i]) === sq) out.push(G.moveTo(all[i]));
    return out;
  }

  function select(sq) {
    st.sel = sq;
    st.ps = sq >= 0 ? legalFrom(sq) : [];
    st.blocked = sq >= 0 ? blockedFrom(sq) : [];
    st.hint = '';
    draw();
  }

  function applyMove(mv) {
    var from = G.moveFrom(mv), to = G.moveTo(mv);
    var p = st.bd[from], cap = st.bd[to];
    var mover = st.turn;

    // 先把「这一步会不会把谁将死」试算出来（matedSides 内部自己做 make/unmake）
    var mated = G.matedSides(st.bd, st.mvf, mover, mv);

    var u = G.makeMove(st.bd, st.mvf, mv);
    var entry = { mv: mv, u: u, turn: mover, killed: null };

    if (mated.length) {
      entry.killed = [];
      mated.forEach(function (s) {
        var cells = [];
        for (var i = 0; i < G.NSQ; i++) {
          if (st.bd[i] && G.sideOf(st.bd[i]) === s) cells.push([i, st.bd[i], st.mvf[i]]);
        }
        G.removeSide(st.bd, st.mvf, s);
        st.alive[s] = false;
        entry.killed.push({ side: s, cells: cells });
      });
    }

    st.sel = -1; st.ps = []; st.blocked = []; st.hint = '';
    st.anim = {
      from: from, to: to, p: p, t0: performance.now(), dur: ANIM_MS
    };
    st.last = { from: from, to: to };
    st.hist.push(entry);
    var key = G.stateKey(st.bd, st.mvf);
    st.keys.push(key);
    st.seen.add(key);
    st.turn = G.NEXT[mover];

    play(cap ? 'capture' : 'move');
    tick();
    setStatus();
    window.setTimeout(afterMove, ANIM_MS + 20);
  }

  function repetition() {
    var key = st.keys[st.keys.length - 1], n = 0;
    for (var i = 0; i < st.keys.length; i++) if (st.keys[i] === key) n++;
    return n >= 4;
  }

  function afterMove() {
    // 跳过已出局的阵营
    var guard = 0;
    while (!st.alive[st.turn] && guard++ < 4) st.turn = G.NEXT[st.turn];

    var solo = (humanCount() === 1), i;
    var alive = [], humansIn = [];
    for (i = 0; i < 4; i++) {
      if (!st.alive[i]) continue;
      alive.push(i);
      if (!isAI(i)) humansIn.push(i);
    }

    // 真人全部出局：对这一局来说已经结束（剩下几个电脑互掐也没人操作了）
    if (!humansIn.length) {
      st.over = true;
      st.overText = alive.length <= 1
        ? SIDE_TXT[alive[0]] + '方胜（' + (solo ? '你已出局' : '真人全部出局') + '）'
        : (solo ? '你出局了' : '真人全部出局，剩下三方是电脑');
      setStatus(); play('lose'); draw();
      return;
    }
    // 只剩一方 —— 前面已排除「真人全灭」，所以存活的那一方一定是真人
    if (alive.length <= 1) {
      st.over = true;
      st.overText = solo
        ? '你赢了！（四方仅存' + SIDE_TXT[alive[0]] + '方）'
        : SIDE_TXT[alive[0]] + '方胜（真人）';
      setStatus(); play('win'); draw();
      return;
    }
    if (repetition()) {
      st.over = true; st.overText = '和棋（同一局面出现四次）';
      setStatus(); draw(); return;
    }
    if (G.inCheck(st.bd, st.turn)) play('check');
    setStatus(); draw();
    if (isAI(st.turn)) scheduleAI();
  }

  function scheduleAI() {
    st.busy = true; setStatus(); draw();
    var myGen = gen;
    var wait = st.delay * 1000;
    if (!(wait > AI_DELAY)) wait = AI_DELAY;
    // 等节奏（默认 3 秒，见「电脑间隔」档位）——让玩家看清上一手落到哪儿了；
    // 到点才跑搜索。同步搜索会卡住主线程，所以这一跳也顺带让出了一帧。
    aiTimer = window.setTimeout(function () {
      aiTimer = 0;
      if (myGen !== gen || st.over || !st.busy) return;      // 期间重开/悔棋了
      var lv = LEVELS[st.level] || LEVELS[DEFAULT_LEVEL];
      var side = st.turn, res = null;
      try {
        res = G.think(st.bd, st.mvf, side, {
          depth: lv.depth, slack: lv.slack, budget: lv.budget, seen: st.seen
        });
      } catch (e) { console.error(e); }
      st.busy = false;
      if (!res || res.move == null) {
        // 该方无着可走（理论上上一步的 matedSides 已经处理过，这里兜底）
        st.alive[side] = false;
        G.removeSide(st.bd, st.mvf, side);
        st.hint = SIDE_TXT[side] + '方无着可走，出局';
        afterMove();
        return;
      }
      if (window.console && res.depth) {
        console.log('[AI ' + SIDE_TXT[side] + '] 深度' + res.depth + ' 值' + res.value +
          ' 节点' + res.nodes + ' ' + res.ms + 'ms');
      }
      applyMove(res.move);
    }, wait);
  }

  // ------------------------------------------------------------ 点击
  function hit(ev) {
    var lg = toLogical(ev);
    var x = lg[0], y = lg[1];
    var c = Math.round((x - MX) / SPACE), rw = Math.round((y - GY0) / SPACE);
    if (c < 0 || c >= COLS || rw < 0 || rw >= ROWS) return -1;
    var dx = x - px(c), dy = y - py(rw);
    if (dx * dx + dy * dy > (SPACE * 0.60) * (SPACE * 0.60)) return -1;
    return rw * COLS + c;
  }

  function onClick(ev) {
    if (st.over || st.busy || st.anim) return;
    if (isAI(st.turn)) return;                  // 轮到电脑，等着就行
    var sq = hit(ev);
    if (sq < 0) { if (st.sel >= 0) select(-1); return; }
    var p = st.bd[sq];

    if (p && G.sideOf(p) === st.turn) {         // 只有当前该走那一方的子能选
      if (st.sel === sq) { select(-1); return; }
      select(sq); play('select');
      return;
    }
    if (st.sel >= 0 && st.ps.indexOf(sq) >= 0) {
      applyMove(st.sel * 256 + sq);
      return;
    }
    // 想吃一个「还没动过」的敌子 —— 明确告诉他为什么不行
    if (st.sel >= 0 && st.blocked.indexOf(sq) >= 0) {
      st.hint = '这一枚还没走动过，吃不了；等它走过一步之后才能吃';
      setStatus();
      return;
    }
    if (st.sel >= 0) select(-1);
  }

  // ------------------------------------------------------------ 按钮
  function restart() {
    cancelAI();
    st = newState();
    tick(); setStatus();
    kickoff();
  }

  /** 开局（或重开）后，如果第一个该走的是电脑，得主动把它踢起来 —— 没人「走完一步」就没人触发 afterMove */
  function kickoff() {
    if (st && !st.over && !st.anim && isAI(st.turn)) scheduleAI();
  }

  function undo() {
    if (st.anim || !st.hist.length) return;
    cancelAI();                       // 电脑还在等节奏的话，先把它的计时器撤掉
    st.over = false; st.overText = ''; st.hint = '';
    // 一路退到「轮到真人」为止：三家电脑时退三步，四人同机时退一步
    var guard = 0;
    do {
      var h = st.hist.pop();
      if (!h) break;
      if (h.killed) {
        h.killed.forEach(function (k) {
          st.alive[k.side] = true;
          k.cells.forEach(function (c) { st.bd[c[0]] = c[1]; st.mvf[c[0]] = c[2]; });
        });
      }
      G.unmakeMove(st.bd, st.mvf, h.mv, h.u);
      st.keys.pop();
      st.turn = h.turn;
    } while (isAI(st.turn) && ++guard < 10);

    st.sel = -1; st.ps = []; st.blocked = [];
    var last = st.hist[st.hist.length - 1];
    st.last = last ? { from: G.moveFrom(last.mv), to: G.moveTo(last.mv) } : null;
    tick(); setStatus();
  }

  function setLevel(v) {
    st.level = v;
    var bs = elLevels.getElementsByTagName('button');
    for (var i = 0; i < bs.length; i++) {
      bs[i].className = (+bs[i].getAttribute('data-level') === v) ? 'on' : '';
    }
  }

  /** 电脑间隔档位（秒）。改档只影响后面还没走的电脑，当前正在等的这一手不打断 */
  function setDelay(v) {
    st.delay = v;
    var bs = elDelay.getElementsByTagName('button');
    for (var i = 0; i < bs.length; i++) {
      bs[i].className = (+bs[i].getAttribute('data-delay') === v) ? 'on' : '';
    }
  }

  // ------------------------------------------------- 电脑参与方（勾选四方）
  /** 状态栏临时提示，几秒后自己撤掉（不打断其它状态） */
  var warnTimer = 0;
  function warn(msg) {
    if (!st) return;
    st.hint = msg;
    setStatus();
    if (warnTimer) window.clearTimeout(warnTimer);
    warnTimer = window.setTimeout(function () {
      warnTimer = 0;
      if (st && st.hint === msg) { st.hint = ''; setStatus(); }
    }, 3000);
  }

  /** 把「电脑方」那一排勾选框同步成 aiFlags 的样子 */
  function syncAIPicker() {
    if (!elAIPick) return;
    var bs = elAIPick.getElementsByTagName('input');
    for (var i = 0; i < bs.length; i++) {
      bs[i].checked = !!aiFlags[+bs[i].getAttribute('data-side')];
    }
  }

  /** 一方电脑都没有时，「难度」「电脑间隔」留着也没用 —— 压暗并禁用 */
  function updateAIFields() {
    var none = (aiCount() === 0);
    if (elLevelField) elLevelField.className = 'field' + (none ? ' off' : '');
    if (elDelayField) elDelayField.className = 'field' + (none ? ' off' : '');
  }

  /**
   * 勾 / 取消某一方由电脑操控。返回是否真的改了。
   * 改完**立刻生效、不重开棋局**：变更后若轮到电脑就开走，轮到真人就等着点。
   */
  function setAI(side, on) {
    on = !!on;
    if (aiFlags[side] === on) { syncAIPicker(); return true; }
    if (on && aiCount() >= 3) {
      syncAIPicker();                    // 把刚勾上的那个退回去
      warn('电脑最多勾 3 方 —— 至少要留一方真人来操作');
      return false;
    }
    cancelAI();                          // 撤掉可能正等着的电脑计时器
    aiFlags[side] = on;
    syncAIPicker();
    updateAIFields();
    if (st.over || st.anim) { setStatus(); draw(); return true; }
    if (isAI(st.turn)) scheduleAI();
    else { setStatus(); draw(); }
    return true;
  }

  // ------------------------------------------------------------ 启动
  function boot() {
    canvas = $('board');
    ctx = canvas.getContext('2d');
    elStatus = $('status');
    elLevels = $('levels');
    elDelay = $('delay');
    elAIPick = $('aiPick');
    elLevelField = $('levelField');
    elDelayField = $('delayField');
    elUndo = $('undo');
    elMeta = $('meta');
    elSides = $('sides');

    elLevels.addEventListener('click', function (e) {
      var b = e.target;
      if (b && b.tagName === 'BUTTON') setLevel(+b.getAttribute('data-level'));
    });
    if (elDelay) {
      elDelay.addEventListener('click', function (e) {
        var b = e.target;
        if (b && b.tagName === 'BUTTON') setDelay(+b.getAttribute('data-delay'));
      });
    }
    $('restart').addEventListener('click', restart);
    $('rotate').addEventListener('click', rotTurn);
    document.getElementById('immersive').addEventListener('click', function () {
      immSet(!immOn(), true);
    });
    document.getElementById('exitImm').addEventListener('click', function () {
      immSet(false, true);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && immOn()) immSet(false, true);
    });
    elUndo.addEventListener('click', undo);
    canvas.addEventListener('click', onClick);
    if (elAIPick) {
      elAIPick.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.tagName === 'INPUT') setAI(+t.getAttribute('data-side'), t.checked);
      });
    }

    initSound();
    initDots();
    loadScheme();

    rot = rotLoad();
    st = newState();
    setLevel(st.level);
    if (elDelay) setDelay(st.delay);
    syncAIPicker();
    updateAIFields();
    setStatus();
    fitCanvas();
    tick();
    kickoff();

    if (immLoad()) immSet(true, false);

    var lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener('resize', function () {
      if (window.innerWidth === lastW && window.innerHeight === lastH) return;
      lastW = window.innerWidth; lastH = window.innerHeight;
      fitCanvas();
      if (st && !st.anim) draw();
    });

    loadImages(function () {
      if (TINT) {
        // 建好两套字形模型再上色：首帧用原图兜底，不会闪一下空白
        TINT.build(imgs, function () {
          applyScheme();
          if (/[?&]probe=1/.test(location.search)) probeScheme();
          if (window.console) console.log('[四界大战] 素材与棋子模型加载完成');
        });
      } else {
        draw();
        if (window.console) console.log('[四界大战] 素材加载完成（着色模块缺位，用原图）');
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // ------------------------------------------------------------ 自动化测试钩子
  window.__chess = {
    state: function () { return st; },
    select: select,
    apply: applyMove,
    hit: hit,
    legal: function () { return G.legalMoves(st.bd, st.mvf, st.turn); },
    legalFrom: legalFrom,
    blockedFrom: blockedFrom,
    geom: {
      SPACE: SPACE, MX: MX, MY: MY, PIECE: PIECE, TITLE_H: TITLE_H, RAIL: RAIL,
      GY0: GY0, COLS: COLS, ROWS: ROWS, BW: BW, BH: BH, BMH: BMH, W: W, H: H,
      px: function (c) { return px(c); }, py: function (r) { return py(r); },
      scale: function () { return viewScale; }
    },
    setDots: function (v) {
      var cb = $('dots');
      if (cb) cb.checked = !!v;
      showDots = !!v;
      draw();
      return showDots;
    },
    getDots: function () { return showDots; },
    setDelay: function (v) { setDelay(v); return st.delay; },
    delays: function () { return DELAYS.slice(); },
    setLevel: function (v) { setLevel(v); return st.level; },
    // 电脑参与方：setAI(方, true/false)；四方全勾会被挡下并返回 false
    setAI: setAI,
    // 配色：setScheme('青','紫红')；名字不在色板里就忽略该侧
    setScheme: function (left, right) {
      if (left && schemeOk(left)) scheme.left = left;
      if (right && schemeOk(right)) scheme.right = right;
      applyScheme();
      return { left: scheme.left, right: scheme.right };
    },
    getScheme: function () { return { left: scheme.left, right: scheme.right }; },
    aiFlags: function () { return aiFlags.slice(); },
    humanCount: humanCount,
    aiCount: aiCount,
    restart: restart,
    setSound: function (v) {
      var cb = $('sound');
      if (cb) cb.checked = !!v;
      soundOn = !!v;
      return soundOn;
    },
    core: G
  };
})();
