'use strict';
/** Apex Chase's rules (apps/aurelm_apex_chase/model.js): node tests/apex_chase.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, DT, W, H, DIRS, LIVES, POINTS, CITIES, OUTSIDE, city, distances, isRoad, wrapX, loadBest, saveBest } = require('../apps/aurelm_apex_chase/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const run = (g, ms) => { for (let t = 0; t < ms; t += DT) g.step(DT); };
/** a game past its start lights, the electric cars parked far away in the station */
function quiet(o) {
    const g = new Game(Object.assign({ rng: seeded(1) }, o || {}));
    g.pause = 0;
    for (const e of g.evs) { e.state = 'home'; e.wait = 1e9; e.x = 22; e.y = 9; e.script = null; }
    return g;
}

test('every city: symmetric, no dead ends, every street reachable, drops and four nitro cans', () => {
    for (let n = 0; n < CITIES.length; n++) {
        const g = city(n);
        assert.strictEqual(g.length, H);
        for (const row of g) { assert.strictEqual(row.length, W); assert.strictEqual(row.replace('S', '.'), [...row.replace('S', '.')].reverse().join('')); }
        const open = (x, y) => y >= 0 && y < H && isRoad(g[y][wrapX(x)]);
        let cells = 0, start = null;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (!open(x, y)) continue;
            cells++; start = start || { x, y };
            const n4 = Object.values(DIRS).filter(([dx, dy]) => open(x + dx, y + dy)).length;
            assert.ok(n4 >= 2, 'city ' + n + ': dead end at ' + x + ',' + y);
        }
        const d = distances(g, start, true);
        let reached = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (open(x, y) && d[y][x] < Infinity) reached++;
        assert.strictEqual(reached, cells, 'city ' + n);
        assert.strictEqual(g.join('').split('o').length - 1, 4);
        assert.ok(g.join('').split('.').length - 1 > 250);
    }
});

test('the car goes the way it was steered, turns as soon as it can, stops at a block', () => {
    const g = quiet();
    assert.deepStrictEqual([g.car.x, g.car.y], [22, 14]);
    g.steer('R');
    run(g, 500);                                          // 8 cells a second along the avenue
    assert.strictEqual(g.car.y, 14);
    assert.ok(g.car.x >= 25 && g.car.x <= 27, 'x ' + g.car.x);
    g.steer('U');                                         // kept until a street goes up (x 27)
    run(g, 800);
    assert.ok(g.car.y < 14 && g.car.x === 27, g.car.x + ',' + g.car.y);
    g.steer('U');
    run(g, 2000);
    assert.strictEqual(g.car.y, 11);                      // the avenue above: on up? no street at 27 over 11
    assert.ok(!g.car.moving);
});

test('a turn back is at once, also between two cells', () => {
    const g = quiet();
    g.steer('R'); run(g, 180);
    const x = g.at(g.car).x;
    g.steer('L'); run(g, 100);
    assert.ok(g.at(g.car).x < x);
});

test('the tunnel takes the car from one side to the other', () => {
    const g = quiet();
    g.car.x = 2; g.car.y = 9; g.car.dir = 'L'; g.car.want = 'L'; g.car.t = 0;
    run(g, 600);
    assert.strictEqual(g.car.y, 9);
    assert.ok(g.car.x > 38, 'x ' + g.car.x);
});

test('drops score 10, a nitro 50 and scares the cars; a scared car caught scores 200, 400, 800, 1600', () => {
    const g = quiet();
    g.steer('L'); run(g, 400);
    assert.strictEqual(g.score, g.eaten * POINTS.dot);
    assert.ok(g.eaten >= 2);
    // a nitro: every car out turns round and flees
    const s0 = g.score;
    g.evs.forEach((e, i) => { e.state = 'out'; e.x = 5 + i * 9; e.y = 4; e.t = 0; e.dir = 'R'; });
    g.car.x = 1; g.car.y = 2; g.car.t = 0; g.car.dir = 'U'; g.car.want = 'U';
    run(g, 200);
    assert.strictEqual(g.score - s0, POINTS.nitro);                // (1,1): the nitro corner
    assert.ok(g.evs.every((e) => e.state === 'scared'));
    assert.ok(g.fright > 0);
    // catch them one after the other
    const pts = [];
    for (const e of g.evs) {
        const p = g.at(g.car);
        e.x = Math.round(p.x); e.y = Math.round(p.y); e.t = 0;
        g._collide();
        pts.push(g.events.filter((v) => v.type === 'caught').map((v) => v.pts).pop());
    }
    assert.deepStrictEqual(pts, POINTS.chain);
    assert.ok(g.evs.every((e) => e.state === 'back'));
});

test('a caught car drives back to the station, charges and comes out again', () => {
    const g = quiet();
    const e = g.evs[1];
    e.state = 'back'; e.x = 5; e.y = 14; e.t = 0; e.dir = 'R'; e.wait = 0;
    let home = false;
    for (let t = 0; t < 15000 && !home; t += DT) { g.step(DT); if (e.state === 'home') home = true; }
    assert.ok(home, 'not home: ' + e.state + ' at ' + e.x + ',' + e.y);
    for (let t = 0; t < 5000 && e.state === 'home'; t += DT) g.step(DT);
    assert.ok(e.state === 'out' || e.state === 'scared');
    assert.deepStrictEqual([e.x, e.y], [OUTSIDE.x, OUTSIDE.y]);
});

test('the cars leave the station one after the other and hunt', () => {
    const g = new Game({ rng: seeded(3) });
    run(g, 1700);
    assert.strictEqual(g.evs.filter((e) => e.state === 'out').length, 1);
    run(g, 12000);
    assert.strictEqual(g.evs.filter((e) => e.state === 'out').length, 4);
});

test('a hunting car that reaches the M car crashes it: a life, the start again; none left: over', () => {
    const g = quiet();
    const e = g.evs[0];
    e.state = 'out'; const p = g.at(g.car); e.x = p.x - 2; e.y = p.y; e.t = 0; e.dir = 'R';      // head on
    run(g, 300);
    assert.ok(g.events.some((v) => v.type === 'crash'));
    assert.strictEqual(g.lives, LIVES - 1);
    run(g, 2000);
    assert.deepStrictEqual([g.car.x, g.car.y], [22, 14]);
    g.lives = 1;
    g.pause = 0;
    const f = g.evs[2]; f.state = 'out'; f.script = null; const q = g.at(g.car); f.x = q.x; f.y = q.y; f.t = 0;
    run(g, 2500);
    assert.ok(g.over);
});

test('a city cleared: the next level in the other city, faster cars, a shorter nitro', () => {
    const g = quiet();
    const sp = g.evSpeed({ state: 'out', x: 10, y: 4 }), fr = g.frightMs();
    g.dots.clear();
    g.step(DT);
    run(g, 2200);
    assert.strictEqual(g.level, 2);
    assert.notDeepStrictEqual(g.grid, city(0));
    assert.ok(g.dots.size > 250);
    assert.ok(g.evSpeed({ state: 'out', x: 10, y: 4 }) > sp);
    assert.ok(g.frightMs() < fr);
});

test('the M car is faster than a hunting car; easy is slower, hard faster', () => {
    const at = (d) => new Game({ difficulty: d }).evSpeed({ state: 'out', x: 10, y: 4 });
    const g = new Game({});
    assert.ok(g.carSpeed() > at('hard') && at('hard') > at('normal') && at('normal') > at('easy'));
    assert.ok(g.evSpeed({ state: 'scared', x: 10, y: 4 }) < at('easy'));
});

test('a bonus appears after 70 drops, pays when collected; an extra car at 10 000', () => {
    const g = quiet();
    g.eaten = 69;
    g.steer('L'); run(g, 200);
    assert.ok(g.bonus);
    const b = g.bonus, s = g.score;
    g.car.x = b.x; g.car.y = b.y; g.car.t = 0; g.car.dir = 'L'; g.car.want = 'L';
    g.step(DT);
    assert.strictEqual(g.bonus, null);
    assert.ok(g.score >= s + b.pts);
    g.score = 9995; g.steer('R'); run(g, 400);
    assert.strictEqual(g.lives, LIVES + 1);
});

test('best scores are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
    const f = path.join(dir, 'best.json');
    assert.deepStrictEqual(loadBest(f), {});
    saveBest(f, { normal: 12340 });
    assert.deepStrictEqual(loadBest(f), { normal: 12340 });
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
