'use strict';
/** Solitaire's rules (apps/solitaire/model.js): node tests/solitaire.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, POINTS, RECYCLE, record, loadState, saveState } = require('../apps/solitaire/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
let nid = 1000;
const C = (str, up = true) => str.split(' ').filter(Boolean).map((x) => {
    const r = { A: 1, J: 11, Q: 12, K: 13 }[x.slice(0, -1)] || Number(x.slice(0, -1));
    return { r, s: x.slice(-1), up, id: nid++ };
});
/** an empty table, then the given piles */
function table(o) {
    const g = new Game({ rng: seeded(1), draw: o.draw });
    g.tab = [0, 1, 2, 3, 4, 5, 6].map((i) => (o.tab && o.tab[i]) || []);
    g.stock = o.stock || []; g.waste = o.waste || []; g.found = o.found || [[], [], [], []];
    return g;
}
const T = (i) => ({ k: 't', i }), F = (i) => ({ k: 'f', i }), WASTE = { k: 'w' };
/** plays the hint until it's won or stuck */
function playOut(g) {
    for (let k = 0; k < 4000 && !g.won(); k++) {
        if (g.canFinish()) { while (g.autoStep()); break; }
        const h = g.hint();
        if (!h || (h.draw && g.recycles > 20)) break;
        if (h.draw) g.drawStock(); else g.move(h.from, h.n, h.to);
    }
    return g.won();
}

test('a deal: seven columns of 1..7 with the top card up, 24 in the stock, all 52 cards once', () => {
    const g = new Game({ rng: seeded(3) });
    assert.deepStrictEqual(g.tab.map((t) => t.length), [1, 2, 3, 4, 5, 6, 7]);
    for (const t of g.tab) { assert.ok(t[t.length - 1].up); assert.ok(t.slice(0, -1).every((c) => !c.up)); }
    assert.strictEqual(g.stock.length, 24);
    const all = g.stock.concat(...g.tab).map((c) => c.r + c.s);
    assert.strictEqual(new Set(all).size, 52);
});

test('tableau: down by one in alternate colours; only a king on an empty column', () => {
    const g = table({ tab: [C('9S'), C('8H'), C('8C'), [], C('KD'), C('QD')] });
    assert.ok(g.canMove(T(1), 1, T(0)));                // red 8 on black 9
    assert.ok(!g.canMove(T(2), 1, T(0)));               // black on black
    assert.ok(!g.canMove(T(0), 1, T(3)));               // a 9 on an empty column
    assert.ok(g.canMove(T(4), 1, T(3)));                // a king does
    assert.ok(!g.canMove(T(5), 1, T(4)));               // red queen on red king
});

test('foundations: up from the ace, one per suit', () => {
    const g = table({ tab: [C('AH'), C('2H'), C('2S')] });
    assert.ok(!g.canMove(T(1), 1, F(1)));
    assert.ok(!g.canMove(T(0), 1, F(0)));               // hearts go on the hearts' foundation
    assert.ok(g.move(T(0), 1, F(1)));
    assert.ok(!g.canMove(T(2), 1, F(1)));
    assert.ok(g.move(T(1), 1, F(1)));
    assert.strictEqual(g.found[1].length, 2);
    assert.strictEqual(g.score, 2 * POINTS.toFound);
});

test('a run moves together; a card under it turns over (+5)', () => {
    const g = table({ tab: [C('5D', false).concat(C('9S 8H 7C')), C('10H')] });
    assert.ok(!g.take(T(0), 4));                        // a face-down card can't come along
    assert.ok(g.move(T(0), 3, T(1)));
    assert.deepStrictEqual(g.tab[1].map((c) => c.r), [10, 9, 8, 7]);
    assert.ok(g.tab[0][0].up);
    assert.strictEqual(g.score, POINTS.turn);
    // a broken run can't
    const h = table({ tab: [C('9S 7H'), C('10H')] });
    assert.ok(!h.canMove(T(0), 2, T(1)));
});

test('the stock: one card at a time, or three; the waste goes back over (-100 / -20)', () => {
    const g = table({ stock: C('2S 3S 4S', false) });
    g.drawStock();
    assert.deepStrictEqual(g.waste.map((c) => c.r), [4]);
    assert.ok(g.waste[0].up);
    g.drawStock(); g.drawStock();
    assert.strictEqual(g.stock.length, 0);
    g.score = 150;
    g.drawStock();
    assert.strictEqual(g.stock.length, 3);
    assert.deepStrictEqual(g.stock.map((c) => c.r), [2, 3, 4]);   // the same order again
    assert.ok(g.stock.every((c) => !c.up));
    assert.strictEqual(g.score, 150 + RECYCLE[1]);
    const t = table({ draw: 3, stock: C('2S 3S 4S 5S', false) });
    t.drawStock();
    assert.deepStrictEqual(t.waste.map((c) => c.r), [5, 4, 3]);
    t.drawStock();
    assert.strictEqual(t.waste.length, 4);
    t.score = 10;
    t.drawStock();
    assert.strictEqual(t.score, 0);                     // never below 0
});

test('only the waste\'s top card plays; waste to tableau +5', () => {
    const g = table({ tab: [C('9S')], waste: C('7H 8H') });
    assert.ok(g.move(WASTE, 1, T(0)));
    assert.strictEqual(g.score, POINTS.wasteTab);
    assert.ok(!g.canMove(WASTE, 2, T(0)));
});

test('a card back from a foundation costs 15; no moves between foundations', () => {
    const g = table({ tab: [C('3S')], found: [C('AH 2H'), [], [], []] });
    g.score = 50;
    assert.ok(g.move(F(0), 1, T(0)));
    assert.strictEqual(g.score, 50 + POINTS.fromFound);
    const h = table({ found: [C('AH'), [], [], []] });
    assert.ok(!h.canMove(F(0), 1, F(1)));
});

test('undo puts everything back as it was, the score too', () => {
    const g = new Game({ rng: seeded(9) });
    const before = JSON.stringify(g.toJSON().tab);
    g.drawStock();
    const h = g.hint();
    if (h && !h.draw) g.move(h.from, h.n, h.to);
    while (g.undo());
    assert.strictEqual(JSON.stringify(g.tab), before);
    assert.strictEqual(g.waste.length, 0);
    assert.strictEqual(g.score, 0);
});

test('the best move: a card to its foundation first, else one that turns a card over', () => {
    const g = table({ tab: [C('AS'), C('KD', false).concat(C('8H')), C('9C'), C('9S')] });
    const m = g.auto(T(0));
    assert.ok(m && m.to.k === 'f');
    const n = g.auto(T(1));                             // the 8 goes on a 9 and the K turns over
    assert.ok(n && n.to.k === 't');
    assert.ok(g.tab[1][0].up);
    assert.ok(!g.auto(T(5)));                           // an empty column: nothing to move
});

test('the best move takes the whole run that fits, from a tapped card', () => {
    const g = table({ tab: [C('4D', false).concat(C('QS JH 10C')), C('KH'), C('JD')] });
    const m = g.auto(T(0));                             // Q J 10 onto the red king: turns the 4 over
    assert.ok(m && m.n === 3 && m.to.i === 1);
    const h = table({ tab: [C('QS JH 10C'), C('KH'), C('JD')] });
    assert.ok(h.auto(T(0), 1));                         // just the 10 (onto the red jack)
    assert.deepStrictEqual(h.tab[2].map((c) => c.r), [11, 10]);
});

test('no pointless moves: a king from an empty column to another, a run onto its twin', () => {
    const g = table({ tab: [C('KS'), [], C('8D 7S'), C('8H')] });
    assert.ok(!g.movesFrom(T(0)).some((m) => m.to.k === 't'));
    assert.ok(!g.movesFrom(T(2)).some((m) => m.to.i === 3));
});

test('hint: a move, else the stock, else stuck', () => {
    const g = table({ tab: [C('AS')] });
    assert.ok(g.hint().to.k === 'f');
    const h = table({ tab: [C('5S')], stock: C('4H', false) });
    assert.ok(h.hint().draw);
    const s = table({ tab: [C('5S')], stock: C('9H', false) });
    assert.strictEqual(s.hint(), null);
});

test('auto finish: with nothing hidden, the cards go up one by one to a win (+ time bonus)', () => {
    const g = table({ tab: [C('KS QH JS 10H 9S 8H 7S 6H 5S 4H 3S 2H AS'), C('KH QS JH 10S 9H 8S 7H 6S 5H 4S 3H 2S AH'), C('KD QC JD 10C 9D 8C 7D 6C 5D 4C 3D 2C AD'), C('KC QD JC 10D 9C 8D 7C 6D 5C 4D 3C 2D AC')] });
    assert.ok(g.canFinish());
    let n = 0;
    while (g.autoStep()) n++;
    assert.strictEqual(n, 52);
    assert.ok(g.won() && !g.canFinish());
    assert.ok(g.events.some((e) => e.type === 'won'));
    g.ms = 140000;
    assert.strictEqual(g.bonus(), 5000);
});

test('a player who follows the hints wins a good share of games, draw one more than draw three', () => {
    let one = 0, three = 0;
    const rng = seeded(21);
    for (let i = 0; i < 150; i++) { if (playOut(new Game({ rng, draw: 1 }))) one++; if (playOut(new Game({ rng, draw: 3 }))) three++; }
    assert.ok(one > 30 && one < 90, 'draw one won ' + one);
    assert.ok(three > 3 && three < one, 'draw three won ' + three);
});

test('statistics: a started game counts, a win with its time, streaks', () => {
    const g = new Game({ rng: seeded(2) });
    let st = record({}, g, false);
    assert.strictEqual(st.played, 0);                   // not started: not counted
    g.drawStock();
    st = record(st, g, false);
    assert.deepStrictEqual([st.played, st.won, st.streak], [1, 0, 0]);
    g.ms = 185000; g.score = 4200;
    st = record(st, g, true);
    st = record(st, g, true);
    assert.deepStrictEqual([st.played, st.won, st.streak, st.bestStreak, st.bestTime, st.bestScore], [3, 2, 2, 2, 185, 4200]);
});

test('a game in progress is kept between drives', () => {
    const g = new Game({ rng: seeded(4), draw: 3 });
    g.drawStock();
    g.ms = 61000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-'));
    const f = path.join(dir, 'state.json');
    saveState(f, { game: g.toJSON() });
    const h = new Game({ state: loadState(f).game });
    assert.deepStrictEqual(h.toJSON(), g.toJSON());
    assert.strictEqual(h.drawN, 3);
    h.drawStock();
    assert.strictEqual(h.waste.length, 6);
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
