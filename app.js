import { Chess } from './vendor/chess.js';

/* ================= Engine ================= */

class Engine {
  constructor() {
    this.worker = new Worker('vendor/stockfish.js');
    this.listeners = [];
    this.queue = Promise.resolve();
    this.worker.onmessage = e => {
      const line = typeof e.data === 'string' ? e.data : '';
      for (const l of [...this.listeners]) l(line);
    };
    this.ready = this.send('uci', l => l === 'uciok').then(() => this.send('isready', l => l === 'readyok'));
  }

  send(text, isDone) {
    return new Promise(resolve => {
      const h = line => {
        if (isDone(line)) { this.listeners = this.listeners.filter(x => x !== h); resolve(line); }
      };
      this.listeners.push(h);
      this.worker.postMessage(text);
    });
  }

  // Returns the score from the side-to-move's perspective plus the best move (UCI).
  analyse(fen, depth) {
    const run = () => new Promise(resolve => {
      let last = { cp: 0, mate: null };
      const h = line => {
        if (line.startsWith('info') && line.includes(' score ') && !/bound/.test(line)) {
          const m = line.match(/score (cp|mate) (-?\d+)/);
          if (m) last = m[1] === 'cp' ? { cp: +m[2], mate: null } : { cp: null, mate: +m[2] };
        } else if (line.startsWith('bestmove')) {
          this.listeners = this.listeners.filter(x => x !== h);
          const best = line.split(' ')[1];
          resolve({ ...last, best: best && best !== '(none)' ? best : null });
        }
      };
      this.listeners.push(h);
      this.worker.postMessage('position fen ' + fen);
      this.worker.postMessage('go depth ' + depth);
    });
    const p = this.queue.then(() => this.ready).then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

let engine = null;

/* ================= Chess helpers ================= */

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const MATE_CP = 10000;

// Convert a side-to-move score to a White-perspective evaluation.
function toWhite(res, turn) {
  const s = turn === 'w' ? 1 : -1;
  if (res.mate != null) {
    const mate = res.mate * s;
    return { cp: mate > 0 ? MATE_CP - mate * 10 : -MATE_CP - mate * 10, mate, best: res.best };
  }
  return { cp: res.cp * s, mate: null, best: res.best };
}

// Win probability for White, 0..100 (lichess formula).
function winPct(e) {
  if (e.mate != null) return e.cp > 0 ? 100 : 0;
  const cp = Math.max(-1000, Math.min(1000, e.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function fmtEval(e) {
  if (!e) return '';
  if (e.mate != null) {
    if (e.mate === 0) return e.cp > 0 ? '1-0' : '0-1';
    return (e.mate > 0 ? '+' : '−') + 'M' + Math.abs(e.mate);
  }
  const v = e.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}

function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

function tryMove(fen, uci) {
  if (!uci) return null;
  try { return new Chess(fen).move(uciToMove(uci)); } catch { return null; }
}

function phaseOf(fen, moveNumber) {
  if (moveNumber <= 10) return 'opening';
  let total = 0, queens = 0;
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if (t === 'q') queens++;
    if ('nbrq'.includes(t)) total += VALUE[t];
  }
  return total <= 20 || (queens === 0 && total <= 26) ? 'endgame' : 'middlegame';
}

const PHASES = { opening: 'Дебют', middlegame: 'Миттельшпиль', endgame: 'Эндшпиль' };

const TYPES = {
  hungMoved:    { label: 'Поставил фигуру под бой',     short: 'Фигура под боем' },
  hungPiece:    { label: 'Оставил фигуру без защиты',   short: 'Фигура без защиты' },
  hungPawn:     { label: 'Отдал пешку',                 short: 'Отдал пешку' },
  oppTactic:    { label: 'Не заметил тактику соперника', short: 'Тактика соперника' },
  allowedMate:  { label: 'Пропустил угрозу мата',       short: 'Угроза мата' },
  missedMate:   { label: 'Упустил мат',                 short: 'Упустил мат' },
  missedTactic: { label: 'Упустил свою тактику',        short: 'Своя тактика' },
  positional:   { label: 'Слабый ход без явной тактики', short: 'Позиционная' },
};

const CLS = {
  blunder:    { label: 'Зевок',    mark: '??', color: 'var(--blunder)' },
  mistake:    { label: 'Ошибка',   mark: '?',  color: 'var(--mistake)' },
  inaccuracy: { label: 'Неточность', mark: '?!', color: 'var(--inacc)' },
};

/* ================= Parsing ================= */

function parseClocks(pgn) {
  const out = [];
  const re = /\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g;
  let m;
  while ((m = re.exec(pgn))) out.push(+m[1] * 3600 + +m[2] * 60 + +m[3]);
  return out;
}

function openingFromHeaders(h) {
  let name = h.Opening || '';
  if (!name && h.ECOUrl) {
    name = decodeURIComponent(h.ECOUrl.split('/').pop() || '').replace(/-\d.*$/, '').replace(/-/g, ' ');
  }
  name = name.trim() || (h.ECO ? 'ECO ' + h.ECO : 'Неизвестный дебют');
  const words = name.split(/[\s:,]+/);
  const idx = words.findIndex(w => /^(Defense|Defence|Game|Opening|Attack|Gambit|System|Countergambit)$/i.test(w));
  const family = idx >= 0 && idx < 5 ? words.slice(0, idx + 1).join(' ') : words.slice(0, 3).join(' ');
  return { name, family };
}

function resultFor(color, headerResult) {
  if (headerResult === '1/2-1/2') return 'd';
  if (headerResult === '1-0') return color === 'w' ? 'w' : 'l';
  if (headerResult === '0-1') return color === 'b' ? 'w' : 'l';
  return 'd';
}

function parseGame(pgn, username, meta = {}) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const h = chess.getHeaders();
  const hist = chess.history({ verbose: true });
  if (!hist.length) return null;

  const user = (username || '').toLowerCase();
  let userColor = 'w';
  if (user && (h.Black || '').toLowerCase() === user) userColor = 'b';

  const tc = h.TimeControl || '';
  const daily = tc.includes('/') || meta.timeClass === 'daily';
  const [base, inc] = daily ? [0, 0] : tc.split('+').map(Number);
  const clocks = daily ? [] : parseClocks(pgn);

  const moves = hist.map((m, i) => {
    const clock = clocks[i];
    const prev = i >= 2 ? clocks[i - 2] : base;
    const spent = clock != null && prev != null && !Number.isNaN(prev) ? Math.max(0, prev - clock + (inc || 0)) : null;
    return {
      san: m.san, uci: m.from + m.to + (m.promotion || ''), from: m.from, to: m.to,
      color: m.color, before: m.before, after: m.after, piece: m.piece, captured: m.captured,
      number: Math.floor(i / 2) + 1, clock, spent,
    };
  });

  const termination = h.Termination || '';
  const date = meta.endTime ? new Date(meta.endTime * 1000) : (h.Date ? new Date(h.Date.replace(/\./g, '-')) : null);
  const opening = openingFromHeaders(h);

  return {
    id: meta.url || h.Link || hashStr(pgn),
    url: meta.url || h.Link || null,
    white: h.White || 'Белые', black: h.Black || 'Чёрные',
    whiteElo: h.WhiteElo || '', blackElo: h.BlackElo || '',
    userColor,
    result: resultFor(userColor, h.Result),
    lostOnTime: meta.userResult ? meta.userResult === 'timeout' : /time/i.test(termination) && resultFor(userColor, h.Result) === 'l',
    timeClass: meta.timeClass || '',
    base: base || 0,
    date,
    opening,
    moves,
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'pgn:' + (h >>> 0).toString(36);
}

/* ================= Fetching ================= */

async function getJSON(url) {
  const r = await fetch(url);
  if (r.status === 404) throw new Error('not-found');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchChessCom(username, count, timeClass, onStatus) {
  let archives;
  try {
    archives = (await getJSON(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`)).archives || [];
  } catch (e) {
    if (e.message === 'not-found') throw new Error(`Игрок «${username}» не найден на chess.com.`);
    throw new Error('Не удалось загрузить партии с chess.com. Проверьте интернет и попробуйте ещё раз.');
  }
  const out = [];
  for (const url of archives.slice().reverse().slice(0, 24)) {
    onStatus(`Загружаю партии: ${url.split('/').slice(-2).join('.')}…`);
    const { games = [] } = await getJSON(url);
    games
      .filter(g => g.rules === 'chess' && g.pgn && (timeClass === 'all' || g.time_class === timeClass))
      .sort((a, b) => b.end_time - a.end_time)
      .forEach(g => { if (out.length < count) out.push(g); });
    if (out.length >= count) break;
  }
  const parsed = [];
  for (const g of out) {
    const isWhite = g.white.username.toLowerCase() === username.toLowerCase();
    try {
      const game = parseGame(g.pgn, username, {
        url: g.url, endTime: g.end_time, timeClass: g.time_class,
        userResult: (isWhite ? g.white : g.black).result,
      });
      if (game) parsed.push(game);
    } catch { /* skip unparsable game */ }
  }
  return parsed;
}

function splitPgn(text) {
  return text.split(/(?=^\s*\[Event )/m).map(s => s.trim()).filter(Boolean);
}

/* ================= Analysis ================= */

const CACHE_VER = 'sfa:v1';
function cacheGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function cacheSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked */ } }

let stopRequested = false;

async function evaluateGame(game, depth, onPos) {
  const key = `${CACHE_VER}:${depth}:${game.id}`;
  const cached = cacheGet(key);
  if (cached && cached.length === game.moves.length + 1) return cached;

  const fens = [game.moves[0].before, ...game.moves.map(m => m.after)];
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    if (stopRequested) return null;
    const c = new Chess(fens[i]);
    if (c.isCheckmate()) evals.push({ cp: c.turn() === 'w' ? -MATE_CP : MATE_CP, mate: 0, best: null });
    else if (c.isStalemate() || c.isInsufficientMaterial()) evals.push({ cp: 0, mate: null, best: null });
    else evals.push(toWhite(await engine.analyse(fens[i], depth), c.turn()));
    onPos(i + 1, fens.length);
  }
  cacheSet(key, evals);
  return evals;
}

function annotate(game, evals) {
  game.evals = evals;
  game.moves.forEach((m, i) => {
    const eb = evals[i], ea = evals[i + 1];
    const s = m.color === 'w' ? 1 : -1;
    const wb = m.color === 'w' ? winPct(eb) : 100 - winPct(eb);
    const wa = m.color === 'w' ? winPct(ea) : 100 - winPct(ea);
    m.winBefore = wb;
    m.winAfter = wa;
    m.loss = m.uci === eb.best ? 0 : Math.max(0, wb - wa);
    m.isBest = m.uci === eb.best;
    m.accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * m.loss) - 3.1669));
    m.cls = m.loss >= 20 ? 'blunder' : m.loss >= 12 ? 'mistake' : m.loss >= 7 ? 'inaccuracy' : null;
    m.phase = phaseOf(m.before, m.number);
    m.bestSan = eb.best ? tryMove(m.before, eb.best)?.san : null;
    m.bestEval = eb;
    const reply = tryMove(m.after, ea.best);
    m.replySan = reply?.san || null;
    m.replyUci = ea.best;
    m.type = m.cls === 'blunder' || m.cls === 'mistake' ? errorType(m, eb, ea, s, reply) : null;
  });
  const mine = game.moves.filter(m => m.color === game.userColor);
  game.accuracy = mine.length ? mine.reduce((a, m) => a + m.accuracy, 0) / mine.length : 0;
  game.blunders = mine.filter(m => m.cls === 'blunder').length;
  game.mistakes = mine.filter(m => m.cls === 'mistake').length;
  game.hadWinning = mine.some(m => m.winAfter >= 85);
  return game;
}

function errorType(m, eb, ea, s, reply) {
  const mateForMeBefore = eb.mate != null && eb.mate * s > 0;
  const mateAgainstBefore = eb.mate != null && eb.mate * s < 0;
  const mateForMeAfter = ea.mate != null && ea.mate * s > 0;
  const mateAgainstAfter = ea.mate != null && ea.mate * s < 0;
  if (mateAgainstAfter && !mateAgainstBefore) return 'allowedMate';
  if (mateForMeBefore && !mateForMeAfter) return 'missedMate';

  if (reply) {
    if (reply.captured && VALUE[reply.captured] >= 3) return reply.to === m.to ? 'hungMoved' : 'hungPiece';
    const c = new Chess(reply.after);
    let attacked = 0;
    for (const row of c.board()) for (const sq of row) {
      if (sq && sq.color === m.color && (VALUE[sq.type] >= 3 || sq.type === 'k') && c.attackers(sq.square, reply.color).includes(reply.to)) attacked++;
    }
    if (attacked >= 2 || reply.san.includes('+')) return 'oppTactic';
  }
  const best = tryMove(m.before, eb.best);
  if (best && ((best.captured && VALUE[best.captured] >= 3) || /[+#]/.test(best.san))) return 'missedTactic';
  if (reply && reply.captured === 'p') return 'hungPawn';
  return 'positional';
}

/* ================= Stats & insights ================= */

function fastThreshold(base) { return Math.max(2, Math.min(10, Math.round(base / 60))); }

function computeStats(games) {
  const st = {
    games: games.length, w: 0, d: 0, l: 0, moves: 0, blunders: 0, mistakes: 0, inacc: 0,
    phase: {}, types: {}, fastBlunders: 0, timedBlunders: 0, troubleBlunders: 0,
    lostWinning: 0, timeLosses: 0, accuracy: 0, openings: {},
  };
  for (const p of Object.keys(PHASES)) st.phase[p] = { moves: 0, blunder: 0, mistake: 0 };
  for (const t of Object.keys(TYPES)) st.types[t] = { blunder: 0, mistake: 0 };

  for (const g of games) {
    st[g.result]++;
    st.accuracy += g.accuracy;
    if (g.hadWinning && g.result !== 'w') st.lostWinning++;
    if (g.result === 'l' && g.lostOnTime) st.timeLosses++;

    const key = g.userColor + '|' + g.opening.family;
    const o = st.openings[key] ||= { family: g.opening.family, color: g.userColor, n: 0, w: 0, d: 0, l: 0, acc: 0, blunders: 0 };
    o.n++; o[g.result]++; o.acc += g.accuracy; o.blunders += g.blunders;

    for (const m of g.moves) {
      if (m.color !== g.userColor) continue;
      st.moves++;
      st.phase[m.phase].moves++;
      if (m.cls === 'blunder') st.blunders++;
      if (m.cls === 'mistake') st.mistakes++;
      if (m.cls === 'inaccuracy') st.inacc++;
      if (m.cls === 'blunder' || m.cls === 'mistake') {
        st.phase[m.phase][m.cls]++;
        st.types[m.type][m.cls]++;
      }
      if (m.cls === 'blunder' && m.spent != null && g.base) {
        st.timedBlunders++;
        if (m.spent < fastThreshold(g.base)) st.fastBlunders++;
        if (m.clock != null && m.clock < Math.min(60, g.base * 0.1)) st.troubleBlunders++;
      }
    }
  }
  st.accuracy = games.length ? st.accuracy / games.length : 0;
  st.fastLabel = games.length ? fastThreshold(mode(games.map(g => g.base))) : 5;
  return st;
}

function mode(arr) {
  const c = {};
  let best = arr[0], n = 0;
  for (const x of arr) { c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; best = x; } }
  return best;
}

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

function buildInsights(st) {
  const out = [];
  const errors = st.blunders + st.mistakes;
  const hung = ['hungMoved', 'hungPiece', 'oppTactic', 'allowedMate']
    .reduce((a, t) => a + st.types[t].blunder + st.types[t].mistake, 0);

  if (errors && hung / errors >= 0.35) {
    out.push({
      score: hung / errors + 0.5,
      title: `${Math.round(hung / errors * 100)}% ваших ошибок: вы отдаёте фигуру или не видите угрозу соперника`,
      text: 'Это главный резерв роста. Перед каждым ходом спрашивайте: «Что атакует последний ход соперника?» и «Будет ли защищена фигура, которой я хожу?»',
    });
  }
  if (st.timedBlunders >= 3 && st.fastBlunders / st.timedBlunders >= 0.4) {
    out.push({
      score: st.fastBlunders / st.timedBlunders + 0.3,
      title: `${st.fastBlunders} из ${st.timedBlunders} зевков сделаны быстрее ${st.fastLabel} сек`,
      text: 'Вы ходите на автомате. Не ускоряйтесь в острых моментах: при любом взятии, шахе или угрозе остановитесь и проверьте ход ещё раз.',
    });
  }
  const rates = Object.entries(st.phase)
    .filter(([, p]) => p.moves >= 15)
    .map(([k, p]) => [k, (p.blunder + p.mistake) / p.moves * 100]);
  if (rates.length) {
    const [worst, rate] = rates.sort((a, b) => b[1] - a[1])[0];
    const advice = {
      opening: 'Выберите один дебют за белых и по одному ответу за чёрных. Соблюдайте принципы: центр, развитие фигур, рокировка.',
      middlegame: 'Решайте тактические задачи по 15–20 минут в день, медленно и точно. Главные мотивы: вилка, связка, двойной удар.',
      endgame: 'Поучите базовые эндшпили: мат ладьёй, оппозицию, правило квадрата. В эндшпиле активируйте короля.',
    }[worst];
    out.push({
      score: 0.6,
      title: `Больше всего ошибок в ${{ opening: 'дебюте', middlegame: 'миттельшпиле', endgame: 'эндшпиле' }[worst]}: ${rate.toFixed(1)} на 100 ходов`,
      text: advice,
    });
  }
  const missed = st.types.missedTactic.blunder + st.types.missedTactic.mistake + st.types.missedMate.blunder + st.types.missedMate.mistake;
  if (missed >= 2) {
    out.push({
      score: 0.4 + missed / Math.max(1, errors),
      title: `${missed} ${plural(missed, 'раз', 'раза', 'раз')} вы упустили свою тактику: выигрыш материала или мат`,
      text: 'Ищите не только угрозы соперника, но и свои возможности. Перед ходом переберите все шахи, взятия и угрозы.',
    });
  }
  if (st.lostWinning >= 1) {
    out.push({
      score: 0.5 + st.lostWinning / st.games,
      title: `В ${st.lostWinning} ${plural(st.lostWinning, 'партии', 'партиях', 'партиях')} у вас была выигранная позиция, но вы не выиграли`,
      text: 'Когда вы впереди по материалу, упрощайте: меняйте фигуры, не открывайте своего короля и не гонитесь за лишней пешкой.',
    });
  }
  if (st.timeLosses >= 2 || st.troubleBlunders >= 3) {
    out.push({
      score: 0.35 + st.timeLosses / st.games,
      title: st.timeLosses >= 2
        ? `${st.timeLosses} ${plural(st.timeLosses, 'поражение', 'поражения', 'поражений')} по времени`
        : `${st.troubleBlunders} ${plural(st.troubleBlunders, 'зевок', 'зевка', 'зевков')} в цейтноте`,
      text: 'Распределяйте время: в дебюте ходите быстрее по знакомым принципам, а время тратьте в критических позициях.',
    });
  }
  const bad = Object.values(st.openings)
    .filter(o => o.n >= 3)
    .map(o => ({ ...o, score: (o.w + o.d / 2) / o.n }))
    .sort((a, b) => a.score - b.score)[0];
  if (bad && bad.score < 0.4) {
    out.push({
      score: 0.3,
      title: `Слабый дебют: ${bad.family} за ${bad.color === 'w' ? 'белых' : 'чёрных'} (${Math.round(bad.score * 100)}% очков в ${bad.n} партиях)`,
      text: 'Посмотрите одно короткое видео по этому дебюту и разберите свои партии в нём: где именно у вас портится позиция.',
    });
  }
  if (!out.length) {
    out.push({ score: 0, title: 'Явных системных проблем не найдено', text: 'Проанализируйте больше партий, чтобы увидеть закономерности.' });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/* ================= Rendering: report ================= */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let analyzed = [];

function renderReport(games, username) {
  const st = computeStats(games);
  const ordered = [...games].sort((a, b) => (a.date || 0) - (b.date || 0));
  const elo = g => +(g.userColor === 'w' ? g.whiteElo : g.blackElo) || null;
  const first = elo(ordered[0]), last = elo(ordered[ordered.length - 1]);
  const diff = first && last ? last - first : null;

  $('#tiles').innerHTML = [
    tile('Партий', st.games, `${st.w} побед · ${st.d} ничьих · ${st.l} поражений`),
    tile('Средняя точность', st.accuracy.toFixed(1) + '%', 'по ходам, как в разборе chess.com'),
    tile('Зевков за партию', (st.blunders / st.games).toFixed(1), `и ещё ${(st.mistakes / st.games).toFixed(1)} ошибки`),
    last ? tile('Рейтинг', last, diff == null ? '' : `за эти партии: ${diff > 0 ? '+' : ''}${diff}`) : '',
  ].join('');

  $('#insights').innerHTML = buildInsights(st).map(i => `<li><b>${esc(i.title)}</b><span>${esc(i.text)}</span></li>`).join('');

  const phaseRows = Object.entries(st.phase).map(([k, p]) => ({
    label: PHASES[k],
    b: p.moves ? p.blunder / p.moves * 100 : 0,
    m: p.moves ? p.mistake / p.moves * 100 : 0,
    fmt: v => v.toFixed(1),
  }));
  $('#by-phase').innerHTML = bars(phaseRows);

  const typeRows = Object.entries(st.types)
    .map(([k, t]) => ({ label: TYPES[k].short, b: t.blunder, m: t.mistake, fmt: v => String(v) }))
    .filter(r => r.b + r.m > 0)
    .sort((a, b) => (b.b + b.m) - (a.b + a.m));
  $('#by-type').innerHTML = typeRows.length ? bars(typeRows) : '<p class="sub">Нет ошибок 🎉</p>';

  const openings = Object.values(st.openings).sort((a, b) => b.n - a.n);
  $('#openings').innerHTML = `
    <thead><tr><th>Дебют</th><th>Цвет</th><th>Партий</th><th>+ / = / −</th><th>Очки</th><th>Точность</th><th>Зевков/партию</th></tr></thead>
    <tbody>${openings.map(o => `
      <tr><td class="name">${esc(o.family)}</td><td>${o.color === 'w' ? '⚪ белые' : '⚫ чёрные'}</td><td>${o.n}</td>
      <td>${o.w} / ${o.d} / ${o.l}</td><td>${Math.round((o.w + o.d / 2) / o.n * 100)}%</td>
      <td>${(o.acc / o.n).toFixed(1)}%</td><td>${(o.blunders / o.n).toFixed(1)}</td></tr>`).join('')}
    </tbody>`;

  const byDate = [...games].sort((a, b) => (b.date || 0) - (a.date || 0));
  $('#games').innerHTML = `
    <thead><tr><th>Дата</th><th></th><th>Соперник</th><th>Итог</th><th>Дебют</th><th>Точность</th><th>Зевки / ошибки</th></tr></thead>
    <tbody>${byDate.map(g => {
      const opp = g.userColor === 'w' ? `${g.black} (${g.blackElo})` : `${g.white} (${g.whiteElo})`;
      return `<tr class="clickable" data-id="${esc(g.id)}">
        <td>${g.date ? g.date.toLocaleDateString('ru-RU') : ''}</td>
        <td title="${g.userColor === 'w' ? 'Вы играли белыми' : 'Вы играли чёрными'}">${g.userColor === 'w' ? '⚪' : '⚫'}</td>
        <td>${esc(opp)}</td>
        <td><span class="res ${g.result}">${{ w: '1', d: '½', l: '0' }[g.result]}</span></td>
        <td class="name">${esc(g.opening.family)}</td>
        <td>${g.accuracy.toFixed(1)}%</td>
        <td><span class="pill b ${g.blunders ? '' : 'zero'}">${g.blunders}</span> <span class="pill m ${g.mistakes ? '' : 'zero'}">${g.mistakes}</span></td>
      </tr>`;
    }).join('')}</tbody>`;
  $('#games').querySelectorAll('tr[data-id]').forEach(tr =>
    tr.addEventListener('click', () => openViewer(games.find(g => g.id === tr.dataset.id))));

  $('#report').classList.remove('hidden');
}

function tile(k, v, d) {
  return `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`;
}

function bars(rows) {
  const max = Math.max(...rows.map(r => r.b + r.m), 0.0001);
  return rows.map(r => `
    <div class="brow"><span>${esc(r.label)}</span>
      <div class="track">
        <div class="seg" style="width:${r.b / max * 100}%;background:var(--blunder)" title="Зевки: ${r.fmt(r.b)}"></div>
        <div class="seg" style="width:${r.m / max * 100}%;background:var(--mistake)" title="Ошибки: ${r.fmt(r.m)}"></div>
      </div>
      <span class="num">${r.fmt(r.b + r.m)}</span></div>`).join('')
    + `<div class="legend"><span><i style="background:var(--blunder)"></i>Зевки</span><span><i style="background:var(--mistake)"></i>Ошибки</span></div>`;
}

/* ================= Rendering: game viewer ================= */

const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟︎' };
const view = { game: null, ply: 0 };

function openViewer(game) {
  view.game = game;
  view.ply = 0;
  $('#report').classList.add('hidden');
  $('#form-card').classList.add('hidden');
  $('#viewer').classList.remove('hidden');

  const res = { w: 'победа', d: 'ничья', l: 'поражение' }[game.result];
  $('#viewer-title').innerHTML = `${esc(game.opening.name)} · ${res} · точность ${game.accuracy.toFixed(1)}%`
    + (game.url ? ` · <a href="${esc(game.url)}" target="_blank" rel="noopener">открыть на chess.com</a>` : '');
  const top = game.userColor === 'w' ? 'b' : 'w';
  const pl = c => c === 'w' ? `⚪ ${esc(game.white)} <small>${esc(game.whiteElo)}</small>` : `⚫ ${esc(game.black)} <small>${esc(game.blackElo)}</small>`;
  $('#player-top').innerHTML = pl(top);
  $('#player-bottom').innerHTML = pl(game.userColor);

  renderMoves();
  const firstErr = game.moves.findIndex(m => m.color === game.userColor && (m.cls === 'blunder' || m.cls === 'mistake'));
  goto(firstErr >= 0 ? firstErr + 1 : 0);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeViewer() {
  $('#viewer').classList.add('hidden');
  $('#report').classList.remove('hidden');
  $('#form-card').classList.remove('hidden');
  view.game = null;
}

function renderMoves() {
  const g = view.game;
  let html = '';
  g.moves.forEach((m, i) => {
    if (m.color === 'w') html += `<div class="no">${m.number}.</div>`;
    else if (i === 0) html += `<div class="no">${m.number}.</div><div class="mv"></div>`;
    const mark = m.cls ? `<span class="mark ${m.cls}">${CLS[m.cls].mark}</span>` : '';
    html += `<div class="mv" data-ply="${i + 1}">${esc(m.san)}${mark}</div>`;
  });
  $('#moves').innerHTML = html;
  $('#moves').querySelectorAll('.mv[data-ply]').forEach(el => el.addEventListener('click', () => goto(+el.dataset.ply)));
}

function goto(ply) {
  const g = view.game;
  view.ply = Math.max(0, Math.min(g.moves.length, ply));
  const m = view.ply ? g.moves[view.ply - 1] : null;
  const fen = m ? m.after : g.moves[0].before;
  renderBoard(fen, m);
  renderEval(g.evals[view.ply]);
  renderComment(m);
  $('#moves').querySelectorAll('.mv.cur').forEach(el => el.classList.remove('cur'));
  const cur = $(`#moves .mv[data-ply="${view.ply}"]`);
  if (cur) { cur.classList.add('cur'); cur.scrollIntoView({ block: 'nearest' }); }
}

function renderBoard(fen, m) {
  const flip = view.game.userColor === 'b';
  const board = new Chess(fen).board();
  const files = 'abcdefgh';
  let html = '';
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const rr = flip ? 7 - r : r, ff = flip ? 7 - f : f;
      const sq = files[ff] + (8 - rr);
      const p = board[rr][ff];
      const light = (rr + ff) % 2 === 0;
      const hl = m && (sq === m.from || sq === m.to) ? ' hl' : '';
      let inner = p ? `<span class="pc ${p.color}">${GLYPH[p.type]}</span>` : '';
      if (r === 7) inner += `<span class="coord f">${files[ff]}</span>`;
      if (f === 0) inner += `<span class="coord r">${8 - rr}</span>`;
      if (m && sq === m.to && m.cls) inner += `<span class="badge" style="background:${CLS[m.cls].color}">${CLS[m.cls].mark}</span>`;
      html += `<div class="sq ${light ? 'l' : 'd'}${hl}">${inner}</div>`;
    }
  }
  $('#board').innerHTML = html;

  // Arrows: green = best move instead of the played one, red = the opponent's refutation.
  const arrows = [];
  if (m && m.cls && !m.isBest && m.bestEval.best) arrows.push([m.bestEval.best, '#3d9a3d']);
  if (m && (m.cls === 'blunder' || m.cls === 'mistake') && m.replyUci) arrows.push([m.replyUci, '#d64545']);
  $('#arrows').innerHTML = `<defs>${['#3d9a3d', '#d64545'].map(c =>
    `<marker id="ah${c.slice(1)}" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 z" fill="${c}"/></marker>`).join('')}</defs>`
    + arrows.map(([uci, c]) => arrowSvg(uci, c, flip)).join('');
}

function arrowSvg(uci, color, flip) {
  const xy = sq => {
    let x = sq.charCodeAt(0) - 97 + 0.5, y = 8 - +sq[1] + 0.5;
    if (flip) { x = 8 - x; y = 8 - y; }
    return [x, y];
  };
  const [x1, y1] = xy(uci.slice(0, 2)), [x2, y2] = xy(uci.slice(2, 4));
  const len = Math.hypot(x2 - x1, y2 - y1), k = (len - 0.35) / len;
  return `<line x1="${x1}" y1="${y1}" x2="${x1 + (x2 - x1) * k}" y2="${y1 + (y2 - y1) * k}" stroke="${color}" stroke-width="0.16" stroke-linecap="round" opacity="0.8" marker-end="url(#ah${color.slice(1)})"/>`;
}

function renderEval(e) {
  const flip = view.game.userColor === 'b';
  const wp = winPct(e);
  const fill = $('#evalbar-fill'), bar = fill.parentElement, txt = $('#evalbar-text');
  fill.style.height = (flip ? 100 - wp : wp) + '%';
  fill.style.background = flip ? '#3a3a37' : '#f2f2ee';
  bar.style.background = flip ? '#f2f2ee' : '#3a3a37';
  txt.textContent = fmtEval(e).replace('+', '').replace('−', '');
  const bottomWinning = flip ? wp < 50 : wp >= 50;
  txt.className = bottomWinning ? '' : 'top';
  txt.style.color = (bottomWinning !== flip) ? '#555' : '#ddd';
}

const TYPE_TEXT = {
  hungMoved: m => `Фигура встала под бой. Соперник отвечает <b>${esc(m.replySan)}</b> и выигрывает материал.`,
  hungPiece: m => `После этого хода у вас остаётся незащищённая фигура. Соперник бьёт: <b>${esc(m.replySan)}</b>.`,
  hungPawn: m => `Вы отдаёте пешку: <b>${esc(m.replySan)}</b>.`,
  oppTactic: m => `Вы не увидели ответ соперника <b>${esc(m.replySan)}</b>: шах, вилка или двойной удар.`,
  allowedMate: m => `Теперь у соперника есть мат. Начинается с <b>${esc(m.replySan)}</b>.`,
  missedMate: m => `У вас был форсированный мат, начиная с <b>${esc(m.bestSan)}</b>.`,
  missedTactic: m => `Вы упустили сильный ход <b>${esc(m.bestSan)}</b>: он выигрывал материал или начинал атаку.`,
  positional: () => 'Явной тактики здесь нет, но ход заметно ухудшил позицию. Сравните с ходом движка.',
};

function renderComment(m) {
  const g = view.game;
  const el = $('#comment');
  if (!m) {
    el.innerHTML = `<h3>Начальная позиция</h3><p class="muted">Листайте ходы стрелками ← → или кнопкой «Следующая ошибка» (клавиша M).</p>`;
    return;
  }
  const mine = m.color === g.userColor;
  const who = mine ? 'Ваш ход' : 'Ход соперника';
  const num = `${m.number}${m.color === 'w' ? '.' : '…'} ${esc(m.san)}`;
  const time = m.spent != null ? ` · ${Math.round(m.spent)} с на ход` : '';
  const evalLine = `<p class="muted">Оценка: ${fmtEval(m.bestEval)} → ${fmtEval(g.evals[g.moves.indexOf(m) + 1])} · шансы ${Math.round(m.winBefore)}% → ${Math.round(m.winAfter)}%${time}</p>`;

  if (!m.cls) {
    const label = m.isBest ? 'Лучший ход' : 'Нормальный ход';
    el.innerHTML = `<h3>${num} <span class="tag" style="background:var(--good)">${label}</span></h3><p class="muted">${who}</p>${evalLine}`;
    return;
  }
  const c = CLS[m.cls];
  let body = '';
  if (m.type) body += `<p><b>${esc(TYPES[m.type].label)}.</b> ${TYPE_TEXT[m.type](m)}</p>`;
  if (m.bestSan && !m.isBest) body += `<p>Лучше было: <b style="color:#3d9a3d">${esc(m.bestSan)}</b> (зелёная стрелка)${m.type && m.replySan && m.type !== 'missedTactic' && m.type !== 'missedMate' ? ', угроза соперника показана красной' : ''}.</p>`;
  el.innerHTML = `<h3>${num} <span class="tag" style="background:${c.color}">${c.label}</span></h3><p class="muted">${who}</p>${body}${evalLine}`;
}

function nextMistake() {
  const g = view.game;
  for (let i = view.ply; i < g.moves.length; i++) {
    const m = g.moves[i];
    if (m.color === g.userColor && (m.cls === 'blunder' || m.cls === 'mistake')) return goto(i + 1);
  }
  const first = g.moves.findIndex(m => m.color === g.userColor && (m.cls === 'blunder' || m.cls === 'mistake'));
  if (first >= 0) goto(first + 1);
}

/* ================= Controller ================= */

let mode_ = 'chesscom';

function setProgress(label, frac) {
  $('#progress').classList.remove('hidden');
  $('#progress-label').textContent = label;
  $('#progress-fill').style.width = Math.round(frac * 100) + '%';
}

function showError(msg) {
  const el = $('#error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

async function run(e) {
  e.preventDefault();
  showError('');
  const username = $('#username').value.trim();
  const depth = +$('#depth').value;
  savePrefs();

  let games;
  $('#go').disabled = true;
  stopRequested = false;
  try {
    if (mode_ === 'chesscom') {
      if (!username) throw new Error('Введите ник на chess.com.');
      games = await fetchChessCom(username, +$('#count').value, $('#timeclass').value, s => setProgress(s, 0));
      if (!games.length) throw new Error('Не нашлось партий с такими настройками. Попробуйте другой контроль времени.');
    } else {
      const chunks = splitPgn($('#pgn').value);
      if (!chunks.length) throw new Error('Вставьте хотя бы одну партию в формате PGN.');
      games = chunks.map(p => { try { return parseGame(p, username); } catch { return null; } }).filter(Boolean);
      if (!games.length) throw new Error('Не удалось прочитать PGN. Проверьте формат.');
    }

    engine ||= new Engine();
    const total = games.reduce((a, g) => a + g.moves.length + 1, 0);
    let done = 0;
    analyzed = [];
    for (let gi = 0; gi < games.length; gi++) {
      const g = games[gi];
      const evals = await evaluateGame(g, depth, (i, n) => {
        setProgress(`Анализ партии ${gi + 1} из ${games.length} · позиция ${i} из ${n}`, (done + i) / total);
      });
      if (!evals) break;
      done += g.moves.length + 1;
      analyzed.push(annotate(g, evals));
    }
    if (!analyzed.length) throw new Error('Анализ остановлен до завершения первой партии.');
    setProgress(stopRequested ? `Остановлено: разобрано ${analyzed.length} из ${games.length}` : `Готово: разобрано ${analyzed.length} ${plural(analyzed.length, 'партия', 'партии', 'партий')}`, 1);
    renderReport(analyzed, username);
    $('#report').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showError(err.message || String(err));
    $('#progress').classList.add('hidden');
  } finally {
    $('#go').disabled = false;
  }
}

function savePrefs() {
  try {
    localStorage.setItem('sfa:prefs', JSON.stringify({
      username: $('#username').value.trim(), count: $('#count').value, timeclass: $('#timeclass').value, depth: $('#depth').value,
    }));
  } catch { /* ignore */ }
}

function loadPrefs() {
  const p = cacheGet('sfa:prefs');
  if (!p) return;
  if (p.username) $('#username').value = p.username;
  if (p.count) $('#count').value = p.count;
  if (p.timeclass) $('#timeclass').value = p.timeclass;
  if (p.depth) $('#depth').value = p.depth;
}

function setMode(m) {
  mode_ = m;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === m));
  document.querySelectorAll('.chesscom-only').forEach(el => el.classList.toggle('hidden', m !== 'chesscom'));
  document.querySelectorAll('.pgn-only').forEach(el => el.classList.toggle('hidden', m !== 'pgn'));
  $('#username').placeholder = m === 'pgn' ? 'ваш ник в PGN, чтобы определить цвет' : 'например, hikaru';
}

$('#form').addEventListener('submit', run);
$('#stop').addEventListener('click', () => { stopRequested = true; });
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.tab)));
$('#back').addEventListener('click', closeViewer);
document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
  const a = b.dataset.nav;
  if (a === 'start') goto(0);
  if (a === 'prev') goto(view.ply - 1);
  if (a === 'next') goto(view.ply + 1);
  if (a === 'end') goto(view.game.moves.length);
  if (a === 'mistake') nextMistake();
}));
document.addEventListener('keydown', e => {
  if (!view.game || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') { goto(view.ply - 1); e.preventDefault(); }
  if (e.key === 'ArrowRight') { goto(view.ply + 1); e.preventDefault(); }
  if (e.key === 'Home') goto(0);
  if (e.key === 'End') goto(view.game.moves.length);
  if (e.key.toLowerCase() === 'm' || e.key.toLowerCase() === 'ь') nextMistake();
  if (e.key === 'Escape') closeViewer();
});

loadPrefs();
