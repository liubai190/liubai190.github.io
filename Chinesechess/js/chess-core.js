/*!
 * chess-core.js — 中国象棋 规则 / 评估 / 搜索
 * 纯逻辑、无 DOM 依赖，可直接在 Node 里跑测试。
 *
 * 坐标：棋盘 9 列 x 10 行，扁平下标 i = row*9 + col
 *       row 0 = 黑方底线（屏幕上方），row 9 = 红方底线（屏幕下方）
 * 棋子编码：0 空；红 1..7；黑 9..15   （黑 = 红 + 8）
 *       1=将 2=士 3=象 4=车 5=马 6=炮 7=兵
 * 着法编码：mv = from*128 + to
 *
 * 走法表（子力位置价值表）与引擎思路参考 MIT 协议的 cocogames/Chess
 * （作者 一叶孤舟），在此基础上重写为「伪合法着法 + 吃将判负」结构，
 * 并修正了原版在搜索中用全局棋盘判断蹩马腿 / 塞象眼的问题。
 */
(function (global) {
  'use strict';

  var RED = 0, BLACK = 1;
  var K = 1, A = 2, B = 3, R = 4, N = 5, C = 6, P = 7;

  var INF = 1 << 28;
  var MATE = 90000;

  function mk(side, t) { return side === RED ? t : t + 8; }
  function sideOf(p) { return p > 8 ? BLACK : RED; }
  function typeOf(p) { return p > 8 ? p - 8 : p; }
  function idx(r, c) { return r * 9 + c; }
  function rowOf(i) { return (i / 9) | 0; }
  function colOf(i) { return i % 9; }
  function inBoard(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }

  // ---------------------------------------------------------------- 开局
  var INIT = (function () {
    var b = new Int8Array(90);
    function put(r, c, p) { b[r * 9 + c] = p; }
    var back = [R, N, B, A, K, A, B, N, R];
    for (var c = 0; c < 9; c++) { put(0, c, mk(BLACK, back[c])); put(9, c, mk(RED, back[c])); }
    put(2, 1, mk(BLACK, C)); put(2, 7, mk(BLACK, C));
    put(7, 1, mk(RED, C)); put(7, 7, mk(RED, C));
    for (var k = 0; k < 9; k += 2) { put(3, k, mk(BLACK, P)); put(6, k, mk(RED, P)); }
    return b;
  })();

  function initialBoard() { return Int8Array.from(INIT); }

  // -------------------------------------------------------- 着法生成（伪合法）
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  // 马：dr, dc, 马腿相对起点的偏移
  var HORSE = [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
               [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]];
  var D2 = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
  var D1 = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  function genMoves(bd, s, out) {
    out = out || [];
    var opp = 1 - s;
    for (var i = 0; i < 90; i++) {
      var p = bd[i];
      if (!p || sideOf(p) !== s) continue;
      var t = typeOf(p), r = (i / 9) | 0, c = i % 9, k, dr, dc, rr, cc, j, q;

      if (t === R) {
        for (k = 0; k < 4; k++) {
          dr = ORTH[k][0]; dc = ORTH[k][1]; rr = r + dr; cc = c + dc;
          while (inBoard(rr, cc)) {
            j = rr * 9 + cc; q = bd[j];
            if (!q) out.push(i * 128 + j);
            else { if (sideOf(q) !== s) out.push(i * 128 + j); break; }
            rr += dr; cc += dc;
          }
        }
      } else if (t === C) {
        for (k = 0; k < 4; k++) {
          dr = ORTH[k][0]; dc = ORTH[k][1]; rr = r + dr; cc = c + dc;
          var screen = false;
          while (inBoard(rr, cc)) {
            j = rr * 9 + cc; q = bd[j];
            if (!screen) {
              if (!q) out.push(i * 128 + j);
              else screen = true;
            } else if (q) {
              if (sideOf(q) !== s) out.push(i * 128 + j);
              break;
            }
            rr += dr; cc += dc;
          }
        }
      } else if (t === N) {
        for (k = 0; k < 8; k++) {
          var h = HORSE[k];
          rr = r + h[0]; cc = c + h[1];
          if (!inBoard(rr, cc)) continue;
          if (bd[(r + h[2]) * 9 + (c + h[3])]) continue;      // 蹩马腿
          j = rr * 9 + cc; q = bd[j];
          if (!q || sideOf(q) !== s) out.push(i * 128 + j);
        }
      } else if (t === B) {
        for (k = 0; k < 4; k++) {
          rr = r + D2[k][0]; cc = c + D2[k][1];
          if (!inBoard(rr, cc)) continue;
          if (s === RED ? rr < 5 : rr > 4) continue;           // 象不过河
          if (bd[(r + D1[k][0]) * 9 + (c + D1[k][1])]) continue; // 塞象眼
          j = rr * 9 + cc; q = bd[j];
          if (!q || sideOf(q) !== s) out.push(i * 128 + j);
        }
      } else if (t === A) {
        var alo = s === RED ? 7 : 0, ahi = s === RED ? 9 : 2;
        for (k = 0; k < 4; k++) {
          rr = r + D1[k][0]; cc = c + D1[k][1];
          if (cc < 3 || cc > 5 || rr < alo || rr > ahi) continue;
          j = rr * 9 + cc; q = bd[j];
          if (!q || sideOf(q) !== s) out.push(i * 128 + j);
        }
      } else if (t === K) {
        var klo = s === RED ? 7 : 0, khi = s === RED ? 9 : 2;
        for (k = 0; k < 4; k++) {
          rr = r + ORTH[k][0]; cc = c + ORTH[k][1];
          if (cc < 3 || cc > 5 || rr < klo || rr > khi) continue;
          j = rr * 9 + cc; q = bd[j];
          if (!q || sideOf(q) !== s) out.push(i * 128 + j);
        }
        // 白脸将（飞将）：同列、中间无子 → 直接把对方将"吃"掉
        for (rr = r - 1; rr >= 0; rr--) {
          q = bd[rr * 9 + c];
          if (q) { if (q === mk(opp, K)) out.push(i * 128 + rr * 9 + c); break; }
        }
        for (rr = r + 1; rr < 10; rr++) {
          q = bd[rr * 9 + c];
          if (q) { if (q === mk(opp, K)) out.push(i * 128 + rr * 9 + c); break; }
        }
      } else if (t === P) {
        rr = r + (s === RED ? -1 : 1);
        if (inBoard(rr, c)) {
          j = rr * 9 + c; q = bd[j];
          if (!q || sideOf(q) !== s) out.push(i * 128 + j);
        }
        if (s === RED ? r <= 4 : r >= 5) {                      // 过河才能横走
          for (k = -1; k <= 1; k += 2) {
            cc = c + k;
            if (cc < 0 || cc > 8) continue;
            j = r * 9 + cc; q = bd[j];
            if (!q || sideOf(q) !== s) out.push(i * 128 + j);
          }
        }
      }
    }
    return out;
  }

  // -------------------------------------------------- 被攻击判定（只判将帅）
  // 马：攻击者相对目标点的偏移 + 马腿相对目标点的偏移
  var NATK = [[-2, -1, -1, -1], [2, -1, 1, -1], [-2, 1, -1, 1], [2, 1, 1, 1],
              [-1, -2, -1, -1], [-1, 2, -1, 1], [1, -2, 1, -1], [1, 2, 1, 1]];
  // 说明：上表 4 项依次为 [攻击者 dr, 攻击者 dc, 马腿 dr, 马腿 dc]
  //   |dr|=2 时马腿在 (目标 + (sign(dr), dc))；|dc|=2 时马腿在 (目标 + (dr, sign(dc)))

  // 索引按阵营：0=红（row 7..9），1=黑（row 0..2）
  var KING_LO = [63, 0], KING_HI = [89, 26];

  /**
   * bySide 一方的棋子是否正在攻击对方将帅（即对方将帅可被吃掉）
   * 只用于判断将帅；仕/相 永远够不到对方将帅，故不参与。
   */
  function kingAttacked(bd, bySide) {
    var opp = 1 - bySide;
    var kp = mk(opp, K), ks = -1, i;
    for (i = KING_LO[opp]; i <= KING_HI[opp]; i++) if (bd[i] === kp) { ks = i; break; }
    if (ks < 0) return true;                       // 对方将帅已不在 → 视为已胜

    var r = (ks / 9) | 0, c = ks % 9, k, rr, cc, q, t;

    // 车 / 炮 / 飞将
    for (k = 0; k < 4; k++) {
      var dr = ORTH[k][0], dc = ORTH[k][1];
      rr = r + dr; cc = c + dc;
      var screen = false;
      while (inBoard(rr, cc)) {
        q = bd[rr * 9 + cc];
        if (q) {
          if (!screen) {
            if (sideOf(q) === bySide) {
              t = typeOf(q);
              if (t === R) return true;
              if (t === K && dc === 0) return true;      // 同列、中间无子 → 飞将
              if (t === K && dr === 0) return true;      // 同行相邻（理论上不会出现）
            }
            screen = true;
          } else {
            if (sideOf(q) === bySide && typeOf(q) === C) return true;
            break;
          }
        }
        rr += dr; cc += dc;
      }
    }

    // 马
    for (k = 0; k < 8; k++) {
      var h = NATK[k];
      var ar = r + h[0], ac = c + h[1];
      if (!inBoard(ar, ac)) continue;
      if (bd[ar * 9 + ac] !== mk(bySide, N)) continue;
      var lr = r + h[2], lc = c + h[3];
      if (inBoard(lr, lc) && bd[lr * 9 + lc]) continue;      // 被蹩腿
      return true;
    }

    // 兵/卒：正前方一格
    var pr = r + (bySide === RED ? 1 : -1);
    if (inBoard(pr, c) && bd[pr * 9 + c] === mk(bySide, P)) return true;
    // 兵/卒：横向（只有过河后才能横走）
    if (bySide === RED ? r <= 4 : r >= 5) {
      for (k = -1; k <= 1; k += 2) {
        cc = c + k;
        if (cc < 0 || cc > 8) continue;
        if (bd[r * 9 + cc] === mk(bySide, P)) return true;
      }
    }
    return false;
  }

  function inCheck(bd, s) { return kingAttacked(bd, 1 - s); }   // s 方被将军

  function makeMove(bd, mv) {
    var from = mv >> 7, to = mv & 127;
    var cap = bd[to];
    bd[to] = bd[from];
    bd[from] = 0;
    return cap;
  }
  function unmakeMove(bd, mv, cap) {
    var from = mv >> 7, to = mv & 127;
    bd[from] = bd[to];
    bd[to] = cap;
  }

  /** 完全合法着法（过滤掉走完后自己被将军的） */
  function legalMoves(bd, s) {
    var ps = genMoves(bd, s, []), out = [], i, cap;
    for (i = 0; i < ps.length; i++) {
      cap = makeMove(bd, ps[i]);
      if (!kingAttacked(bd, 1 - s)) out.push(ps[i]);
      unmakeMove(bd, ps[i], cap);
    }
    return out;
  }

  function hasLegalMove(bd, s) { return legalMoves(bd, s).length > 0; }

  // ---------------------------------------------------------------- 评估
  // 表按「红方视角、row0=对方底线」编写；黑方取 row 镜像
  var RAW = {
    R: [   // 车
      [206, 208, 207, 213, 214, 213, 207, 208, 206],
      [206, 212, 209, 216, 233, 216, 209, 212, 206],
      [206, 208, 207, 214, 216, 214, 207, 208, 206],
      [206, 213, 213, 216, 216, 216, 213, 213, 206],
      [208, 211, 211, 214, 215, 214, 211, 211, 208],
      [208, 212, 212, 214, 215, 214, 212, 212, 208],
      [204, 209, 204, 212, 214, 212, 204, 209, 204],
      [198, 208, 204, 212, 212, 212, 204, 208, 198],
      [200, 208, 206, 212, 200, 212, 206, 208, 200],
      [194, 206, 204, 212, 200, 212, 204, 206, 194]
    ],
    N: [   // 马
      [90, 90, 90, 96, 90, 96, 90, 90, 90],
      [90, 96, 103, 97, 94, 97, 103, 96, 90],
      [92, 98, 99, 103, 99, 103, 99, 98, 92],
      [93, 108, 100, 107, 100, 107, 100, 108, 93],
      [90, 100, 99, 103, 104, 103, 99, 100, 90],
      [90, 98, 101, 102, 103, 102, 101, 98, 90],
      [92, 94, 98, 95, 98, 95, 98, 94, 92],
      [93, 92, 94, 95, 92, 95, 94, 92, 93],
      [85, 90, 92, 93, 78, 93, 92, 90, 85],
      [88, 85, 90, 88, 90, 88, 90, 85, 88]
    ],
    B: [   // 相
      [0, 0, 20, 0, 0, 0, 20, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 23, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 20, 0, 0, 0, 20, 0, 0],
      [0, 0, 20, 0, 0, 0, 20, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [18, 0, 0, 0, 23, 0, 0, 0, 18],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 20, 0, 0, 0, 20, 0, 0]
    ],
    A: [   // 士
      [0, 0, 0, 20, 0, 20, 0, 0, 0],
      [0, 0, 0, 0, 23, 0, 0, 0, 0],
      [0, 0, 0, 20, 0, 20, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 20, 0, 20, 0, 0, 0],
      [0, 0, 0, 0, 23, 0, 0, 0, 0],
      [0, 0, 0, 20, 0, 20, 0, 0, 0]
    ],
    K: [   // 将（不参与子力，仅占位）
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0]
    ],
    C: [   // 炮
      [100, 100, 96, 91, 90, 91, 96, 100, 100],
      [98, 98, 96, 92, 89, 92, 96, 98, 98],
      [97, 97, 96, 91, 92, 91, 96, 97, 97],
      [96, 99, 99, 98, 100, 98, 99, 99, 96],
      [96, 96, 96, 96, 100, 96, 96, 96, 96],
      [95, 96, 99, 96, 100, 96, 99, 96, 95],
      [96, 96, 96, 96, 96, 96, 96, 96, 96],
      [97, 96, 100, 99, 101, 99, 100, 96, 97],
      [96, 97, 98, 98, 98, 98, 98, 97, 96],
      [96, 96, 97, 99, 99, 99, 97, 96, 96]
    ],
    P: [   // 兵
      [9, 9, 9, 11, 13, 11, 9, 9, 9],
      [19, 24, 34, 42, 44, 42, 34, 24, 19],
      [19, 24, 32, 37, 37, 37, 32, 24, 19],
      [19, 23, 27, 29, 30, 29, 27, 23, 19],
      [14, 18, 20, 27, 29, 27, 20, 18, 14],
      [7, 0, 13, 0, 16, 0, 13, 0, 7],
      [7, 0, 7, 0, 15, 0, 7, 0, 7],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0]
    ]
  };
  var BASE = (function () {   // 基础子力（叠加在位置表上）
    var b = new Int16Array(8);
    b[K] = 0; b[A] = 20; b[B] = 20; b[R] = 0; b[N] = 0; b[C] = 0; b[P] = 12;
    return b;
  })();
  var PST = {};
  (function () {
    for (var name in RAW) { PST[{ R: R, N: N, B: B, A: A, K: K, C: C, P: P }[name]] = [].concat.apply([], RAW[name]); }
  })();

  var MVAL = new Int16Array(8);
  MVAL[K] = 1000; MVAL[A] = 22; MVAL[B] = 22; MVAL[R] = 200; MVAL[N] = 92; MVAL[C] = 96; MVAL[P] = 30;

  function evaluate(bd, s) {
    var sc = 0, i, p, t;
    for (i = 0; i < 90; i++) {
      p = bd[i];
      if (!p) continue;
      if (p > 8) {
        t = p - 8;
        sc -= PST[t][(9 - ((i / 9) | 0)) * 9 + (i % 9)] + BASE[t];
      } else {
        sc += PST[p][i] + BASE[p];
      }
    }
    return s === RED ? sc : -sc;
  }

  // ---------------------------------------------------------------- 搜索
  var killers = [];
  for (var _i = 0; _i < 80; _i++) killers.push([-1, -1]);
  var history = new Int32Array(90 * 128);
  var ORD = new Int32Array(512);

  var nodes = 0, abortAt = 0, aborted = false;

  function scoreMoves(bd, moves, ply, depth) {
    var n = moves.length, i, j, mv, cap, sc, kidx = ply < 80 ? ply : 79;
    var kl = killers[kidx];
    for (i = 0; i < n; i++) {
      mv = moves[i];
      cap = bd[mv & 127];
      if (cap) sc = 1e6 + MVAL[typeOf(cap)] * 16 - MVAL[typeOf(bd[mv >> 7])];
      else if (mv === kl[0]) sc = 9e5;
      else if (mv === kl[1]) sc = 8e5;
      else sc = history[mv];
      ORD[i] = sc;
    }
    for (i = 1; i < n; i++) {
      mv = moves[i]; sc = ORD[i];
      for (j = i - 1; j >= 0 && ORD[j] < sc; j--) { moves[j + 1] = moves[j]; ORD[j + 1] = ORD[j]; }
      moves[j + 1] = mv; ORD[j + 1] = sc;
    }
  }

  function search(bd, depth, alpha, beta, s, ply) {
    if (aborted) return alpha;
    if ((++nodes & 1023) === 0 && Date.now() > abortAt) { aborted = true; return alpha; }
    if (kingAttacked(bd, s)) return MATE - ply;          // 我可吃对方将 → 胜
    if (depth <= 0) return evaluate(bd, s);

    var moves = genMoves(bd, s, []);
    scoreMoves(bd, moves, ply, depth);
    var kidx = ply < 80 ? ply : 79;
    var best = -INF, i, mv, cap, v;
    for (i = 0; i < moves.length; i++) {
      mv = moves[i];
      cap = makeMove(bd, mv);
      v = -search(bd, depth - 1, -beta, -alpha, 1 - s, ply + 1);
      unmakeMove(bd, mv, cap);
      if (aborted) return best > -INF ? best : alpha;
      if (v > best) best = v;
      if (v > alpha) {
        alpha = v;
        if (alpha >= beta) {
          if (!cap && moves.length) {
            var kl = killers[kidx];
            if (kl[0] !== mv) { kl[1] = kl[0]; kl[0] = mv; }
            history[mv] += depth * depth;
          }
          break;
        }
      }
    }
    return best;
  }

  function posKey(bd) {
    var out = '', i, p;
    for (i = 0; i < 90; i++) { p = bd[i]; out += p ? String.fromCharCode(64 + p) : '.'; }
    return out;
  }

  /**
   * 思考并给出着法
   * opts: { depth, slack, budget, seed, seen:Set<posKey> 已出现过的局面 }
   * 返回 { move, value, depth, nodes, ms } ；无合法着法时 move 为 null
   */
  function think(bd, s, opts) {
    opts = opts || {};
    var maxDepth = opts.depth || 3;
    var slack = opts.slack == null ? 12 : opts.slack;
    var budget = opts.budget || 2000;
    var seen = opts.seen || null;
    var t0 = Date.now();

    nodes = 0; aborted = false; abortAt = t0 + budget;
    for (var z = 0; z < 90 * 128; z++) history[z] = 0;

    var legal = legalMoves(bd, s);
    if (!legal.length) return { move: null, value: 0, depth: 0, nodes: 0, ms: 0 };

    var result = null, prevBest = -1;
    for (var d = 1; d <= maxDepth; d++) {
      if (prevBest >= 0) {                       // 上一轮最佳提前
        var pos = legal.indexOf(prevBest);
        if (pos > 0) { legal.splice(pos, 1); legal.unshift(prevBest); }
      }
      var alpha = -INF, bv = -INF, cands = [], i, mv, cap, v;
      for (i = 0; i < legal.length; i++) {
        mv = legal[i];
        cap = makeMove(bd, mv);
        v = -search(bd, d - 1, -INF, -alpha, 1 - s, 1);
        unmakeMove(bd, mv, cap);
        if (aborted) break;
        if (v > alpha) {
          if (v > bv) bv = v;
          alpha = bv - slack;
          cands.push([mv, v]);
        }
      }
      if (aborted) break;
      if (!cands.length) break;

      cands.sort(function (a, b) { return b[1] - a[1]; });
      var best = cands[0][1];
      var pool = [], k, key;
      for (k = 0; k < cands.length; k++) {
        if (cands[k][1] < best - slack) break;
        mv = cands[k][0];
        if (seen) {
          cap = makeMove(bd, mv);
          key = posKey(bd);
          unmakeMove(bd, mv, cap);
          if (seen.has(key)) continue;           // 尽量不走重复局面
        }
        pool.push(mv);
      }
      if (!pool.length) {                        // 全是重复局面，退让一步
        for (k = 0; k < cands.length; k++) { if (cands[k][1] < best - slack) break; pool.push(cands[k][0]); }
      }
      result = { pool: pool, value: best, depth: d, nodes: nodes, ms: Date.now() - t0 };
      prevBest = pool[0];
      if (Date.now() - t0 > budget) break;
    }

    if (!result) result = { pool: [legal[0]], value: 0, depth: 0, nodes: nodes, ms: Date.now() - t0 };
    var rnd = opts.rnd || Math.random;
    result.move = result.pool[(rnd() * result.pool.length) | 0];
    return result;
  }

  // ---------------------------------------------------------------- 导出
  var CC = {
    RED: RED, BLACK: BLACK, K: K, A: A, B: B, R: R, N: N, C: C, P: P,
    INF: INF, MATE: MATE,
    mk: mk, sideOf: sideOf, typeOf: typeOf, idx: idx, rowOf: rowOf, colOf: colOf,
    initialBoard: initialBoard, INIT: INIT,
    genMoves: genMoves, legalMoves: legalMoves, hasLegalMove: hasLegalMove,
    kingAttacked: kingAttacked, inCheck: inCheck,
    makeMove: makeMove, unmakeMove: unmakeMove,
    evaluate: evaluate, think: think, posKey: posKey,
    moveFrom: function (mv) { return mv >> 7; },
    moveTo: function (mv) { return mv & 127; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CC;
  global.CC = CC;
})(typeof window !== 'undefined' ? window : globalThis);
