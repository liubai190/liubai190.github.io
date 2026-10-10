/*!
 * ccx-core.js —— 串串香 规则引擎
 *
 * 棋盘：线沿用翻棋盘那 9 竖 x 5 横
 *       棋子摆在**线的交点**上：9 列 x 5 行 = 45 个点，**45 个点全部可落子**
 *       开局 32 枚铺在内圈的 32 个点（第 1~8 竖线 x 第 2~5 横线）
 *       —— 最上面那条横线、最右边那条竖线开局留空，但照样能走上去、能在上面吃子
 *
 * 玩法（白 2026-10-10 口述确认）：
 *   1. 暗棋机制：全扣着开局，第一枚翻出的颜色归翻子的人；扣着的子不能被吃
 *   2. 象棋走法，但限制全放开：无九宫、象能过河、马不蹩腿、象不塞眼、兵能后退
 *   3. 吃子按走法算，不按等级大小
 *   4. 连吃：吃完可以接着吃，能拐弯，也能中途停手（落点自选）
 *   5. 暗子只挡路、能当炮架
 *   6. 吃光对方、或轮到自己无棋可走 -> 判负；没有将军这回事
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCX = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COLS = 9, ROWS = 5, N = COLS * ROWS;        // 9 竖 x 5 横 = 45 个交点，全是有效落子点
  var SEAT_COLS = 8, SEAT_ROW0 = 1;               // 开局铺子区：第 1~8 竖线 x 第 2~5 横线 = 32 点
  var RED = 0, BLACK = 1;

  // 每方的子力
  var ARMY = [['j', 1], ['s', 2], ['x', 2], ['c', 2], ['m', 2], ['p', 2], ['z', 5]];

  var TEXT = [
    { j: '帅', s: '仕', x: '相', c: '车', m: '马', p: '炮', z: '兵' },
    { j: '将', s: '士', x: '象', c: '车', m: '马', p: '炮', z: '卒' }
  ];

  var VAL = { j: 100, s: 2, x: 2, c: 9, m: 4, p: 4.5, z: 1 };

  var D4 = [[0, -1], [0, 1], [-1, 0], [1, 0]];                    // 上下左右
  var DG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];                  // 斜
  var KN = [[-1, -2], [1, -2], [-2, -1], [2, -1],
            [-2, 1], [2, 1], [-1, 2], [1, 2]];                    // 日字

  var MAX_CHAIN = 8;        // 连吃最长层数
  var MAXCAP = 600;         // 单个子最多产出多少条吃子着法（防爆）
  var QUIET_LIMIT = 70;     // 连续多少手没吃子也没翻子 -> 判和
  var PLY_LIMIT = 500;

  // ---------------------------------------------------------------- 坐标
  function idx(c, r) { return r * COLS + c; }
  function colOf(i) { return i % COLS; }
  function rowOf(i) { return (i / COLS) | 0; }
  function inB(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }

  function pieceName(p) { return (p.s === RED ? 'r_' : 'b_') + p.t; }
  function pieceText(p) { return TEXT[p.s][p.t]; }
  function val(p) { return VAL[p.t] || 1; }

  // ---------------------------------------------------------------- 开局
  function createGame(rnd) {
    rnd = rnd || Math.random;
    var bag = [], cells = [], i, k, a, r, c;

    for (i = 0; i < ARMY.length; i++) {
      a = ARMY[i];
      for (k = 0; k < a[1]; k++) {
        bag.push({ s: RED, t: a[0] });
        bag.push({ s: BLACK, t: a[0] });
      }
    }
    for (i = bag.length - 1; i > 0; i--) {          // 32 枚洗牌
      k = (rnd() * (i + 1)) | 0;
      var tmp = bag[i]; bag[i] = bag[k]; bag[k] = tmp;
    }
    // 铺在内圈那 32 个点：最上一横线、最右一竖线开局留空（空点可走上去、可在上面吃子）
    for (r = SEAT_ROW0; r < ROWS; r++) {
      for (c = 0; c < SEAT_COLS; c++) cells.push(idx(c, r));
    }
    var bd = new Array(N).fill(null);
    for (i = 0; i < cells.length; i++) bd[cells[i]] = bag[i];

    return {
      bd: bd,
      open: new Array(N).fill(false),
      seatColor: [null, null],
      turn: 0,
      plies: 0,
      quiet: 0,
      hist: [],
      result: null,
      last: null,
      seen: {}
    };
  }

  // ---------------------------------------------------------------- 走法
  // 能走到的空格
  function moveTargets(g, cur, p) {
    var out = [], c0 = colOf(cur), r0 = rowOf(cur), k, c, r, t = p.t, i;

    function add(c, r) {
      if (!inB(c, r)) return;
      i = idx(c, r);
      if (!g.bd[i]) out.push(i);
    }

    if (t === 'c' || t === 'p') {                   // 车 / 炮：不吃时直线滑行
      for (k = 0; k < 4; k++) {
        c = c0 + D4[k][0]; r = r0 + D4[k][1];
        while (inB(c, r) && !g.bd[idx(c, r)]) { out.push(idx(c, r)); c += D4[k][0]; r += D4[k][1]; }
      }
    } else if (t === 'm') {                          // 马：走日，不蹩腿
      for (k = 0; k < 8; k++) add(c0 + KN[k][0], r0 + KN[k][1]);
    } else if (t === 'x') {                          // 相/象：走田，不塞眼，能过河
      for (k = 0; k < 4; k++) add(c0 + DG[k][0] * 2, r0 + DG[k][1] * 2);
    } else if (t === 's') {                          // 仕/士：斜一格，不限九宫
      for (k = 0; k < 4; k++) add(c0 + DG[k][0], r0 + DG[k][1]);
    } else {                                         // 帅/将、兵/卒：上下左右一格
      for (k = 0; k < 4; k++) add(c0 + D4[k][0], r0 + D4[k][1]);
    }
    return out;
  }

  // 当前位置能一口吃掉的对方**明**子（暗子不能吃，但会挡路/当炮架）
  function biteTargets(g, cur, p) {
    var out = [], c0 = colOf(cur), r0 = rowOf(cur), k, c, r, t = p.t, s = p.s, i;

    function foe(c, r) {
      if (!inB(c, r)) return false;
      i = idx(c, r);
      return g.bd[i] && g.open[i] && g.bd[i].s !== s;
    }

    if (t === 'c') {
      for (k = 0; k < 4; k++) {
        c = c0 + D4[k][0]; r = r0 + D4[k][1];
        while (inB(c, r) && !g.bd[idx(c, r)]) { c += D4[k][0]; r += D4[k][1]; }
        if (foe(c, r)) out.push(idx(c, r));
      }
    } else if (t === 'p') {                          // 炮：隔一个子打
      for (k = 0; k < 4; k++) {
        c = c0 + D4[k][0]; r = r0 + D4[k][1];
        while (inB(c, r) && !g.bd[idx(c, r)]) { c += D4[k][0]; r += D4[k][1]; }
        if (!inB(c, r)) continue;                    // 一路没子，没有炮架
        c += D4[k][0]; r += D4[k][1];                // 越过炮架（炮架是谁都行，暗子也算）
        while (inB(c, r) && !g.bd[idx(c, r)]) { c += D4[k][0]; r += D4[k][1]; }
        if (foe(c, r)) out.push(idx(c, r));
      }
    } else if (t === 'm') {
      for (k = 0; k < 8; k++) { c = c0 + KN[k][0]; r = r0 + KN[k][1]; if (foe(c, r)) out.push(idx(c, r)); }
    } else if (t === 'x') {
      for (k = 0; k < 4; k++) { c = c0 + DG[k][0] * 2; r = r0 + DG[k][1] * 2; if (foe(c, r)) out.push(idx(c, r)); }
    } else if (t === 's') {
      for (k = 0; k < 4; k++) { c = c0 + DG[k][0]; r = r0 + DG[k][1]; if (foe(c, r)) out.push(idx(c, r)); }
    } else {
      for (k = 0; k < 4; k++) { c = c0 + D4[k][0]; r = r0 + D4[k][1]; if (foe(c, r)) out.push(idx(c, r)); }
    }
    return out;
  }

  // 从 from 出发的所有吃子着法（含连吃；每个中间落点都是一步合法着法 —— 所以可以随时停手）
  function chainCaptures(g, from, p) {
    var res = [];
    var path = [from], caps = [];
    var piece = g.bd[from];

    function dfs(cur, depth) {
      if (res.length >= MAXCAP) return;
      var tg = biteTargets(g, cur, p), k, to, victim, wasOpen, fromOpen;

      for (k = 0; k < tg.length; k++) {
        if (res.length >= MAXCAP) return;
        to = tg[k];
        victim = g.bd[to];
        wasOpen = g.open[to];
        fromOpen = g.open[cur];

        g.bd[to] = piece; g.open[to] = true;
        g.bd[cur] = null; g.open[cur] = false;
        path.push(to); caps.push(victim);

        res.push({ k: 2, f: from, t: to, path: path.slice(), caps: caps.slice() });

        if (depth + 1 < MAX_CHAIN && res.length < MAXCAP) dfs(to, depth + 1);

        caps.pop(); path.pop();
        g.bd[cur] = piece; g.open[cur] = fromOpen;
        g.bd[to] = victim; g.open[to] = wasOpen;
      }
    }

    dfs(from, 0);
    return res;
  }

  // 全部合法着法
  function legalMoves(g) {
    var out = [], i, p, j, to, side;
    if (g.result) return out;

    // 1) 翻暗子
    for (i = 0; i < N; i++) if (g.bd[i] && !g.open[i]) out.push({ k: 0, f: i, t: i });

    side = g.seatColor[g.turn];
    if (side == null) return out;          // 还没定色，只能翻

    // 2) 己方明子
    for (i = 0; i < N; i++) {
      p = g.bd[i];
      if (!p || !g.open[i] || p.s !== side) continue;

      var mt = moveTargets(g, i, p);
      for (j = 0; j < mt.length; j++) out.push({ k: 1, f: i, t: mt[j] });

      var cc = chainCaptures(g, i, p);
      for (j = 0; j < cc.length; j++) out.push(cc[j]);
    }
    return out;
  }

  // 某一枚子能走的空格 / 能吃的落点（UI 用）
  function movesFrom(g, i) {
    var p = g.bd[i], side = g.seatColor[g.turn];
    if (!p || !g.open[i] || p.s !== side) return { moves: [], caps: [] };
    return { moves: moveTargets(g, i, p), caps: chainCaptures(g, i, p) };
  }

  // ---------------------------------------------------------------- 落子
  function applyMove(g, mv) {
    var p;
    if (mv.k === 0) {
      g.open[mv.f] = true;
      if (g.seatColor[0] == null) {
        g.seatColor[0] = g.bd[mv.f].s;
        g.seatColor[1] = 1 - g.bd[mv.f].s;
      }
      g.quiet = 0;
      g.last = { k: 0, f: mv.f, t: mv.f, piece: g.bd[mv.f], seat: g.turn, caps: [] };
    } else if (mv.k === 1) {
      g.bd[mv.t] = g.bd[mv.f];
      g.open[mv.t] = true;
      g.bd[mv.f] = null; g.open[mv.f] = false;
      g.quiet++;
      g.last = { k: 1, f: mv.f, t: mv.t, piece: g.bd[mv.t], seat: g.turn, caps: [] };
    } else {
      p = g.bd[mv.f];
      var k;
      for (k = 1; k < mv.path.length; k++) { g.bd[mv.path[k]] = null; g.open[mv.path[k]] = false; }
      g.bd[mv.t] = p; g.open[mv.t] = true;
      g.bd[mv.f] = null; g.open[mv.f] = false;
      g.quiet = 0;
      g.last = { k: 2, f: mv.f, t: mv.t, piece: p, seat: g.turn, caps: mv.caps.slice() };
    }
    g.turn = 1 - g.turn;
    g.plies++;
  }

  function doMove(g, mv) {
    g.hist.push(snapshot(g));
    if (g.hist.length > 400) g.hist.shift();
    applyMove(g, mv);
    checkResult(g);
    return g;
  }

  function undo(g) {
    if (!g.hist.length) return false;
    var st = g.hist.pop();
    g.bd = st.bd; g.open = st.open; g.seatColor = st.seatColor;
    g.turn = st.turn; g.plies = st.plies; g.quiet = st.quiet;
    g.result = st.result; g.last = st.last;
    return true;
  }

  function snapshot(g) {
    return {
      bd: g.bd.map(function (p) { return p ? { s: p.s, t: p.t } : null; }),
      open: g.open.slice(),
      seatColor: g.seatColor.slice(),
      turn: g.turn, plies: g.plies, quiet: g.quiet,
      result: g.result, last: g.last
    };
  }

  // ---------------------------------------------------------------- 判定
  function aliveCount(g) {
    var n = [0, 0], i;
    for (i = 0; i < N; i++) if (g.bd[i]) n[g.bd[i].s]++;
    return n;
  }

  function key(g) {
    var s = [], i, p;
    for (i = 0; i < N; i++) {
      p = g.bd[i];
      s.push(p ? ((g.open[i] ? 'O' : 'H') + p.t + p.s) : '..');
    }
    return s.join('') + '|' + g.turn;
  }

  function checkResult(g) {
    if (g.result) return g.result;
    var n = aliveCount(g);
    if (n[RED] === 0) { g.result = { draw: false, winColor: BLACK, reason: 'eaten' }; return g.result; }
    if (n[BLACK] === 0) { g.result = { draw: false, winColor: RED, reason: 'eaten' }; return g.result; }
    if (legalMoves(g).length === 0) {
      // 轮到自己却无棋可走 = 自己判负，赢的是对手那一边的颜色
      // （早先写成了 seatColor[g.turn]，把输的一方当成了赢家）
      g.result = { draw: false, winColor: g.seatColor[1 - g.turn], reason: 'nomove' };
      return g.result;
    }
    if (g.quiet >= QUIET_LIMIT) { g.result = { draw: true, reason: 'quiet' }; return g.result; }
    if (g.plies >= PLY_LIMIT) { g.result = { draw: true, reason: 'maxply' }; return g.result; }
    var k = key(g);
    g.seen[k] = (g.seen[k] || 0) + 1;
    if (g.seen[k] >= 3) { g.result = { draw: true, reason: 'repeat' }; return g.result; }
    return null;
  }

  // ---------------------------------------------------------------- 评估 / AI
  // 只算**明子**的价值：暗子身份未知，对谁都不算数（这也让 AI 不会偷看你的暗子）
  function evaluate(g, side) {
    var v = 0, i, p, w;
    for (i = 0; i < N; i++) {
      p = g.bd[i];
      if (!p || !g.open[i]) continue;
      w = VAL[p.t] || 1;
      v += (p.s === side ? w : -w);
    }
    return v;
  }

  function capsValue(caps) {
    var v = 0, i;
    for (i = 0; i < caps.length; i++) v += VAL[caps[i].t] || 1;
    return v;
  }

  // 临时落子跑一段逻辑再还原
  function withMove(g, mv, fn) {
    var st = snapshot(g);
    applyMove(g, mv);
    var r = fn(g, st);
    g.bd = st.bd; g.open = st.open; g.seatColor = st.seatColor;
    g.turn = st.turn; g.plies = st.plies; g.quiet = st.quiet;
    g.result = st.result; g.last = st.last;
    return r;
  }

  // 对方（g.turn 那方）一步能吃我多少
  function worstBite(g, me) {
    var ms = legalMoves(g), i, j, v, worst = 0, lost;
    for (i = 0; i < ms.length; i++) {
      if (ms[i].k !== 2) continue;
      lost = 0;
      for (j = 0; j < ms[i].caps.length; j++) if (ms[i].caps[j].s === me) lost += VAL[ms[i].caps[j].t] || 1;
      if (lost > worst) worst = lost;
    }
    return worst;
  }

  // ---- 位置启发（只给 AI 用，不参与规则判定） ------------------------------
  // 站在 sq 上的那枚子，会被对方哪个明子一口吃掉 —— 返回最大的那份价值（只看单步）
  function dangerAt(g, sq, me) {
    var p0 = g.bd[sq];
    if (!p0) return 0;
    var v = VAL[p0.t] || 1, i, p, t, j, hit;
    for (i = 0; i < N; i++) {
      p = g.bd[i];
      if (!p || !g.open[i] || p.s === me) continue;
      t = biteTargets(g, i, p);
      hit = false;
      for (j = 0; j < t.length; j++) if (t[j] === sq) { hit = true; break; }
      if (hit) return v;                     // 已经被盯上了，问「多少个」没有意义
    }
    return 0;
  }

  // 走完这一步之后，落点上那枚子挨打的风险
  function riskAfter(g, mv, me) {
    return withMove(g, mv, function (gg) { return dangerAt(gg, mv.t, me); });
  }

  // 走完这一步之后，新位置能威胁到对方多少（封顶，免得一条长线把权重全吃掉）
  function attackAfter(g, mv, me) {
    return withMove(g, mv, function (gg) {
      var p = gg.bd[mv.t];
      if (!p) return 0;
      var t = biteTargets(gg, mv.t, p), v = 0, i, q;
      for (i = 0; i < t.length; i++) {
        q = gg.bd[t[i]];
        v += Math.min(3, VAL[q.t] || 1) * 0.12;
      }
      return Math.min(0.6, v);
    });
  }

  // 这个位置适合翻吗：旁边有自己的明子（翻出敌子能顺手吃）加分，
  // 旁边有对方的大子（翻出自己的子会被吃）减分
  function flipSpot(g, sq, me) {
    var c0 = colOf(sq), r0 = rowOf(sq), k, c, r, i, q, mine = 0, foe = 0;
    for (k = 0; k < 4; k++) {
      c = c0 + D4[k][0]; r = r0 + D4[k][1];
      if (!inB(c, r)) continue;
      i = idx(c, r); q = g.bd[i];
      if (!q || !g.open[i]) continue;
      if (q.s === me) mine++;
      else if ((VAL[q.t] || 1) >= 4) foe++;
    }
    return Math.min(3, mine) * 0.16 - Math.min(2, foe) * 0.28;
  }

  // 三档难度共用的着法权重。关键一条：**翻子是有正价值的** ——
  // 扣着的子只有翻开才能用，不翻就只能拿手上那几枚明子耗。
  var EAT_BONUS = 0.35;                  // 吃子的确定性加成：摆在嘴边的子一定要吃
  var FLIP_BONUS = 0.90;                 // 翻子的基准分（≈ 一枚兵的价值）
  var WALK_PENALTY = 0.25;               // 什么都不干的挪子，天然排最后
  var RISK_W = [0, 0.35, 0.60];          // 简单 / 中等 / 困难：「吃完会被反吃」的顾虑
  var NOISE = [0.55, 0.22, 0];           // 简单 / 中等 / 困难：在「差不太多」的着法里乱选的幅度

  function chooseMove(g, level, rnd) {
    rnd = rnd || Math.random;
    var moves = legalMoves(g);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];

    var me = g.seatColor[g.turn];
    if (me == null) return moves[(rnd() * moves.length) | 0];   // 还没定色，只能翻，位置无差别

    var L = Math.max(1, Math.min(3, level | 0)) - 1;
    var i, mv, sc, scores = new Array(moves.length), best = [], bestV = -Infinity;

    for (i = 0; i < moves.length; i++) {
      mv = moves[i];
      if (mv.k === 2) {
        // 吃子：吃到手的价值 − 站上去之后被人家反吃的风险
        sc = capsValue(mv.caps) - riskAfter(g, mv, me) * RISK_W[L] + EAT_BONUS;
      } else if (mv.k === 0) {
        // 翻子：恒定正收益（简单档不看位置，所以乱翻）
        sc = FLIP_BONUS + (L > 0 ? flipSpot(g, mv.f, me) : 0);
      } else {
        // 走空：只有在没有暗子可翻的时候才轮得到它
        sc = (L > 0 ? attackAfter(g, mv, me) - riskAfter(g, mv, me) * RISK_W[L] : 0)
             - WALK_PENALTY;
      }
      scores[i] = sc;
      if (sc > bestV) { bestV = sc; best = [mv]; }
      else if (sc > bestV - 1e-9) best.push(mv);
    }

    // 最优解是吃子 -> 不做任何随机（这就是「有吃必吃」）
    for (i = 0; i < best.length; i++) if (best[i].k === 2) return best[(rnd() * best.length) | 0];

    // 其余情况：在「离最优不差太多」的一堆着法里挑（难度差异就在这个窗口的宽窄上）
    var tol = NOISE[L];
    if (tol > 0) {
      var cand = [];
      for (i = 0; i < moves.length; i++) if (scores[i] >= bestV - tol) cand.push(moves[i]);
      if (cand.length) return cand[(rnd() * cand.length) | 0];
    }
    return best[(rnd() * best.length) | 0];
  }

  // ---------------------------------------------------------------- 导出
  return {
    COLS: COLS, ROWS: ROWS, N: N, RED: RED, BLACK: BLACK,
    idx: idx, colOf: colOf, rowOf: rowOf,
    pieceName: pieceName, pieceText: pieceText, val: val,
    createGame: createGame,
    legalMoves: legalMoves, movesFrom: movesFrom,
    moveTargets: moveTargets, biteTargets: biteTargets, chainCaptures: chainCaptures,
    doMove: doMove, applyMove: applyMove, undo: undo, snapshot: snapshot,
    checkResult: checkResult, aliveCount: aliveCount,
    evaluate: evaluate, capsValue: capsValue, chooseMove: chooseMove,
    dangerAt: dangerAt, riskAfter: riskAfter, attackAfter: attackAfter, flipSpot: flipSpot,
    AI: { EAT_BONUS: EAT_BONUS, FLIP_BONUS: FLIP_BONUS, WALK_PENALTY: WALK_PENALTY,
          RISK_W: RISK_W, NOISE: NOISE }
  };
});
