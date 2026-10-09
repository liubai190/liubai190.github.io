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
  var SIDE_TXT = ['红', '黑', '青', '蓝'];    // 屏幕上显示的军名，按颜色叫

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
  var imgs = {}, boardImg = null;
  var soundOn = true, snd = {};
  var showDots = false;       // 「走法提示」开关，默认关（与上一版一致）
  var aiTimer = 0;            // 电脑等节奏的计时器（悔棋/重开要能把它撤掉）
  var gen = 0;                // 局面代次：重开后旧计时器一律作废

  // ------------------------------------------------------------ 状态
  var st = null;

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
   * 画布尺寸：逻辑坐标恒为 1116x750，位图按（视口缩放 x devicePixelRatio）渲染。
   * 面板已经从右侧挪到棋盘下方，所以纵向余量更紧 —— 按宽高都收，但留 0.66 下限，
   * 实在放不下就让页面滚动，不把棋盘缩成看不清的小块。
   */
  function fitCanvas() {
    var top = canvas.getBoundingClientRect().top || 0;
    var availW = (document.documentElement.clientWidth || 1200) - 48;
    var availH = (window.innerHeight || 900) - top - 26;
    var sW = availW / W, sH = availH / H;
    var vs = Math.min(1, sW);
    if (vs > sH) vs = Math.max(0.66, sH);
    vs = Math.max(0.5, vs);
    viewScale = vs;
    dpr = viewScale * Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = (W * viewScale).toFixed(2) + 'px';
    canvas.style.height = (H * viewScale).toFixed(2) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function px(c) { return MX + c * SPACE; }
  function py(r) { return GY0 + r * SPACE; }

  // ------------------------------------------------------------ 绘制
  function drawPiece(p, cx, cy, alpha) {
    var im = imgs[pieceName(p)];
    if (!im || !im.complete || !im.naturalWidth) return;
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
    ctx.clearRect(0, 0, W, H);
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
  }

  function tick() {
    draw();
    if (st && st.anim) requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ 界面文案
  function setStatus() {
    var t, cls = '';
    if (st.over) { t = st.overText; cls = 'over'; }
    else if (st.hint) { t = st.hint; cls = 'hint'; }
    else if (st.busy) { t = SIDE_TXT[st.turn] + '方思考中'; cls = 'busy'; }
    else if (st.turn === G.RED) {
      t = '轮到你走（红）';
      if (G.inCheck(st.bd, G.RED)) t = '你被将军了！' + t;
    } else {
      t = SIDE_TXT[st.turn] + '方走棋';
      if (G.inCheck(st.bd, st.turn)) t = SIDE_TXT[st.turn] + '方被将军';
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
      html += '<span class="' + cl + '">' + SIDE_TXT[i] + (i === G.RED ? '（你）' : '') + '</span>';
    }
    elSides.innerHTML = html;
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
  function legalFrom(sq) {
    var all = G.legalMoves(st.bd, st.mvf, G.RED), out = [];
    for (var i = 0; i < all.length; i++) if (G.moveFrom(all[i]) === sq) out.push(G.moveTo(all[i]));
    return out;
  }
  function blockedFrom(sq) {
    var all = G.blockedByRule(st.bd, st.mvf, G.RED), out = [];
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

    if (!st.alive[G.RED]) {
      st.over = true;
      st.overText = aliveCount() <= 1 ? '红方出局，' + SIDE_TXT[st.turn] + '方胜' : '红方出局（你已出局）';
      setStatus(); play('lose'); draw();
      return;
    }
    if (aliveCount() <= 1) {
      st.over = true;
      st.overText = '你赢了！（四方仅存红方）';
      setStatus(); play('win'); draw();
      return;
    }
    if (repetition()) {
      st.over = true; st.overText = '和棋（同一局面出现四次）';
      setStatus(); draw(); return;
    }
    if (G.inCheck(st.bd, st.turn)) play('check');
    setStatus(); draw();
    if (st.turn !== G.RED) scheduleAI();
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
    var r = canvas.getBoundingClientRect();
    var x = (ev.clientX - r.left) * (W / r.width);
    var y = (ev.clientY - r.top) * (H / r.height);
    var c = Math.round((x - MX) / SPACE), rw = Math.round((y - GY0) / SPACE);
    if (c < 0 || c >= COLS || rw < 0 || rw >= ROWS) return -1;
    var dx = x - px(c), dy = y - py(rw);
    if (dx * dx + dy * dy > (SPACE * 0.60) * (SPACE * 0.60)) return -1;
    return rw * COLS + c;
  }

  function onClick(ev) {
    if (st.over || st.busy || st.anim) return;
    if (st.turn !== G.RED) return;
    var sq = hit(ev);
    if (sq < 0) { if (st.sel >= 0) select(-1); return; }
    var p = st.bd[sq];

    if (p && G.sideOf(p) === G.RED) {
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
  }

  function undo() {
    if (st.anim || !st.hist.length) return;
    cancelAI();                       // 电脑还在等节奏的话，先把它的计时器撤掉
    st.over = false; st.overText = ''; st.hint = '';
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
    } while (st.turn !== G.RED && ++guard < 6);

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

  // ------------------------------------------------------------ 启动
  function boot() {
    canvas = $('board');
    ctx = canvas.getContext('2d');
    elStatus = $('status');
    elLevels = $('levels');
    elDelay = $('delay');
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
    elUndo.addEventListener('click', undo);
    canvas.addEventListener('click', onClick);

    initSound();
    initDots();

    st = newState();
    setLevel(st.level);
    if (elDelay) setDelay(st.delay);
    setStatus();
    fitCanvas();
    tick();

    var lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener('resize', function () {
      if (window.innerWidth === lastW && window.innerHeight === lastH) return;
      lastW = window.innerWidth; lastH = window.innerHeight;
      fitCanvas();
      if (st && !st.anim) draw();
    });

    loadImages(function () {
      draw();
      if (window.console) console.log('[四界大战] 素材加载完成');
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
    setSound: function (v) {
      var cb = $('sound');
      if (cb) cb.checked = !!v;
      soundOn = !!v;
      return soundOn;
    },
    core: G
  };
})();
