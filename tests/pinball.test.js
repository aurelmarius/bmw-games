'use strict';
/** M Pinball's rules and physics (apps/aurelm_pinball/model.js): node tests/pinball.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../apps/aurelm_pinball/model');
const { Game, DT, POINTS, BUMPERS, PIVOTS, FLIP, RAMP, seeded, closest, loadBest, saveBest } = M;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = (g, ms, each) => { for (let t = 0; t < ms; t += DT) { if (each) each(g); g.step(DT); } };
/** a game with one ball placed at (u, v) moving (vu, vv), nothing on the plunger */
function placed(u, v, vu, vv, o) {
    const g = new Game(Object.assign({ rng: seeded(1) }, o || {}));
    g.balls = [];
    const b = g._ball(u, v); b.vu = vu || 0; b.vv = vv || 0;
    g.balls.push(b);
    return { g, b };
}
const types = (g) => g.events.map((e) => e.type);
/** an autopilot on the flippers: up when a ball is about to reach one, for a moment */
function pilot(rng) {
    const st = { hold: [0, 0], cool: [0, 0] };
    return (g) => {
        for (let s = 0; s < 2; s++) {
            const p = PIVOTS[s], tip = g.flipperTip(s, FLIP.rest);
            if (st.hold[s] > 0) { st.hold[s] -= DT; if (st.hold[s] <= 0) { g.flipper(s, false); st.cool[s] = 250; } continue; }
            if (st.cool[s] > 0) { st.cool[s] -= DT; continue; }
            const near = g.balls.some((b) => {
                if (b.plunger || b.ramp || b.hold) return false;
                const fu = b.u + b.vu * 0.03, fv = b.v + b.vv * 0.03, q = closest([p.u, p.v], tip, fu, fv);
                return Math.hypot(fu - q[0], fv - q[1]) < 30 && q[2] > 0.3;
            });
            if (near) { g.flipper(s, true); st.hold[s] = 200; }
        }
        if (g.onPlunger()) { g.setPull(0.45 + rng() * 0.5); g.launch(); }
    };
}

test('the ball waits on the plunger; a weak launch comes back down the lane, a strong one goes round the arch', () => {
    const g = new Game({ rng: seeded(2) });
    assert.ok(g.onPlunger());
    run(g, 3000);
    assert.ok(g.onPlunger(), 'it waits');
    g.setPull(0.1); g.launch();
    let top = 9999;
    run(g, 3000, () => { if (g.balls[0]) top = Math.min(top, g.balls[0].v); });
    assert.ok(g.onPlunger() && top > 300, 'back on the plunger, it rose to ' + top);
    g.setPull(1); g.launch();
    top = 9999;
    let left = 9999;
    run(g, 1500, () => { const b = g.balls[0]; if (b) { top = Math.min(top, b.v); if (b.v < 300) left = Math.min(left, b.u); } });
    assert.ok(top < 40, 'up to the arch: ' + top);
    assert.ok(left < 120, 'and round it to the left: ' + left);
    assert.ok(!g.onPlunger());
});

test('a ball never leaves the table nor stays stuck: 30 games played by an autopilot', () => {
    const rng = seeded(9);
    let ms = 0, laps = 0, pits = 0, bumpers = 0;
    for (let n = 0; n < 30; n++) {
        const g = new Game({ rng: seeded(100 + n) });
        const p = pilot(rng), still = new Map();
        let t = 0;
        while (!g.over && t < 15 * 60000) {
            p(g); g.step(DT); t += DT;
            for (const e of g.events.splice(0)) { if (e.type === 'lap') laps++; if (e.type === 'pit' || e.type === 'multiball' || e.type === 'extraBall') pits++; if (e.type === 'bumper') bumpers++; }
            for (const b of g.balls) {
                assert.ok(b.u > -2 && b.u < 602 && b.v > -2, 'escaped at ' + b.u + ',' + b.v);
                if (b.plunger || b.hold || b.ramp) continue;
                const k = Math.hypot(b.vu, b.vv) < 8 ? (still.get(b) || 0) + DT : 0;
                still.set(b, k);
                assert.ok(k < 4000, 'stuck at ' + b.u.toFixed(1) + ',' + b.v.toFixed(1));
            }
        }
        assert.ok(g.over, 'a game ends');
        ms += t;
    }
    assert.ok(ms / 30 > 30000, 'a game lasts ' + Math.round(ms / 30000) + ' s');
    assert.ok(laps > 0 && pits > 0 && bumpers > 100, 'laps ' + laps + ', pits ' + pits + ', bumpers ' + bumpers);
});

test('a flipper bats a ball resting on it up the table', () => {
    const { g, b } = placed(58, 940, 0, 0);
    g.saveUntil = 1e9;
    g.flipper(0, true); run(g, 1500);                       // the ball rolls down the inlane into the cradle
    assert.ok(Math.abs(b.v - 1062) < 15 && Math.hypot(b.vu, b.vv) < 30, 'cradled at ' + b.u + ',' + b.v);
    g.flipper(0, false); run(g, 500);                      // let go: it rolls down the flipper
    g.flipper(0, true); g.step(DT); g.step(DT);
    assert.ok(b.vv < -1200, 'batted up at ' + b.vv);
    assert.ok(types(g).includes('bat'));
});

test('flipped at the right moment, the left flipper makes the CHICANE and the right one the PIT LANE', () => {
    const outcome = (side, delay) => {
        const { g, b } = placed(side ? 497 : 58, 940, 0, 0);
        g.saveUntil = 1e9;
        g.flipper(side, true); run(g, 1500);
        g.flipper(side, false); run(g, delay);
        g.flipper(side, true); g.events = [];
        for (let t = 0; t < 2500; t += DT) { g.step(DT); const e = g.events.find((x) => ['lap', 'pit', 'rampBack'].includes(x.type)); if (e) return e.type; }
        return b ? '-' : '-';
    };
    const hits = (side, want) => { let n = 0; for (let d = 560; d < 760; d += 4) if (outcome(side, d) === want) n++; return n; };
    assert.ok(hits(0, 'lap') >= 2, 'the ramp from the left');
    assert.ok(hits(1, 'pit') >= 2, 'the pit from the right');
});

test('the CHICANE: in fast, round the wire to the left inlane (a lap); too slow, it rolls back out', () => {
    const { g, b } = placed(420, 612, 0, -1500);
    g.step(DT);
    assert.ok(b.ramp, 'on the ramp');
    for (let t = 0; t < 3000 && b.ramp; t += DT) g.step(DT);
    assert.ok(!b.ramp && types(g).includes('lap'), types(g).join(' '));
    assert.ok(Math.abs(b.u - RAMP[RAMP.length - 1][0]) < 10 && b.v > 860 && b.vv > 0, 'down at the inlane: ' + b.u + ',' + b.v);
    assert.strictEqual(g.score, POINTS.lap);
    const s = placed(420, 606, 0, -500);
    run(s.g, 2500);
    assert.ok(s.g.events.some((e) => e.type === 'rampBack') && !s.g.events.some((e) => e.type === 'lap'));
    assert.ok(s.b.v > 600, 'back on the playfield');
});

test('laps within 4 s are a combo; every 5th lights an extra ball, collected at the pit', () => {
    const g = new Game({ rng: seeded(3) });
    const b = g.balls[0]; b.plunger = false; b.inLane = false;
    for (let i = 1; i <= 5; i++) { g.ms += 1000; g._lap(b); }
    const laps = g.events.filter((e) => e.type === 'lap').map((e) => e.combo);
    assert.deepStrictEqual(laps, [1, 2, 3, 4, 5]);
    assert.ok(g.extraLit && types(g).includes('fastLap'));
    g.ms += 10000; g._lap(b);
    assert.strictEqual(g.events.filter((e) => e.type === 'lap').pop().combo, 1);
    g._pit(b);
    assert.ok(types(g).includes('extraBall') && g.extra === 1 && !g.extraLit);
});

test('the bumpers kick the ball away and score; the slings kick it back across', () => {
    const q = BUMPERS[2];
    const { g, b } = placed(q.u, q.v - q.r - 30, 0, 300);
    run(g, 200);
    assert.ok(types(g).includes('bumper'));
    assert.ok(g.score >= POINTS.bumper && b.vv < -500, 'kicked: ' + b.vv);
    const s = placed(140, 930, 0, 0);
    s.b.vu = -400;
    run(s.g, 400);
    assert.ok(s.g.events.some((e) => e.type === 'sling'), 'the sling: ' + s.g.events.map((e) => e.type).join(' '));
    assert.ok(s.b.u > 150, 'sent across: ' + s.b.u);
});

test('the lanes: all three lit gear the bonus up; the flippers move the lit ones along', () => {
    const g = new Game({ rng: seeded(4) });
    const b = g.balls[0]; b.plunger = false;
    g._lane(0, b); g._lane(2, b);
    assert.deepStrictEqual(g.lanes, [true, false, true]);
    g.flipper(1, true); g.flipper(1, false);                  // the right flipper: along to the right
    assert.deepStrictEqual(g.lanes, [true, true, false]);
    g._lane(2, b);
    assert.deepStrictEqual(g.lanes, [false, false, false]);
    assert.strictEqual(g.gear, 2);
    assert.ok(types(g).includes('gear'));
    for (let k = 0; k < 6; k++) for (let i = 0; i < 3; i++) g._lane(i, b);
    assert.strictEqual(g.gear, 5);                            // x5 at most
});

test('a ball through the lane blinking at its launch is a skill shot', () => {
    const g = new Game({ rng: seeded(5) });
    run(g, 950);                                             // the skill lane walks while it waits
    assert.strictEqual(g.skillLane, 1);
    g.setPull(0.5); g.launch();
    const b = g.balls[0];
    g._lane(1, b);
    assert.ok(types(g).includes('skill'));
    assert.strictEqual(g.score, POINTS.skill + POINTS.lane);
    const h = new Game({ rng: seeded(5) });
    run(h, 950); h.setPull(0.5); h.launch();
    h._lane(0, h.balls[0]);
    assert.ok(!types(h).includes('skill'));
});

test('M-POWER: six targets open the pit; the pit then starts a three ball multiball; laps are jackpots', () => {
    const g = new Game({ rng: seeded(6) });
    const b = g.balls[0]; b.plunger = false; b.inLane = false; b.u = 300; b.v = 500;
    for (let i = 0; i < 6; i++) g._target(i);
    g._target(0);                                            // again: points, nothing new
    assert.ok(g.pitLit && types(g).filter((t) => t === 'mpower').length === 1);
    g._pit(b);
    assert.ok(g.multiball && types(g).includes('multiball'));
    run(g, 6000);
    assert.strictEqual(g.balls.length, 3, 'three in play');
    assert.ok(g.balls.every((x) => !x.plunger && !x.hold));
    const s0 = g.score;
    g._lap(g.balls[0]);
    g.ms += 10000; g._lap(g.balls[0]);
    const jp = g.events.filter((e) => e.type === 'jackpot').map((e) => e.pts);
    assert.deepStrictEqual(jp, [POINTS.jackpot, POINTS.jackpot + POINTS.jackpotStep]);
    assert.ok(g.score - s0 >= 2 * POINTS.jackpot);
    // two drained (save over): back to one ball, the targets reset
    g.saveUntil = 0;
    g._drain(g.balls[2]); g._drain(g.balls[1]);
    assert.ok(!g.multiball && types(g).includes('multiballEnd'));
    assert.ok(g.targets.every((t) => !t));
    assert.strictEqual(g.ballNo, 1);
});

test('ball save: a ball drained just after its launch comes back to the plunger, once', () => {
    const g = new Game({ rng: seeded(7) });
    g.setPull(0.6); g.launch();
    run(g, 1000);
    g._drain(g.balls[0]);
    assert.ok(types(g).includes('saved') && g.onPlunger() && g.ballNo === 1);
    g.setPull(0.6); g.launch();
    run(g, 1000);
    g._drain(g.balls[0]);
    assert.strictEqual(g.ballNo, 2);
    assert.ok(types(g).includes('drain'));
});

test('a drained ball pays its bonus times the gear; the game is three balls (or five)', () => {
    const g = new Game({ rng: seeded(8) });
    g.saveUsed = true;
    g.tally = { targets: 2, laps: 1, bumpers: 10 }; g.gear = 3;
    const s = g.score;
    g.setPull(0.6); g.launch(); g._drain(g.balls[0]);
    const raw = 2 * 5000 + 20000 + 10 * 1000;
    assert.strictEqual(g.score - s, raw * 3);
    assert.strictEqual(g.gear, 1);                            // a new ball: x1 again
    for (let i = 0; i < 2; i++) { g.saveUsed = true; g.launch(); g._drain(g.balls[0]); }
    assert.ok(g.over);
    const five = new Game({ rng: seeded(8), balls: 5 });
    for (let i = 0; i < 4; i++) { five.saveUsed = true; five.launch(); five._drain(five.balls[0]); }
    assert.ok(!five.over && five.ballNo === 5);
});

test('nudges: a shove to the ball; the third within 6 s tilts (dead flippers, no bonus)', () => {
    const { g, b } = placed(300, 500, 0, 0);
    g.nudge(1);
    assert.ok(b.vv < -150 && b.vu > 50);
    g.ms += 1000; g.nudge(-1);
    assert.strictEqual(g.events.filter((e) => e.type === 'nudge').pop().warn, 2);
    g.ms += 1000; g.nudge(1);
    assert.ok(g.tilted && types(g).includes('tilt'));
    g.flipper(0, true);
    assert.ok(!g.flip[0].held);
    g.tally = { targets: 5, laps: 5, bumpers: 5 };
    const s = g.score;
    g._drain(b);
    assert.strictEqual(g.score, s);
    assert.ok(!g.tilted, 'the next ball is clean');
    const h = placed(300, 500, 0, 0).g;
    h.nudge(); h.ms += 7000; h.nudge(); h.ms += 7000; h.nudge();
    assert.ok(!h.tilted, 'spread out: no tilt');
});

test('a ball left on the plunger goes by itself after a while', () => {
    const g = new Game({ rng: seeded(10) });
    run(g, 14000);
    assert.ok(g.onPlunger());
    run(g, 1500);
    assert.ok(!g.onPlunger() || types(g).includes('back'));
    assert.ok(types(g).includes('launch'));
});

test('best scores are kept in a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
    const f = path.join(dir, 'best.json');
    assert.deepStrictEqual(loadBest(f), {});
    saveBest(f, { 'normal-3': 1234500 });
    assert.deepStrictEqual(loadBest(f), { 'normal-3': 1234500 });
    fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
