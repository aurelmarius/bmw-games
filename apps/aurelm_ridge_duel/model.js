'use strict';
/**
 * Ridge Duel's rules: no drawing here (art.js), no head unit (main.js); tests/ridge_duel.test.js.
 *
 * Two armed cars on hills, a turn each: aim, power, fire. The ground is a height for every column of the
 * board (y down, 0 at the board's top), so a shell takes a round bite out of it. Wind pushes the shells
 * sideways; it changes a little every turn.
 *
 *   shells     STANDARD (as many as you like), CLUSTER (splits in three at the top of its flight),
 *              BOUNCER (bounces twice off the ground before it goes off), HEAVY (a big blast)
 *   damage     full for a direct hit (+15 %), less the further the blast; an armour takes its share off
 *   your car   SEDAN: agile - drives further in a turn, low and narrow (harder to hit), but no armour
 *              SUV: armoured - takes 20 % less, climbs steeper slopes, fires from higher up; drives less
 *   the rival  a pick-up (10 % armour), aimed by the game: it works out the shot and misses by a little,
 *              less on harder levels and less with every shot at the same target
 *   a match    rounds on new ground until one side has won 3; a round is lost at 0 health
 */
const fs = require('fs');

const W = 1116, H = 462;                    // the board, px
const G = 320;                               // gravity, px/s^2
const VMAX = 600;                            // a shell's speed at full power, px/s
const WIND_K = 4;                            // px/s^2 for each km/h of wind
const WIND_MAX = 20;
const DT = 1000 / 60;
const SUB = 4;
const DRIVE_SPEED = 55;                      // px/s
const WINS = 3;                              // rounds to win a match
const BOOM_MS = 700;                         // an explosion, before the ground settles and the turn moves on
const CHARGE_MS = 1600;                      // a full power charge (held press)

const BODIES = {
    sedan: { label: 'SPORT SEDAN', hp: 100, armour: 0, fuel: 150, climb: 0.85, half: 44, height: 28, gun: [-10.1, -32.2], barrel: 21.6, scale: 0.46 },
    suv: { label: 'PERFORMANCE SUV', hp: 100, armour: 0.2, fuel: 80, climb: 1.4, half: 47, height: 38, gun: [-14.7, -42.8], barrel: 21.6, scale: 0.46 },
    pickup: { label: 'PICK-UP', hp: 100, armour: 0.1, fuel: 100, climb: 1.1, half: 50, height: 40, gun: [-36.1, -36.1], barrel: 20.7, scale: 0.44 },
};
const SHELLS = {
    standard: { label: 'STANDARD', dmg: 32, r: 24, ammo: Infinity },
    cluster: { label: 'CLUSTER', dmg: 17, r: 15, ammo: 2, split: 3 },
    bouncer: { label: 'BOUNCER', dmg: 32, r: 24, ammo: 2, bounces: 2 },
    heavy: { label: 'HEAVY', dmg: 55, r: 38, ammo: 1 },
};
const ORDER = ['standard', 'cluster', 'bouncer', 'heavy'];
const AI = {
    easy: { angle: 9, power: 0.11, learn: 0.85, think: 1400 },
    normal: { angle: 7, power: 0.08, learn: 0.75, think: 1100 },
    hard: { angle: 3.2, power: 0.04, learn: 0.6, think: 900 },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function seeded(s) { s = (s >>> 0) || 1; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
function gauss(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/* ---------- the ground ---------- */
let groundSeq = 0;                           // every ground its own id (its drawing is cached under it)
class Ground {
    constructor(rng) {
        this.id = ++groundSeq;
        this.h = new Float32Array(W);
        this.burnt = new Uint8Array(W);
        this.ver = 1;
        // a few hills and valleys, gentler where the cars start
        const hills = [];
        for (let i = 0; i < 5; i++) hills.push({ x: 120 + rng() * (W - 240), w: 90 + rng() * 140, a: (rng() < 0.75 ? -1 : 1) * (30 + rng() * 60) });
        const ph = rng() * 6, base = 330 + rng() * 40;
        for (let x = 0; x < W; x++) {
            let y = base + Math.sin(x * 0.011 + ph) * 18 + Math.sin(x * 0.047 + ph * 2) * 4;
            for (const k of hills) y += k.a * Math.exp(-(((x - k.x) / k.w) ** 2));
            this.h[x] = clamp(y, 185, H - 40);
        }
        for (let p = 0; p < 2; p++) for (let x = 1; x < W - 1; x++) this.h[x] = (this.h[x - 1] + this.h[x] * 2 + this.h[x + 1]) / 4;
    }
    at(x) {
        if (x <= 0) return this.h[0];
        if (x >= W - 1) return this.h[W - 1];
        const i = Math.floor(x), t = x - i;
        return this.h[i] * (1 - t) + this.h[i + 1] * t;
    }
    slope(x) { return (this.at(x + 2) - this.at(x - 2)) / 4; }
    /** a round bite out of the ground (no overhangs: what was over it falls in) */
    carve(cx, cy, r) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
            const s = Math.sqrt(Math.max(0, r * r - (x - cx) ** 2)), bottom = cy + s;
            if (this.h[x] < bottom && this.h[x] < H - 8) { this.h[x] = Math.min(H - 8, bottom); this.burnt[x] = 1; }
            else if (Math.abs(x - cx) < r * 1.25) this.burnt[x] = 1;
        }
        this.ver++;
    }
}

/* ---------- the cars ---------- */
class Car {
    constructor(side, body, x) {
        const B = BODIES[body];
        Object.assign(this, { side, body, x, y: 0, a: 0, facing: side === 0 ? 1 : -1, hp: B.hp, aim: 45, power: 0.7, shell: 'standard', fuel: B.fuel, driven: 0 });
        this.ammo = { standard: Infinity, cluster: SHELLS.cluster.ammo, bouncer: SHELLS.bouncer.ammo, heavy: SHELLS.heavy.ammo };
    }
    get spec() { return BODIES[this.body]; }
    settle(g) {
        const s = this.spec.half * 0.6;
        const l = g.at(this.x - s), r = g.at(this.x + s);
        // on its wheels: tilted to the ground under them (at most 22 degrees), its middle on the line between
        this.a = clamp(Math.atan2(r - l, 2 * s), -0.38, 0.38);
        this.y = Math.min((l + r) / 2, g.at(this.x) + 4) + 1;
    }
    /** the turret's pivot and the muzzle, on the page of the board */
    gun() {
        const [gx, gy] = this.spec.gun, c = Math.cos(this.a), s = Math.sin(this.a), f = this.facing;
        const px = this.x + gx * f * c - gy * s, py = this.y + gx * f * s + gy * c;
        const r = this.aim * Math.PI / 180, dx = Math.cos(r) * f, dy = -Math.sin(r);
        return { px, py, dx, dy, mx: px + dx * this.spec.barrel, my: py + dy * this.spec.barrel };
    }
    centre() { return [this.x - Math.sin(this.a) * this.spec.height / 2, this.y - Math.cos(this.a) * this.spec.height / 2]; }
    /** is a point inside the car (its body, turned with the slope)? */
    contains(x, y, pad) {
        pad = pad || 0;
        const dx = x - this.x, dy = y - this.y, c = Math.cos(this.a), s = Math.sin(this.a);
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        return Math.abs(lx) <= this.spec.half + pad && ly <= 2 + pad && ly >= -this.spec.height - pad;
    }
}

/* ---------- a match ---------- */
class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.body = BODIES[o.body] && o.body !== 'pickup' ? o.body : 'sedan';
        this.difficulty = AI[o.difficulty] ? o.difficulty : 'normal';
        this.wins = [0, 0];
        this.roundNo = 0;
        this.events = [];
        this.over = false;
        this.starts = 0;
        this.stats = { shots: 0, hits: 0, dealt: 0 };
        this.newRound();
    }
    emit(type, o) { this.events.push(Object.assign({ type }, o || {})); }

    newRound() {
        this.roundNo++;
        this.ground = new Ground(this.rng);
        this.cars = [new Car(0, this.body, 110 + this.rng() * 140), new Car(1, 'pickup', W - 110 - this.rng() * 140)];
        this.cars.forEach((c) => c.settle(this.ground));
        this.cars[1].aim = 40;
        this.wind = Math.round((this.rng() * 2 - 1) * WIND_MAX * 0.7);
        this.shells = [];
        this.booms = [];
        this.turn = this.starts;
        this.starts = 1 - this.starts;
        this.phase = 'aim';
        this.wait = 0;
        this.roundWinner = -1;
        this.aiMemo = null;
        this.emit('round', { n: this.roundNo });
        this._startTurn();
    }
    _startTurn() {
        const c = this.cars[this.turn];
        c.fuel = c.spec.fuel; c.driven = 0;
        if (c.ammo[c.shell] <= 0) c.shell = 'standard';
        this.phase = 'aim';
        if (this.turn === 1) this._aiPlan();
        this.emit('turn', { side: this.turn });
    }
    current() { return this.cars[this.turn]; }
    mine() { return this.phase === 'aim' && this.turn === 0 && !this.over && this.roundWinner < 0; }

    /* ----- what a player does on their turn ----- */
    setAim(deg) { const c = this.cars[0]; if (this.mine()) c.aim = clamp(deg, 0, 90); }
    turnAim(d) { this.setAim(this.cars[0].aim + d); }
    choose(shell) { const c = this.cars[0]; if (this.mine() && SHELLS[shell] && c.ammo[shell] > 0) c.shell = shell; }
    cycleShell(d) {
        const c = this.cars[0];
        if (!this.mine()) return;
        let i = ORDER.indexOf(c.shell);
        for (let k = 0; k < ORDER.length; k++) { i = (i + d + ORDER.length) % ORDER.length; if (c.ammo[ORDER[i]] > 0) { c.shell = ORDER[i]; return; } }
    }
    /** drive dir (-1 / +1) for dt ms; uses the fuel; can't climb more than the car's slope */
    drive(side, dir, dt) {
        const c = this.cars[side];
        if (this.phase !== 'aim' || this.turn !== side || !dir || c.fuel <= 0) return 0;
        const step = Math.min(c.fuel, DRIVE_SPEED * dt / 1000), nx = clamp(c.x + dir * step, 40, W - 40);
        const other = this.cars[1 - side];
        if (Math.abs(nx - other.x) < c.spec.half + other.spec.half + 6 && Math.abs(nx - other.x) < Math.abs(c.x - other.x)) return 0;
        const rise = (this.ground.at(c.x) - this.ground.at(nx)) / Math.max(0.001, Math.abs(nx - c.x));    // + = uphill
        if (rise > c.spec.climb) { this.emit('stall', { side }); return 0; }
        c.fuel -= Math.abs(nx - c.x); c.driven += Math.abs(nx - c.x);
        c.x = nx; c.settle(this.ground);
        return step;
    }
    fire(side, power) {
        const c = this.cars[side];
        if (this.phase !== 'aim' || this.turn !== side) return false;
        c.power = clamp(power, 0.05, 1);
        if (c.ammo[c.shell] <= 0) c.shell = 'standard';
        c.ammo[c.shell]--;
        const g = c.gun(), v = VMAX * c.power;
        this.shells.push({ kind: c.shell, x: g.mx, y: g.my, vx: g.dx * v, vy: g.dy * v, from: side, bounces: 0, split: false, age: 0, dmg: SHELLS[c.shell].dmg, r: SHELLS[c.shell].r });
        this.phase = 'flight';
        if (side === 0) this.stats.shots++;
        this.emit('fire', { side, kind: c.shell, x: g.mx, y: g.my });
        return true;
    }

    /* ----- time ----- */
    step(dt) {
        dt = dt || DT;
        if (this.over) return;
        if (this.phase === 'aim' && this.turn === 1) this._aiStep(dt);
        if (this.phase === 'flight' || this.phase === 'boom') {
            const h = dt / 1000 / SUB;
            for (let k = 0; k < SUB; k++) for (const s of this.shells.slice()) this._fly(s, h);
            this.booms = this.booms.filter((b) => (b.t += dt) < BOOM_MS);
            if (this.phase === 'flight' && !this.shells.length) { this.phase = 'boom'; this.wait = this.booms.length ? 0 : 300; }
            if (this.phase === 'boom' && !this.shells.length && !this.booms.length && (this.wait -= dt) <= 0) this._afterShot();
        } else if (this.phase === 'roundOver') {
            if ((this.wait -= dt) <= 0) { if (this.wins[0] >= WINS || this.wins[1] >= WINS) { this.over = true; this.phase = 'over'; this.emit('match', { winner: this.wins[0] >= WINS ? 0 : 1 }); } else this.newRound(); }
        }
    }
    _fly(s, h) {
        s.age += h;
        s.vx += this.wind * WIND_K * h; s.vy += G * h;
        s.x += s.vx * h; s.y += s.vy * h;
        if (s.kind === 'cluster' && !s.split && s.vy >= 0 && s.age > 0.25) {
            // it splits at the top of its flight
            s.split = true;
            this.shells.splice(this.shells.indexOf(s), 1);
            for (const dvx of [-55, 0, 55]) this.shells.push(Object.assign({}, s, { vx: s.vx + dvx, split: true, child: true }));
            this.emit('split', { x: s.x, y: s.y });
            return;
        }
        if (s.x < -60 || s.x > W + 60 || s.y > H + 60) { this.shells.splice(this.shells.indexOf(s), 1); this.emit('miss', { x: s.x }); return; }
        for (const c of this.cars) if ((s.age > 0.12 || c.side !== s.from) && c.contains(s.x, s.y)) { this._blast(s, s.x, s.y, c); return; }
        const gy = this.ground.at(s.x);
        if (s.y >= gy) {
            if (s.kind === 'bouncer' && s.bounces < SHELLS.bouncer.bounces) {
                const sl = this.ground.slope(s.x), l = Math.hypot(sl, 1), nx = sl / l, ny = -1 / l;
                const vn = s.vx * nx + s.vy * ny;
                s.vx = (s.vx - 2 * vn * nx) * 0.6; s.vy = (s.vy - 2 * vn * ny) * 0.6;
                s.y = gy - 2; s.bounces++;
                this.emit('bounce', { x: s.x, y: gy });
                return;
            }
            this._blast(s, s.x, Math.min(s.y, gy + 2), null);
        }
    }
    _blast(s, x, y, direct) {
        this.shells.splice(this.shells.indexOf(s), 1);
        this.ground.carve(x, y, s.r);
        const hits = [];
        for (const c of this.cars) {
            const [cx, cy] = c.centre(), d = Math.hypot(cx - x, cy - y);
            let k = c === direct ? 1.15 : clamp(1 - Math.max(0, d - c.spec.half * 0.4) / (s.r + 22), 0, 1);
            if (k <= 0) continue;
            const dmg = Math.round(s.dmg * k * (1 - c.spec.armour));
            if (dmg <= 0) continue;
            c.hp = Math.max(0, c.hp - dmg);
            hits.push({ side: c.side, dmg });
            if (s.from === 0 && c.side === 1) { this.stats.dealt += dmg; }
        }
        if (s.from === 0 && hits.some((q) => q.side === 1)) this.stats.hits++;
        for (const c of this.cars) c.settle(this.ground);
        this.booms.push({ x, y, r: s.r, t: 0, kind: s.kind });
        this.emit('boom', { x, y, r: s.r, kind: s.kind, direct: !!direct, hits, from: s.from });
        // the AI learns from where its shot came down
        if (s.from === 1 && !s.child) this._aiLearn(x);
    }
    _afterShot() {
        const dead = this.cars.filter((c) => c.hp <= 0);
        if (dead.length) {
            this.phase = 'roundOver'; this.wait = 2600;
            if (dead.length === 2) { this.roundWinner = 2; this.emit('roundOver', { winner: -1 }); this.roundNo--; return; }   // both: the round again
            const w = 1 - dead[0].side;
            this.wins[w]++; this.roundWinner = w;
            this.emit('roundOver', { winner: w, wins: this.wins.slice() });
            return;
        }
        // the next turn: the wind moves a little
        this.wind = clamp(this.wind + Math.round((this.rng() * 2 - 1) * 4), -WIND_MAX, WIND_MAX);
        this.turn = 1 - this.turn;
        this._startTurn();
    }

    /* ----- the rival ----- */
    /** where a shot from car c at (aim, power) comes down (no ground bitten; the cars count as ground) */
    landing(c, aim, power) {
        const keep = [c.aim, c.power];
        c.aim = aim;
        const g = c.gun();
        c.aim = keep[0];
        let x = g.mx, y = g.my, vx = g.dx * VMAX * power, vy = g.dy * VMAX * power;
        const h = 1 / 120, other = this.cars[1 - c.side];
        for (let t = 0; t < 12; t += h) {
            vx += this.wind * WIND_K * h; vy += G * h; x += vx * h; y += vy * h;
            if (x < -60 || x > W + 60 || y > H + 60) return { x, y, out: true };
            if (t > 0.12 && other.contains(x, y)) return { x, y, car: true };
            if (y >= this.ground.at(x)) return { x, y };
        }
        return { x, y, out: true };
    }
    _aiPlan() {
        const me = this.cars[1], you = this.cars[0], P = AI[this.difficulty];
        // the best shot it can find
        let best = null;
        for (let a = 15; a <= 80; a += 2.5) for (let p = 0.35; p <= 1.001; p += 0.025) {
            const l = this.landing(me, a, p), d = l.car ? 0 : Math.abs(l.x - you.x);
            if (!best || d < best.d || (d === best.d && Math.abs(a - 45) < Math.abs(best.a - 45))) best = { a, p, d };
        }
        // its shell: the heavy one when it's likely to land, a cluster now and then
        let shell = 'standard';
        if (me.ammo.heavy > 0 && (this.aiMemo && this.aiMemo.err < 40 || you.hp <= 45)) shell = 'heavy';
        else if (me.ammo.cluster > 0 && this.rng() < 0.3) shell = 'cluster';
        else if (me.ammo.bouncer > 0 && this.rng() < 0.15) shell = 'bouncer';
        // its error: less with every shot at the same target
        const m = this.aiMemo && Math.abs(this.aiMemo.youX - you.x) < 20 ? this.aiMemo.k : 1;
        const aim = clamp(best.a + gauss(this.rng) * P.angle * m, 5, 85), power = clamp(best.p + gauss(this.rng) * P.power * m, 0.25, 1);
        this.ai = { aim, power, shell, t: 0, think: P.think, charge: 0 };
        this.aiMemo = { youX: you.x, k: m * P.learn, err: best.d + Math.abs(aim - best.a) * 8 };
        me.shell = shell;
    }
    _aiLearn(x) { if (this.aiMemo) this.aiMemo.err = Math.abs(x - this.cars[0].x); }
    _aiStep(dt) {
        const me = this.cars[1], q = this.ai;
        if (!q) return;
        q.t += dt;
        // it turns its gun to the aim, then holds the press for its power, then fires
        const turn = 50 * dt / 1000;
        if (Math.abs(me.aim - q.aim) > turn) { me.aim += Math.sign(q.aim - me.aim) * turn; return; }
        me.aim = q.aim;
        if (q.t < q.think) return;
        q.charge = Math.min(q.power, q.charge + dt / CHARGE_MS);
        me.power = q.charge;
        if (q.charge >= q.power) { this.ai = null; this.fire(1, q.power); }
    }
}

function loadStats(file, log) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT' && log) log.warn('ridge_duel: stats: ' + e.message); return {}; }
}
function saveStats(file, st) { fs.writeFileSync(file, JSON.stringify(st)); }
/** a finished match into the statistics (per difficulty) */
function record(st, g) {
    const k = g.difficulty, s = Object.assign({ played: 0, won: 0, streak: 0, best: 0, shots: 0, hits: 0 }, st[k] || {});
    s.played++;
    if (g.wins[0] >= WINS) { s.won++; s.streak++; s.best = Math.max(s.best, s.streak); } else s.streak = 0;
    s.shots += g.stats.shots; s.hits += g.stats.hits;
    return Object.assign({}, st, { [k]: s });
}

module.exports = {
    W, H, G, VMAX, WIND_K, WIND_MAX, DT, WINS, BOOM_MS, CHARGE_MS, BODIES, SHELLS, ORDER, AI, DRIVE_SPEED,
    Ground, Car, Game, seeded, clamp, loadStats, saveStats, record,
};
