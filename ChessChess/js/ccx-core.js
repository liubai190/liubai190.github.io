/*!
 * ccx-core.js —— 串串香 规则引擎
 *
 * 棋盘：线沿用翻棋盘那 9 竖 x 5 横
 *       棋子摆在**线的交点**上：8 列 x 4 行 = 32 个点，32 枚棋子正好铺满
 *       最上面那条横线、最右边那条竖线留空
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

  var COLS = 8, ROWS = 4, N = COLS * ROWS;
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
    var bag = [], i, k, a;
    for (i = 0; i < ARMY.length; i++) {
      a = ARMY[i];
      for (k = 0; k < a[1]; k++) {
        bag.push({ s: RED, t: a[0] });
        bag.push({ s: BLACK, t: a[0] });
      }
    }
    // 32 枚洗牌铺满 32 个点
    for (i = bag.length - 1; i > 0; i--) {
      k = (rnd() * (i + 1)) | 0;
      var tmp = bag[i]; bag[i] = bag[k]; bag[k] = tmp;
    }
    return {
      bd: bag,
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
      g.result = { draw: false, winColor: g.seatColor[g.turn], reason: 'nomove' };
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

  function chooseMove(g, level, rnd) {
    rnd = rnd || Math.random;
    var moves = legalMoves(g);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];

    var me = g.seatColor[g.turn];
    if (me == null) return moves[(rnd() * moves.length) | 0];      // 开局只能翻，随机

    var i, mv, v, best = [], bestV = -Infinity;

    if (level <= 1) {
      // 简单：大多随机，有机会吃子时常常会吃
      var eats = [];
      for (i = 0; i < moves.length; i++) if (moves[i].k === 2) eats.push(moves[i]);
      if (eats.length && rnd() < 0.55) {
        eats.sort(function (a, b) { return capsValue(b.caps) - capsValue(a.caps); });
        return eats[Math.min(eats.length - 1, (rnd() * 2) | 0)];
      }
      return moves[(rnd() * moves.length) | 0];
    }

    for (i = 0; i < moves.length; i++) {
      mv = moves[i];
      v = withMove(g, mv, function (gg) {
        var sc = evaluate(gg, me);
        if (mv.k === 0) sc -= 0.4;                       // 翻子有一点信息代价
        if (level >= 3) sc -= worstBite(gg, me) * 0.75;  // 别把子送到人家嘴边
        return sc;
      });
      if (v > bestV + 1e-6) { bestV = v; best = [mv]; }
      else if (v > bestV - 1e-6) best.push(mv);
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
    evaluate: evaluate, capsValue: capsValue, chooseMove: chooseMove
  };
});
