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
    INK.dirtyAll();          // 整盘换掉，墨水屏下必须整屏重画，否则旧棋子会留在画布上
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

  /** 可用宽度：读 .wrap 的内容宽度（clientWidth 含内边距，再扣掉左右 padding）。
   *  原来写死「视口宽 - 48」，手机断点把 wrap 内边距改小之后算出来就比容器宽，
   *  棋盘会横向溢出。2026-11-09 移动端适配时改掉。 */
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
  var ROT_KEY = 'graywood.ccx.rot';
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
  /** 手机竖屏默认竖起来（90 度）：横盘塞进竖屏只能缩到很小，转过来才用得满手机屏 */
  function rotDefault() {
    var touch = false;
    try { touch = window.matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) {}
    return (touch && window.innerHeight > window.innerWidth) ? 1 : 0;
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

  // ------------------------------------------------------------ 沉浸模式
  /* 2026-11-09：只留棋盘 —— 页头与面板整个 display:none，wrap 撑满视口把棋盘居中，
     左上角浮一个「✕ 退出」。退出按钮写在 body 下（不走 wrap 的 flex），不受布局影响。
     状态写 localStorage，与旋转同规矩：刷新后仍是沉浸（head 里有脚本提前打 class）。
     没动浏览器全屏 API：手机与 iframe 里 requestFullscreen 时灵时不灵，退出还得多一条同步。 */
  var IMM_KEY = 'graywood.ccx.imm';
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
    var availW = availWidth();
    var vs = Math.min(1, availW / cw);
    // 竖起来之后高度可能成为约束（手机竖屏 90 度）：超了按高度收。
    // 纵向挤一点可以往下滚，横向溢出才是真错，所以这一档只收不放。
    // 沉浸模式下棋盘在视口里居中，「到页顶的距离」这个量法失效，直接按整屏算（上下各 8px）。
    if (rotSwap() || immOn()) {
      var top = canvas.getBoundingClientRect().top || 0;
      var availH = immOn() ? (window.innerHeight || 900) - 16
                           : (window.innerHeight || 900) - top - 26;
      if (ch * vs > availH) vs = availH / ch;
    }
    // 手机竖屏只有 358px 可用：888 / 964 的盘按 0.40 收会横向溢出，放宽到 0.26
    vs = Math.max(0.26, vs);
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
    var ink = INK.isOn();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!ink) ctx.clearRect(0, 0, lw(), lh());
    ctx.save();
    rotCtx();
    if (ink) {
      /* 墨水屏：只框「本帧与上帧涉及的交点」当 clip，其余像素一律不动。
         残影按像素变化算，整屏重写一步就会闪一下；框住两格之后只剩 5% 左右。 */
      var ip = [], qq;
      if (g.last) { ip.push(g.last.f); if (g.last.t !== g.last.f) ip.push(g.last.t); }
      if (sel >= 0) ip.push(sel);
      if (hintOn) {
        for (qq = 0; qq < moveTo.length; qq++) ip.push(moveTo[qq]);
        for (qq in capTo) if (capTo.hasOwnProperty(qq)) ip.push(+qq);
      }
      INK.clip(ctx, ip, !!over);
      INK.board(ctx);
    } else if (boardImg && boardImg.complete && boardImg.naturalWidth) {
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
      if (ink) {
        if (!g.open[i] && !over) INK.back(ctx, X(i), Y(i), PIECE);
        else INK.piece(ctx, CCX.pieceName(p), X(i), Y(i), PIECE);
      } else if (!g.open[i] && !over) drawImg(backImg, X(i), Y(i), PIECE);
      else drawImg(imgs[CCX.pieceName(p)], X(i), Y(i), PIECE);
    }

    // 上一步：起点/终点各套一枚金环（画在棋子上才看得见）
    if (g.last) {
      if (ink) {
        INK.hlLast(ctx, X(g.last.f), Y(g.last.f), SPACE);
        if (g.last.t !== g.last.f) INK.hlLast(ctx, X(g.last.t), Y(g.last.t), SPACE);
      } else {
        ring(g.last.f, 'rgba(255,214,120,.50)', 3, PIECE * 0.44);
        if (g.last.t !== g.last.f) ring(g.last.t, 'rgba(255,214,120,.50)', 3, PIECE * 0.44);
      }
    }

    // 能走的空格
    var dots = hintOn ? moveTo : [];
    for (i = 0; i < dots.length; i++) {
      if (ink) INK.hlDot(ctx, X(dots[i]), Y(dots[i]), PIECE);
      else dot(dots[i], 'rgba(198,52,38,.42)', 12);
    }

    // 能吃的落点：圈画在棋子外沿（内侧会压到棋子自带的红边，红子上糊成一片）
    // 先用米色描一圈底衬，红圈压在上面，红子/黑子/木纹底上都看得清
    if (hintOn) {
      for (var k in capTo) if (capTo.hasOwnProperty(k)) {
        var mv = capTo[k];
        var many = mv.caps.length > 1;
        if (ink) {
          INK.hlCap(ctx, X(+k), Y(+k), PIECE);
          if (many) {
            // 墨水屏里徽章改成「白底黑圈黑字」，纯 1 位色也读得出连吃几枚
            var ibx = X(+k), iby = Y(+k) - PIECE * 0.56;
            ctx.save();
            ctx.beginPath(); ctx.arc(ibx, iby, 13, 0, Math.PI * 2);
            ctx.fillStyle = '#fff'; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke();
            ctx.fillStyle = '#000';
            ctx.font = '500 17px system-ui, "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(mv.caps.length), ibx, iby + 0.5);
            ctx.restore();
          }
          continue;
        }
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

    // 悬停预览（墨水屏没有鼠标，且它靠透明度分层，1 位色里会变网点 —— 直接不画）
    var hd = (!ink && hintOn && sel < 0) ? hoverArr : [];
    for (i = 0; i < hd.length; i++) dot(hd[i], 'rgba(198,52,38,.20)', 11);
    if (!ink && hoverMv && hintOn && sel < 0) {
      ring(hoverMv.t, 'rgba(198,52,38,.42)', 2.5, PIECE * 0.44);
      ring(hoverSq, 'rgba(255,214,120,.42)', 2, PIECE * 0.46);
    }

    // 选中
    if (sel >= 0) {
      if (ink) INK.hlSel(ctx, X(sel), Y(sel), PIECE);
      else ring(sel, 'rgba(255,214,120,.95)', 4, PIECE * 0.46);
    }
    ctx.restore();                                // 收掉旋转变换
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
        // 定色规则（2026-10-16 起）：第一枚子只记颜色、不作数，翻到异色才定谁执哪一方
        if (g.firstColor == null) {
          s = '翻子开局 —— 第一枚只记颜色，翻出另一种颜色才定谁执哪一方';
        } else {
          s = '目前翻出的都是' + colorName(g.firstColor) + '方，接着翻：谁先翻出' +
              colorName(1 - g.firstColor) + '方，谁就执' + colorName(1 - g.firstColor) + '方';
        }
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
      var p = toLogical(e);
      var c = Math.round((p[0] - X0) / SPACE);
      var r = Math.round((p[1] - Y0) / SPACE);
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
      INK.dirtyAll();        // 悔棋会一次改回好几个格子
      clearSel(); over = false;
      draw(); render();
      scheduleAI();
    });

    elRestart.addEventListener('click', function () { newGame(); });
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

    rot = rotLoad();
    // 墨水屏模块要在第一次 draw 之前 init：它管着棋盘线、棋子重绘和脏区 clip
    INK.init({
      type: 'ccx', W: W, H: H, cell: SPACE, piece: PIECE,
      xy: function (i) { return [X(i), Y(i)]; }
    });
    g = CCX.createGame();
    loadImages(function () { fitCanvas(); draw(); render(); });
    // 墨水屏一开就强制沉浸：既然是墨水屏，本来就是只看棋盘
    if (immLoad() || INK.isOn()) immSet(true, false);

    window.addEventListener('resize', function () { fitCanvas(); draw(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 自动化测试入口（正常游玩用不到）
  window.CCX_UI = {
    game: function () { return g; },
    // 测试用：强制整屏重画一帧（用来验证墨水屏的脏区重绘没漏画）
    redraw: function () { INK.dirtyAll(); draw(); },
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
