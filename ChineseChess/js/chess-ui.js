/*!
 * chess-ui.js — 画布渲染 + 交互 + 音效
 * 依赖 chess-core.js（规则/搜索）
 */
(function () {
  'use strict';

  var B = window.CC;
  if (!B) { console.error('chess-core.js 未加载'); return; }

  // ---- 几何：与 img/board.png、img/*.png 的烘焙尺寸严格对应 ----
  // 比例取自 APK scene.cfg（boardInterval 79 / pieceWidth 77 / piecePt 44,235 / boardPt 0,175）
  // → 首子圆心相对棋盘原点 (44,60)，即左右边距 44、上下边距 60；棋子直径/格距 = 77/79 = 0.975
  var SPACE = 60, MX = 29, MY = 41, PIECE = 58;
  var BW = 538, BH = 622;        // 棋盘本体
  var PAD = 26;                  // 画布上下各留 26px（透明，用来放金珠轨）
  var W = BW, H = BH + PAD * 2;  // 画布 538 x 674
  var OY = PAD;                  // 棋盘在画布里的 y 偏移
  var TYPES = ['j', 's', 'x', 'c', 'm', 'p', 'z'];

  // 选中棋子后是否显示"可走点"小圆点 —— 由右侧面板的「走法提示」开关控制，默认关。
  // 注意：关掉只影响"画不画"，st.ps 仍照常算，点可走格走子的逻辑不受影响。
  var showDots = false;

  // 对局模式：
  //   'pve' = 人机（红方是你，黑方是引擎）
  //   'pvp' = 双人（一台机器上两人轮流走，红的走完轮黑的，引擎不插手）
  var mode = 'pve';

  // 三档难度：固定搜索深度 + 随机宽容度 + 时间上限（毫秒）
  var LEVELS = {
    2: { depth: 2, slack: 60, budget: 600 },
    4: { depth: 4, slack: 15, budget: 1500 },
    6: { depth: 6, slack: 4, budget: 3000 }
  };
  var DEFAULT_LEVEL = 4;

  var ANIM_MS = 170;

  // ------------------------------------------------------------ DOM
  function $(id) { return document.getElementById(id); }
  var canvas, ctx, elStatus, elPlies, elLevels, elUndo, elBox;
  var elModes, elLevelField, elSub;
  var imgs = {}, boardImg = null;
  var soundOn = true, snd = {};

  // ------------------------------------------------------------ 状态
  var st = null;
  var animating = false;

  function newState() {
    var b = B.initialBoard();
    return {
      board: b,
      turn: B.RED,
      level: st ? st.level : DEFAULT_LEVEL,
      sel: -1,
      ps: [],
      hist: [],
      posList: [B.posKey(b)],
      last: null,
      anim: null,
      busy: false,
      over: false,
      overText: ''
    };
  }

  // ------------------------------------------------------------ 资源
  function loadImages(cb) {
    var names = [], i;
    for (i = 0; i < 7; i++) { names.push('r_' + TYPES[i]); names.push('b_' + TYPES[i]); }
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

  function pieceName(p) { return (p > 8 ? 'b_' : 'r_') + TYPES[(p % 8) - 1]; }

  var dpr = 1, viewScale = 1;

  /** 可用宽度：读 .wrap 的内容宽度（clientWidth 含内边距，再扣掉左右 padding）。
   *  原来写死「视口宽 - 48」，手机断点把 wrap 内边距改小之后算出来就比容器宽。 */
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
  var ROT_KEY = 'graywood.chess.rot';
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
   * 画布尺寸：逻辑坐标恒为 538x674，实际位图按 (视口缩放 × devicePixelRatio) 渲染，
   * 保证在小屏笔记本上整盘可见、在高分屏上依然清晰。
   * 2026-11-09 移动端适配：原来**只看窗口高度**，手机上 538 宽会横向溢出 ——
   * 现在宽高都收，宽度是硬约束（宁可小也不横溢）。
   */
  // ------------------------------------------------------------ 沉浸模式
  /* 2026-11-09：只留棋盘 —— 页头与面板整个 display:none，wrap 撑满视口把棋盘居中，
     左上角浮一个「✕ 退出」。退出按钮写在 body 下（不走 wrap 的 flex），不受布局影响。
     状态写 localStorage，与旋转同规矩：刷新后仍是沉浸（head 里有脚本提前打 class）。
     没动浏览器全屏 API：手机与 iframe 里 requestFullscreen 时灵时不灵，退出还得多一条同步。 */
  var IMM_KEY = 'graywood.chinese.imm';
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
    var cw = lw(), ch = lh();
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    var top = canvas.getBoundingClientRect().top || 0;
    var availW = availWidth();
    // 沉浸时棋盘在视口里居中，「到页顶的距离」量法失效，按整屏算（上下各 8px 留白）
    var availH = immOn() ? (window.innerHeight || 900) - 16
                         : (window.innerHeight || 900) - top - 26;
    var sW = availW / cw, sH = availH / ch;
    var vs = Math.min(1, sW, Math.max(0.5, sH));
    if (vs > sW) vs = sW;
    viewScale = vs;
    dpr = viewScale * Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = (cw * viewScale).toFixed(2) + 'px';
    canvas.style.height = (ch * viewScale).toFixed(2) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 改 canvas.width/height 会清空画布；墨水屏平时只重画脏区，
    // 不在这里打个「整屏重画」的标记，退出沉浸/旋转/改窗口之后盘上会只剩几个格子
    if (window.INK) INK.dirtyAll();
  }

  function px(col) { return MX + col * SPACE; }
  function py(row) { return OY + MY + row * SPACE; }

  // ------------------------------------------------------------ 金珠轨
  // 照 back.jpg 的外框观感画：竖向金渐变条 + 等距金珠（珠距约 0.6 格距）
  var RAILH = 12, STUD_R = 5.5, STUD_N = 15, RAIL_GAP = 1;
  var RAIL_Y0 = PAD - RAILH - RAIL_GAP;
  var RAIL_Y1 = OY + BH + RAIL_GAP;

  function drawRail(y0) {
    var g = ctx.createLinearGradient(0, y0, 0, y0 + RAILH);
    g.addColorStop(0.00, '#4a2f14');
    g.addColorStop(0.18, '#9c6008');
    g.addColorStop(0.38, '#c98b12');
    g.addColorStop(0.72, '#7a4f18');
    g.addColorStop(1.00, '#3a2410');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, BW, RAILH);
    ctx.strokeStyle = 'rgba(30,18,8,.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5); ctx.lineTo(BW, y0 + 0.5);
    ctx.moveTo(0, y0 + RAILH - 0.5); ctx.lineTo(BW, y0 + RAILH - 0.5);
    ctx.stroke();

    var step = BW / STUD_N, cy = y0 + RAILH / 2;
    for (var i = 0; i < STUD_N; i++) {
      var cx = step * (i + 0.5);
      var g2 = ctx.createRadialGradient(cx - 1.4, cy - 1.7, 0.4, cx, cy, STUD_R);
      g2.addColorStop(0.00, '#ffe98f');
      g2.addColorStop(0.45, '#f0b429');
      g2.addColorStop(1.00, '#a86c0e');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(cx, cy, STUD_R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(52,32,10,.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,248,214,.8)';
      ctx.beginPath(); ctx.arc(cx - 1.6, cy - 1.8, 1.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ 绘制
  function drawPieceAt(p, cx, cy) {
    if (INK.isOn()) { INK.piece(ctx, pieceName(p), cx, cy, PIECE); return; }
    var im = imgs[pieceName(p)];
    if (!im || !im.complete || !im.naturalWidth) return;
    ctx.drawImage(im, cx - PIECE / 2, cy - PIECE / 2, PIECE, PIECE);
  }
  function drawPieceAtIdx(p, i) { drawPieceAt(p, px(i % 9), py((i / 9) | 0)); }

  function drawRing(i, color, width, radiusMul) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(px(i % 9), py((i / 9) | 0), PIECE * (radiusMul || 0.52), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawFrame(i, color, width) {
    var x = px(i % 9), y = py((i / 9) | 0), s = PIECE * 0.46;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 2;
    ctx.strokeRect(x - s, y - s, s * 2, s * 2);
    ctx.restore();
  }

  function drawDot(i) {
    var x = px(i % 9), y = py((i / 9) | 0);
    var occupied = st.board[i] !== 0;
    if (INK.isOn()) { INK.hlDot(ctx, x, y, PIECE); return; }
    ctx.save();
    if (occupied) {
      ctx.strokeStyle = 'rgba(166,43,33,.50)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, PIECE * 0.5 - 1, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(166,43,33,.34)';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function draw() {
    var ink = INK.isOn();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!ink) ctx.clearRect(0, 0, lw(), lh());
    ctx.save();
    rotCtx();
    if (ink) {
      /* 墨水屏：只框「本帧与上帧涉及的交点」当 clip，其余像素一律不动。
         残影是按像素变化算的，整屏重写一步就会闪一下。
         走子动画在这个模式下直接不做 —— 170ms 里要重画十几次，屏幕上会拖一片灰。 */
      if (st.anim) st.anim = null;
      var ip = [], q;
      if (st.last) { ip.push(st.last.from); ip.push(st.last.to); }
      if (st.sel >= 0) {
        ip.push(st.sel);
        if (showDots) for (q = 0; q < st.ps.length; q++) ip.push(st.ps[q]);
      }
      INK.clip(ctx, ip, !!st.over);
      INK.board(ctx);
    } else if (boardImg && boardImg.complete && boardImg.naturalWidth) {
      ctx.drawImage(boardImg, 0, OY, BW, BH);
    } else {
      ctx.fillStyle = '#ddc38f';
      ctx.fillRect(0, OY, BW, BH);
    }
    if (!ink) {
      drawRail(RAIL_Y0);
      drawRail(RAIL_Y1);
    }

    var c = st.anim, prog = 1, done = false;
    if (c) {
      prog = (performance.now() - c.t0) / c.dur;
      if (prog >= 1) { prog = 1; done = true; }
    }

    if (st.last) {
      if (ink) {
        INK.hlLast(ctx, px(st.last.from % 9), py((st.last.from / 9) | 0), SPACE);
        INK.hlLast(ctx, px(st.last.to % 9), py((st.last.to / 9) | 0), SPACE);
      } else {
        drawFrame(st.last.from, 'rgba(120,110,90,.45)', 1.5);
        drawFrame(st.last.to, 'rgba(120,110,90,.45)', 1.5);
      }
    }

    var skip = (c && !done) ? c.from : -1;
    for (var i = 0; i < 90; i++) {
      var p = st.board[i];
      if (!p || i === skip) continue;
      drawPieceAtIdx(p, i);
    }

    if (c && !done) {
      var e = prog * prog * (3 - 2 * prog);            // smoothstep
      drawPieceAt(c.p, px(c.fc) + (px(c.tc) - px(c.fc)) * e,
                       py(c.fr) + (py(c.tr) - py(c.fr)) * e);
    }
    if (done) st.anim = null;

    if (st.sel >= 0) {
      if (ink) INK.hlSel(ctx, px(st.sel % 9), py((st.sel / 9) | 0), PIECE);
      else drawRing(st.sel, 'rgba(166,43,33,.80)', 2.5, 0.52);
      if (showDots) for (var k = 0; k < st.ps.length; k++) drawDot(st.ps[k]);
    }
    ctx.restore();                                // 收掉旋转变换
  }

  function tick() {
    draw();
    if (st.anim) { animating = true; requestAnimationFrame(tick); }
    else animating = false;
  }

  // ------------------------------------------------------------ 界面文案
  function sideName(s) { return s === B.RED ? '红方' : '黑方'; }

  function setStatus() {
    var t, cls = '';
    if (st.over) { t = st.overText; cls = 'over'; }
    else if (st.busy) { t = '电脑思考中'; cls = 'busy'; }
    else if (mode === 'pvp') {
      t = '轮到' + sideName(st.turn);
      if (B.inCheck(st.board, st.turn)) t = sideName(st.turn) + '被将军';
    } else {
      t = st.turn === B.RED ? '轮到你走' : '电脑走棋';
      if (B.inCheck(st.board, st.turn)) t = '被将军了，' + t;
    }
    elStatus.textContent = t;
    elStatus.className = 'status' + (cls ? ' ' + cls : '');
    elPlies.textContent = '第 ' + Math.ceil(st.hist.length / 2) + ' 手';
    elUndo.disabled = st.busy || st.hist.length === 0;
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

  // 右侧面板的「走法提示」开关：勾上就显示选中棋子的可走点。
  // 默认值以 HTML 上有没有 checked 为准（当前没有 = 关）。
  function initDots() {
    var cb = $('dots');
    showDots = cb ? cb.checked : false;
    if (cb) cb.addEventListener('change', function () {
      showDots = cb.checked;
      if (st) draw();             // 立刻重绘，不必等下一次点击
    });
  }
  function play(n) {
    if (!soundOn) return;
    var a = snd[n];
    if (!a) return;
    try { a.currentTime = 0; var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { }
  }

  // ------------------------------------------------------------ 走子
  function legalFrom(sq) {
    var p = st.board[sq];
    if (!p) return [];
    var all = B.legalMoves(st.board, B.sideOf(p)), out = [], i;
    for (i = 0; i < all.length; i++) if ((all[i] >> 7) === sq) out.push(all[i] & 127);
    return out;
  }

  function select(sq) {
    st.sel = sq;
    st.ps = sq >= 0 ? legalFrom(sq) : [];
    draw();
  }

  function applyMove(mv) {
    var from = mv >> 7, to = mv & 127;
    var p = st.board[from], cap = st.board[to];

    st.sel = -1; st.ps = [];
    st.anim = {
      from: from, to: to, p: p,
      fc: from % 9, fr: (from / 9) | 0,
      tc: to % 9, tr: (to / 9) | 0,
      t0: performance.now(), dur: ANIM_MS
    };
    B.makeMove(st.board, mv);
    st.last = { from: from, to: to };
    st.hist.push({ mv: mv, cap: cap, turn: st.turn });
    st.posList.push(B.posKey(st.board));
    st.turn = 1 - st.turn;

    play(cap ? 'capture' : 'move');
    tick();
    setStatus();
    window.setTimeout(afterMove, ANIM_MS + 30);
  }

  function repetition() {
    var key = st.posList[st.posList.length - 1], n = 0;
    for (var i = 0; i < st.posList.length; i++) if (st.posList[i] === key) n++;
    return n >= 3;
  }

  function afterMove() {
    var side = st.turn;                     // 轮到谁走
    if (!B.hasLegalMove(st.board, side)) {
      st.over = true;
      // 双人档没有「你/对方」，直接报哪一方胜；人机档才分你我
      st.overText = (mode === 'pvp')
        ? sideName(1 - side) + '胜'
        : (side === B.BLACK ? '你赢了' : '你输了');
      setStatus();
      // 音效也跟着视角走：人机档按"我"的输赢，双人档不播输赢音（两人共用一个屏幕）
      if (mode === 'pve') play(side === B.BLACK ? 'win' : 'lose');
      else play('win');
      draw();
      return;
    }
    if (repetition()) {
      st.over = true; st.overText = '和棋（同一局面出现三次）';
      setStatus(); draw();
      return;
    }
    if (B.inCheck(st.board, side)) play('check');
    setStatus(); draw();
    if (mode === 'pve' && st.turn === B.BLACK) scheduleAI();
  }

  function scheduleAI() {
    st.busy = true; setStatus();
    window.setTimeout(function () {
      var lv = LEVELS[st.level] || LEVELS[DEFAULT_LEVEL];
      var res = null;
      try {
        res = B.think(st.board, B.BLACK, {
          depth: lv.depth, slack: lv.slack, budget: lv.budget,
          seen: new Set(st.posList)
        });
      } catch (e) { console.error(e); }
      st.busy = false;
      if (mode !== 'pve') { setStatus(); draw(); return; }   // 思考期间被切到双人档了
      if (!res || res.move == null) {
        st.over = true; st.overText = '你赢了';
        setStatus(); play('win'); draw();
        return;
      }
      if (window.console && res.depth) {
        console.log('[AI] 深度' + res.depth + ' 值' + res.value + ' 节点' + res.nodes + ' ' + res.ms + 'ms');
      }
      applyMove(res.move);
    }, 40);
  }

  // ------------------------------------------------------------ 点击
  function hit(ev) {
    var lg = toLogical(ev);
    var x = lg[0], y = lg[1];
    var c = Math.round((x - MX) / SPACE), rw = Math.round((y - OY - MY) / SPACE);
    if (c < 0 || c > 8 || rw < 0 || rw > 9) return -1;
    var dx = x - px(c), dy = y - py(rw);
    if (dx * dx + dy * dy > (SPACE * 0.62) * (SPACE * 0.62)) return -1;
    return rw * 9 + c;
  }

  function onClick(ev) {
    if (st.over || st.busy || st.anim) return;
    // 人机档只有红方（你）能动手；双人档轮到哪一方就哪一方能点
    var mine = (mode === 'pvp') ? st.turn : B.RED;
    if (st.turn !== mine) return;
    var sq = hit(ev);
    if (sq < 0) { if (st.sel >= 0) select(-1); return; }
    var p = st.board[sq];

    if (p && B.sideOf(p) === mine) {
      if (st.sel === sq) { select(-1); return; }        // 再点一次取消
      select(sq); play('select');
      return;
    }
    if (st.sel >= 0 && st.ps.indexOf(sq) >= 0) {
      applyMove(st.sel * 128 + sq);
      return;
    }
    if (st.sel >= 0) select(-1);
  }

  // ------------------------------------------------------------ 按钮
  function restart() {
    INK.dirtyAll();          // 整盘换掉，墨水屏下必须整屏重画，否则旧棋子会留在画布上
    st = newState();
    tick(); setStatus();
  }

  function undo() {
    if (st.busy || st.anim || !st.hist.length) return;
    INK.dirtyAll();          // 悔棋会一次改回好几个格子
    st.over = false; st.overText = '';

    if (mode === 'pvp') {
      // 双人：退一手，轮到上一个人重走
      var h1 = st.hist.pop();
      if (h1) { B.unmakeMove(st.board, h1.mv, h1.cap); st.posList.pop(); st.turn = h1.turn; }
    } else {
      // 人机：一路退到自己该走（一般退两步 —— 电脑一步 + 自己走前那一步）
      var guard = 0;
      do {
        var h2 = st.hist.pop();
        if (!h2) break;
        B.unmakeMove(st.board, h2.mv, h2.cap);
        st.posList.pop();
        st.turn = h2.turn;
      } while (st.turn !== B.RED && ++guard < 4);
    }

    st.sel = -1; st.ps = [];
    var last = st.hist[st.hist.length - 1];
    st.last = last ? { from: last.mv >> 7, to: last.mv & 127 } : null;
    tick(); setStatus();
  }

  function setLevel(v) {
    st.level = v;
    var bs = elLevels.getElementsByTagName('button');
    for (var i = 0; i < bs.length; i++) {
      bs[i].className = (+bs[i].getAttribute('data-level') === v) ? 'on' : '';
    }
  }

  // 切换对局模式。不重开棋局 —— 局面原样保留：
  //   双人 → 人机  且正轮到黑方，电脑立刻接手；
  //   人机 → 双人  黑方交给人来点。
  function setMode(v) {
    mode = (v === 'pvp') ? 'pvp' : 'pve';
    // 页面里没有这个控件也照常工作（自动化测试页可能只摘了面板的一部分）
    if (elModes) {
      var bs = elModes.getElementsByTagName('button');
      for (var i = 0; i < bs.length; i++) {
        bs[i].className = (bs[i].getAttribute('data-mode') === mode) ? 'on' : '';
      }
    }
    if (elLevelField) elLevelField.className = 'field' + (mode === 'pve' ? '' : ' dim');
    if (elSub) {
      elSub.textContent = (mode === 'pve')
        ? '单机人机对弈 · 红先 · 三档难度'
        : '双人轮流走 · 一台机器 · 红先';
    }
    if (!st) return;
    st.sel = -1; st.ps = [];
    setStatus(); draw();
    if (mode === 'pve' && !st.over && !st.busy && !st.anim && st.turn === B.BLACK) scheduleAI();
  }

  // ------------------------------------------------------------ 启动
  function boot() {
    canvas = $('board');
    ctx = canvas.getContext('2d');
    elStatus = $('status');
    elPlies = $('plies');
    elLevels = $('levels');
    elUndo = $('undo');
    elBox = $('boardBox');
    elModes = $('modes');
    elLevelField = $('levelField');
    elSub = $('sub');

    if (elModes) {
      elModes.addEventListener('click', function (e) {
        var b = e.target;
        if (b && b.tagName === 'BUTTON') setMode(b.getAttribute('data-mode'));
      });
    }
    elLevels.addEventListener('click', function (e) {
      var b = e.target;
      if (b && b.tagName === 'BUTTON') setLevel(+b.getAttribute('data-level'));
    });
    $('restart').addEventListener('click', restart);
    $('rotate').addEventListener('click', rotTurn);
    document.getElementById('immersive').addEventListener('click', function () {
      immSet(!immOn(), true);
    });
    document.getElementById('exitImm').addEventListener('click', function () {
      immSet(false, true);
    });
    // 墨水屏是自用开关：入口在面板里，键盘按 i 也能切（切了整页重来）
    var elInk = document.getElementById('ink');
    if (elInk) {
      elInk.textContent = INK.isOn() ? '墨水屏 · 开' : '墨水屏';
      elInk.addEventListener('click', function () { INK.toggle(); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && immOn()) immSet(false, true);
      if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var t = e.target && e.target.tagName;
        if (t !== 'INPUT' && t !== 'TEXTAREA') INK.toggle();
      }
    });
    elUndo.addEventListener('click', undo);
    canvas.addEventListener('click', onClick);

    initSound();
    initDots();
    rot = rotLoad();
    fitCanvas();

    var lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener('resize', function () {
      if (window.innerWidth === lastW && window.innerHeight === lastH) return;
      lastW = window.innerWidth; lastH = window.innerHeight;
      fitCanvas();
      if (st && !st.anim) draw();
    });

    st = newState();
    // 墨水屏模块要在第一次 draw 之前 init：它管着棋盘线、棋子重绘和脏区 clip
    INK.init({
      type: 'xiangqi', W: W, H: H, cell: SPACE, piece: PIECE,
      xy: function (i) { return [px(i % 9), py((i / 9) | 0)]; }
    });
    setMode(mode);          // 同步一次按钮态／难度置灰／副标题
    setStatus();
    tick();

    // 恢复上次的沉浸状态：必须放在局面建好、tick 起跑之后 ——
    // immSet 里会 fitCanvas + draw，早一步 st 还是 null，draw 抛错会把整个 boot 打断
    // 墨水屏一开就强制沉浸：既然是墨水屏，本来就是只看棋盘
    if (immLoad() || INK.isOn()) immSet(true, false);

    loadImages(function () {
      draw();
      if (window.console) console.log('[象棋] 素材加载完成');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 给自动化测试留的钩子
  window.__chess = {
    state: function () { return st; },
    // 测试用：强制整屏重画一帧（用来验证墨水屏的脏区重绘没漏画）
    redraw: function () { INK.dirtyAll(); draw(); },
    select: select,
    apply: applyMove,
    legal: function () { return B.legalMoves(st.board, st.turn); },
    geom: { SPACE: SPACE, MX: MX, MY: MY, PIECE: PIECE, PAD: PAD, OY: OY,
            BW: BW, BH: BH, W: W, H: H },
    // 界面里那个「走法提示」开关 —— setDots 会同步勾选框状态，测试用
    setDots: function (v) {
      var cb = $('dots');
      if (cb) cb.checked = !!v;
      showDots = !!v;
      draw();
      return showDots;
    },
    getDots: function () { return showDots; },
    // 对局模式开关（人机 / 双人）
    setMode: function (v) { setMode(v); return mode; },
    getMode: function () { return mode; },
    undo: undo,
    restart: restart,
    core: B
  };
})();
