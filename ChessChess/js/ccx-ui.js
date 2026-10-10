/*!
 * ccx-ui.js —— 串串香 画布渲染 + 交互 + 音效
 * 依赖 ccx-core.js
 *
 * 棋盘上棋子摆在**线的交点**上，所以点击按「最近的交点」取，用四舍五入。
 * 连吃的处理：从选中的子出发，把每条吃子路径的**落点**点亮，
 * 点哪个落点就吃到哪儿 —— 落点本身就是「吃到第几个停手」的选择器。
 */
(function () {
  'use strict';

  var CCX = window.CCX;
  if (!CCX) { console.error('ccx-core.js 未加载'); return; }

  // 几何：与 _ccx_build/_gen_assets.py 烘焙的 img/board.png 严格一致
  var SPACE = 104, X0 = 66, Y0 = 66, PIECE = 96;
  var COLS = CCX.COLS, ROWS = CCX.ROWS, NSQ = CCX.N;
  var W = 964, H = 548;

  function X(i) { return X0 + CCX.colOf(i) * SPACE; }
  function Y(i) { return Y0 + CCX.rowOf(i) * SPACE; }

  var DELAYS = [0.8, 1.5, 2.5, 4];
  var DEFAULT_DELAY = 1.5;

  // ------------------------------------------------------------ DOM
  function $(id) { return document.getElementById(id); }
  var canvas, ctx, elStatus, elSides, elMeta, elLevels, elDelays,
      elUndo, elRestart, elSound, elHint, elRules, elMode;

  var boardImg = null, backImg = null, imgs = {};
  var soundOn = true, snd = {};
  var dpr = 1, viewScale = 1;

  // ------------------------------------------------------------ 状态
  var g = null;
  var sel = -1;                 // 选中的己方明子
  var moveTo = [];              // 能走到的空格
  var capTo = {};               // 能吃到的落点 -> 着法
  var hintOn = true;            // 走法提示
  var hoverSq = -1, hoverMv = null, hoverArr = [];
  var mode = 'pve';             // pve = 人机（座位 0 玩家 / 座位 1 电脑）, pvp = 双人
  var level = 2, delay = DEFAULT_DELAY;
  var busy = false, over = false;
  var aiTimer = 0, gen = 0;

  function newGame() {
    cancelAI();
    g = CCX.createGame();
    sel = -1; moveTo = []; capTo = {}; hoverSq = -1; hoverMv = null; hoverArr = [];
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
    vs = Math.max(0.40, vs);
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

  function ring(i, color, width, r, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(X(i), Y(i), r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function dot(i, color, r) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(i), Y(i), r, 0, Math.PI * 2);
    ctx.fill();
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

    // 棋子。终局后全部亮牌 —— 否则「对方被吃光了，怎么还扣着一堆子」看着像 bug：
    // 暗子不能被吃，所以被吃光的一方能剩子，剩下的必是胜方自己的。
    for (i = 0; i < NSQ; i++) {
      p = g.bd[i];
      if (!p) continue;
      if (!g.open[i] && !over) drawImg(backImg, X(i), Y(i), PIECE);
      else drawImg(imgs[CCX.pieceName(p)], X(i), Y(i), PIECE);
    }

    // 上一步：起点/终点各套一枚金环（画在棋子上才看得见）
    if (g.last) {
      ring(g.last.f, 'rgba(255,214,120,.50)', 3, PIECE * 0.44);
      if (g.last.t !== g.last.f) ring(g.last.t, 'rgba(255,214,120,.50)', 3, PIECE * 0.44);
    }

    // 能走的空格
    var dots = hintOn ? moveTo : [];
    for (i = 0; i < dots.length; i++) dot(dots[i], 'rgba(198,52,38,.42)', 12);

    // 能吃的落点：圈画在棋子外沿（内侧会压到棋子自带的红边，红子上糊成一片）
    // 先用米色描一圈底衬，红圈压在上面，红子/黑子/木纹底上都看得清
    if (hintOn) {
      for (var k in capTo) if (capTo.hasOwnProperty(k)) {
        var mv = capTo[k];
        var many = mv.caps.length > 1;
        var rr = PIECE * 0.53;
        ring(+k, 'rgba(255,249,236,.92)', many ? 9 : 7, rr);
        ring(+k, many ? 'rgba(198,52,38,.98)' : 'rgba(198,52,38,.85)', many ? 5 : 3, rr);
        if (many) {
          // 连吃个数做成小徽章，压在棋子正上方
          var bx = X(+k), by = Y(+k) - PIECE * 0.56;
          ctx.save();
          ctx.beginPath();
          ctx.arc(bx, by, 13, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,249,236,.97)';
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(198,52,38,.98)';
          ctx.stroke();
          ctx.fillStyle = 'rgba(170,34,22,1)';
          ctx.font = '700 18px system-ui, "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(mv.caps.length), bx, by + 0.5);
          ctx.restore();
        }
      }
    }

    // 悬停预览
    var hd = (hintOn && sel < 0) ? hoverArr : [];
    for (i = 0; i < hd.length; i++) dot(hd[i], 'rgba(198,52,38,.20)', 11);
    if (hoverMv && hintOn && sel < 0) {
      ring(hoverMv.t, 'rgba(198,52,38,.42)', 2.5, PIECE * 0.44);
      ring(hoverSq, 'rgba(255,214,120,.42)', 2, PIECE * 0.46);
    }

    // 选中
    if (sel >= 0) ring(sel, 'rgba(255,214,120,.95)', 4, PIECE * 0.46);
  }

  // ------------------------------------------------------------ 提示
  function seatName(seat) {
    return mode === 'pve' ? (seat === 0 ? '你' : '电脑') : (seat === 0 ? '先手' : '后手');
  }
  function colorName(c) { return c === CCX.RED ? '红' : '黑'; }

  function resultText() {
    var r = g.result;
    if (!r) return '';
    if (r.draw) {
      var why = r.reason === 'quiet' ? '连续 70 手没吃子也没翻子'
              : r.reason === 'maxply' ? '双方总步数满 500'
              : '同一局面重复';
      return '和棋 —— ' + why;
    }
    // 输赢措辞要跟着「谁被吃光」走，别一律写「对方」
    var myColor = g.seatColor[0];
    var why2 = r.reason === 'nomove' ? '无棋可走' : '棋子被吃光';
    if (mode === 'pve') {
      var iWin = (r.winColor === myColor);
      return (iWin ? '你赢了' : '你输了') + ' —— ' + (iWin ? '对方' : '你的') + why2;
    }
    return colorName(r.winColor) + '方胜 —— ' + colorName(1 - r.winColor) + '方' + why2;
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
          var nc = 0, k;
          for (k in capTo) if (capTo.hasOwnProperty(k)) nc++;
          var canMove = moveTo.length, canEat = nc;
          s += ' · 选中 ' + CCX.pieceText(p) + '（可走 ' + canMove + ' 处';
          if (canEat) {
            var best = 0;
            for (k in capTo) if (capTo.hasOwnProperty(k)) {
              if (capTo[k].caps.length > best) best = capTo[k].caps.length;
            }
            s += '，可吃 ' + canEat + ' 处' + (best > 1 ? '（最多连吃 ' + best + ' 个）' : '');
          }
          s += '）';
        }
        elStatus.className = 'status';
      }
    }
    elStatus.textContent = s;

    // 状态条：只显示公开信息
    var n = CCX.aliveCount(g), hidden = 0, i;
    for (i = 0; i < NSQ; i++) if (g.bd[i] && !g.open[i]) hidden++;
    var pieces = [
      '<span class="side s-red">红 ' + n[CCX.RED] + '</span>',
      '<span class="side s-black">黑 ' + n[CCX.BLACK] + '</span>',
      '<span class="side">暗子 ' + hidden + (g.result && hidden ? '（已亮出）' : '') + '</span>'
    ];
    if (g.seatColor[0] != null && mode === 'pve') {
      pieces.unshift('<span class="side' + (g.turn === 0 ? ' now' : '') + '">你执' +
                     colorName(g.seatColor[0]) + '</span>');
    }
    elSides.innerHTML = pieces.join('');

    // 上一手摘要（终局时改成结算说明）
    var lt = '';
    if (g.last) {
      var who = seatName(g.last.seat);
      if (g.last.k === 0) lt = who + ' 翻开 ' + CCX.pieceText(g.last.piece);
      else if (g.last.k === 2) {
        var names = g.last.caps.map(function (x) { return CCX.pieceText(x); });
        lt = who + ' 用 ' + CCX.pieceText(g.last.piece) + ' 吃掉 ' + names.join(' + ') +
             (names.length > 1 ? '（连吃 ' + names.length + ' 个）' : '');
      } else lt = who + ' ' + CCX.pieceText(g.last.piece) + ' 挪了一步';
    }
    if (g.result && !g.result.draw) {
      // 把「为什么还剩一堆暗子却已经分出胜负」讲明白，免得看着像判错了
      lt = hidden
        ? '结算：败方一枚不剩（' + hidden + ' 枚暗子已亮出 —— 暗子不能被吃，' +
          '所以留在盘上的暗子只可能属于胜方）'
        : '结算：败方一枚不剩，盘上没有剩下的暗子';
    }
    elMeta.textContent = lt || '尚未落子';

    elUndo.disabled = !g.hist.length;
  }

  // ------------------------------------------------------------ 高亮
  function computeTargets() {
    moveTo = []; capTo = {};
    if (sel < 0 || !g) return;
    var r = CCX.movesFrom(g, sel), i, mv, prev;
    moveTo = r.moves;
    for (i = 0; i < r.caps.length; i++) {
      mv = r.caps[i];
      prev = capTo[mv.t];
      if (!prev || CCX.capsValue(mv.caps) > CCX.capsValue(prev.caps)) capTo[mv.t] = mv;
    }
  }

  function clearSel() { sel = -1; moveTo = []; capTo = {}; }

  // ------------------------------------------------------------ 落子
  function sameMove(a, b) {
    if (a.k !== b.k || a.f !== b.f || a.t !== b.t) return false;
    if (a.k === 2 && b.k === 2) {
      if (a.path.length !== b.path.length) return false;
      for (var i = 0; i < a.path.length; i++) if (a.path[i] !== b.path[i]) return false;
    }
    return true;
  }

  function play(mv) {
    var all = CCX.legalMoves(g), ok = false, i;
    for (i = 0; i < all.length; i++) if (sameMove(all[i], mv)) { ok = true; break; }
    if (!ok) { beep('check'); return; }

    CCX.doMove(g, mv);
    clearSel(); hoverSq = -1; hoverMv = null; hoverArr = [];

    if (mv.k === 0) beep('move');
    else if (mv.k === 2) beep('capture');
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
    hoverSq = -1; hoverMv = null; hoverArr = [];
    if (!humanCanAct()) { beep('check'); return; }

    var p = g.bd[i], col = g.seatColor[g.turn];

    // 1) 已选中：先看是不是走 / 吃
    if (sel >= 0) {
      if (moveTo.indexOf(i) >= 0) { play({ k: 1, f: sel, t: i }); return; }
      if (capTo[i]) { play(capTo[i]); return; }
    }
    // 2) 暗子 -> 翻开
    if (p && !g.open[i]) { play({ k: 0, f: i, t: i }); return; }
    // 3) 自己的明子 -> 选中 / 取消
    if (p && g.open[i] && p.s === col) {
      if (sel === i) { clearSel(); draw(); render(); return; }
      sel = i; computeTargets();
      beep('select'); draw(); render(); return;
    }
    // 4) 其它 -> 取消
    if (sel >= 0) { clearSel(); draw(); render(); return; }
    beep('check');
  }

  // 悬停：只看自己已翻开的子（扣着的子扫一眼就漏身份，绝不提示）
  function hoverPreview(i) {
    hoverSq = -1; hoverMv = null; hoverArr = [];
    if (i < 0 || !hintOn || sel >= 0 || !humanCanAct()) return;
    var p = g.bd[i], col = g.seatColor[g.turn];
    if (!p || !g.open[i] || p.s !== col) return;

    var r = CCX.movesFrom(g, i), best = null, k;
    hoverArr = r.moves;
    for (k = 0; k < r.caps.length; k++) {
      if (!best || CCX.capsValue(r.caps[k].caps) > CCX.capsValue(best.caps)) best = r.caps[k];
    }
    if (best) { hoverMv = best; hoverArr.push(best.t); hoverSq = i; }
  }

  // ------------------------------------------------------------ 电脑
  function scheduleAI() {
    if (mode !== 'pve' || g.result || g.turn !== 1) return;
    busy = true; render();
    var my = ++gen;
    aiTimer = window.setTimeout(function () {
      if (my !== gen) return;
      var mv = CCX.chooseMove(g, level, Math.random);
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
      var c = Math.round((x - X0) / SPACE);
      var r = Math.round((y - Y0) / SPACE);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
      return r * COLS + c;
    }

    canvas.addEventListener('click', function (e) {
      if (!g) return;
      var i = squareAt(e);
      if (i >= 0) onSquare(i);
    });

    canvas.addEventListener('mousemove', function (e) {
      if (!g) return;
      var i = squareAt(e);
      if (i === hoverSq && hoverMv === null) return;
      hoverPreview(i);
      draw();
    });

    canvas.addEventListener('mouseleave', function () {
      if (hoverSq < 0 && !hoverMv) return;
      hoverSq = -1; hoverMv = null; hoverArr = []; draw();
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
      CCX.undo(g);
      if (mode === 'pve' && g.hist.length && g.turn !== 0) CCX.undo(g);
      clearSel(); over = false;
      draw(); render();
      scheduleAI();
    });

    elRestart.addEventListener('click', function () { newGame(); });

    elSound.addEventListener('change', function () { soundOn = elSound.checked; });

    elHint.addEventListener('change', function () {
      hintOn = elHint.checked;
      if (!hintOn) { hoverSq = -1; hoverMv = null; hoverArr = []; }
      draw();
    });

    elRules.addEventListener('click', function () {
      var box = $('rulesbox');
      box.hidden = !box.hidden;
      elRules.textContent = box.hidden ? '规则' : '收起规则';
    });

    g = CCX.createGame();
    loadImages(function () { fitCanvas(); draw(); render(); });
    window.addEventListener('resize', function () { fitCanvas(); draw(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 自动化测试入口（正常游玩用不到）
  window.CCX_UI = {
    game: function () { return g; },
    play: play,
    square: onSquare,
    setMode: function (m) { mode = m; newGame(); },
    setLevel: function (l) { level = l; },
    setDelay: function (d) { delay = d; },
    isBusy: function () { return busy; },
    isHumanTurn: humanCanAct,
    isOver: function () { return over; },
    setHint: function (v) { elHint.checked = !!v; elHint.dispatchEvent(new Event('change')); },
    setOver: function (v) { over = !!v; draw(); render(); },
    hover: function (i) { hoverPreview(i); draw(); },
    dbg: function () {
      var nc = 0, k;
      for (k in capTo) if (capTo.hasOwnProperty(k)) nc++;
      return { hint: hintOn, sel: sel, moves: moveTo.length, caps: nc,
               hoverSq: hoverSq, hover: hoverArr.length, over: over };
    },
    newGame: newGame,
    undo: function () { elUndo.click(); }
  };
})();
