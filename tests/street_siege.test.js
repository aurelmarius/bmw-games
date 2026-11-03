'use strict';
/** Street Siege's rules (apps/aurelm_street_siege/model.js): node tests/street_siege.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game, DT, BW, BH, TW, TH, DIRS, LIVES, GARAGE_HP, PER_LEVEL, ON_YARD, TYPES, BASE, RING, SPAWNS, PLAYER, build, convoy, loadBest, saveBest } = require('../apps/aurelm_street_siege/model');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const run = (g, ms) => { for (let t = 0; t < ms; t += DT) g.step(DT); };
/** a game on an empty yard (but the garage and its ring), no cars coming in */
function empty(o) {
    const g = new Game(Object.assign({ rng: seeded(1), autoFire: false }, o || {}));
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) if (!'tG'.includes(g.grid[y][x]) || y < RING.y) g.grid[y][x] = '.';
    g.spawnAt = 1e12;
    return g;
}
/** an enemy standing at (x, y) */
function enemy(g, kind, x, y, dir) { const e = { kind, x, y, dir: dir || 'D', hp: TYPES[kind].hp, state: 'on', wait: 0, cool: 1e9, turnIn: 1e9, flash: false, solid: true }; g.cars.push(e); g.come++; return e; }

test('every yard: the size it should be, symmetric, the garage in its ring, clear ways in, reachable everywhere', () => {
    for (let n = 1; n <= 12; n++) {
        const y = build(n);
        assert.strictEqual(y.length, BH);
        for (const row of y) { assert.strictEqual(row.length, BW); assert.strictEqual(row, [...row].reverse().join('')); }
        for (let r = BASE.y; r < BASE.y + BASE.h; r++) for (let c = BASE.x; c < BASE.x + BASE.w; c++) assert.strictEqual(y[r][c], 'G');
        assert.ok(y[RING.y].slice(RING.x, RING.x + RING.w) === 'tttttttt');
        for (const s of [...SPAWNS, PLAYER]) for (let r = s.y; r < s.y + 2; r++) for (let c = s.x; c < s.x + 2; c++) assert.strictEqual(y[r][c], '.', 'level ' + n + ': blocked at ' + c + ',' + r);
        // every open brick reachable from a way in, tyres counted open
        const open = (c, r) => r >= 0 && c >= 0 && r < BH && c < BW && !'cw'.includes(y[r][c]);
        const seen = new Set(['22,0']), q = [[22, 0]];
        while (q.length) { const [c, r] = q.shift(); for (const [dx, dy] of Object.values(DIRS)) { const k = (c + dx) + ',' + (r + dy); if (open(c + dx, r + dy) && !seen.has(k)) { seen.add(k); q.push([c + dx, r + dy]); } } }
        for (let r = 0; r < BH; r++) for (let c = 0; c < BW; c++) if (open(c, r)) assert.ok(seen.has(c + ',' + r), 'level ' + n + ': pocket at ' + c + ',' + r);
    }
    assert.notDeepStrictEqual(build(1), build(2));
    assert.deepStrictEqual(build(4), build(4));                       // the same yard every time
});

test('twenty cars a level, more armour later on', () => {
    assert.strictEqual(convoy(1).length, PER_LEVEL);
    const count = (n, k) => convoy(n).filter((x) => x === k).length;
    assert.strictEqual(count(1, 'suv'), 0);
    assert.ok(count(9, 'suv') + count(9, 'pickup') > count(1, 'suv') + count(1, 'pickup'));
});

test('the M car drives, stops at tyres and at the yard\'s edge, turns onto the brick grid', () => {
    const g = empty();
    g.drive('L'); run(g, 1000);
    assert.ok(Math.abs(g.car.x - (PLAYER.x - 5)) < 0.3, 'x ' + g.car.x);
    g.drive('U'); run(g, 100);
    assert.strictEqual(g.car.x, Math.round(g.car.x));
    g.drive('L'); run(g, 9000);
    assert.strictEqual(g.car.x, 0);
    g.grid[20][0] = 't'; g.drive('U'); run(g, 3000);
    assert.ok(g.car.y >= 21 - 1e-6, 'y ' + g.car.y);                 // stopped under the tyre
});

test('a shot takes two tyre bricks across its way; concrete stops it; the canal lets it pass', () => {
    const g = empty();
    g.car.x = 10; g.car.y = 20; g.car.dir = 'U';
    g.grid[10][10] = 't'; g.grid[10][11] = 't'; g.grid[10][12] = 't';
    g.fire(); run(g, 1000);
    assert.strictEqual(g.grid[10][10], '.'); assert.strictEqual(g.grid[10][11], '.'); assert.strictEqual(g.grid[10][12], 't');
    g.grid[8][10] = 'c'; g.fire(); run(g, 1000);
    assert.strictEqual(g.grid[8][10], 'c');
    g.grid[8][10] = '.'; g.grid[12][10] = 'w'; g.grid[5][11] = 't'; g.car.cool = 0; g.fire(); run(g, 1000);
    assert.strictEqual(g.grid[12][10], 'w');
    assert.strictEqual(g.grid[5][11], '.');
    // a fully upgraded cannon breaks concrete
    g.power = 3; g.grid[3][10] = 'c'; g.car.cool = 0; g.fire(); run(g, 1000);
    assert.strictEqual(g.grid[3][10], '.');
});

test('a car hit is destroyed and scores; an armoured SUV takes four hits', () => {
    const g = empty();
    g.car.x = 10; g.car.y = 20; g.car.dir = 'U';
    enemy(g, 'van', 10, 5);
    g.fire(); run(g, 1000);
    assert.strictEqual(g.cars.length, 0);
    assert.strictEqual(g.score, TYPES.van.pts);
    const s = enemy(g, 'suv', 10, 5);
    for (let i = 0; i < 3; i++) { g.car.cool = 0; g.fire(); run(g, 900); }
    assert.ok(g.cars.includes(s) && s.hp === 1);
    g.car.cool = 0; g.fire(); run(g, 900);
    assert.ok(!g.cars.includes(s));
});

test('an enemy shot costs the M car a life (not under a shield); none left: over', () => {
    const g = empty();
    g.car.shield = 0;
    g._choose = () => 'D';                                             // (it keeps facing the M car)
    const e = enemy(g, 'van', PLAYER.x, 4, 'D');
    e.cool = 0; run(g, 2500);
    assert.ok(g.events.some((v) => v.type === 'crash'));
    assert.strictEqual(g.lives, LIVES - 1);
    run(g, 2000);
    assert.ok(g.car.alive && g.car.shield > 0);                       // back, shielded a moment
    e.cool = 0; run(g, 1500);
    assert.strictEqual(g.lives, LIVES - 1);
    g.lives = 1; g.car.shield = 0; g.car.x = PLAYER.x; g.car.y = PLAYER.y;
    e.x = PLAYER.x; e.cool = 0; run(g, 5000);
    assert.ok(g.over);
    assert.strictEqual(g.lost, 'cars');
});

test('the garage stands three enemy shots (not two at once), not the M car\'s own', () => {
    const g = empty();
    g.car.x = BASE.x; g.car.y = BASE.y - 4; g.car.dir = 'D';
    for (let k = 0; k < 6; k++) { g.car.cool = 0; g.fire(); run(g, 400); }
    assert.strictEqual(g.garage, GARAGE_HP);
    g.car.x = 2;
    g._choose = () => 'D';                                             // (it keeps facing the garage)
    const e = enemy(g, 'van', BASE.x + 1, BASE.y - 6, 'D');
    for (let k = 0; k < 20 && !g.lost; k++) { e.cool = 0; run(g, 600); }   // (a hit, then a moment it shrugs off)
    assert.strictEqual(g.garage, 0);
    assert.strictEqual(g.lost, 'garage');
    run(g, 2000);
    assert.ok(g.over);
});

test('four cars on the yard at most, from the ways in at the top', () => {
    const g = new Game({ rng: seeded(5) });
    g.car.shield = 1e9;
    run(g, 30000);
    assert.ok(g.cars.length <= ON_YARD);
    assert.ok(g.come >= ON_YARD);
});

test('power-ups: the cannon, NITRO (they stand), concrete round the garage for a while, an EMP, a spare car', () => {
    const g = empty();
    const e = enemy(g, 'hatch', 30, 4, 'L');
    g._power('star'); assert.strictEqual(g.power, 1);
    g._power('nitro'); const x = e.x; e.turnIn = 0; run(g, 1000); assert.strictEqual(e.x, x);
    g._power('fortify');
    assert.strictEqual(g.grid[RING.y][RING.x], 'c');
    run(g, 16000);
    assert.strictEqual(g.grid[RING.y][RING.x], 't');
    const n = g.score; enemy(g, 'van', 5, 4); g._power('emp');
    assert.strictEqual(g.cars.length, 0);
    g._power('life'); assert.strictEqual(g.lives, LIVES + 1);
    assert.ok(g.score >= n + 1000);
});

test('a flashing car leaves a power-up; the M car picks it up', () => {
    const g = empty();
    g.car.x = 10; g.car.y = 20; g.car.dir = 'U';
    const e = enemy(g, 'van', 10, 5); e.flash = true;
    g.fire(); run(g, 1000);
    assert.ok(g.bonus);
    g.bonus.x = g.car.x; g.bonus.y = g.car.y;
    g.step(DT);
    assert.strictEqual(g.bonus, null);
    assert.ok(g.events.some((v) => v.type === 'power'));
});

test('all twenty stopped: the yard is cleared and the next level starts', () => {
    const g = empty();
    g.killed = PER_LEVEL; g.come = PER_LEVEL;
    g.step(DT);
    assert.ok(g.events.some((v) => v.type === 'cleared'));
    run(g, 3200);
    assert.strictEqual(g.level, 2);
    assert.strictEqual(g.left(), PER_LEVEL);
});

test('automatic fire: only at a car in the line', () => {
    const g = empty({ autoFire: true });
    g.car.x = 10; g.car.y = 20; g.car.dir = 'U';
    run(g, 500);
    assert.strictEqual(g.shots.length, 0);
    enemy(g, 'van', 10, 3);
    run(g, 50);
    assert.ok(g.shots.length >= 1);
});

test('best scores are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
    const f = path.join(dir, 'best.json');
    assert.deepStrictEqual(loadBest(f), {});
    saveBest(f, { normal: 8800 });
    assert.deepStrictEqual(loadBest(f), { normal: 8800 });
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
