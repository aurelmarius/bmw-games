'use strict';
/**
 * M Pinball's rules and physics: no drawing here (art.js), no head unit (main.js); tests/pinball.test.js.
 *
 * The table is a plane, u across (0..600) and v down it (0 at the top, 1200 at the flippers' end), a
 * steel ball of radius 14 rolling on it under gravity along +v. The world is stepped at 60 Hz in 8 sub
 * steps (480 Hz), so a ball at full speed moves less than half its radius between two looks.
 *
 *   walls      capsules (a segment with a radius): the arch, the sides, the guides, the posts
 *   bumpers    three wheels that kick the ball away (1 000)
 *   slings     the two triangles above the flippers: their inner side kicks (100)
 *   flippers   two tapered capsules turning about a pivot; the ball gets the speed of the flipper where
 *              it touches it
 *   lanes      GEARS 1 2 3 at the top: all three lit = a gear up (bonus x2 .. x5). The flippers move
 *              the lit ones along. The lane blinking while the ball waits on the plunger is the skill
 *              shot (100 000) when it's the first one the launched ball rolls through.
 *   targets    M P O W E R, two banks of three: all six open the PIT LANE (150 000)
 *   PIT LANE   a saucer that holds the ball and kicks it out: open = SAFETY CAR MULTIBALL (3 balls,
 *              the CHICANE then scores jackpots: 500 000, +100 000 each); else an extra ball when
 *              lit (every 5th lap), else 25 000
 *   CHICANE    the ramp: a ball that runs in fast enough goes up it, over the top and down the wire to
 *              the left inlane (a lap: 25 000, x2 within 4 s of the last); too slow, it rolls back
 *   ball save  a ball drained within a few seconds of its launch comes back
 *   nudge      a shove to the table; the third within 6 s tilts it (the flippers die, no bonus)
 * A drained ball pays its bonus (targets, laps, bumpers) times the gear; the game is 3 (or 5) balls.
 */
const fs = require('fs');

const DT = 1000 / 60;                 // ms per step
const SUB = 8;                        // sub steps per step
const TW = 600, TL = 1200, R = 14;
const DIFF = {
    easy: { g: 900, save: 15000 },
    normal: { g: 1050, save: 10000 },
    hard: { g: 1200, save: 6000 },
};
const MAX_V = 3000;
const AUTO_MS = 15000;              // a ball left on the plunger this long goes by itself
const POINTS = { bumper: 1000, sling: 100, lane: 5000, gear: 50000, target: 10000, mpower: 150000, lap: 25000, pit: 25000, skill: 100000, jackpot: 500000, jackpotStep: 100000, fastLap: 250000 };
const BONUS = { target: 5000, lap: 20000, bumper: 1000 };
const MIRROR = (u) => 555 - u;

/* ---------- the table ---------- */
const PLUNGER = { u: 577.5, v: 1100 };
const ARCH = { u: 300, v: 300, r: 300 };
const LANES = [172.5, 237.5, 302.5];                 // GEARS 1 2 3 (centres; sensors at v 150)
const LANE_POSTS = [140, 205, 270, 335];
const BUMPERS = [{ u: 210, v: 330, r: 34 }, { u: 350, v: 315, r: 34 }, { u: 282, v: 445, r: 34 }];
const PIT = { u: 100, v: 560 };
// M P O: a bank facing down on the left; W E R: one facing the left flipper on the right
const TARGETS = [[190, 652, 0, 1], [220, 642, 0, 1], [250, 632, 0, 1], [519, 632, -1, 0], [524, 684, -1, 0], [529, 736, -1, 0]].map(([u, v, fu, fv], i) => {
    // along the bank: the left one rises to the right, the right one runs down the side
    const du = fv ? 12.3 : 1.4, dv = fv ? -4.1 : 13;
    return { u, v, a: [u - du, v - dv], b: [u + du, v + dv], face: [fu, fv], letter: 'MPOWER'[i] };
});
const SLING_L = { a: [78, 880], b: [78, 995], c: [158, 1026] };
const SLING_R = { a: [MIRROR(78), 880], b: [MIRROR(78), 995], c: [MIRROR(158), 1026] };
const FLIP = { len: 84, r0: 13, r1: 7, rest: 0.52, up: -0.45, wUp: 32, wDown: 20 };
const PIVOTS = [{ u: 176, v: 1092 }, { u: 379, v: 1092 }];
const MOUTH = { a: [382, 600], b: [458, 600] };
// the ramp: up the plastic to the top (TOP), then the wire round and down to the left inlane
const RAMP = [[420, 600], [428, 500], [446, 400], [466, 320], [462, 240], [435, 180], [400, 145],
    [360, 95], [300, 70], [230, 72], [165, 95], [110, 140], [70, 210], [45, 320], [40, 460], [44, 620], [52, 760], [58, 870]];
const RAMP_TOP = 6;                                   // index of the plastic's end, its highest point
const RAMP_UP = 560, RAMP_DOWN = 260;                // u/s^2 against and along the ball

function pathLens(p) { const s = [0]; for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])); return s; }
const RAMP_S = pathLens(RAMP);
const RAMP_LEN = RAMP_S[RAMP_S.length - 1];
/** a point of the ramp s along it: [u, v, du, dv] (the direction) */
function rampAt(s) {
    s = Math.max(0, Math.min(RAMP_LEN, s));
    let i = 1;
    while (i < RAMP.length - 1 && RAMP_S[i] < s) i++;
    const a = RAMP[i - 1], b = RAMP[i], l = RAMP_S[i] - RAMP_S[i - 1], t = (s - RAMP_S[i - 1]) / l;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / l, (b[1] - a[1]) / l];
}
/** the ramp's height above the playfield s along it (0..1): for the shadow and the size */
function rampHeight(s) {
    const top = RAMP_S[RAMP_TOP];
    return s <= top ? s / top : Math.max(0, 1 - (s - top) / (RAMP_LEN - top) * 0.85);
}

/** the walls: capsules { a, b, r, e (bounce), kind, kick } */
function buildWalls() {
    const W = [];
    const wall = (a, b, o) => W.push(Object.assign({ a, b, r: 3, e: 0.45, kind: 'wall' }, o || {}));
    // the arch (the top half of a circle) and the sides
    const N = 36;
    for (let i = 0; i < N; i++) {
        const a0 = Math.PI + i / N * Math.PI, a1 = Math.PI + (i + 1) / N * Math.PI;
        wall([ARCH.u + Math.cos(a0) * ARCH.r, ARCH.v + Math.sin(a0) * ARCH.r], [ARCH.u + Math.cos(a1) * ARCH.r, ARCH.v + Math.sin(a1) * ARCH.r], { e: 0.35 });
    }
    wall([0, 300], [0, 1300]);
    // the left orbit's end: a rubber that turns a ball coming down the side wall back into play
    wall([0, 580], [60, 640], { r: 5, e: 0.6, kind: 'rubber' });
    wall([600, 300], [600, 1200]);
    // the shooter lane: its inner wall, the one-way gate at its top
    wall([555, 345], [555, 1200]);
    wall([555, 345], [600, 303], { kind: 'gate', e: 0.3 });
    // the lanes' posts at the top
    for (const u of LANE_POSTS) wall([u, 105], [u, 175], { r: 4, e: 0.5, kind: 'post' });
    // the ramp's mouth: two short guides
    wall([382, 600], [388, 525], { r: 4 });
    wall([458, 600], [466, 525], { r: 4 });
    // over the right bank of targets: a cap down to the lane's wall (no pocket behind them)
    wall([517.6, 619], [553, 589], { r: 4 });
    // inlane guides and slingshots, both sides
    for (const m of [false, true]) {
        const f = m ? MIRROR : (u) => u, S = m ? SLING_R : SLING_L;
        wall([f(38), 900], [f(38), 1046]);
        wall([f(38), 1046], [f(168), 1074]);          // ends over the flipper's pivot: the ball rolls on
        wall(S.a, S.b, { e: 0.3 });
        wall(S.b, S.c, { e: 0.3 });
        wall(S.a, S.c, { kind: 'sling', e: 0.6, kick: 520, side: m ? 1 : 0 });
    }
    // the targets
    TARGETS.forEach((t, i) => wall(t.a, t.b, { r: 5, e: 0.35, kind: 'target', i }));
    return W;
}
const WALLS = buildWalls();

/* ---------- geometry ---------- */
function closest(a, b, pu, pv) {
    const du = b[0] - a[0], dv = b[1] - a[1], l2 = du * du + dv * dv;
    let t = l2 ? ((pu - a[0]) * du + (pv - a[1]) * dv) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return [a[0] + du * t, a[1] + dv * t, t];
}

function seeded(s) { s = (s >>> 0) || 1; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.difficulty = DIFF[o.difficulty] ? o.difficulty : 'normal';
        this.g = DIFF[this.difficulty].g;
        this.saveMs = DIFF[this.difficulty].save;
        this.ballsPerGame = o.balls === 5 ? 5 : 3;
        this.score = 0;
        this.ballNo = 1;
        this.extra = 0;                          // extra balls waiting
        this.extraLit = false; this.extraGiven = false;
        this.over = false;
        this.events = [];
        this.ms = 0;
        this.flip = [{ a: FLIP.rest, w: 0, held: false }, { a: FLIP.rest, w: 0, held: false }];
        this.pull = 0;                           // the plunger, 0..1
        this.balls = [];
        this.tiltWarn = []; this.tilted = false;
        this.multiball = false; this.jackpot = POINTS.jackpot;
        this.queue = 0;                          // balls still to be put on the plunger (multiball)
        this.autoAt = 0;
        this.lapsGame = 0;
        this._newBallState();
        this._toPlunger(false);
    }

    /* ----- the state that a ball starts with ----- */
    _newBallState() {
        this.lanes = [false, false, false];
        this.gear = 1;
        this.targets = [false, false, false, false, false, false];
        this.pitLit = false;
        this.saveUntil = 0; this.saveUsed = false;
        this.tally = { targets: 0, laps: 0, bumpers: 0 };
        this.skillLane = 0; this.skillOpen = false;
        this.lastLap = -1e9; this.combo = 0;
        this.tilted = false; this.tiltWarn = [];
    }
    _ball(u, v) { return { u, v, vu: 0, vv: 0, plunger: false, inLane: false, ramp: null, hold: 0, id: Math.floor(this.rng() * 1e9), lane: -1, launchedAt: 0 }; }
    _toPlunger(auto) {
        const b = this._ball(PLUNGER.u, PLUNGER.v);
        b.plunger = true; b.inLane = true;
        this.balls.push(b);
        this.pull = 0;
        if (auto) this.autoAt = this.ms + 700; else this.autoAt = 0;
        this.waitSince = this.ms;
        this.skillOpen = !this.multiball && !auto;
        return b;
    }
    onPlunger() { return this.balls.find((b) => b.plunger) || null; }
    emit(type, o) { this.events.push(Object.assign({ type }, o || {})); }
    add(pts) { this.score += pts; }

    /* ----- the player ----- */
    flipper(side, up) {
        const f = this.flip[side];
        if (this.tilted || this.over) up = false;
        if (up && !f.held) {
            this.emit('flip', { side });
            // the lit lanes move along with the flipper
            if (side === 0) this.lanes.push(this.lanes.shift()); else this.lanes.unshift(this.lanes.pop());
        }
        f.held = up;
    }
    setPull(p) { this.pull = Math.max(0, Math.min(1, p)); }
    launch() {
        const b = this.onPlunger();
        if (!b) { this.pull = 0; return false; }
        const p = this.pull;
        b.plunger = false;
        b.vv = -(900 + 1600 * p); b.vu = 0;
        b.launchedAt = this.ms;
        if (!this.saveUsed && !this.multiball) this.saveUntil = this.ms + this.saveMs;
        this.pull = 0;
        this.emit('launch', { power: p });
        return true;
    }
    nudge(dir) {
        if (this.tilted || this.over) return;
        const d = dir || (this.rng() < 0.5 ? -1 : 1);
        for (const b of this.balls) if (!b.plunger && !b.ramp && !b.hold) { b.vu += d * 90; b.vv -= 200; }
        this.tiltWarn = this.tiltWarn.filter((t) => this.ms - t < 6000);
        this.tiltWarn.push(this.ms);
        if (this.tiltWarn.length >= 3) {
            this.tilted = true;
            this.flip.forEach((f) => { f.held = false; });
            this.emit('tilt');
        } else this.emit('nudge', { warn: this.tiltWarn.length });
    }

    /* ----- a step of DT ms ----- */
    step(dt) {
        dt = dt || DT;
        if (this.over) return;
        this.ms += dt;
        const h = dt / 1000 / SUB;
        // the skill lane walks while the ball waits; an auto launch for multiball balls
        const pb = this.onPlunger();
        if (pb && this.skillOpen) this.skillLane = Math.floor((this.ms - this.waitSince) / 900) % 3;
        // a ball left waiting goes by itself after a while (not while it's being pulled)
        if (pb && !this.autoAt && this.pull === 0 && this.ms - this.waitSince > AUTO_MS) this.autoAt = this.ms;
        if (pb && this.autoAt && this.ms >= this.autoAt) { this.pull = 0.62 + this.rng() * 0.25; this.launch(); this.autoAt = 0; }
        if (!pb && this.queue > 0 && !this.balls.some((b) => b.inLane)) { this.queue--; this._toPlunger(true); }
        for (let k = 0; k < SUB; k++) {
            for (const f of this.flip) {
                const target = f.held ? FLIP.up : FLIP.rest;
                const sp = (f.held ? FLIP.wUp : FLIP.wDown) * h;
                const prev = f.a;
                if (f.a > target) f.a = Math.max(target, f.a - sp); else f.a = Math.min(target, f.a + sp);
                f.w = (f.a - prev) / h;                     // rad/s, negative going up (the left one)
            }
            for (const b of this.balls) this._move(b, h);
            if (this.balls.length > 1) this._ballsMeet();
        }
        // drained balls
        for (const b of this.balls.slice()) if (b.v > TL + 40) this._drain(b);
    }

    _move(b, h) {
        if (b.plunger) { b.u = PLUNGER.u; b.v = PLUNGER.v + this.pull * 36; b.vu = b.vv = 0; return; }
        if (b.hold > 0) {
            b.hold -= h * 1000;
            b.u = PIT.u; b.v = PIT.v; b.vu = b.vv = 0;
            if (b.hold <= 0) { b.hold = 0; b.vu = 560; b.vv = 330; b.u += 18; b.v += 10; this.emit('kick'); }
            return;
        }
        if (b.ramp) return this._rampMove(b, h);
        const pu = b.u, pv = b.v;
        b.vv += this.g * h;
        const damp = 1 - 0.12 * h;
        b.vu *= damp; b.vv *= damp;
        const sp = Math.hypot(b.vu, b.vv);
        if (sp > MAX_V) { b.vu *= MAX_V / sp; b.vv *= MAX_V / sp; }
        b.u += b.vu * h; b.v += b.vv * h;
        if (b.inLane && b.v < 290) b.inLane = false;
        // back down the lane onto the plunger
        if (b.inLane && b.u > 555 && b.v >= PLUNGER.v && b.vv > 0) { b.plunger = true; b.u = PLUNGER.u; b.v = PLUNGER.v; b.vu = b.vv = 0; this.waitSince = this.ms; this.emit('back'); return; }
        // into the ramp: across the mouth going up
        if (b.vv < 0 && pv >= MOUTH.a[1] && b.v < MOUTH.a[1] && b.u > MOUTH.a[0] + 4 && b.u < MOUTH.b[0] - 4) {
            const s = Math.max(0, -b.vv * 0.92 + Math.abs(b.vu) * 0.2);
            b.ramp = { s: 0, sp: s };
            this.emit('rampIn', { u: b.u });
            return;
        }
        // walls, bumpers, flippers (twice: a corner can push the ball into another wall)
        for (let pass = 0; pass < 2; pass++) {
            for (const w of WALLS) {
                if (w.kind === 'gate' && b.inLane) continue;
                this._capsule(b, w.a, w.b, w.r, w.r, w.e, null, w, pass);
            }
            for (let i = 0; i < BUMPERS.length; i++) {
                const q = BUMPERS[i], du = b.u - q.u, dv = b.v - q.v, d = Math.hypot(du, dv);
                if (d < q.r + R && d > 0) {
                    const nu = du / d, nv = dv / d;
                    b.u = q.u + nu * (q.r + R); b.v = q.v + nv * (q.r + R);
                    const vn = b.vu * nu + b.vv * nv;
                    if (vn < 0) { b.vu -= 1.6 * vn * nu; b.vv -= 1.6 * vn * nv; }
                    // the kick: never slower than 800 away from it
                    const out = b.vu * nu + b.vv * nv;
                    if (out < 800) { b.vu += (800 - out) * nu; b.vv += (800 - out) * nv; }
                    if (pass === 0) this._hit('bumper', { i, u: q.u, v: q.v });
                }
            }
            for (let s = 0; s < 2; s++) this._flipperHit(b, s);
        }
        // the lanes at the top
        if (b.v > 130 && b.v < 170) {
            for (let i = 0; i < 3; i++) if (Math.abs(b.u - LANES[i]) < 24 && b.lane !== i) { b.lane = i; this._lane(i, b); }
        } else if (b.v > 200 || b.v < 110) b.lane = -1;
        // the saucer
        const du = b.u - PIT.u, dv = b.v - PIT.v, d = Math.hypot(du, dv);
        if (d < 30 && d > 0.01) { b.vu -= du / d * 3000 * h; b.vv -= dv / d * 3000 * h; }
        if (d < 13) this._pit(b);                       // (a direct hit stays in, however fast)
    }

    _capsule(b, a, c, ra, rb, e, vel, w, pass) {
        const q = closest(a, c, b.u, b.v), r = ra + (rb - ra) * q[2];
        let du = b.u - q[0], dv = b.v - q[1];
        const d2 = du * du + dv * dv, lim = r + R;
        if (d2 >= lim * lim) return false;
        let d = Math.sqrt(d2);
        if (d < 1e-6) { du = 0; dv = -1; d = 1; }
        const nu = du / d, nv = dv / d;
        b.u = q[0] + nu * lim; b.v = q[1] + nv * lim;
        const su = vel ? vel(q[0], q[1])[0] : 0, sv = vel ? vel(q[0], q[1])[1] : 0;
        const ru = b.vu - su, rv = b.vv - sv, vn = ru * nu + rv * nv;
        if (vn < 0) {
            b.vu -= (1 + e) * vn * nu; b.vv -= (1 + e) * vn * nv;
            // a little friction along the surface
            const tu = -nv, tv = nu, vt = (b.vu - su) * tu + (b.vv - sv) * tv;
            b.vu -= vt * 0.02 * tu; b.vv -= vt * 0.02 * tv;
            if (w && pass === 0) {
                if (w.kind === 'sling' && -vn > 120) {
                    // the kick: away from the triangle
                    const S = w.side ? SLING_R : SLING_L;
                    const mu = (w.a[0] + w.b[0]) / 2 - S.b[0], mv = (w.a[1] + w.b[1]) / 2 - S.b[1];
                    const sgn = mu * nu + mv * nv > 0 ? 1 : -1;
                    b.vu += nu * sgn * w.kick; b.vv += nv * sgn * w.kick;
                    this._hit('sling', { side: w.side, u: q[0], v: q[1] });
                }
                if (w.kind === 'target' && -vn > 60 && nu * TARGETS[w.i].face[0] + nv * TARGETS[w.i].face[1] > 0.5) this._target(w.i);
                if (w.kind !== 'sling' && w.kind !== 'target' && -vn > 400) this.emit('clack', { u: q[0], v: q[1], s: -vn });
            }
        }
        return true;
    }

    flipperTip(side, a) {
        const p = PIVOTS[side], ang = a === undefined ? this.flip[side].a : a;
        const dir = side === 0 ? ang : Math.PI - ang;
        return [p.u + Math.cos(dir) * FLIP.len, p.v + Math.sin(dir) * FLIP.len];
    }
    _flipperHit(b, side) {
        const p = PIVOTS[side], f = this.flip[side];
        if (Math.abs(b.u - p.u) > FLIP.len + 40 || Math.abs(b.v - p.v) > FLIP.len + 40) return;
        const tip = this.flipperTip(side);
        const w = side === 0 ? f.w : -f.w;       // the angular speed on the page (+ = clockwise in u,v)
        const vel = (qu, qv) => [-w * (qv - p.v), w * (qu - p.u)];
        if (this._capsule(b, [p.u, p.v], tip, FLIP.r0, FLIP.r1, 0.35, vel, null, 1) && Math.abs(f.w) > 5) this.emit('bat', { side });
    }

    _ballsMeet() {
        const B = this.balls.filter((b) => !b.plunger && !b.ramp && !b.hold);
        for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
            const a = B[i], c = B[j], du = c.u - a.u, dv = c.v - a.v, d = Math.hypot(du, dv);
            if (d >= 2 * R || d < 1e-6) continue;
            const nu = du / d, nv = dv / d, o = (2 * R - d) / 2;
            a.u -= nu * o; a.v -= nv * o; c.u += nu * o; c.v += nv * o;
            const vn = (c.vu - a.vu) * nu + (c.vv - a.vv) * nv;
            if (vn < 0) { a.vu += vn * nu * 0.95; a.vv += vn * nv * 0.95; c.vu -= vn * nu * 0.95; c.vv -= vn * nv * 0.95; }
        }
    }

    _rampMove(b, h) {
        const r = b.ramp, top = RAMP_S[RAMP_TOP];
        r.sp += (r.s < top ? -RAMP_UP : RAMP_DOWN) * h;
        r.sp = Math.min(r.sp, 1400);
        r.s += r.sp * h;
        if (r.s <= 0) {
            // rolled back out of the mouth
            const p = rampAt(0);
            b.ramp = null; b.u = p[0]; b.v = p[1] + 4; b.vu = 0; b.vv = Math.max(60, -r.sp);
            this.emit('rampBack');
            return;
        }
        if (r.s >= RAMP_LEN) {
            const p = rampAt(RAMP_LEN);
            b.ramp = null; b.u = p[0]; b.v = p[1]; b.vu = p[2] * r.sp; b.vv = p[3] * r.sp;
            this._lap(b);
            return;
        }
        if (!r.over && r.s >= top) { r.over = true; this.emit('rampTop'); }
        const p = rampAt(r.s);
        b.u = p[0]; b.v = p[1]; b.vu = p[2] * r.sp; b.vv = p[3] * r.sp;
    }

    /* ----- scoring ----- */
    _hit(kind, o) {
        if (this.tilted) return;
        if (kind === 'bumper') { this.add(POINTS.bumper); this.tally.bumpers++; }
        if (kind === 'sling') this.add(POINTS.sling);
        this.emit(kind, o);
    }
    _lane(i, b) {
        if (this.tilted) return;
        if (b.launchedAt && this.ms - b.launchedAt < 5000 && this.skillOpen) {
            this.skillOpen = false;
            if (i === this.skillLane) { this.add(POINTS.skill); this.emit('skill', { i }); }
        }
        this.skillOpen = false;
        b.launchedAt = 0;
        this.add(POINTS.lane);
        this.lanes[i] = true;
        this.emit('lane', { i });
        if (this.lanes.every(Boolean)) {
            this.lanes = [false, false, false];
            this.add(POINTS.gear);
            if (this.gear < 5) this.gear++;
            this.emit('gear', { gear: this.gear });
        }
    }
    _target(i) {
        if (this.tilted) return;
        this.add(POINTS.target);
        this.tally.targets++;
        const fresh = !this.targets[i];
        this.targets[i] = true;
        this.emit('target', { i, fresh });
        if (fresh && this.targets.every(Boolean) && !this.multiball) {
            this.pitLit = true;
            this.add(POINTS.mpower);
            this.emit('mpower');
        }
    }
    _lap(b) {
        if (this.tilted) { this.emit('lap', { pts: 0 }); return; }
        this.combo = this.ms - this.lastLap < 4000 ? this.combo + 1 : 1;
        this.lastLap = this.ms;
        let pts = POINTS.lap * Math.min(this.combo, 4);
        this.tally.laps++; this.lapsGame++;
        if (this.multiball) { pts += this.jackpot; this.emit('jackpot', { pts: this.jackpot }); this.jackpot += POINTS.jackpotStep; }
        this.add(pts);
        this.emit('lap', { pts, combo: this.combo, laps: this.lapsGame });
        if (this.lapsGame % 5 === 0) {
            this.add(POINTS.fastLap);
            this.emit('fastLap');
            if (!this.extraGiven && !this.extraLit) { this.extraLit = true; this.emit('extraLit'); }
        }
    }
    _pit(b) {
        b.hold = 1400; b.u = PIT.u; b.v = PIT.v; b.vu = b.vv = 0;
        if (this.tilted) return;
        if (this.pitLit && !this.multiball) {
            this.pitLit = false;
            this.multiball = true;
            this.jackpot = POINTS.jackpot;
            this.queue += 2;
            this.saveUntil = this.ms + 15000; this.saveUsed = false;
            this.add(POINTS.pit);
            this.emit('multiball');
        } else if (this.extraLit) {
            this.extraLit = false; this.extraGiven = true; this.extra++;
            this.add(POINTS.pit);
            this.emit('extraBall');
        } else {
            this.add(POINTS.pit);
            this.emit('pit');
        }
    }
    _drain(b) {
        this.balls.splice(this.balls.indexOf(b), 1);
        this.emit('out', { u: b.u });
        const live = this.balls.length + this.queue;
        if (this.ms < this.saveUntil && !this.tilted) {
            // ball save: it comes back (once a ball, while it lasts in multiball)
            if (!this.multiball) { this.saveUsed = true; this.saveUntil = 0; }
            this.emit('saved');
            if (this.multiball) { this.queue++; return; }
            this._toPlunger(false);
            this.skillOpen = false;
            return;
        }
        if (this.multiball) {
            if (live <= 1) { this.multiball = false; this.targets = this.targets.map(() => false); this.emit('multiballEnd'); }
            if (live >= 1) return;
        }
        if (live > 0) return;
        // the ball is over: its bonus, then the next
        const t = this.tally, raw = t.targets * BONUS.target + t.laps * BONUS.lap + t.bumpers * BONUS.bumper;
        const bonus = this.tilted ? 0 : raw * this.gear;
        this.add(bonus);
        this.emit('drain', { bonus, raw, gear: this.gear, tilted: this.tilted });
        if (this.extra > 0) { this.extra--; this.emit('shootAgain'); } else this.ballNo++;
        if (this.ballNo > this.ballsPerGame) { this.over = true; this.emit('over'); return; }
        this._newBallState();
        this.flip.forEach((f) => { f.held = false; });
        this._toPlunger(false);
    }

    /* ----- what the lamps show ----- */
    saving() { return this.ms < this.saveUntil && !this.tilted; }
    ballsLeft() { return Math.max(0, this.ballsPerGame - this.ballNo) + this.extra; }
}

function loadBest(file, log) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT' && log) log.warn('pinball: best: ' + e.message); return {}; }
}
function saveBest(file, best) { fs.writeFileSync(file, JSON.stringify(best)); }

module.exports = {
    Game, DT, SUB, TW, TL, R, DIFF, POINTS, BONUS, PLUNGER, ARCH, LANES, LANE_POSTS, BUMPERS, PIT, TARGETS, SLING_L, SLING_R,
    FLIP, PIVOTS, MOUTH, RAMP, RAMP_TOP, RAMP_S, RAMP_LEN, WALLS, MIRROR, rampAt, rampHeight, closest, seeded, loadBest, saveBest,
};
