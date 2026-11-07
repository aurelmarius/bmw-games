'use strict';
/** Ridge Duel's rules (apps/aurelm_ridge_duel/model.js): node tests/ridge_duel.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../apps/aurelm_ridge_duel/model');
const { Game, Ground, DT, W, H, G, VMAX, BODIES, SHELLS, WINS, seeded, loadStats, saveStats, record } = M;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = (g, ms, each) => { for (let t = 0; t < ms; t += DT) { if (each && each(g)) return true; g.step(DT); } return false; };
const types = (g) => g.events.map((e) => e.type);
/** flat ground at y = 380, the cars at 200 and 900 */
function flat(o) {
    const g = new Game(Object.assign({ rng: seeded(1) }, o || {}));
    g.ground.h.fill(380); g.ground.burnt.fill(0);
    g.cars[0].x = 200; g.cars[1].x = 900;
    g.cars.forEach((c) => c.settle(g.ground));
    g.wind = 0; g.turn = 0; g.phase = 'aim'; g.ai = null;
    return g;
}
/** the shot (aim, power) from car c that lands nearest x */
function solve(g, c, x) {
    let b = null;
    for (let a = 10; a <= 85; a += 0.5) for (let p = 0.3; p <= 1.0001; p += 0.01) { const l = g.landing(c, a, p), d = Math.abs(l.x - x); if (!b || d < b.d) b = { a, p, d }; }
    return b;
}

test('the ground: inside the board, smooth enough to drive; a shell bites a round crater out of it', () => {
    for (let s = 1; s <= 30; s++) {
        const gr = new Ground(seeded(s));
        for (let x = 0; x < W; x++) assert.ok(gr.h[x] >= 150 && gr.h[x] <= H - 40, 'seed ' + s + ' x ' + x + ': ' + gr.h[x]);
        for (let x = 1; x < W; x++) assert.ok(Math.abs(gr.h[x] - gr.h[x - 1]) < 4, 'a cliff at ' + x);
    }
    const gr = new Ground(seeded(2));
    gr.h.fill(300);
    const v = gr.ver;
    gr.carve(500, 300, 30);
    assert.strictEqual(gr.ver, v + 1);
    assert.ok(Math.abs(gr.h[500] - 330) < 0.01, 'the bottom of the crater: ' + gr.h[500]);
    assert.ok(gr.h[520] > 300 && gr.h[520] < 330);
    assert.strictEqual(gr.h[540], 300);
    assert.ok(gr.burnt[500] && gr.burnt[530] && !gr.burnt[560]);
});

test('every ground has its own id (a new match, a round again: never the drawing of the last one)', () => {
    const a = new Game({ rng: seeded(1) }), b = new Game({ rng: seeded(1) });
    assert.notStrictEqual(a.ground.id, b.ground.id);
    const id = a.ground.id, v = a.ground.ver;
    a.newRound();
    assert.notStrictEqual(a.ground.id, id);
    a.ground.carve(300, 300, 20);
    assert.strictEqual(a.ground.ver, v + 1);
});

test('a shell flies as it should: range v^2 sin 2a / g on the flat, no wind', () => {
    const g = flat();
    g.cars[1].x = W - 41; g.cars[1].settle(g.ground);                 // (out of the way)
    const c = g.cars[0], gun = (() => { c.aim = 45; return c.gun(); })();
    const l = g.landing(c, 45, 0.8), v = VMAX * 0.8;
    // from the muzzle's height down to the ground: a little further than the flat range
    const dy = 380 - gun.my, vx = v * Math.SQRT1_2, vy = v * Math.SQRT1_2, t = (vy + Math.sqrt(vy * vy + 2 * G * dy)) / G;
    assert.ok(Math.abs(l.x - (gun.mx + vx * t)) < 3, l.x + ' vs ' + (gun.mx + vx * t));
});

test('the wind pushes a shell its way', () => {
    const g = flat();
    const still = g.landing(g.cars[0], 45, 0.7).x;
    g.wind = 15; const tail = g.landing(g.cars[0], 45, 0.7).x;
    g.wind = -15; const head = g.landing(g.cars[0], 45, 0.7).x;
    assert.ok(tail > still + 40 && head < still - 40, head + ' < ' + still + ' < ' + tail);
});

test('a direct hit: full damage +15 %, less the armour; the rival\'s turn next', () => {
    const g = flat();
    g.cars[1].x = 700; g.cars[1].settle(g.ground);
    const s = solve(g, g.cars[0], 700);
    g.cars[0].aim = s.a;
    assert.ok(g.fire(0, s.p));
    assert.ok(!g.fire(0, s.p), 'one shot a turn');
    run(g, 6000, () => g.turn === 1);
    const boom = g.events.find((e) => e.type === 'boom');
    assert.ok(boom && boom.hits.some((h) => h.side === 1), JSON.stringify(boom));
    const dmg = boom.hits.find((h) => h.side === 1).dmg;
    if (boom.direct) assert.strictEqual(dmg, Math.round(SHELLS.standard.dmg * 1.15 * (1 - BODIES.pickup.armour)));
    else assert.ok(dmg > 15 && dmg <= SHELLS.standard.dmg);
    assert.strictEqual(g.cars[1].hp, 100 - dmg);
    assert.strictEqual(g.turn, 1);
    assert.ok(types(g).includes('turn'));
});

test('splash: the further from the blast, the less; nothing past its reach; the SUV takes 20 % less', () => {
    const at = (body, dx) => {
        const g = flat({ body });
        const c = g.cars[0], [cx] = c.centre();
        g.shells.push({ kind: 'standard', x: cx + dx, y: 379, vx: 0, vy: 10, from: 1, bounces: 0, split: false, age: 1, dmg: SHELLS.standard.dmg, r: SHELLS.standard.r });
        g.phase = 'flight';
        run(g, 500, (x) => x.events.some((e) => e.type === 'boom'));
        return 100 - c.hp;
    };
    const near = at('sedan', 25), far = at('sedan', 45), out = at('sedan', 120);
    assert.ok(near > far && far > 0 && out === 0, near + ' > ' + far + ' > ' + out);
    const suv = at('suv', 0), sedan = at('sedan', 0);
    assert.ok(suv > 0 && Math.abs(suv - sedan * 0.8) <= 2, suv + ' ~ 0.8 x ' + sedan);
});

test('the CLUSTER splits in three at the top; the BOUNCER bounces twice; the HEAVY bites deep', () => {
    const g = flat();
    g.cars[0].shell = 'cluster'; g.cars[0].aim = 50;
    g.fire(0, 0.6);
    let most = 0;
    run(g, 6000, (x) => { most = Math.max(most, x.shells.length); return x.turn === 1; });
    assert.strictEqual(most, 3);
    assert.strictEqual(g.events.filter((e) => e.type === 'boom').length, 3);
    assert.strictEqual(g.cars[0].ammo.cluster, SHELLS.cluster.ammo - 1);
    const b = flat();
    b.cars[0].shell = 'bouncer'; b.cars[0].aim = 30;
    b.fire(0, 0.55);
    run(b, 8000, (x) => x.turn === 1);
    assert.strictEqual(b.events.filter((e) => e.type === 'bounce').length, 2);
    const h = flat();
    h.cars[0].shell = 'heavy'; h.cars[0].aim = 45;
    h.fire(0, 0.6);
    run(h, 6000, (x) => x.turn === 1);
    const deepest = Math.max(...h.ground.h);
    assert.ok(deepest > 380 + SHELLS.heavy.r * 0.8, 'deep: ' + deepest);
    assert.strictEqual(h.cars[0].ammo.heavy, 0);
    h.turn = 0; h._startTurn();
    assert.strictEqual(h.cars[0].shell, 'standard');                  // none left: back to the standard
    h.choose('heavy');
    assert.notStrictEqual(h.cars[0].shell, 'heavy');                  // none left
});

test('driving: the turn\'s fuel, the sedan further than the SUV; too steep stalls, the SUV climbs more', () => {
    const go = (body) => { const g = flat({ body }); const x0 = g.cars[0].x; for (let t = 0; t < 8000; t += DT) g.drive(0, 1, DT); return g.cars[0].x - x0; };
    const sedan = go('sedan'), suv = go('suv');
    assert.ok(Math.abs(sedan - BODIES.sedan.fuel) < 1 && Math.abs(suv - BODIES.suv.fuel) < 1, sedan + ' / ' + suv);
    const slope = (body, k) => {
        const g = flat({ body });
        for (let x = 0; x < W; x++) g.ground.h[x] = 380 - Math.max(0, x - 230) * k;
        g.cars[0].settle(g.ground);
        const x0 = g.cars[0].x;
        for (let t = 0; t < 3000; t += DT) g.drive(0, 1, DT);
        return g.cars[0].x - x0;
    };
    assert.ok(slope('sedan', 1.1) < 40 && slope('suv', 1.1) > 70, slope('sedan', 1.1) + ' / ' + slope('suv', 1.1));
    const g = flat();
    g.turn = 1;
    assert.strictEqual(g.drive(0, 1, 100), 0, 'not on the rival\'s turn');
});

test('the turn: aim from 0 to 90, the shells in turn; nothing on the rival\'s turn', () => {
    const g = flat();
    g.setAim(120); assert.strictEqual(g.cars[0].aim, 90);
    g.turnAim(-100); assert.strictEqual(g.cars[0].aim, 0);
    g.cycleShell(1); assert.strictEqual(g.cars[0].shell, 'cluster');
    g.cycleShell(-1); g.cycleShell(-1); assert.strictEqual(g.cars[0].shell, 'heavy');
    g.turn = 1;
    g.setAim(30); assert.strictEqual(g.cars[0].aim, 0);
    assert.ok(!g.fire(0, 0.5));
});

test('the rival works out its shot: on hard its shots come down near you, nearer with every one', () => {
    let near = 0, total = 0;
    for (let s = 1; s <= 12; s++) {
        const g = new Game({ rng: seeded(s), difficulty: 'hard' });
        g.turn = 1; g._startTurn();
        const errs = [];
        for (let k = 0; k < 3; k++) {
            g.cars[0].hp = 100;
            run(g, 20000, (x) => x.phase !== 'aim');
            const b = (() => { let e = null; run(g, 20000, (x) => { e = x.events.find((v) => v.type === 'boom' && v.from === 1); return !!e; }); return e; })();
            run(g, 20000, (x) => x.phase === 'aim');
            if (b) errs.push(Math.abs(b.x - g.cars[0].x));
            g.events = [];
            g.turn = 1; g._startTurn();
        }
        total++;
        if (errs.length && Math.min(...errs) < 90) near++;
    }
    assert.ok(near >= 8, near + ' of ' + total);
});

test('a round is won at 0 health; the match at ' + WINS + '; a draw plays the round again', () => {
    const g = flat();
    g.cars[1].hp = 1;
    g.cars[0].aim = 45; g.fire(0, 0.5);
    g.cars[1].hp = 0;                                           // (as if it was hit)
    run(g, 8000, (x) => x.phase === 'roundOver');
    assert.ok(types(g).includes('roundOver'));
    assert.deepStrictEqual(g.wins, [1, 0]);
    run(g, 4000, (x) => x.roundNo === 2);
    assert.strictEqual(g.roundNo, 2);
    assert.ok(g.cars.every((c) => c.hp === 100));
    assert.strictEqual(g.cars[0].ammo.heavy, 1);
    g.wins = [WINS - 1, 0];
    g.phase = 'boom'; g.wait = 0; g.shells = []; g.booms = []; g.cars[1].hp = 0;
    run(g, 6000, (x) => x.over);
    assert.ok(g.over && types(g).includes('match'));
    const d = flat();
    d.cars[0].hp = 0; d.cars[1].hp = 0; d.phase = 'boom'; d.wait = 0;
    run(d, 6000, (x) => x.roundNo === 2 || x.events.some((e) => e.type === 'round' && e.n === 1 && x.phase === 'aim' && x.cars[0].hp === 100));
    assert.deepStrictEqual(d.wins, [0, 0]);
    assert.strictEqual(d.roundNo, 1, 'the same round again');
});

test('whole matches against the rival end, one way or the other, and nothing gets stuck', () => {
    let won = 0;
    for (let s = 1; s <= 10; s++) {
        const g = new Game({ rng: seeded(s), difficulty: 'easy', body: s % 2 ? 'sedan' : 'suv' });
        const rng = seeded(s + 50);
        let steps = 0;
        while (!g.over && steps < 400000) {
            if (g.mine()) { const b = solve(g, g.cars[0], g.cars[1].x); g.cars[0].aim = b.a + (rng() - 0.5) * 6; g.fire(0, b.p); }
            g.step(DT); steps++;
            for (const c of g.cars) assert.ok(c.x >= 40 && c.x <= W - 40 && c.y <= H);
        }
        assert.ok(g.over, 'seed ' + s + ' stuck in ' + g.phase);
        if (g.wins[0] >= WINS) won++;
    }
    assert.ok(won >= 4, 'a fair shooter beats the easy rival: ' + won + ' of 10');
});

test('statistics: matches, wins, the run, shots and hits, kept in a file', () => {
    const g = new Game({ rng: seeded(3) });
    g.wins = [WINS, 1]; g.stats = { shots: 9, hits: 4, dealt: 200 };
    let st = record({}, g);
    st = record(st, g);
    g.wins = [1, WINS];
    st = record(st, g);
    assert.deepStrictEqual(st.normal, { played: 3, won: 2, streak: 0, best: 2, shots: 27, hits: 12 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
    const f = path.join(dir, 'stats.json');
    assert.deepStrictEqual(loadStats(f), {});
    saveStats(f, st);
    assert.deepStrictEqual(loadStats(f), st);
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
