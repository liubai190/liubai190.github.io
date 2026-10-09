/*!
 * chess4-core.js — 四界大战（四家中国象棋）规则 / 评估 / 搜索
 * 纯逻辑、无 DOM 依赖，可直接在 Node 里跑测试。
 *
 * 棋盘：18 列 x 10 行（左右各半张），扁平下标 i = row*18 + col
 *       row 0 = 上方（黑方底线），row 9 = 下方（红方底线）
 *
 * 军名：**界面上按棋子颜色叫「红 蓝 黑 青」**（2026-10-09 起，文字与色统一）。
 *   代码里的内部常量是素材来源的老名字（GREEN=青军 / YELLOW=蓝军，图名前缀 g_ / y_），
 *   因为青军字形取自黑方素材、蓝军字形取自红方素材，改成色名反而难对。
 *   需要给用户看的文字一律走 SIDE_NAME（本文件）/ SIDE_TXT（chess4-ui.js）。
 *
 * 四方：红(下) 青(左) 黑(上) 蓝(右)
 *   黑/红：后排在第 4~12 列（横向），九宫在行 0-2 / 7-9、列 7-9
 *   青：  后排在第 0 列、占 1~9 行；九宫 行 4-6、列 0-2
 *   蓝：  后排在第 17 列、占 0~8 行；九宫 行 3-5、列 15-17
 * 棋子编码：code = side*8 + type，type 1..7（1=将帅 2=士 3=象相 4=车 5=马 6=炮 7=兵卒）
 *       红 1..7  黑 9..15  青 17..23  蓝 25..31
 * 着法编码：mv = from*256 + to（180 个格，8 位放不下）
 * 走子顺序：红 → 蓝 → 黑 → 青（逆时针：下 → 右 → 上 → 左）
 *   （2026-10-09 用户反馈「红走完该是黄不该是绿」，由原来的红绿黑黄改过来；
 *    当日稍后军团改按颜色命名，黄→蓝、绿→青，顺序不变）
 *
 * 四界大战特有规则（其余同中国象棋）：
 *   除将帅外，**从未移动过的棋子不能被吃**；走出去又退回来算移动过。
 *   为此每个格子配一个 moved 标志，跟着棋子一起搬。
 */
(function (global) {
  'use strict';

  var COLS = 18, ROWS = 10, NSQ = COLS * ROWS;

  var RED = 0, BLACK = 1, GREEN = 2, YELLOW = 3;
  var SIDE_NAME = ['红', '黑', '青', '蓝'];          // 对外文字（与棋子颜色一致）
  var ORDER = [RED, YELLOW, BLACK, GREEN];          // 红 → 蓝 → 黑 → 青
  var NEXT = [];
  ORDER.forEach(function (s, i) { NEXT[s] = ORDER[(i + 1) % 4]; });

  var K = 1, A = 2, B = 3, R = 4, N = 5, C = 6, P = 7;

  var INF = 1 << 28;
  var MATE = 90000;          // 本方被将死
  var ELIM_WIN = 30000;      // 敌方被将死（出局）

  function mk(s, t) { return (s << 3) | t; }
  function sideOf(p) { return (p >> 3) & 3; }
  function typeOf(p) { return p & 7; }
  function idx(r, c) { return r * COLS + c; }
  function rowOf(i) { return (i / COLS) | 0; }
  function colOf(i) { return i % COLS; }
  function inBoard(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

  // 每方：前进方向（红上 / 黑下 / 青右 / 蓝左）
  var FWD = [[-1, 0], [1, 0], [0, 1], [0, -1]];
  // 每方九宫左上角（行,列）
  var PAL = [[7, 7], [0, 7], [4, 0], [3, 15]];

  /** 兵/卒 是否已过河（过河后才能横走） */
  function crossed(s, r, c) {
    if (s === RED) return r <= 4;
    if (s === BLACK) return r >= 5;
    if (s === GREEN) return c >= 4;
    return c <= 12;                                   // YELLOW
  }
  /** 象/相 的活动范围：不得越过本方界河 */
  function inHome(s, r, c) {
    if (s === RED) return r >= 5;
    if (s === BLACK) return r <= 4;
    if (s === GREEN) return c <= 3;
    return c >= 13;                                   // YELLOW
  }
  function inPalace(s, r, c) {
    var p = PAL[s];
    return r >= p[0] && r <= p[0] + 2 && c >= p[1] && c <= p[1] + 2;
  }

  // ---------------------------------------------------------------- 开局
  var BACK = [R, N, B, A, K, A, B, N, R];
  function initialBoard() {
    var b = new Int8Array(NSQ), i;
    function put(r, c, s, t) { b[r * COLS + c] = mk(s, t); }
    // 黑（上）
    for (i = 0; i < 9; i++) put(0, 4 + i, BLACK, BACK[i]);
    put(2, 5, BLACK, C); put(2, 11, BLACK, C);
    [4, 6, 8, 10, 12].forEach(function (c) { put(3, c, BLACK, P); });
    // 红（下）
    for (i = 0; i < 9; i++) put(9, 4 + i, RED, BACK[i]);
    put(7, 5, RED, C); put(7, 11, RED, C);
    [4, 6, 8, 10, 12].forEach(function (c) { put(6, c, RED, P); });
    // 青（左）后排第 0 列、占 1~9 行
    for (i = 0; i < 9; i++) put(1 + i, 0, GREEN, BACK[i]);
    put(2, 2, GREEN, C); put(8, 2, GREEN, C);
    [1, 3, 5, 7, 9].forEach(function (r) { put(r, 3, GREEN, P); });
    // 蓝（右）后排第 17 列、占 0~8 行
    for (i = 0; i < 9; i++) put(i, 17, YELLOW, BACK[i]);
    put(1, 15, YELLOW, C); put(7, 15, YELLOW, C);
    [0, 2, 4, 6, 8].forEach(function (r) { put(r, 13, YELLOW, P); });
    return b;
  }

  // -------------------------------------------------------- 着法生成（伪合法）
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var HORSE = [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
               [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]];
  var D2 = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
  var D1 = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  /** 能否落到 j：空格可以；敌子要看「未动过的子不可吃」（将帅除外） */
  function canTake(bd, mvf, s, j) {
    var q = bd[j];
    if (!q) return true;
    if (sideOf(q) === s) return false;
    if (typeOf(q) === K) return true;          // 将帅不受"未动"保护
    return mvf[j] === 1;
  }

  /** 被"未动不可吃"挡下来的吃子（只用于给玩家提示，不参与着法生成判断） */
  function blockedCapture(bd, mvf, s, from, to) {
    var q = bd[to];
    if (!q || sideOf(q) === s || typeOf(q) === K) return false;
    return mvf[to] !== 1 && q !== bd[from];
  }

  function genMoves(bd, mvf, s, out) {
    out = out || [];
    for (var i = 0; i < NSQ; i++) {
      var p = bd[i];
      if (!p || sideOf(p) !== s) continue;
      var t = typeOf(p), r = (i / COLS) | 0, c = i % COLS, k, dr, dc, rr, cc, j, q;

      if (t === R) {
        for (k = 0; k < 4; k++) {
          dr = ORTH[k][0]; dc = ORTH[k][1]; rr = r + dr; cc = c + dc;
          while (inBoard(rr, cc)) {
            j = rr * COLS + cc; q = bd[j];
            if (!q) out.push(i * 256 + j);
            else { if (canTake(bd, mvf, s, j)) out.push(i * 256 + j); break; }
            rr += dr; cc += dc;
          }
        }
      } else if (t === C) {
        for (k = 0; k < 4; k++) {
          dr = ORTH[k][0]; dc = ORTH[k][1]; rr = r + dr; cc = c + dc;
          var screen = false;
          while (inBoard(rr, cc)) {
            j = rr * COLS + cc; q = bd[j];
            if (!screen) {
              if (!q) out.push(i * 256 + j);
              else screen = true;
            } else if (q) {
              if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
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
          if (bd[(r + h[2]) * COLS + (c + h[3])]) continue;         // 蹩马腿
          j = rr * COLS + cc;
          if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
        }
      } else if (t === B) {
        for (k = 0; k < 4; k++) {
          rr = r + D2[k][0]; cc = c + D2[k][1];
          if (!inBoard(rr, cc)) continue;
          if (!inHome(s, rr, cc)) continue;                          // 象不过河
          if (bd[(r + D1[k][0]) * COLS + (c + D1[k][1])]) continue;   // 塞象眼
          j = rr * COLS + cc;
          if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
        }
      } else if (t === A) {
        for (k = 0; k < 4; k++) {
          rr = r + D1[k][0]; cc = c + D1[k][1];
          if (!inBoard(rr, cc) || !inPalace(s, rr, cc)) continue;
          j = rr * COLS + cc;
          if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
        }
      } else if (t === K) {
        for (k = 0; k < 4; k++) {
          rr = r + ORTH[k][0]; cc = c + ORTH[k][1];
          if (!inBoard(rr, cc) || !inPalace(s, rr, cc)) continue;
          j = rr * COLS + cc;
          if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
        }
        // 照面将：同行/同列、中间无子 → 可直取对方将帅（四方通用）
        for (k = 0; k < 4; k++) {
          dr = ORTH[k][0]; dc = ORTH[k][1];
          rr = r + dr; cc = c + dc;
          while (inBoard(rr, cc)) {
            q = bd[rr * COLS + cc];
            if (q) {
              if (sideOf(q) !== s && typeOf(q) === K) out.push(i * 256 + rr * COLS + cc);
              break;
            }
            rr += dr; cc += dc;
          }
        }
      } else if (t === P) {
        var f = FWD[s];
        rr = r + f[0]; cc = c + f[1];
        if (inBoard(rr, cc)) {
          j = rr * COLS + cc;
          if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
        }
        if (crossed(s, r, c)) {                                     // 过河才能横走
          if (f[0] === 0) {                                         // 青/蓝：横=上下
            for (k = -1; k <= 1; k += 2) {
              rr = r + k;
              if (!inBoard(rr, c)) continue;
              j = rr * COLS + c;
              if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
            }
          } else {                                                  // 红/黑：横=左右
            for (k = -1; k <= 1; k += 2) {
              cc = c + k;
              if (!inBoard(r, cc)) continue;
              j = r * COLS + cc;
              if (canTake(bd, mvf, s, j)) out.push(i * 256 + j);
            }
          }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------- 被攻击判定
  // 马：攻击者相对目标点的偏移 + 马腿相对目标点的偏移
  var NATK = [[-2, -1, -1, -1], [2, -1, 1, -1], [-2, 1, -1, 1], [2, 1, 1, 1],
              [-1, -2, -1, -1], [-1, 2, -1, 1], [1, -2, 1, -1], [1, 2, 1, 1]];

  /** sq 是否被 by 方攻击（用于判将；将帅本身永远可被吃） */
  function attacked(bd, sq, by) {
    var r = (sq / COLS) | 0, c = sq % COLS, k, dr, dc, rr, cc, q, t;
    // 车 / 炮 / 照面将
    for (k = 0; k < 4; k++) {
      dr = ORTH[k][0]; dc = ORTH[k][1];
      rr = r + dr; cc = c + dc;
      var screen = false;
      while (inBoard(rr, cc)) {
        q = bd[rr * COLS + cc];
        if (q) {
          if (!screen) {
            if (sideOf(q) === by) {
              t = typeOf(q);
              if (t === R) return true;
              if (t === K) return true;            // 照面（同行/同列、中间无子）
            }
            screen = true;
          } else {
            if (sideOf(q) === by && typeOf(q) === C) return true;
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
      if (bd[ar * COLS + ac] !== mk(by, N)) continue;
      var lr = r + h[2], lc = c + h[3];
      if (inBoard(lr, lc) && bd[lr * COLS + lc]) continue;      // 被蹩腿
      return true;
    }
    // 兵/卒：反推攻击者所在格（正前方推进 + 过河后的横走）
    var f = FWD[by];
    for (k = 0; k < 4; k++) {
      dr = ORTH[k][0]; dc = ORTH[k][1];
      rr = r - dr; cc = c - dc;
      if (!inBoard(rr, cc)) continue;
      if (bd[rr * COLS + cc] !== mk(by, P)) continue;
      if (dr === f[0] && dc === f[1]) return true;
      if (f[0] * dr + f[1] * dc === 0 && crossed(by, rr, cc)) return true;
    }
    return false;
  }

  /** 该方是否还在盘上（九宫里还有将帅） */
  function sideAlive(bd, s) { return kingSquare(bd, s) >= 0; }

  /** 找某方的将帅（九宫内 9 格），不在则返回 -1（该方已出局） */
  function kingSquare(bd, s) {
    var p = PAL[s], r, c;
    for (r = p[0]; r <= p[0] + 2; r++)
      for (c = p[1]; c <= p[1] + 2; c++)
        if (bd[r * COLS + c] === mk(s, K)) return r * COLS + c;
    return -1;
  }

  /** s 方是否被将军（被任意存活的他方攻击） */
  function inCheck(bd, s) {
    var ks = kingSquare(bd, s);
    if (ks < 0) return false;
    for (var i = 0; i < 4; i++) {
      if (i === s) continue;
      if (attacked(bd, ks, i)) return true;
    }
    return false;
  }
  /** 哪些方正在攻击 s 方的将帅 */
  function checkers(bd, s) {
    var ks = kingSquare(bd, s), out = [];
    if (ks < 0) return out;
    for (var i = 0; i < 4; i++) {
      if (i !== s && attacked(bd, ks, i)) out.push(i);
    }
    return out;
  }

  // ------------------------------------------------------------ 走子/撤销
  // 撤销信息打包成一个 int：cap(5bit) | movedFrom<<5 | movedTo<<10
  function makeMove(bd, mvf, mv) {
    var from = mv >> 8, to = mv & 255;
    var u = bd[to] | (mvf[from] << 5) | (mvf[to] << 10);
    bd[to] = bd[from];
    bd[from] = 0;
    mvf[to] = 1;                    // 走出去了就算动过（退回来也算）
    mvf[from] = 0;
    return u;
  }
  function unmakeMove(bd, mvf, mv, u) {
    var from = mv >> 8, to = mv & 255;
    bd[from] = bd[to];
    bd[to] = u & 31;
    mvf[from] = (u >> 5) & 31;
    mvf[to] = (u >> 10) & 31;
  }

  /** 完全合法着法（过滤掉走完后自己被将军的） */
  function legalMoves(bd, mvf, s) {
    var ps = genMoves(bd, mvf, s, []), out = [], i, u;
    for (i = 0; i < ps.length; i++) {
      u = makeMove(bd, mvf, ps[i]);
      if (!inCheck(bd, s)) out.push(ps[i]);
      unmakeMove(bd, mvf, ps[i], u);
    }
    return out;
  }

  /**
   * 走完这一步之后，会把哪些方将死／困毙（返回出局的阵营数组）。
   * 象棋里困毙（无着可走）同样判负，所以不再要求「正被将军」。
   */
  function matedSides(bd, mvf, mover, mv) {
    var u = makeMove(bd, mvf, mv), out = [], s;
    for (s = 0; s < 4; s++) {
      if (s === mover) continue;
      if (kingSquare(bd, s) < 0) continue;             // 已经出局了
      if (legalMoves(bd, mvf, s).length === 0) out.push(s);
    }
    unmakeMove(bd, mvf, mv, u);
    return out;
  }

  /** 把出局方的棋子从盘上撤掉（用户选定的规则），返回被撤掉的子数 */
  function removeSide(bd, mvf, s) {
    var n = 0;
    for (var i = 0; i < NSQ; i++) {
      if (bd[i] && sideOf(bd[i]) === s) { bd[i] = 0; mvf[i] = 0; n++; }
    }
    return n;
  }

  // ---------------------------------------------------------------- 评估
  // 表按「本方视角、row 9 = 本方底线」编写（沿用 2 人版，四方共用）
  var RAW = {
    R: [
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
    N: [
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
    B: [
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
    A: [
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
    K: [
      [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]
    ],
    C: [
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
    P: [
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
  var BASE = new Int16Array(8);
  BASE[K] = 0; BASE[A] = 20; BASE[B] = 20; BASE[R] = 0;
  BASE[N] = 0; BASE[C] = 0; BASE[P] = 12;
  var PST = [null, null, null, null, null, null, null, null];
  (function () {
    var m = { R: R, N: N, B: B, A: A, K: K, C: C, P: P };
    for (var name in RAW) PST[m[name]] = Int16Array.from([].concat.apply([], RAW[name]));
  })();

  var MVAL = new Int16Array(8);
  MVAL[K] = 1000; MVAL[A] = 22; MVAL[B] = 22; MVAL[R] = 200;
  MVAL[N] = 92; MVAL[C] = 96; MVAL[P] = 30;

  /** 把格子折到「本方视角」：lr = 离本方底线的距离，lc = 沿本方正面线的位置 */
  function localOf(s, r, c) {
    var lr, lc;
    if (s === RED) { lr = 9 - r; lc = c - 4; }
    else if (s === BLACK) { lr = r; lc = c - 4; }
    else if (s === GREEN) { lr = c; lc = r - 1; }
    else { lr = 17 - c; lc = r; }
    if (lr > 9) lr = 9; else if (lr < 0) lr = 0;
    if (lc < 0) lc = 0; else if (lc > 8) lc = 8;
    return (9 - lr) * 9 + lc;
  }

  // 预算 4x180 的 PST 下标表，省掉评估里逐子做 localOf 的分支
  var PIDX = [];
  (function () {
    for (var s = 0; s < 4; s++) {
      var a = new Int16Array(NSQ);
      for (var i = 0; i < NSQ; i++) a[i] = localOf(s, (i / COLS) | 0, i % COLS);
      PIDX.push(a);
    }
  })();

  /** root 视角的分数：自家子力权重 3 倍（一打三，自然要更看重自己的子）
   *  出局阵营由搜索增量维护（DEAD），这里不再每次扫九宫。 */
  function evaluate(bd, mvf, root) {
    if (DEAD[root]) return -MATE;
    var tot = [0, 0, 0, 0], i, p, t, s, v;
    for (i = 0; i < NSQ; i++) {
      p = bd[i];
      if (!p) continue;
      s = (p >> 3) & 3;
      if (DEAD[s]) continue;              // 已出局阵营的残子不计分
      t = p & 7;
      v = PST[t][PIDX[s][i]] + BASE[t];
      tot[s] += v;
    }
    var sc = 3 * tot[root];
    for (s = 0; s < 4; s++) if (s !== root) sc -= tot[s];
    return sc;
  }
  var DEAD = [false, false, false, false];
  /** 按当前盘面刷新「出局掩码」。evaluate 依赖它（搜索内部会增量维护），
   *  外部若在 think 之后直接调用 evaluate，请先调一次本函数。 */
  function syncDead(bd) {
    for (var q = 0; q < 4; q++) DEAD[q] = kingSquare(bd, q) < 0;
  }

  // ---------------------------------------------------------------- 搜索
  var killers = [];
  for (var _i = 0; _i < 80; _i++) killers.push([-1, -1]);
  var history = new Int32Array(NSQ * 256);
  var nodes = 0, abortAt = 0, aborted = false;
  var ORD = new Int32Array(1024);       // 单方着法数上限（四家盘面上限也就 300 出头）
  // 每层一个复用的着法数组：搜索一秒钟要过几十万个节点，逐个 new Array 会把 GC 压垮
  var MVPOOL = [];
  for (var _p = 0; _p < 80; _p++) MVPOOL.push([]);

  function scoreMoves(bd, moves, ply) {
    var n = moves.length, i, j, mv, cap, sc, kidx = ply < 80 ? ply : 79;
    var kl = killers[kidx];
    if (n > ORD.length) throw new Error("着法数超出 ORD 容量: " + n);
    for (i = 0; i < n; i++) {
      mv = moves[i];
      cap = bd[mv & 255];
      if (cap) sc = 1e6 + MVAL[typeOf(cap)] * 16 - MVAL[typeOf(bd[mv >> 8])];
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

  /**
   * 偏执搜索（paranoid）：root 方取最大，其余三方一律取最小。
   * 返回 root 视角的分数。
   */
  function search(bd, mvf, depth, alpha, beta, s, root, ply) {
    if (aborted) return alpha;
    if ((++nodes & 1023) === 0 && Date.now() > abortAt) { aborted = true; return alpha; }
    if (DEAD[root]) return -(MATE - ply);                    // 自己的将被吃 → 输

    // 已出局的阵营直接跳过（残子留在盘上只当障碍物，不再走子）
    var guard = 0;
    while (DEAD[s]) {
      s = NEXT[s];
      if (s === root || ++guard > 4) return evaluate(bd, mvf, root);   // 只剩自己了
    }
    if (depth <= 0) return evaluate(bd, mvf, root);

    var kidx = ply < 80 ? ply : 79;
    var moves = MVPOOL[kidx];
    moves.length = 0;
    genMoves(bd, mvf, s, moves);
    if (!moves.length) return (s === root) ? -(MATE - ply) : (ELIM_WIN - ply);
    scoreMoves(bd, moves, ply);

    var i, u, v, mv, best, cut = false, played = 0, killed = -1, wasDead = false;
    var maxing = (s === root);
    best = maxing ? -INF : INF;
    for (i = 0; i < moves.length; i++) {
      mv = moves[i];
      u = makeMove(bd, mvf, mv);
      if (inCheck(bd, s)) { unmakeMove(bd, mvf, mv, u); continue; }   // 自己送将，跳过
      played++;
      // 把对方的将帅吃掉 = 这一家出局（子树里它的残子不再计分）
      var cap = u & 31;
      killed = -1;
      if (cap && (cap & 7) === K) { killed = (cap >> 3) & 3; wasDead = DEAD[killed]; DEAD[killed] = true; }
      v = search(bd, mvf, depth - 1, alpha, beta, NEXT[s], root, ply + 1);
      if (killed >= 0) DEAD[killed] = wasDead;
      unmakeMove(bd, mvf, mv, u);
      if (aborted) return best > -INF && best < INF ? best : alpha;
      if (maxing) {
        if (v > best) best = v;
        if (v > alpha) {
          alpha = v;
          if (alpha >= beta) {
            cut = true;
            if (!(u & 31)) { var kl = killers[kidx]; if (kl[0] !== mv) { kl[1] = kl[0]; kl[0] = mv; } history[mv] += depth * depth; }
            break;
          }
        }
      } else {
        if (v < best) best = v;
        if (v < beta) {
          beta = v;
          if (alpha >= beta) { cut = true; break; }
        }
      }
    }
    // 一个合法着法都没有 --- 将死或困毙
    if (!played) return (s === root) ? -(MATE - ply) : (ELIM_WIN - ply);
    return best;
  }

  /**
   * 「本该能吃、却被"未动过的子不可吃"挡下来」的着法。
   * 做法：把所有格子的 moved 标志当成 1 再算一遍合法着法，减去真正的合法着法。
   * 只给界面做提示用，不参与搜索。
   */
  function blockedByRule(bd, mvf, s) {
    var all = new Int8Array(NSQ);
    all.fill(1);
    var a = legalMoves(bd, all, s), b = legalMoves(bd, mvf, s);
    var hit = {}, i;
    for (i = 0; i < b.length; i++) hit[b[i]] = 1;
    var out = [];
    for (i = 0; i < a.length; i++) if (!hit[a[i]]) out.push(a[i]);
    return out;
  }

  function posKey(bd) {
    var out = '', i, p;
    for (i = 0; i < NSQ; i++) { p = bd[i]; out += p ? String.fromCharCode(64 + p) : '.'; }
    return out;
  }

  /** 局面键（含 moved 标志）—— 判重复局面用，光看棋子摆位不够 */
  function stateKey(bd, mvf) {
    return posKey(bd) + '|' + mvf.join('');
  }

  /**
   * 思考并给出着法
   * opts: { depth, slack, budget, seen:Set<posKey>, rnd }
   * 返回 { move, pool, value, depth, nodes, ms }；无合法着法时 move 为 null
   */
  function think(bd, mvf, s, opts) {
    opts = opts || {};
    var maxDepth = opts.depth || 4;
    var slack = opts.slack == null ? 40 : opts.slack;
    var budget = opts.budget || 1200;
    var seen = opts.seen || null;
    var t0 = Date.now();

    nodes = 0; aborted = false; abortAt = t0 + budget;
    for (var z = 0; z < history.length; z++) history[z] = 0;
    syncDead(bd);

    var legal = legalMoves(bd, mvf, s);
    if (!sideAlive(bd, s) || !legal.length) {
      return { move: null, pool: [], value: 0, depth: 0, nodes: 0, ms: 0 };
    }

    var result = null, prevBest = -1;
    for (var d = 1; d <= maxDepth; d++) {
      if (prevBest >= 0) {
        var pos = legal.indexOf(prevBest);
        if (pos > 0) { legal.splice(pos, 1); legal.unshift(prevBest); }
      }
      var bv = -INF, cands = [], i, mv, u, v;
      for (i = 0; i < legal.length; i++) {
        mv = legal[i];
        u = makeMove(bd, mvf, mv);
        v = search(bd, mvf, d - 1, bv - slack, INF, NEXT[s], s, 1);
        unmakeMove(bd, mvf, mv, u);
        if (aborted) break;
        if (v > bv - slack) {
          if (v > bv) bv = v;
          cands.push([mv, v]);
        }
      }
      if (aborted) break;
      if (!cands.length) break;

      cands.sort(function (a, b) { return b[1] - a[1]; });
      var best = cands[0][1], pool = [], k, key;
      for (k = 0; k < cands.length; k++) {
        if (cands[k][1] < best - slack) break;
        mv = cands[k][0];
        if (seen) {
          u = makeMove(bd, mvf, mv);
          key = stateKey(bd, mvf);
          unmakeMove(bd, mvf, mv, u);
          if (seen.has(key)) continue;
        }
        pool.push(mv);
      }
      if (!pool.length) {
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
  var C4 = {
    COLS: COLS, ROWS: ROWS, NSQ: NSQ,
    RED: RED, BLACK: BLACK, GREEN: GREEN, YELLOW: YELLOW,
    ORDER: ORDER, NEXT: NEXT, SIDE_NAME: SIDE_NAME,
    K: K, A: A, B: B, R: R, N: N, C: C, P: P,
    INF: INF, MATE: MATE, ELIM_WIN: ELIM_WIN,
    mk: mk, sideOf: sideOf, typeOf: typeOf, idx: idx, rowOf: rowOf, colOf: colOf,
    inBoard: inBoard, crossed: crossed, inHome: inHome, inPalace: inPalace,
    initialBoard: initialBoard,
    genMoves: genMoves, legalMoves: legalMoves,
    blockedCapture: blockedCapture, blockedByRule: blockedByRule,
    attacked: attacked, inCheck: inCheck, checkers: checkers,
    kingSquare: kingSquare, sideAlive: sideAlive,
    makeMove: makeMove, unmakeMove: unmakeMove,
    matedSides: matedSides, removeSide: removeSide,
    evaluate: evaluate, think: think, posKey: posKey, stateKey: stateKey, syncDead: syncDead,
    moveFrom: function (mv) { return mv >> 8; },
    moveTo: function (mv) { return mv & 255; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = C4;
  global.C4 = C4;
})(typeof window !== 'undefined' ? window : globalThis);
