/*!
 * flip-ui.js —— 翻棋（暗棋）画布渲染 + 交互 + 音效
 * 依赖 flip-core.js（规则 / AI）
 *
 * 棋盘 img/board.png 是烘焙好的 8x4 半盘（格盘，不是象棋的交叉点），
 * 本文件只负责摆棋子、画高亮、收点击。
 *
 * 关于「谁执什么颜色」：座位 0 是先手（翻第一枚棋子的那个人），
 * 人机模式下座位 0 恒为玩家、座位 1 为电脑 —— 先行者翻出的颜色决定归属，
 * 所以人机模式里玩家也可能执黑。
 */
(function () {
  'use strict';

  var FQ = window.FQ;
  if (!FQ) { console.error('flip-core.js 未加载'); return; }

  // ---- 几何：与 _gen_assets.py 烘焙出来的 img/board.png 严格一致 ----
  var SPACE = 104, MX = 28, MY = 28, PIECE = 87;
  var COLS = FQ.COLS, ROWS = FQ.ROWS, NSQ = FQ.NSQ;
  var W = 888, H = 472;

  function X(i) { return MX + SPACE / 2 + FQ.colOf(i) * SPACE; }
  function Y(i) { return MY + SPACE / 2 + FQ.rowOf(i) * SPACE; }

  var DELAYS = [0.8, 1.5, 2.5, 4];
  var DELAY_TXT = ['0.8', '1.5', '2.5', '4'];
  var DEFAULT_DELAY = 1.5;

  // ------------------------------------------------------------ DOM
  function $(id) { return document.getElementById(id); }
  var canvas, ctx, elStatus, elSides, elMeta, elLevels, elDelays, elUndo, elRestart, elSound, elHint, elRules, elMode;

  var boardImg = null, backImg = null, imgs = {};
  var soundOn = true, snd = {};
  var dpr = 1, viewScale = 1;

  // ------------------------------------------------------------ 状态
  var g = null;
  var sel = -1, targets = [];
  var hintOn = true;          // 走法提示：关掉后不画任何可走点
  var hoverSq = -1, hoverArr = [];   // 鼠标悬停在自己明子上时的走法
  var mode = 'pve';           // pve = 人机（座位 0 玩家 / 座位 1 电脑）, pvp = 双人
  var level = 2;
  var delay = DEFAULT_DELAY;
  var busy = false, over = false;
  var aiTimer = 0, gen = 0;   // gen：重开 / 悔棋后旧计时器一律作废

  function newGame() {
    cancelAI();
    g = FQ.createGame();
    sel = -1; targets = [];
    hoverSq = -1; hoverArr = [];
    busy = false; over = false;
    draw(); render();
  }

  function cancelAI() {
    if (aiTimer) { window.clearTimeout(aiTimer); aiTimer = 0; }
    gen++;
    busy = false;
  }

  // ------------------------------------------------------------ 资源
  function loadImages(cb) {
    var names = ['r_j', 'r_s', 'r_x', 'r_c', 'r_m', 'r_p', 'r_z',
                 'b_j', 'b_s', 'b_x', 'b_c', 'b_m', 'b_p', 'b_z'];
    var total = names.length + 2, done = 0;
    function tick() { if (++done >= total) cb(); }
    names.forEach(function (n) {
      var im = new Image();
      im.onload = tick; im.onerror = tick;
      im.src = 'img/' + n + '.png';
      imgs[n] = im;
    });
    boardImg = new Image(); boardImg.onload = tick; boardImg.onerror = tick;
    boardImg.src = 'img/board.png';
    backImg = new Image(); backImg.onload = tick; backImg.onerror = tick;
    backImg.src = 'img/back.png';
  }

  function fitCanvas() {
    var availW = (document.documentElement.clientWidth || 1200) - 48;
    var vs = Math.min(1, availW / W);
    vs = Math.max(0.42, vs);
    viewScale = vs;
    dpr = viewScale * Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = (W * viewScale).toFixed(2) + 'px';
    canvas.style.height = (H * viewScale).toFixed(2) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ------------------------------------------------------------ 绘制
  function drawImg(im, cx, cy, size, alpha) {
    if (!im || !im.complete || !im.naturalWidth) return;
    var a = (alpha == null) ? 1 : alpha;
    if (a < 1) ctx.globalAlpha = a;
    ctx.drawImage(im, cx - size / 2, cy - size / 2, size, size);
    if (a < 1) ctx.globalAlpha = 1;
  }

  function ring(i, color, width, mul, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(X(i), Y(i), PIECE * (mul || 0.50), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    if (!g) return;
    ctx.clearRect(0, 0, W, H);
    if (boardImg && boardImg.complete && boardImg.naturalWidth) {
      ctx.drawImage(boardImg, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#ddc38f'; ctx.fillRect(0, 0, W, H);
    }

    var i, p;

    // 上一步
    if (g.last) {
      var l = g.last;
      ctx.save();
      ctx.strokeStyle = 'rgba(224,179,84,.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(X(l.f) - SPACE / 2 + 3, Y(l.f) - SPACE / 2 + 3, SPACE - 6, SPACE - 6);
      if (l.t !== l.f) ctx.strokeRect(X(l.t) - SPACE / 2 + 3, Y(l.t) - SPACE / 2 + 3, SPACE - 6, SPACE - 6);
      ctx.restore();
    }

    // 棋子
    for (i = 0; i < NSQ; i++) {
      p = g.bd[i];
      if (!p) continue;
      if (!g.open[i]) drawImg(backImg, X(i), Y(i), PIECE);
      else drawImg(imgs[FQ.pieceName(p)], X(i), Y(i), PIECE);
    }

    // 可走 / 可吃（「走法提示」关掉后一个点都不画）
    var dots = hintOn ? targets : [];
    for (i = 0; i < dots.length; i++) {
      var m = dots[i];
      if (m.k === 2) ring(m.t, 'rgba(198,52,38,.85)', 3, 0.50);
      else {
        ctx.save();
        ctx.fillStyle = 'rgba(198,52,38,.42)';
        ctx.beginPath(); ctx.arc(X(m.t), Y(m.t), 10, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }

    // 悬停提示：比选中的淡一档，且只在手上没有选中子的时候出现
    var hd = (hintOn && sel < 0) ? hoverArr : [];
    for (i = 0; i < hd.length; i++) {
      var hm = hd[i];
      if (hm.k === 2) ring(hm.t, 'rgba(198,52,38,.42)', 2.5, 0.47);
      else {
        ctx.save();
        ctx.fillStyle = 'rgba(198,52,38,.20)';
        ctx.beginPath(); ctx.arc(X(hm.t), Y(hm.t), 9, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
    if (hd.length) ring(hoverSq, 'rgba(255,214,120,.42)', 2, 0.53);

    // 选中
    if (sel >= 0) ring(sel, 'rgba(255,214,120,.95)', 3.5, 0.52);
  }

  // ------------------------------------------------------------ 提示
  function seatName(seat) {
    return mode === 'pve' ? (seat === 0 ? '你' : '电脑') : (seat === 0 ? '先手' : '后手');
  }
  function colorName(c) { return c === FQ.RED ? '红' : '黑'; }

  function resultText() {
    var r = g.result;
    if (!r) return '';
    if (r.draw) {
      var why = r.reason === 'quiet' ? '连续 70 步无吃子或翻子'
              : r.reason === 'maxply' ? '双方总步数满 500'
              : '同一局面重复';
      return '和棋 —— ' + why;
    }
    var myColor = g.seatColor[0];
    var line;
    if (mode === 'pve') line = (r.winColor === myColor) ? '你赢了' : '你输了';
    else line = colorName(r.winColor) + '方胜';
    var why2 = r.reason === 'nomove' ? '对方无棋可走' : '对方棋子被吃光';
    return line + ' —— ' + why2;
  }

  function render() {
    if (!g) return;
    var s = '';
    if (g.result) {
      s = resultText();
      elStatus.className = 'status over';
    } else if (busy) {
      s = '电脑思考中';
      elStatus.className = 'status busy';
    } else {
      var col = g.seatColor[g.turn];
      if (g.seatColor[0] == null) {
        s = mode === 'pve' ? '翻一枚棋子开局 —— 翻出的颜色就是你执的一方'
                           : '先手翻一枚棋子开局 —— 翻出的颜色决定他执哪一方';
        elStatus.className = 'status hint';
      } else {
        s = (mode === 'pve' ? (g.turn === 0 ? '轮到你走' : '电脑走棋')
                            : seatName(g.turn) + '（' + colorName(col) + '）走棋');
        if (sel >= 0) {
          var p = g.bd[sel];
          s += ' · 选中 ' + FQ.pieceText(p);
        }
        elStatus.className = 'status';
      }
    }
    elStatus.textContent = s;

    // 状态条：只显示公开信息（剩余子数可由「总量 − 已吃掉」推得）
    var n = FQ.aliveCount(g), hidden = 0, i;
    for (i = 0; i < NSQ; i++) if (g.bd[i] && !g.open[i]) hidden++;
    var pieces = [
      '<span class="side s-red">红 ' + n[FQ.RED] + '</span>',
      '<span class="side s-black">黑 ' + n[FQ.BLACK] + '</span>',
      '<span class="side">暗子 ' + hidden + '</span>'
    ];
    if (g.seatColor[0] != null && mode === 'pve') {
      pieces.unshift('<span class="side' + (g.turn === 0 ? ' now' : '') + '">你执' +
                     colorName(g.seatColor[0]) + '</span>');
    }
    elSides.innerHTML = pieces.join('');

    // 上一手摘要
    var lt = '';
    if (g.last) {
      var who = mode === 'pve' ? (g.last.seat === 0 ? '你' : '电脑')
                               : (g.last.seat === 0 ? '先手' : '后手');
      if (g.last.k === 0) lt = who + ' 翻开 ' + FQ.pieceText(g.last.piece);
      else if (g.last.cap) lt = who + ' 用 ' + FQ.pieceText(g.last.piece) + ' 吃掉 ' + FQ.pieceText(g.last.cap);
      else lt = who + ' ' + FQ.pieceText(g.last.piece) + ' 走一格';
    }
    elMeta.textContent = lt || '尚未落子';

    elUndo.disabled = !g.hist.length;
  }

  // ------------------------------------------------------------ 落子
  function legalHereFrom(i) {
    var all = FQ.legalMoves(g), out = [], k;
    for (k = 0; k < all.length; k++) if (all[k].f === i && all[k].k !== 0) out.push(all[k]);
    return out;
  }

  function legalHere() { return legalHereFrom(sel); }

  // 悬停到某一格：只有「轮到我 + 已经翻开 + 是我的子」才给提示，
  // 扣着的子一律没有 —— 免得鼠标一扫就把暗子的身份漏出去
  function hoverTargets(i) {
    var p = g.bd[i];
    if (!p || !g.open[i]) return [];
    if (g.seatColor[g.turn] == null) return [];
    if (FQ.sideOf(p) !== g.seatColor[g.turn]) return [];
    return legalHereFrom(i);
  }

  function sameMove(a, b) { return a.k === b.k && a.f === b.f && a.t === b.t; }

  function play(mv) {
    var all = FQ.legalMoves(g), ok = false, i;
    for (i = 0; i < all.length; i++) if (sameMove(all[i], mv)) { ok = true; break; }
    if (!ok) { beep('check'); return; }

    FQ.doMove(g, mv);
    sel = -1; targets = [];

    if (mv.k === 0) beep('move');
    else if (g.last.cap) beep('capture');
    else beep('move');

    draw(); render();
    if (g.result) { finish(); return; }
    scheduleAI();
  }

  function humanCanAct() {
    if (!g || g.result || busy) return false;
    if (mode === 'pve') return g.turn === 0;
    return true;
  }

  function onSquare(i) {
    if (!g) return;
    hoverSq = -1; hoverArr = [];
    if (!humanCanAct()) { beep('check'); return; }

    var p = g.bd[i], col = g.seatColor[g.turn];

    // 1) 已选中：先看是不是走 / 吃
    if (sel >= 0) {
      for (var k = 0; k < targets.length; k++) {
        if (targets[k].t === i) { play(targets[k]); return; }
      }
    }
    // 2) 暗子 -> 翻开
    if (p && !g.open[i]) { play({ k: 0, f: i, t: i }); return; }
    // 3) 自己的明子 -> 选中 / 取消
    if (p && g.open[i] && FQ.sideOf(p) === col) {
      if (sel === i) { sel = -1; targets = []; draw(); render(); return; }
      sel = i; targets = legalHere();
      beep('select'); draw(); render(); return;
    }
    // 4) 其它 -> 取消
    if (sel >= 0) { sel = -1; targets = []; draw(); render(); return; }
    beep('check');
  }

  // ------------------------------------------------------------ 电脑
  function scheduleAI() {
    if (mode !== 'pve' || g.result || g.turn !== 1) return;
    busy = true; render();
    var my = ++gen;
    aiTimer = window.setTimeout(function () {
      if (my !== gen) return;
      var mv = FQ.chooseMove(g, level, Math.random);
      if (my !== gen) return;
      busy = false;
      if (!mv) { render(); return; }
      aiTimer = 0;
      play(mv);
    }, Math.max(120, delay * 1000));
  }

  function finish() {
    cancelAI();
    over = true;
    var r = g.result;
    if (r && r.draw) beep('check');
    else {
      var mine = (mode === 'pve') ? (r.winColor === g.seatColor[0]) : null;
      if (mine === true) beep('win');
      else if (mine === false) beep('lose');
      else beep('win');
    }
    render();
  }

  // ------------------------------------------------------------ 音效
  function beep(name) {
    if (!soundOn) return;
    var a = snd[name];
    if (!a) return;
    try { a.currentTime = 0; var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
  }

  // ------------------------------------------------------------ 装配
  function bindSeg(el, attr, fn) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      var kids = el.querySelectorAll('button'), i;
      for (i = 0; i < kids.length; i++) kids[i].classList.remove('on');
      b.classList.add('on');
      fn(b.getAttribute(attr), b);
    });
  }

  function boot() {
    canvas = $('board'); ctx = canvas.getContext('2d');
    elStatus = $('status'); elSides = $('sides'); elMeta = $('meta');
    elLevels = $('levels'); elDelays = $('delays');
    elUndo = $('undo'); elRestart = $('restart');
    elSound = $('sound'); elHint = $('hint'); elRules = $('rules'); elMode = $('modes');

    snd.select = $('snd-select'); snd.move = $('snd-move');
    snd.capture = $('snd-capture'); snd.check = $('snd-check');
    snd.win = $('snd-win'); snd.lose = $('snd-lose');

    function squareAt(e) {
      var rect = canvas.getBoundingClientRect();
      var x = (e.clientX - rect.left) / viewScale;
      var y = (e.clientY - rect.top) / viewScale;
      var c = Math.floor((x - MX) / SPACE), r = Math.floor((y - MY) / SPACE);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
      return r * COLS + c;
    }

    canvas.addEventListener('click', function (e) {
      if (!g) return;
      var i = squareAt(e);
      if (i >= 0) onSquare(i);
    });

    // 鼠标停在自己的明子上就预览走法（「走法提示」关掉时不做任何事）
    canvas.addEventListener('mousemove', function (e) {
      if (!g) return;
      var i = squareAt(e), want = -1, arr = [];
      if (i >= 0 && hintOn && sel < 0 && humanCanAct()) {
        arr = hoverTargets(i);
        if (arr.length) want = i;
      }
      if (want === hoverSq) return;      // 指着的还是同一格就不重绘
      hoverSq = want; hoverArr = arr;
      draw();
    });

    canvas.addEventListener('mouseleave', function () {
      if (hoverSq < 0) return;
      hoverSq = -1; hoverArr = []; draw();
    });

    bindSeg(elLevels, 'data-level', function (v) { level = +v; });
    bindSeg(elDelays, 'data-delay', function (v) { delay = +v; });
    bindSeg(elMode, 'data-mode', function (v) {
      mode = v;
      var kids = elMode.querySelectorAll('button');
      for (var i = 0; i < kids.length; i++) kids[i].disabled = false;
      newGame();
    });

    elUndo.addEventListener('click', function () {
      if (!g || !g.hist.length) return;
      cancelAI();
      FQ.undo(g);
      if (mode === 'pve' && g.hist.length && g.turn !== 0) FQ.undo(g);
      sel = -1; targets = []; over = false;
      draw(); render();
      scheduleAI();
    });

    elRestart.addEventListener('click', function () { newGame(); });

    elSound.addEventListener('change', function () { soundOn = elSound.checked; });

    elHint.addEventListener('change', function () {
      hintOn = elHint.checked;
      if (!hintOn) { hoverSq = -1; hoverArr = []; }
      draw();
    });

    elRules.addEventListener('click', function () {
      var box = $('rulesbox');
      box.hidden = !box.hidden;
      elRules.textContent = box.hidden ? '规则' : '收起规则';
    });

    // 先建局面：否则图片加载完的回调里 draw()/render() 拿不到 g
    g = FQ.createGame();
    loadImages(function () {
      fitCanvas(); draw(); render();
    });
    window.addEventListener('resize', function () { fitCanvas(); draw(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 自动化测试用的调试入口（正常游玩用不到，也不影响任何行为）
  window.FQ_UI = {
    game: function () { return g; },
    play: play,
    square: onSquare,
    setMode: function (m) { mode = m; newGame(); },
    setLevel: function (l) { level = l; },
    setDelay: function (d) { delay = d; },
    isBusy: function () { return busy; },
    isHumanTurn: humanCanAct,
    isOver: function () { return over; },
    setHint: function (v) {
      elHint.checked = !!v;
      elHint.dispatchEvent(new Event('change'));
    },
    hover: function (i) {
      hoverSq = -1; hoverArr = [];
      if (i >= 0 && hintOn && sel < 0 && humanCanAct()) {
        var arr = hoverTargets(i);
        if (arr.length) { hoverSq = i; hoverArr = arr; }
      }
      draw();
    },
    dbg: function () {
      return { hint: hintOn, sel: sel, targets: targets.length,
               hoverSq: hoverSq, hover: hoverArr.length };
    },
    newGame: newGame,
    undo: function () { elUndo.click(); }
  };
})();
