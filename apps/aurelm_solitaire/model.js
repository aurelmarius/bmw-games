'use strict';
/**
 * Solitaire (Klondike)'s rules, without drawing or the car (tested in tests/solitaire.test.js).
 *
 *   const g = new Game({ draw: 1 });          // or 3; { state } resumes a saved game
 *   g.drawStock()                             // turn cards from the stock (or the waste back over)
 *   g.move(from, n, to)                       // n cards from a pile to another, if the rules allow it
 *   g.auto(from, n)                           // the best move for those cards (a tap / a press)
 *   g.hint() / g.undo() / g.autoStep()
 *
 * Piles: { k: 'w' } the waste, { k: 'f', i } a foundation (0..3), { k: 't', i } a tableau column (0..6).
 * A card is { r: 1..13, s: 'S' | 'H' | 'D' | 'C', up, id }. Tableau: down by one in alternate colours, a
 * king (with what's on it) on an empty column; foundations: up from the ace, one per suit (spades, hearts,
 * diamonds, clubs, as printed on the table). The stock turns
 * one card or three at a time, the waste goes back over as often as wanted.
 *
 * Scoring as the classic game has it: waste to tableau 5, to a foundation 10, a tableau card turned over
 * 5, a card back from a foundation -15, the waste turned over again -100 (one at a time) or -20 (three);
 * never below 0. A win adds a bonus for speed: 700 000 / seconds (over 30 s).
 */
const SUITS = ['S', 'H', 'D', 'C'];
const red = (c) => c.s === 'H' || c.s === 'D';
const POINTS = { wasteTab: 5, toFound: 10, turn: 5, fromFound: -15 };
const RECYCLE = { 1: -100, 3: -20 };
const UNDO_MAX = 300;

function deck(rng) {
    const d = [];
    let id = 0;
    for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push({ r, s, up: false, id: id++ });
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.drawN = o.draw === 3 ? 3 : 1;
        this.history = [];
        this.events = [];
        if (o.state && o.state.tab) { Object.assign(this, clone(o.state)); this.drawN = o.state.drawN === 3 ? 3 : 1; return; }
        const d = deck(this.rng);
        this.tab = [];
        for (let i = 0; i < 7; i++) {
            const col = d.splice(0, i + 1);
            col[col.length - 1].up = true;
            this.tab.push(col);
        }
        this.stock = d;
        this.waste = [];
        this.found = [[], [], [], []];
        this.score = 0; this.moves = 0; this.recycles = 0;
        this.ms = 0;               // time played (main.js adds it while the game is on screen and going)
        this.started = false;
    }

    /* ---------- piles ---------- */
    pile(p) { return p.k === 'w' ? this.waste : p.k === 'f' ? this.found[p.i] : p.k === 't' ? this.tab[p.i] : this.stock; }
    top(p) { const a = this.pile(p); return a[a.length - 1]; }
    /** can these cards (bottom one c) go on pile `to`? */
    fits(cards, to) {
        const c = cards[0], a = this.pile(to), t = a[a.length - 1];
        if (to.k === 'f') return cards.length === 1 && (t ? t.s === c.s && t.r === c.r - 1 : c.r === 1 && c.s === SUITS[to.i]);
        if (to.k === 't') return t ? t.up && red(t) !== red(c) && t.r === c.r + 1 : c.r === 13;
        return false;
    }
    /** the n cards on top of pile `from`, if they may be picked up together (face up, in sequence) */
    take(from, n) {
        const a = this.pile(from);
        if (!a || n < 1 || n > a.length) return null;
        if (from.k !== 't' && n !== 1) return null;
        const cards = a.slice(a.length - n);
        if (!cards.every((c) => c.up)) return null;
        for (let i = 1; i < cards.length; i++) if (!(red(cards[i]) !== red(cards[i - 1]) && cards[i].r === cards[i - 1].r - 1)) return null;
        return cards;
    }
    canMove(from, n, to) {
        if (to.k === from.k && to.i === from.i) return false;
        if (from.k === 's' || to.k === 's' || to.k === 'w' || (from.k === 'f' && to.k === 'f')) return false;
        const cards = this.take(from, n);
        return !!cards && this.fits(cards, to);
    }

    _save() { this.history.push(clone({ tab: this.tab, stock: this.stock, waste: this.waste, found: this.found, score: this.score, recycles: this.recycles })); if (this.history.length > UNDO_MAX) this.history.shift(); }
    _add(p) { this.score = Math.max(0, this.score + p); }

    move(from, n, to) {
        if (!this.canMove(from, n, to)) return false;
        this._save();
        const a = this.pile(from), cards = a.splice(a.length - n, n);
        this.pile(to).push(...cards);
        if (to.k === 'f') this._add(POINTS.toFound);
        else if (from.k === 'w') this._add(POINTS.wasteTab);
        if (from.k === 'f') this._add(POINTS.fromFound);
        let turned = null;
        if (from.k === 't' && a.length && !a[a.length - 1].up) { a[a.length - 1].up = true; turned = a[a.length - 1]; this._add(POINTS.turn); }
        this.moves++; this.started = true;
        this.events.push({ type: 'move', from, to, n, cards: cards.map((c) => c.id), turned: turned && turned.id });
        if (this.won()) this.events.push({ type: 'won', score: this.score });
        return true;
    }
    /** turn cards from the stock; an empty stock takes the waste back over */
    drawStock() {
        if (!this.stock.length) {
            if (!this.waste.length) return false;
            this._save();
            this.stock = this.waste.reverse().map((c) => Object.assign(c, { up: false }));
            this.waste = [];
            this.recycles++;
            this._add(RECYCLE[this.drawN]);
            this.moves++; this.started = true;
            this.events.push({ type: 'recycle' });
            return true;
        }
        this._save();
        const n = Math.min(this.drawN, this.stock.length);
        for (let i = 0; i < n; i++) { const c = this.stock.pop(); c.up = true; this.waste.push(c); }
        this.moves++; this.started = true;
        this.events.push({ type: 'draw', n });
        return true;
    }
    undo() {
        const h = this.history.pop();
        if (!h) return false;
        Object.assign(this, h);
        this.moves++;
        this.events.push({ type: 'undo' });
        return true;
    }

    /* ---------- help ---------- */
    /**
     * Every legal move, best first: to a foundation, then tableau moves that turn a card over or empty a
     * column for a king, then the waste onto the tableau, then the rest (none that only shuffles a king
     * from one empty column to another, or a run onto an equal one).
     */
    movesFrom(from, all) {
        const out = [], a = this.pile(from);
        if (!a || !a.length) return out;
        const maxN = from.k === 't' ? a.length : 1;
        for (let n = 1; n <= maxN; n++) {
            if (!this.take(from, n)) continue;
            const below = from.k === 't' ? a[a.length - n - 1] : null;
            for (let i = 0; i < 4; i++) if (this.canMove(from, n, { k: 'f', i })) out.push({ from, n, to: { k: 'f', i }, w: 100 + (below && !below.up ? 20 : 0) });
            for (let i = 0; i < 7; i++) {
                const to = { k: 't', i };
                if (!this.canMove(from, n, to)) continue;
                const reveals = below && !below.up, empties = from.k === 't' && n === a.length;
                if (!all && from.k === 't' && !reveals && !this.tab[i].length && empties) continue;        // a king from empty to empty
                if (!all && from.k === 't' && !reveals && !empties && below && below.up && this.tab[i].length) {
                    // a run moved onto a card just like the one it leaves: pointless (unless it frees a foundation card)
                    const t = this.top(to);
                    if (t && below.r === t.r && red(below) === red(t)) continue;
                }
                let w = 10;
                if (reveals) w = 60 + (this.pile(from).length - n);       // more cards under it: better
                else if (empties) w = 40;
                else if (from.k === 'w') w = 30;
                else if (from.k === 'f') w = 1;
                if (!this.tab[i].length && n !== a.length) w += 2;
                out.push({ from, n, to, w });
            }
        }
        return out.sort((x, y) => y.w - x.w);
    }
    /** the best move for the n cards on top of `from` (n omitted: whatever moves best), done; false if none */
    auto(from, n) {
        if (from.k === 's') return this.drawStock();
        let ms = this.movesFrom(from);
        // a card picked out (a tap on it): its run goes where it fits, even where the hint wouldn't take it
        if (n) { const own = this.movesFrom(from, true).filter((m) => m.n === n); ms = own.concat(ms.filter((m) => m.n < n)); }
        // a single card from the tableau or the waste goes to a foundation before anywhere else
        const m = ms[0];
        if (!m) return false;
        return this.move(m.from, m.n, m.to) && m;
    }
    allMoves() {
        const piles = [{ k: 'w' }].concat([0, 1, 2, 3, 4, 5, 6].map((i) => ({ k: 't', i }))).concat([0, 1, 2, 3].map((i) => ({ k: 'f', i })));
        let out = [];
        for (const p of piles) out = out.concat(this.movesFrom(p).filter((m) => p.k !== 'f' || m.w > 1));
        return out.sort((x, y) => y.w - x.w);
    }
    /** a move worth making, or { draw: true } (turn the stock), or null: stuck */
    hint() {
        const m = this.allMoves().find((x) => x.w > 10);
        if (m) return m;
        // the stock and the waste still hold a card that could be played somewhere: turn on
        const places = [0, 1, 2, 3].map((i) => ({ k: 'f', i })).concat([0, 1, 2, 3, 4, 5, 6].map((i) => ({ k: 't', i })));
        if (this.stock.concat(this.waste).some((c) => places.some((p) => this.fits([c], p)))) return { draw: true };
        return null;
    }

    won() { return this.found.every((f) => f.length === 13); }
    /** nothing left hidden: the cards can go up by themselves */
    canFinish() { return !this.won() && !this.stock.length && !this.waste.length && this.tab.every((t) => t.every((c) => c.up)); }
    /** one card to a foundation (the lowest first): for the auto finish */
    autoStep() {
        let best = null;
        for (let i = 0; i < 7; i++) {
            const c = this.top({ k: 't', i });
            if (c && (!best || c.r < best.c.r)) best = { c, from: { k: 't', i } };
        }
        if (this.waste.length) { const c = this.top({ k: 'w' }); if (!best || c.r < best.c.r) best = { c, from: { k: 'w' } }; }
        if (!best) return false;
        for (let i = 0; i < 4; i++) if (this.canMove(best.from, 1, { k: 'f', i })) return this.move(best.from, 1, { k: 'f', i });
        return false;
    }
    /** the time bonus a win would add now */
    bonus() { const s = Math.round(this.ms / 1000); return s > 30 ? Math.floor(700000 / s) : 0; }

    toJSON() { return { tab: this.tab, stock: this.stock, waste: this.waste, found: this.found, score: this.score, moves: this.moves, recycles: this.recycles, ms: Math.round(this.ms), started: this.started, drawN: this.drawN }; }
}

const STATS = { played: 0, won: 0, bestTime: 0, bestScore: 0, streak: 0, bestStreak: 0 };
/** a game ends: counted when it was started (a move made); won or given up */
function record(stats, g, won) {
    const st = Object.assign({}, STATS, stats || {});
    if (!g.started && !won) return st;
    st.played++;
    if (won) {
        st.won++;
        st.streak++;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
        const t = Math.round(g.ms / 1000);
        if (!st.bestTime || t < st.bestTime) st.bestTime = t;
        st.bestScore = Math.max(st.bestScore, g.score);
    } else st.streak = 0;
    return st;
}

function loadState(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('solitaire: state not read: ' + e.message);
        return {};
    }
}
function saveState(file, st) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(st));
    fs.renameSync(file + '.tmp', file);
}

module.exports = { Game, SUITS, POINTS, RECYCLE, STATS, red, record, loadState, saveState };
