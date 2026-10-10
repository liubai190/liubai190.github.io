/*!
 * flip-core.js —— 翻棋（暗棋 / 半棋）规则引擎 + 不完全信息 AI
 *
 * 规则依据：Android《中国象棋》1.80 内 data/053_c7a55aa3ba06.bin
 *          （GBK，981 字节）规则全文，逐条照搬。
 *
 *   棋盘   4x8 = 32 格，32 枚棋子（红黑各 16）全部背面朝上铺满
 *   回合   每回合二选一：翻一枚暗子 / 走一枚自己的明子
 *   定色   先行者翻出的第一枚棋子的颜色，就决定他执哪一方
 *   走子   每步走一格，上下左右（车马相仕帅兵都一样，没有象棋那套走法）
 *   吃子   帅>仕>相>车>马>炮>兵，大的吃小的，相同的互吃
 *          帅不能吃兵；兵能吃帅（本页与「同级互吃」合并取通行解：兵也能吃兵）
 *          炮吃任何子，但中间必须隔一个棋子，且可横向或竖向走多格
 *   判负   棋子被吃光 / 无棋可走
 *   判和   同一局面重复 / 连续 70 步没有吃子或翻子 / 双方总步数满 500
 *
 * 未实现：规则里那句「循环长捉判负」需要判定「捉」的意图链，本页用
 *         「同一局面重复三次判和」覆盖（见 README 说明）。
 *
 * 纯函数式：core 不碰 DOM，可单独在 node 里跑测试。
 */
(function (root) {
  'use strict';

  var COLS = 8, ROWS = 4, NSQ = 32;
  var RED = 0, BLACK = 1;

  var T_GEN = 1, T_ADV = 2, T_ELE = 3, T_CHA = 4, T_HOR = 5, T_CAN = 6, T_SOL = 7;
  var TYPE_CH = [null, 'j', 's', 'x', 'c', 'm', 'p', 'z'];   // 对应素材后缀
  var TYPE_CN = [null, '帅', '仕', '相', '车', '马', '炮', '兵'];
  var RANK = [0, 7, 6, 5, 4, 3, 2, 1];                       // 帅仕相车马炮兵
  var VALUE = [0, 15, 5, 5, 6, 5, 6, 2];                     // AI 估值
  var ARMY = [[T_GEN, 1], [T_ADV, 2], [T_ELE, 2], [T_CHA, 2], [T_HOR, 2], [T_CAN, 2], [T_SOL, 5]];

  var MATE = 100000;
  var INF = 1e9;

  // ---------------------------------------------------------------- 基础
  function enc(s, t) { return ((s & 1) << 3) | (t & 7); }
  function sideOf(p) { return (p >> 3) & 1; }
  function typeOf(p) { return p & 7; }
  function rankOf(p) { return RANK[p & 7]; }
  function colOf(i) { return i % COLS; }
  function rowOf(i) { return (i / COLS) | 0; }
  function idxOf(r, c) { return r * COLS + c; }
  function other(s) { return s ^ 1; }
  function pieceName(p) { return (sideOf(p) === RED ? 'r_' : 'b_') + TYPE_CH[typeOf(p)]; }
  function pieceText(p) { return (sideOf(p) === RED ? '红' : '黑') + TYPE_CN[typeOf(p)]; }

  var FULL = (function () {
    var a = [], s, k, n;
    for (s = 0; s < 2; s++)
      for (k = 0; k < ARMY.length; k++)
        for (n = 0; n < ARMY[k][1]; n++) a.push(enc(s, ARMY[k][0]));
    return a;
  })();   // 32 枚

  var NB = (function () {
    var out = [], i, r, c, l;
    for (i = 0; i < NSQ; i++) {
      r = rowOf(i); c = colOf(i); l = [];
      if (r > 0) l.push(i - COLS);
      if (r < ROWS - 1) l.push(i + COLS);
      if (c > 0) l.push(i - 1);
      if (c < COLS - 1) l.push(i + 1);
      out.push(l);
    }
    return out;
  })();

  // ---------------------------------------------------------------- 规则
  /** 普通子（非炮）能否吃：att 吃 def */
  function canCapture(att, def) {
    if (sideOf(att) === sideOf(def)) return false;
    var ta = typeOf(att), td = typeOf(def);
    if (ta === T_CAN) return false;                          // 炮只能跳吃
    if (ta === T_SOL) return td === T_GEN || td === T_SOL;   // 兵：吃帅；同级互吃
    if (ta === T_GEN) return td !== T_SOL;                   // 帅不吃兵
    return RANK[ta] >= RANK[td];                             // 大吃的、同级互吃
  }

  /** 炮的跳吃目标：同一直线上隔且仅隔一个棋子（炮架可以是任意子，含暗子） */
  function cannonTargets(bd, open, from) {
    var r0 = rowOf(from), c0 = colOf(from), out = [];
    var dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]], d, r, c, i, screen;
    for (var k = 0; k < 4; k++) {
      d = dirs[k]; screen = false;
      for (r = r0 + d[0], c = c0 + d[1]; r >= 0 && r < ROWS && c >= 0 && c < COLS; r += d[0], c += d[1]) {
        i = idxOf(r, c);
        if (!bd[i]) continue;
        if (!screen) { screen = true; continue; }            // 第一个子 = 炮架
        if (open[i] && sideOf(bd[i]) !== sideOf(bd[from])) out.push(i);
        break;                                               // 炮架之后只认第一个
      }
    }
    return out;
  }

  /**
   * 生成合法着法。col 传 null（定色之前）时只生成「翻子」。
   * 返回 [{ k:0 翻 | 1 走 | 2 吃, f: 起点, t: 终点 }]
   */
  function genMoves(bd, open, col) {
    var out = [], i, j, p, q, nb, tg;
    for (i = 0; i < NSQ; i++) if (bd[i] && !open[i]) out.push({ k: 0, f: i, t: i });
    if (col == null) return out;

    for (i = 0; i < NSQ; i++) {
      p = bd[i];
      if (!p || !open[i] || sideOf(p) !== col) continue;
      nb = NB[i];
      if (typeOf(p) === T_CAN) {
        for (j = 0; j < nb.length; j++) if (!bd[nb[j]]) out.push({ k: 1, f: i, t: nb[j] });
        tg = cannonTargets(bd, open, i);
        for (j = 0; j < tg.length; j++) out.push({ k: 2, f: i, t: tg[j] });
      } else {
        for (j = 0; j < nb.length; j++) {
          q = bd[nb[j]];
          if (!q) out.push({ k: 1, f: i, t: nb[j] });
          else if (open[nb[j]] && canCapture(p, q)) out.push({ k: 2, f: i, t: nb[j] });
        }
      }
    }
    return out;
  }

  /** 只有位置与棋盘，不含回合信息 */
  function applyMove(bd, open, mv) {
    var nb = bd.slice(), no = open.slice();
    if (mv.k === 0) {
      no[mv.f] = 1;
    } else {
      nb[mv.t] = nb[mv.f];
      nb[mv.f] = 0;
    }
    return { bd: nb, open: no };
  }

  // ---------------------------------------------------------------- 局面
  function shuffle(a, rng) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0, t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function initialBoard(rng) {
    return Int8Array.from(shuffle(FULL.slice(), rng || Math.random));
  }

  /** 玩家视角的重复局面键：暗子一律记成同一个符号（翻子会改变这个键） */
  function stateKey(g) {
    var a = new Array(NSQ), i;
    for (i = 0; i < NSQ; i++) a[i] = g.bd[i] ? (g.open[i] ? String(g.bd[i] + 40) : '*') : '.';
    return a.join('') + '|' + g.turn + '|' + (g.seatColor[0] == null ? '?' : g.seatColor[0]);
  }

  function createGame(opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random;
    var g = {
      bd: initialBoard(rng),
      open: new Uint8Array(NSQ),
      turn: 0,                       // 座位：0 = 先手（第一手翻子定色），1 = 后手
      seatColor: [null, null],       // 座位 -> 颜色；第一枚翻出后定
      eaten: [],                     // 已被吃掉的棋子（公开信息）
      quiet: 0,                      // 连续没有吃子 / 翻子的步数
      plies: 0,                      // 双方总步数（半回合）
      hist: [],
      last: null,
      result: null,                  // {winner:0|1} 或 {draw:true, reason}
      repKeys: {},
      cur: '',
      flipped: null                  // 第一枚被翻开的棋子的颜色
    };
    g.cur = stateKey(g);
    g.repKeys[g.cur] = 1;
    return g;
  }

  function aliveCount(g) {
    var n = [0, 0], i;
    for (i = 0; i < NSQ; i++) if (g.bd[i]) n[sideOf(g.bd[i])]++;
    return n;
  }

  function colorOfSeat(g, seat) { return g.seatColor[seat]; }
  function seatOfColor(g, col) { return g.seatColor[0] === col ? 0 : (g.seatColor[1] === col ? 1 : -1); }

  function legalMoves(g) {
    return genMoves(g.bd, g.open, g.seatColor[g.turn]);
  }

  /** 终局判定，结果写进 g.result */
  function checkEnd(g) {
    if (g.result) return g.result;
    var i;

    // 1) 吃光对方棋子 —— 只有在双方颜色都定了之后才谈得上「对方」
    if (g.seatColor[0] != null) {
      var n = aliveCount(g);
      if (n[RED] === 0 || n[BLACK] === 0) {
        var wc = n[RED] === 0 ? BLACK : RED;
        g.result = { winner: seatOfColor(g, wc), winColor: wc, reason: 'eaten' };
        return g.result;
      }
    }

    // 2) 无棋可走
    if (legalMoves(g).length === 0) {
      g.result = { winner: other(g.turn), winColor: g.seatColor[other(g.turn)],
                   reason: 'nomove', loseColor: g.seatColor[g.turn] };
      return g.result;
    }

    // 3) 和棋
    if (g.plies >= 500) { g.result = { draw: true, reason: 'maxply' }; return g.result; }
    if (g.quiet >= 70) { g.result = { draw: true, reason: 'quiet' }; return g.result; }
    if (g.repKeys[g.cur] >= 3) { g.result = { draw: true, reason: 'repeat' }; return g.result; }

    return null;
  }

  /** 走一步（会改 g）。mv 必须来自 legalMoves(g) */
  function doMove(g, mv) {
    if (g.result) return null;
    var snap = {
      bd: g.bd.slice(), open: g.open.slice(), turn: g.turn,
      sc0: g.seatColor[0], sc1: g.seatColor[1],
      eaten: g.eaten.slice(), quiet: g.quiet, plies: g.plies,
      last: g.last, cur: g.cur, repKeys: Object.assign({}, g.repKeys),
      flipped: g.flipped, result: g.result
    };
    g.hist.push(snap);

    var cap = 0, moved = g.bd[mv.f], mover = g.turn;
    if (mv.k === 0) {
      g.open[mv.f] = 1;
      if (g.seatColor[g.turn] == null) {                 // 第一枚翻子 -> 定色
        var c = sideOf(g.bd[mv.f]);
        g.seatColor[g.turn] = c;
        g.seatColor[other(g.turn)] = other(c);
        g.flipped = c;
      }
    } else {
      if (g.bd[mv.t]) { cap = g.bd[mv.t]; g.eaten.push(cap); }
      g.bd[mv.t] = g.bd[mv.f];
      g.bd[mv.f] = 0;
    }

    if (mv.k === 0 || cap) g.quiet = 0; else g.quiet++;
    g.plies++;
    g.last = { k: mv.k, f: mv.f, t: mv.t, cap: cap || 0, seat: mover, piece: moved };
    g.turn = other(g.turn);

    g.cur = stateKey(g);
    g.repKeys[g.cur] = (g.repKeys[g.cur] || 0) + 1;

    checkEnd(g);
    return g.last;
  }

  function undo(g) {
    var s = g.hist.pop();
    if (!s) return false;
    g.bd = s.bd; g.open = s.open; g.turn = s.turn;
    g.seatColor = [s.sc0, s.sc1];
    g.eaten = s.eaten; g.quiet = s.quiet; g.plies = s.plies;
    g.last = s.last; g.cur = s.cur; g.repKeys = s.repKeys;
    g.flipped = s.flipped; g.result = s.result;
    return true;
  }

  // ---------------------------------------------------------------- AI
  /** 未翻开的棋子还可能是哪些（公开信息推导：全部 32 枚 － 盘上明子 － 已吃掉的子） */
  function poolFor(g) {
    var all = FULL.slice(), i, j;
    for (i = 0; i < NSQ; i++) if (g.open[i] && g.bd[i]) {
      j = all.indexOf(g.bd[i]);
      if (j >= 0) all.splice(j, 1);          // 必须判 j >= 0：splice(-1) 会删掉最后一项
    }
    for (i = 0; i < g.eaten.length; i++) {
      j = all.indexOf(g.eaten[i]);
      if (j >= 0) all.splice(j, 1);
    }
    return all;
  }

  /** 采样一份「信念棋盘」：明子照旧，暗子的身份从池子里随机分配 */
  function sampleBoard(g, rng) {
    var pool = shuffle(poolFor(g), rng);
    var bd = g.bd.slice(), k = 0, i;
    for (i = 0; i < NSQ; i++) if (bd[i] && !g.open[i]) bd[i] = pool[k++ % pool.length];
    return bd;
  }

  /**
   * 评估：采样棋盘上的子力差。
   * 注意这里**不跳过暗子** —— 调用方（negamax / chooseMove）传进来的 bd
   * 已经由 sampleBoard 给暗子填上了「从公开信息池里抽出来的身份」，
   * 不拿它来算，采样就白采了（暗子只当挡路石子，AI 对盘面毫无概念）。
   */
  function evalFor(bd, open, col) {
    var s = 0, i, p;
    for (i = 0; i < NSQ; i++) {
      p = bd[i];
      if (!p) continue;
      s += (sideOf(p) === col ? 1 : -1) * VALUE[typeOf(p)];
    }
    return s;
  }

  /**
   * 走完这一步之后，落点上那枚子被对方明子一口吃掉的风险（返回被吃子的价值）
   * —— 与串串香那边的 dangerAt 同源，这里按翻翻棋「大吃小」的规则实现。
   */
  function riskOfMove(g, mv) {
    var mov = g.bd[mv.f];
    if (!mov || mv.k === 0) return 0;              // 翻子：翻出来是谁还不知道，不算风险
    var bd = g.bd.slice(), open = g.open.slice();
    bd[mv.t] = mov; bd[mv.f] = 0; open[mv.t] = 1;
    var myside = sideOf(mov), v = VALUE[typeOf(mov)], foe = other(myside);
    var i, j, p, nb;
    for (i = 0; i < NSQ; i++) {
      p = bd[i];
      if (!p || !open[i] || sideOf(p) !== foe) continue;
      if (typeOf(p) === T_CAN) {
        if (cannonTargets(bd, open, i).indexOf(mv.t) >= 0) return v;
      } else {
        nb = NB[i];
        for (j = 0; j < nb.length; j++) {
          if (nb[j] === mv.t && canCapture(p, bd[mv.t])) return v;
        }
      }
    }
    return 0;
  }

  /**
   * 落点的位置分：挨着对方明子 = 有接触、有机会；挨着自己明子 = 有照应。
   * 光靠子力评估的话，双方会互相绕圈、谁都不接触，一路磨到判和。
   */
  var DIRS4 = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  function spotScore(g, sq, me) {
    var r0 = rowOf(sq), c0 = colOf(sq), s = 0, k, r, c, i, p;
    for (k = 0; k < 4; k++) {
      r = r0 + DIRS4[k][0]; c = c0 + DIRS4[k][1];
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
      i = idxOf(r, c); p = g.bd[i];
      if (!p || !g.open[i]) continue;
      if (sideOf(p) === me) s += 0.06;
      else s += Math.min(3, VALUE[typeOf(p)]) * 0.06;
    }
    return Math.min(0.6, s);
  }

  function negamax(bd, open, col, depth, alpha, beta) {
    var moves = genMoves(bd, open, col);
    if (!moves.length) return -MATE;              // 当前方无棋可走 = 输
    if (depth <= 0) return evalFor(bd, open, col);

    // 吃子优先排序，利于剪枝
    moves.sort(function (a, b) {
      var va = a.k === 2 ? VALUE[typeOf(bd[a.t])] : 0;
      var vb = b.k === 2 ? VALUE[typeOf(bd[b.t])] : 0;
      return vb - va;
    });

    var best = -INF;
    for (var i = 0; i < moves.length; i++) {
      var n = applyMove(bd, open, moves[i]);
      var sc = -negamax(n.bd, n.open, other(col), depth - 1, -beta, -alpha);
      if (sc > best) best = sc;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // noise：在分数差不多的着法之间乱选的幅度
  // flip  ：翻暗子的基准分 —— 同时也是「这口吃不吃」的门槛
  //         （暗子只有翻开才能用，一直不翻就只能拿手上几枚子耗到和棋）
  // risk  ：对「吃完站那儿会被反吃」的顾虑
  var LEVELS = {
    1: { samples: 4,  depth: 1, noise: 3.0, flip: 1.2, risk: 0.00 },
    2: { samples: 6,  depth: 2, noise: 1.2, flip: 1.2, risk: 0.35 },
    3: { samples: 10, depth: 2, noise: 0.4, flip: 1.2, risk: 0.45 }
  };

  /**
   * 选一步。level 1/2/3；返回着法或 null。
   * 定色之前（只有翻子可走）直接随机，位置没有战术差别。
   */
  function chooseMove(g, level, rng) {
    rng = rng || Math.random;
    var moves = legalMoves(g);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];

    var me = g.seatColor[g.turn];
    if (me == null) return moves[(rng() * moves.length) | 0];

    var cfg = LEVELS[level] || LEVELS[2];
    var m, mv, v, n, sc, bd, s, q, tac, noise;

    // 局面越僵越不能挑食：久无吃子 / 翻子时把「怕被反吃」放松下来。
    // 否则双方都躲着换子，会一路耗到 70 手判和 —— 看着就是在磨棋。
    var effRisk = cfg.risk * (1 - Math.min(0.7, (g.quiet || 0) / 60));

    // 每一步「站上去会被对方反吃」的风险，只算一次
    var risk = new Float64Array(moves.length);
    for (m = 0; m < moves.length; m++) risk[m] = riskOfMove(g, moves[m]);

    // ---- 一、不吃亏又能吃到的子：直接吃，不给随机留空子 ----
    var eatBest = -Infinity, eatPool = [];
    for (m = 0; m < moves.length; m++) {
      mv = moves[m];
      if (mv.k !== 2) continue;
      v = VALUE[typeOf(g.bd[mv.t])] - risk[m] * effRisk;
      if (v > eatBest + 1e-9) { eatBest = v; eatPool = [mv]; }
      else if (v > eatBest - 1e-9) eatPool.push(mv);
    }
    if (eatPool.length && eatBest >= cfg.flip) return eatPool[(rng() * eatPool.length) | 0];

    // ---- 二、其余着法交给采样搜索排序 ----
    var acc = new Float64Array(moves.length);
    for (s = 0; s < cfg.samples; s++) {
      bd = sampleBoard(g, rng);
      for (m = 0; m < moves.length; m++) {
        mv = moves[m];
        n = applyMove(bd, g.open, mv);
        sc = (cfg.depth <= 0) ? evalFor(n.bd, n.open, me)
                              : -negamax(n.bd, n.open, other(me), cfg.depth - 1, -INF, INF);
        acc[m] += sc;
      }
    }

    var best = null, bestSc = -Infinity;
    for (m = 0; m < moves.length; m++) {
      mv = moves[m];
      if (mv.k === 2) {
        // 走到这儿说明这口吃得不划算（否则第一步就吃了），但还是比瞎挪强
        tac = VALUE[typeOf(g.bd[mv.t])] - risk[m] * effRisk;
        noise = Math.min(cfg.noise * 0.25, 0.5);
      } else if (mv.k === 0) {
        tac = cfg.flip + spotScore(g, mv.f, me) * 0.5;
        noise = cfg.noise;
      } else {
        tac = -0.5 + spotScore(g, mv.t, me) - risk[m] * effRisk * 0.5;
        noise = cfg.noise;
      }
      // 搜索分只用来在「同一类着法」内部比高下，量级压到 ±1.5，
      // 免得子力差（±33）把上面的战术分整个淹掉
      q = acc[m] / cfg.samples * 0.08;
      if (q > 1.5) q = 1.5; else if (q < -1.5) q = -1.5;
      v = tac + q + (rng() - 0.5) * noise;
      if (v > bestSc) { bestSc = v; best = mv; }
    }
    return best;
  }

  // ---------------------------------------------------------------- 导出
  root.FQ = {
    COLS: COLS, ROWS: ROWS, NSQ: NSQ, RED: RED, BLACK: BLACK,
    T_GEN: T_GEN, T_ADV: T_ADV, T_ELE: T_ELE, T_CHA: T_CHA,
    T_HOR: T_HOR, T_CAN: T_CAN, T_SOL: T_SOL,
    TYPE_CH: TYPE_CH, TYPE_CN: TYPE_CN, RANK: RANK, VALUE: VALUE,
    colOf: colOf, rowOf: rowOf, idxOf: idxOf, other: other,
    enc: enc, sideOf: sideOf, typeOf: typeOf, rankOf: rankOf,
    pieceName: pieceName, pieceText: pieceText,
    canCapture: canCapture, cannonTargets: cannonTargets, genMoves: genMoves,
    createGame: createGame, legalMoves: legalMoves, doMove: doMove, undo: undo,
    checkEnd: checkEnd, aliveCount: aliveCount, stateKey: stateKey,
    poolFor: poolFor, sampleBoard: sampleBoard, evalFor: evalFor,
    riskOfMove: riskOfMove, spotScore: spotScore,
    chooseMove: chooseMove, LEVELS: LEVELS
  };
})(typeof window !== 'undefined' ? window : globalThis);
