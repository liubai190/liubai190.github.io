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

  /**
   * 画布尺寸：逻辑坐标恒为 588x648，实际位图按 (视口缩放 × devicePixelRatio) 渲染，
   * 保证在小屏笔记本上整盘可见、在高分屏上依然清晰。
   * （仅按窗口高度收缩，不做移动端布局）
   */
  function fitCanvas() {
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    var top = canvas.getBoundingClientRect().top || 0;
    var avail = (window.innerHeight || 900) - top - 26;
    viewScale = Math.max(0.55, Math.min(1, avail / H));
    dpr = viewScale * Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = (W * viewScale).toFixed(2) + 'px';
    canvas.style.height = (H * viewScale).toFixed(2) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    ctx.clearRect(0, 0, W, H);
    if (boardImg && boardImg.complete && boardImg.naturalWidth) {
      ctx.drawImage(boardImg, 0, OY, BW, BH);
    } else {
      ctx.fillStyle = '#ddc38f';
      ctx.fillRect(0, OY, BW, BH);
    }
    drawRail(RAIL_Y0);
    drawRail(RAIL_Y1);

    var c = st.anim, prog = 1, done = false;
    if (c) {
      prog = (performance.now() - c.t0) / c.dur;
      if (prog >= 1) { prog = 1; done = true; }
    }

    if (st.last) { drawFrame(st.last.from, 'rgba(120,110,90,.45)', 1.5); drawFrame(st.last.to, 'rgba(120,110,90,.45)', 1.5); }

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
      drawRing(st.sel, 'rgba(166,43,33,.80)', 2.5, 0.52);
      if (showDots) for (var k = 0; k < st.ps.length; k++) drawDot(st.ps[k]);
    }
  }

  function tick() {
    draw();
    if (st.anim) { animating = true; requestAnimationFrame(tick); }
    else animating = false;
  }

  // ------------------------------------------------------------ 界面文案
  function setStatus() {
    var t, cls = '';
    if (st.over) { t = st.overText; cls = 'over'; }
    else if (st.busy) { t = '电脑思考中'; cls = 'busy'; }
    else {
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
    var all = B.legalMoves(st.board, B.RED), out = [], i;
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
      st.overText = side === B.BLACK ? '你赢了' : '你输了';
      setStatus(); play(side === B.BLACK ? 'win' : 'lose');
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
    if (st.turn === B.BLACK) scheduleAI();
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
    var r = canvas.getBoundingClientRect();
    var x = (ev.clientX - r.left) * (W / r.width);
    var y = (ev.clientY - r.top) * (H / r.height);
    var c = Math.round((x - MX) / SPACE), rw = Math.round((y - OY - MY) / SPACE);
    if (c < 0 || c > 8 || rw < 0 || rw > 9) return -1;
    var dx = x - px(c), dy = y - py(rw);
    if (dx * dx + dy * dy > (SPACE * 0.62) * (SPACE * 0.62)) return -1;
    return rw * 9 + c;
  }

  function onClick(ev) {
    if (st.over || st.busy || st.anim) return;
    var sq = hit(ev);
    if (sq < 0) { if (st.sel >= 0) select(-1); return; }
    var p = st.board[sq];

    if (p && B.sideOf(p) === B.RED) {
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
    st = newState();
    tick(); setStatus();
  }

  function undo() {
    if (st.busy || st.anim || !st.hist.length) return;
    st.over = false; st.overText = '';
    var guard = 0;
    do {
      var h = st.hist.pop();
      if (!h) break;
      B.unmakeMove(st.board, h.mv, h.cap);
      st.posList.pop();
      st.turn = h.turn;
    } while (st.turn !== B.RED && ++guard < 4);

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

  // ------------------------------------------------------------ 启动
  function boot() {
    canvas = $('board');
    ctx = canvas.getContext('2d');
    elStatus = $('status');
    elPlies = $('plies');
    elLevels = $('levels');
    elUndo = $('undo');
    elBox = $('boardBox');

    elLevels.addEventListener('click', function (e) {
      var b = e.target;
      if (b && b.tagName === 'BUTTON') setLevel(+b.getAttribute('data-level'));
    });
    $('restart').addEventListener('click', restart);
    elUndo.addEventListener('click', undo);
    canvas.addEventListener('click', onClick);

    initSound();
    initDots();
    fitCanvas();

    var lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener('resize', function () {
      if (window.innerWidth === lastW && window.innerHeight === lastH) return;
      lastW = window.innerWidth; lastH = window.innerHeight;
      fitCanvas();
      if (st && !st.anim) draw();
    });

    st = newState();
    setStatus();
    tick();

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
    core: B
  };
})();
