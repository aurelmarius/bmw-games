'use strict';
/**
 * Lap Record's rules: the circuits, the car's physics, the timing. No drawing here (art.js), no head unit
 * (main.js); tests/lap_record.test.js.
 *
 * World units are metres (x east, y south). A circuit is a closed curve through a few points, sampled
 * every 2 m; for each sample: its place, its direction, its curvature, the kerbs (in the corners), what's
 * beside it (grass, or gravel on the outside of a corner) and how far the barrier is.
 *
 * The car: a heading (where it points) and a direction of travel; the tyres pull the travel round to the
 * heading as hard as the surface lets them (asphalt the most, then the kerbs, grass, gravel), so too fast
 * into a corner it slides wide (smoke, marks) and scrubs off speed. Off the track it's slow, into the
 * barrier it bounces off and loses most of its speed.
 *
 * Timing: from the line, in three sectors; a lap with more than OFF_LIMIT seconds off the track (past the
 * kerbs) doesn't count. The best lap of each circuit is kept with its run (the ghost).
 */
const fs = require('fs');

const DT = 1000 / 60;
const SUB = 2;
const STEP = 2;                       // m between samples
const WIDTH = 12;                     // the track, m
const KERB = 1.4;                     // m of kerb past the edge
const RUNOFF = 13;                    // m from the edge to the barrier
const OFF_LIMIT = 1.5;                // s off the track in a lap before it's invalid
const GRID_BACK = 30;                 // the car starts this far behind the line
const GHOST_MS = 50;                  // a ghost sample every
const CAR = { len: 4.7, wid: 1.9, base: 2.85 };
const PHYS = { vmax: 80, acc: 10, brake: 17, coast: 1.6, drag: 0.6 };
const GRIP = { asphalt: 17, kerb: 14, grass: 6.5, gravel: 4.5 };
const ROLL = { asphalt: 0, kerb: 0.4, grass: 3.5, gravel: 9 };     // m/s^2 it slows on its own

const CIRCUITS = {
    riverside: {
        name: 'RIVERSIDE GP',
        pts: [[0, 0], [220, 0], [440, 0], [560, -20], [630, -80], [640, -170], [590, -230], [510, -240], [460, -200], [450, -140], [410, -100], [330, -110], [270, -170],
            [210, -250], [120, -280], [30, -260], [-40, -210], [-40, -140], [0, -100], [20, -60], [0, -30], [-50, -34], [-95, -12], [-80, 18], [-40, 14]],
    },
    hillside: {
        name: 'HILLSIDE RING',
        pts: [[0, 0], [160, 0], [290, 10], [360, 60], [350, 140], [280, 170], [220, 130], [160, 150], [150, 220], [220, 260], [330, 260], [420, 300], [430, 380], [350, 420],
            [200, 420], [60, 400], [-40, 350], [-70, 260], [-30, 180], [-90, 110], [-80, 30]],
    },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

/* ---------- a circuit ---------- */
class Track {
    constructor(id) {
        const def = CIRCUITS[id] || CIRCUITS.riverside;
        this.id = CIRCUITS[id] ? id : 'riverside';
        this.name = def.name;
        this.width = WIDTH;
        // the curve, densely, then every STEP m along it
        const p = def.pts, dense = [];
        for (let i = 0; i < p.length; i++) {
            const p0 = p[(i - 1 + p.length) % p.length], p1 = p[i], p2 = p[(i + 1) % p.length], p3 = p[(i + 2) % p.length];
            for (let k = 0; k < 60; k++) {
                const t = k / 60, t2 = t * t, t3 = t2 * t;
                const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
                dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
            }
        }
        const cum = [0];
        for (let i = 1; i <= dense.length; i++) { const a = dense[i - 1], b = dense[i % dense.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
        const total = cum[dense.length], n = Math.round(total / STEP);
        this.length = n * STEP;
        this.s = [];
        let j = 0;
        for (let i = 0; i < n; i++) {
            const want = i / n * total;
            while (cum[j + 1] < want) j++;
            const a = dense[j], b = dense[(j + 1) % dense.length], t = (want - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
            this.s.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t });
        }
        const N = this.s.length;
        for (let i = 0; i < N; i++) {
            const a = this.s[(i - 1 + N) % N], b = this.s[(i + 1) % N], l = Math.hypot(b.x - a.x, b.y - a.y);
            const q = this.s[i];
            q.tx = (b.x - a.x) / l; q.ty = (b.y - a.y) / l;
            q.nx = -q.ty; q.ny = q.tx;                    // to the right of the way (y is south)
            q.d = i * STEP;
        }
        for (let i = 0; i < N; i++) {
            const a = this.s[(i - 5 + N) % N], b = this.s[(i + 5) % N];
            this.s[i].curv = wrapA(Math.atan2(b.ty, b.tx) - Math.atan2(a.ty, a.tx)) / (10 * STEP);     // rad/m, + = turning right (y south)
        }
        // smoothed curvature: kerbs where the corner is tight, gravel on its outside
        for (let i = 0; i < N; i++) {
            let c = 0;
            for (let k = -6; k <= 6; k++) c += this.s[(i + k + N) % N].curv;
            c /= 13;
            const q = this.s[i];
            q.kerb = Math.abs(c) > 0.009;
            q.outside = c > 0 ? -1 : 1;                    // the outside of the corner (+1 = the n side, the right)
            q.gravel = Math.abs(c) > 0.012 ? q.outside : 0;
        }
        // a grid of the samples, for finding the nearest
        this.cell = 30;
        this.grid = new Map();
        this.s.forEach((q, i) => { const k = this._key(q.x, q.y); if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(i); });
        // where a barrier stands: not where another part of the track is close
        for (const q of this.s) {
            q.wall = [1, -1].map((side) => {
                // (none on the inside of a corner too tight for it: the line would fold over itself)
                if (side !== q.outside && Math.abs(q.curv) * (WIDTH / 2 + RUNOFF) > 0.6) return false;
                const bx = q.x + q.nx * side * (WIDTH / 2 + RUNOFF), by = q.y + q.ny * side * (WIDTH / 2 + RUNOFF);
                const near = this.nearest(bx, by);
                return Math.abs(near.lat) > WIDTH / 2 + RUNOFF - 4;
            });
        }
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of this.s) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
        this.bounds = { x0, x1, y0, y1 };
    }
    _key(x, y) { return Math.floor(x / this.cell) + ',' + Math.floor(y / this.cell); }
    at(i) { const N = this.s.length; return this.s[((i % N) + N) % N]; }
    /** the nearest sample to (x, y): its index, the distance across (lat, + = right) and along (s) */
    nearest(x, y, hint) {
        const N = this.s.length;
        let best = -1, bd = Infinity;
        const look = (i) => { const q = this.s[i], d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = i; } };
        if (hint !== undefined && hint >= 0) for (let k = -25; k <= 25; k++) look(((hint + k) % N + N) % N);
        if (best < 0 || bd > 30 * 30) {
            const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
            for (let r = 1; r <= 3 && (best < 0 || r === 1); r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { const l = this.grid.get((cx + i) + ',' + (cy + j)); if (l) for (const k of l) look(k); }
            if (best < 0) for (let i = 0; i < N; i++) look(i);
        }
        const q = this.s[best], dx = x - q.x, dy = y - q.y;
        return { i: best, lat: dx * q.nx + dy * q.ny, s: q.d + dx * q.tx + dy * q.ty };
    }
    /** what the ground is at a distance across the track */
    surface(q, lat) {
        const a = Math.abs(lat), side = lat >= 0 ? 1 : -1;
        if (a <= WIDTH / 2) return 'asphalt';
        if (a <= WIDTH / 2 + KERB && q.kerb) return 'kerb';
        if (a <= WIDTH / 2 + RUNOFF) return q.gravel === side ? 'gravel' : 'grass';
        return q.wall[side > 0 ? 0 : 1] ? 'wall' : 'grass';
    }
}

/* ---------- a session on a circuit ---------- */
class Game {
    constructor(o) {
        o = o || {};
        this.track = new Track(o.circuit);
        this.best = o.best && o.best.time ? o.best : null;            // { time, sectors, ghost: [[t, x, y, h], ...] }
        this.bestSectors = o.bestSectors || (this.best ? this.best.sectors.slice() : [Infinity, Infinity, Infinity]);
        this.events = [];
        this.t = 0;
        // on the grid, behind the line
        const N = this.track.s.length, g = this.track.at(N - Math.round(GRID_BACK / STEP));
        this.car = { x: g.x, y: g.y, h: Math.atan2(g.ty, g.tx), dir: Math.atan2(g.ty, g.tx), v: 0, steer: 0, slip: 0, i: N - Math.round(GRID_BACK / STEP), lat: 0, surface: 'asphalt', sliding: false, braking: false, gear: 1, rpm: 0 };
        this.prog = -GRID_BACK;              // m along the track from the line, counting laps
        this.lights = { n: 0, t: 0, go: false, hold: 600 + (o.rng || Math.random)() * 1000 };
        this.lap = 0;                         // laps started
        this.lapT = 0; this.lapStart = 0;
        this.sector = 0; this.sectorT = [];
        this.off = 0; this.invalid = false;
        this.last = null;
        this.ghostRec = [];
        this.recAt = 0;
        this.wrong = 0;
        this.ctrl = { steer: 0, throttle: 0, brake: 0 };
    }
    emit(type, o) { this.events.push(Object.assign({ type }, o || {})); }
    /** the controls: steer -1 (left) .. 1, throttle and brake 0 .. 1 */
    control(steer, throttle, brake) { this.ctrl = { steer: clamp(steer, -1, 1), throttle: clamp(throttle, 0, 1), brake: clamp(brake, 0, 1) }; }

    step(dt) {
        dt = dt || DT;
        this.t += dt;
        // the start lights: five reds, one a second, then out
        const L = this.lights;
        if (!L.go) {
            L.t += dt;
            const n = Math.min(5, Math.floor(L.t / 800));
            if (n !== L.n) { L.n = n; this.emit('light', { n }); }
            if (n === 5 && L.t >= 4000 + L.hold) { L.go = true; L.n = 0; this.emit('go'); }
            return;
        }
        const h = dt / 1000 / SUB;
        for (let k = 0; k < SUB; k++) this._drive(h);
        this._timing(dt);
    }

    _drive(h) {
        const c = this.car, T = this.track, u = this.ctrl;
        const near = T.nearest(c.x, c.y, c.i), q = T.s[near.i];
        c.i = near.i; c.lat = near.lat;
        const surf = T.surface(q, near.lat);
        c.surface = surf === 'wall' ? 'grass' : surf;
        const grip = GRIP[c.surface];
        // engine, brakes, the air, the ground
        const v = c.v;
        let a = 0;
        if (u.throttle > 0) a += PHYS.acc * u.throttle * Math.pow(Math.max(0, 1 - v / PHYS.vmax), 0.75) * (c.surface === 'asphalt' || c.surface === 'kerb' ? 1 : 0.6);
        else a -= PHYS.coast;
        if (u.brake > 0) a -= PHYS.brake * u.brake * (grip / GRIP.asphalt * 0.6 + 0.4);
        a -= PHYS.drag * (v / PHYS.vmax) * (v / PHYS.vmax) * 10 + ROLL[c.surface];
        c.v = Math.max(0, v + a * h);
        c.braking = u.brake > 0.1 && c.v > 1;
        // steering: less lock the faster it goes; the heading turns, the travel follows as far as the grip lets it
        c.steer += clamp(u.steer - c.steer, -4 * h, 4 * h);
        const lock = 0.5 / (1 + c.v / 16);
        const yaw = c.v / CAR.base * Math.tan(c.steer * lock);
        c.h = wrapA(c.h + yaw * h);
        const want = wrapA(c.h - c.dir), turn = (grip / Math.max(2, c.v)) * h;
        c.dir = wrapA(c.dir + clamp(want, -turn, turn));
        c.slip = wrapA(c.h - c.dir);
        // sliding scrubs speed off; the car straightens itself out
        if (Math.abs(c.slip) > 0.04) c.v = Math.max(0, c.v - Math.abs(Math.sin(c.slip)) * 9 * h);
        c.h = wrapA(c.h - clamp(c.slip, -1.4 * h, 1.4 * h));
        c.sliding = Math.abs(c.slip) > 0.09 && c.v > 8;
        c.x += Math.cos(c.dir) * c.v * h; c.y += Math.sin(c.dir) * c.v * h;
        // the barrier
        const after = T.nearest(c.x, c.y, c.i), q2 = T.s[after.i];
        if (T.surface(q2, after.lat) === 'wall') {
            const side = after.lat > 0 ? 1 : -1, lim = WIDTH / 2 + RUNOFF - 0.2;
            c.x -= q2.nx * (after.lat - side * lim); c.y -= q2.ny * (after.lat - side * lim);
            const ta = Math.atan2(q2.ty, q2.tx), rel = wrapA(c.dir - ta);
            c.dir = wrapA(ta - rel * 0.4); c.h = wrapA(c.h - rel * 0.5);
            const hit = c.v;
            c.v *= 0.45;
            if (hit > 4) this.emit('wall', { x: c.x, y: c.y, v: hit });
        }
        // the gearbox, for the display: 7 gears
        const kmh = c.v * 3.6, tops = [0, 62, 98, 134, 170, 208, 246, 300];
        let g = 1; while (g < 7 && kmh > tops[g] - 4) g++;
        c.gear = g; c.rpm = clamp((kmh - (g > 1 ? tops[g - 1] - 14 : 0)) / (tops[g] - (g > 1 ? tops[g - 1] - 14 : 0)), 0, 1);
    }

    _timing(dt) {
        const c = this.car, T = this.track, Ln = T.length;
        // how far along, counting laps (no jumps: the nearest point moves on a few metres at a time)
        const s = T.s[c.i].d + 0, base = Math.floor(this.prog / Ln) * Ln;
        let p = base + s;
        if (p - this.prog > Ln / 2) p -= Ln; else if (this.prog - p > Ln / 2) p += Ln;
        const before = this.prog;
        this.prog = p;
        if (p < before - 0.5 && c.v > 3) { this.wrong += dt; if (this.wrong > 1500 && this.wrong - dt <= 1500) this.emit('wrongWay'); } else this.wrong = 0;
        if (this.lap === 0) {
            if (before < 0 && p >= 0) this._startLap(0);
            return;
        }
        this.lapT = this.t - this.lapStart;
        // off the track (past the kerbs)
        if (Math.abs(c.lat) > WIDTH / 2 + KERB + CAR.wid / 2) {
            this.off += dt / 1000;
            if (!this.invalid && this.off > OFF_LIMIT) { this.invalid = true; this.emit('invalid'); }
        }
        // the ghost's run
        if (this.t - this.recAt >= GHOST_MS) { this.recAt = this.t; this.ghostRec.push([Math.round(this.lapT), +c.x.toFixed(2), +c.y.toFixed(2), +c.h.toFixed(3)]); }
        const lapsDone = this.lap - 1, into = p - lapsDone * Ln;
        // sectors
        const sec = Math.min(2, Math.floor(into / (Ln / 3)));
        if (into >= 0 && sec > this.sector && sec <= 2) {
            const split = this.lapT - (this.sectorT.reduce((x, y) => x + y, 0));
            this.sectorT.push(split);
            this._sectorDone(this.sector, split);
            this.sector = sec;
        }
        if (into >= Ln) this._finish(dt, (into - Ln) / Math.max(1, c.v) * 1000);
    }
    _startLap(over) {
        this.lap++;
        this.lapStart = this.t - over; this.lapT = over;
        this.sector = 0; this.sectorT = []; this.off = 0; this.invalid = false;
        this.ghostRec = [[0, +this.car.x.toFixed(2), +this.car.y.toFixed(2), +this.car.h.toFixed(3)]]; this.recAt = this.t;
        this.emit('lap', { n: this.lap });
    }
    _sectorDone(k, ms) {
        const best = this.bestSectors[k], bestLap = this.best ? this.best.sectors[k] : Infinity;
        const colour = !this.invalid && ms < best ? 'purple' : !this.invalid && ms < bestLap ? 'green' : 'yellow';
        if (!this.invalid && ms < best) this.bestSectors[k] = ms;
        this.emit('sector', { k, ms, colour, delta: isFinite(bestLap) ? ms - bestLap : null });
    }
    _finish(dt, past) {
        const time = Math.round(this.lapT - past);
        const done = this.sectorT.reduce((x, y) => x + y, 0);
        const last = time - done;
        this.sectorT.push(last);
        this._sectorDone(2, last);
        const valid = !this.invalid;
        const record = valid && (!this.best || time < this.best.time);
        this.last = { time, valid, sectors: this.sectorT.slice() };
        if (record) this.best = { time, sectors: this.sectorT.slice(), ghost: this.ghostRec.slice(), at: Date.now() };
        this.emit('lapDone', { n: this.lap, time, valid, record, delta: this.best && !record ? time - this.best.time : null });
        this._startLap(past);
    }

    /** the ghost of the best lap where it was this far into it */
    ghost() {
        if (!this.best || !this.best.ghost || this.lap === 0) return null;
        const g = this.best.ghost, t = this.lapT;
        if (t > g[g.length - 1][0]) return null;
        let lo = 0, hi = g.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g[m][0] <= t) lo = m; else hi = m; }
        const a = g[lo], b = g[hi], k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
        return { x: a[1] + (b[1] - a[1]) * k, y: a[2] + (b[2] - a[2]) * k, h: a[3] + wrapA(b[3] - a[3]) * k };
    }
    /** how far ahead (-) or behind (+) of the best lap, ms, at this point of the lap */
    delta() {
        if (!this.best || !this.best.ghost || this.lap === 0) return null;
        const g = this.best.ghost, c = this.car, T = this.track;
        const into = this.prog - (this.lap - 1) * T.length;
        // the time the best lap was this far along
        let lo = 0, hi = g.length - 1;
        const along = (k) => { const n = T.nearest(g[k][1], g[k][2]); let d = T.s[n.i].d; if (k > g.length / 2 && d < T.length / 4) d += T.length; if (k < g.length / 4 && d > T.length * 3 / 4) d -= T.length; return d; };
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (along(m) <= into) lo = m; else hi = m; }
        const a = along(lo), b = along(hi), k = b > a ? clamp((into - a) / (b - a), 0, 1) : 0;
        return this.lapT - (g[lo][0] + (g[hi][0] - g[lo][0]) * k);
    }
}

const fmtTime = (ms) => {
    if (ms === null || ms === undefined || !isFinite(ms)) return '-:--.---';
    const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
};
const fmtDelta = (ms) => (ms === null || !isFinite(ms) ? '' : (ms < 0 ? '-' : '+') + (Math.abs(ms) / 1000).toFixed(3));

function loadRecords(file, log) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT' && log) log.warn('lap_record: records: ' + e.message); return {}; }
}
function saveRecords(file, r) { fs.writeFileSync(file, JSON.stringify(r)); }

module.exports = {
    DT, STEP, WIDTH, KERB, RUNOFF, OFF_LIMIT, GRID_BACK, CAR, PHYS, GRIP, CIRCUITS,
    Track, Game, wrapA, clamp, fmtTime, fmtDelta, loadRecords, saveRecords,
};
