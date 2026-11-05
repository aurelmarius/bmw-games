'use strict';
/** Lap Record's physics and timing (apps/aurelm_lap_record/model.js): node tests/lap_record.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../apps/aurelm_lap_record/model');
const { Track, Game, DT, STEP, WIDTH, KERB, RUNOFF, PHYS, GRIP, CIRCUITS, fmtTime, fmtDelta, loadRecords, saveRecords, wrapA, clamp } = M;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = (g, ms, each) => { for (let t = 0; t < ms; t += DT) { if (each && each(g) === true) return true; g.step(DT); } return false; };
const types = (g) => g.events.map((e) => e.type);
/** a game past its start lights */
function going(o) { const g = new Game(Object.assign({ rng: () => 0.5 }, o || {})); run(g, 5200); assert.ok(g.lights.go); g.events = []; return g; }
/** the autopilot: down the track, braking for what the corners ahead allow (k: how hard it pushes) */
function pilot(k) {
    return (g) => {
        const c = g.car, T = g.track;
        const ahead = T.at(c.i + Math.round((6 + c.v * 0.45) / STEP));
        const err = wrapA(Math.atan2(ahead.y - c.y, ahead.x - c.x) - c.h);
        let vt = PHYS.vmax;
        for (let d = 0; d < 160; d += 4) {
            let cv = 0; for (let j = -4; j <= 4; j++) cv += Math.abs(T.at(c.i + d / STEP + j).curv);
            const lim = Math.sqrt(GRIP.asphalt * k / Math.max(1e-4, cv / 9));
            vt = Math.min(vt, Math.sqrt(lim * lim + 2 * PHYS.brake * 0.8 * d));
        }
        g.control(clamp(err * 3, -1, 1), c.v < vt ? 1 : 0, c.v > vt + 1.5 ? 1 : 0);
    };
}

test('the circuits: closed, sampled every 2 m, smooth, no corner tighter than a hairpin', () => {
    for (const id of Object.keys(CIRCUITS)) {
        const t = new Track(id);
        assert.ok(t.length > 1800 && t.length < 2400, id + ' ' + t.length);
        for (let i = 0; i < t.s.length; i++) {
            const a = t.s[i], b = t.at(i + 1);
            assert.ok(Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - STEP) < 0.3, id + ': a step of ' + Math.hypot(b.x - a.x, b.y - a.y) + ' at ' + i);
            assert.ok(Math.abs(a.curv) < 0.07, id + ': too tight at ' + i);
        }
        assert.ok(t.s.some((q) => q.kerb) && t.s.some((q) => q.gravel), id + ': kerbs and gravel');
    }
});

test('where on the track: the nearest sample, across (+ = right), along; the ground there', () => {
    const t = new Track('riverside');
    const q = t.s[100];
    const n = t.nearest(q.x + q.nx * 3, q.y + q.ny * 3);
    assert.ok(Math.abs(n.i - 100) <= 1 && Math.abs(n.lat - 3) < 0.3, JSON.stringify(n));
    assert.strictEqual(t.surface(q, 0), 'asphalt');
    assert.strictEqual(t.surface(q, WIDTH / 2 + RUNOFF / 2), q.gravel === 1 ? 'gravel' : 'grass');
    const k = t.s.find((x) => x.kerb && x.wall[0] && x.wall[1]);
    assert.strictEqual(t.surface(k, WIDTH / 2 + KERB / 2), 'kerb');
    assert.strictEqual(t.surface(k, WIDTH / 2 + RUNOFF + 1), 'wall');
    // the gravel is on the outside of the corner
    const c = t.s.find((x) => x.gravel && Math.abs(x.curv) > 0.02);
    assert.strictEqual(c.gravel, c.curv > 0 ? -1 : 1);
});

test('the start: five red lights, a second apart, then out; the car can\'t go before', () => {
    const g = new Game({ rng: () => 0.5 });
    g.control(0, 1, 0);
    const lights = [];
    run(g, 6000, (x) => { for (const e of x.events.splice(0)) lights.push(e.type === 'light' ? e.n : e.type); });
    assert.deepStrictEqual(lights, [1, 2, 3, 4, 5, 'go']);
    const x0 = new Game({ rng: () => 0.5 });
    const p = [x0.car.x, x0.car.y];
    x0.control(0, 1, 0); run(x0, 3000);
    assert.deepStrictEqual([x0.car.x, x0.car.y], p);
});

test('flat out: past 170 km/h down the main straight; the brakes stop it in a sensible distance', () => {
    const g = going();
    // a straight: the first 400 m of Riverside
    let top = 0;
    const steer = pilot(0.85);
    run(g, 9000, (x) => { steer(x); x.control(x.ctrl.steer, 1, 0); top = Math.max(top, x.car.v); return x.track.s[x.car.i].d > 420 && x.track.s[x.car.i].d < 600; });
    assert.ok(top * 3.6 > 170 && top < PHYS.vmax, 'top ' + (top * 3.6).toFixed(0) + ' km/h at the end of the straight');
    const g2 = going();
    run(g2, 5000, (x) => { steer(x); x.control(x.ctrl.steer, 1, 0); });
    const v0 = g2.car.v, x0 = g2.car.x, y0 = g2.car.y;
    run(g2, 8000, (x) => { steer(x); x.control(x.ctrl.steer, 0, 1); return x.car.v === 0; });
    const d = Math.hypot(g2.car.x - x0, g2.car.y - y0);
    assert.ok(d > v0 * v0 / (2 * PHYS.brake) * 0.8 && d < v0 * v0 / (2 * PHYS.brake) * 1.6, 'from ' + (v0 * 3.6).toFixed(0) + ' km/h in ' + d.toFixed(0) + ' m');
});

test('steering: the car turns the way it\'s steered; too fast into a corner it slides wide', () => {
    const g = going();
    run(g, 2000, (x) => { x.control(0, 1, 0); });
    const h0 = g.car.h;
    run(g, 300, (x) => { x.control(1, 0, 0); });
    assert.ok(wrapA(g.car.h - h0) > 0.05, 'right: the heading goes up (y is south)');
    const s = going();
    s.car.v = 60;                                              // 216 km/h, full lock
    let slid = false;
    run(s, 800, (x) => { x.control(1, 0, 0); if (x.car.sliding) slid = true; });
    assert.ok(slid && s.car.v < 58, 'it slid and lost speed: ' + s.car.v);
});

test('off the track it\'s slow; into the barrier it bounces off and loses most of its speed', () => {
    const coast = (lat) => {
        const g = going();
        const i = g.track.s.findIndex((x) => x.d > 100 && !x.kerb), q = g.track.s[i];
        Object.assign(g.car, { x: q.x + q.nx * lat, y: q.y + q.ny * lat, h: Math.atan2(q.ty, q.tx), dir: Math.atan2(q.ty, q.tx), v: 40, i });
        run(g, 1000, (x) => { x.control(0, 0, 0); });
        return g.car;
    };
    const on = coast(0), off = coast(WIDTH / 2 + 6);
    assert.ok(off.surface === 'grass' || off.surface === 'gravel', off.surface);
    assert.ok(off.v < on.v - 2, 'grass ' + off.v.toFixed(1) + ' < asphalt ' + on.v.toFixed(1));
    // into the wall: a straight bit with a barrier on the right
    const w = going();
    const i = w.track.s.findIndex((x) => x.wall[0] && !x.kerb && x.d > 60);
    const p = w.track.s[i];
    Object.assign(w.car, { x: p.x + p.nx * (WIDTH / 2 + RUNOFF - 3), y: p.y + p.ny * (WIDTH / 2 + RUNOFF - 3), h: Math.atan2(p.ny, p.nx), dir: Math.atan2(p.ny, p.nx), v: 30, i });
    run(w, 600, (x) => { x.control(0, 0, 0); return x.events.some((e) => e.type === 'wall'); });
    assert.ok(types(w).includes('wall') && w.car.v < 16, w.car.v);
    const n = w.track.nearest(w.car.x, w.car.y);
    assert.ok(Math.abs(n.lat) <= WIDTH / 2 + RUNOFF);
});

test('laps: timed from the line in three sectors; the best one kept with its ghost; the ghost drives it again', () => {
    const g = going();
    const p = pilot(0.85), laps = [], secs = [];
    run(g, 200000, (x) => { p(x); for (const e of x.events.splice(0)) { if (e.type === 'lapDone') laps.push(e); if (e.type === 'sector') secs.push(e); } return laps.length >= 3; });
    assert.strictEqual(laps.length, 3);
    for (const l of laps) assert.ok(l.valid && l.time > 40000 && l.time < 75000, fmtTime(l.time));
    assert.ok(laps[0].record && g.best && g.best.ghost.length > 500);
    assert.strictEqual(secs.length, 9);
    const l2 = laps[1], s2 = secs.slice(3, 6).reduce((a, e) => a + e.ms, 0);
    assert.ok(Math.abs(s2 - l2.time) <= 2, 'the sectors add up to the lap: ' + s2 + ' / ' + l2.time);
    assert.strictEqual(secs[0].colour, 'purple');             // the first lap: every sector the best yet
    // the ghost: where the best lap was this far into it; the gap to it near 0 driving the same way
    run(g, 6000, (x) => { p(x); x.events = []; });
    const gh = g.ghost(), d = g.delta();
    assert.ok(gh && Math.hypot(gh.x - g.car.x, gh.y - g.car.y) < 25, 'the ghost is near');
    assert.ok(d !== null && Math.abs(d) < 600, 'the gap: ' + d);
});

test('a lap with too long off the track doesn\'t count (nor make a record)', () => {
    const g = going();
    const p = pilot(0.85);
    let cut = false, done = null;
    run(g, 200000, (x) => {
        p(x);
        if (x.lap === 1 && x.track.s[x.car.i].d > 900 && x.track.s[x.car.i].d < 1000 && !cut) {
            const q = x.track.s[x.car.i];
            x.car.x += q.nx * 12; x.car.y += q.ny * 12; cut = true;            // out onto the grass
        }
        for (const e of x.events.splice(0)) if (e.type === 'lapDone') done = e;
        return !!done;
    });
    assert.ok(cut && done && !done.valid && !done.record, JSON.stringify(done));
    assert.strictEqual(g.best, null);
});

test('the clock\'s looks: 1:02.345, gaps with their sign', () => {
    assert.strictEqual(fmtTime(62345), '1:02.345');
    assert.strictEqual(fmtTime(9050), '0:09.050');
    assert.strictEqual(fmtTime(null), '-:--.---');
    assert.strictEqual(fmtDelta(-214), '-0.214');
    assert.strictEqual(fmtDelta(1500), '+1.500');
});

test('the records are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'));
    const f = path.join(dir, 'best.json');
    assert.deepStrictEqual(loadRecords(f), {});
    const r = { riverside: { best: { time: 54321, sectors: [1, 2, 3], ghost: [[0, 1, 2, 0]] }, sectors: [1, 2, 3] } };
    saveRecords(f, r);
    assert.deepStrictEqual(loadRecords(f), r);
    const g = new Game({ circuit: 'riverside', best: r.riverside.best, bestSectors: r.riverside.sectors });
    assert.strictEqual(g.best.time, 54321);
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
