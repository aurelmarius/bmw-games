'use strict';
/**
 * Apex Chase's rules, without drawing or the car (tested in tests/apex_chase.test.js).
 *
 *   const g = new Game({ difficulty: 'normal' });
 *   g.steer('L' | 'R' | 'U' | 'D')    // the way the M car should go (kept until it can turn)
 *   g.step(DT)                        // advance the world DT ms (main.js steps it at 60 Hz)
 *   g.events.splice(0)                // what happened, for the drawing
 *
 * A night city seen from above: streets between blocks, tunnels at both sides of the middle avenue,
 * a charging station in the middle. The M car collects the fuel drops on every street; four electric
 * cars hunt it, each its own way (Volt goes for the car, Spark for where it's heading, Amp for the
 * street behind it, Watt comes close and then turns away), switching between hunting and going round
 * their own corner of the city. A NITRO can drains their batteries: for a while they crawl and flee,
 * and a car that catches one sends it back to the charging station (200, 400, 800, 1600). A street
 * cleared of every drop is the next level: faster, the nitro shorter, the other city.
 *
 * Positions are in cells: a car is at cell + dir * t (t 0..1 toward the next cell); x wraps through the
 * tunnels.
 */
const DT = 1000 / 60;
const W = 45, H = 19;
const DIRS = { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] };
const BACK = { L: 'R', R: 'L', U: 'D', D: 'U' };
const ORDER = ['U', 'L', 'D', 'R'];                    // the order ties are broken in
const LIVES = 3, EXTRA_AT = 10000;
const POINTS = { dot: 10, nitro: 50, chain: [200, 400, 800, 1600] };
const BONUS = [{ kind: 'flag', pts: 100 }, { kind: 'cup', pts: 300 }, { kind: 'wrench', pts: 500 }, { kind: 'tyre', pts: 700 }, { kind: 'key', pts: 1000 }];
const BONUS_AT = [70, 170], BONUS_MS = 9000;
// the electric cars' speed, how long a nitro lasts, how soon they leave the station
const DIFF = { easy: { speed: 0.86, fright: 1.4, release: 1.3 }, normal: { speed: 1, fright: 1, release: 1 }, hard: { speed: 1.12, fright: 0.7, release: 0.75 } };
// hunting and roaming in turns (ms); the last hunt goes on
const MODES = [['roam', 7000], ['hunt', 20000], ['roam', 7000], ['hunt', 20000], ['roam', 5000], ['hunt', 20000], ['roam', 5000], ['hunt', Infinity]];
const NAMES = ['Volt', 'Spark', 'Amp', 'Watt'];
const CORNERS = [[42, -2], [2, -2], [42, 21], [2, 21]];
const DOOR = { x: 22, y: 8 }, OUTSIDE = { x: 22, y: 7 }, HOME = [{ x: 22, y: 9 }, { x: 20, y: 9 }, { x: 24, y: 9 }, { x: 22, y: 9 }];

/* ---------- the cities: avenues across, short streets between them; the same middle and edges ---------- */
const CITIES = [
    { 2: [1, 7, 15, 20, 24, 29, 37, 43], 5: [1, 11, 18, 26, 33, 43], 8: [5, 13, 16, 28, 31, 39], 12: [1, 9, 17, 22, 27, 35, 43], 15: [1, 6, 13, 20, 24, 31, 38, 43] },
    { 2: [1, 5, 12, 20, 24, 32, 39, 43], 5: [1, 8, 15, 22, 29, 36, 43], 8: [5, 13, 16, 28, 31, 39], 12: [1, 6, 14, 20, 24, 30, 38, 43], 15: [1, 10, 17, 20, 24, 27, 34, 43] },
];
/** the city's grid of rows: '#' block, '.' a drop, 'o' a nitro, ' ' street, 'P' the station, '-' its door, 'S' the M car's start */
function city(n) {
    const spec = CITIES[n % CITIES.length];
    const g = Array.from({ length: H }, () => Array(W).fill('#'));
    for (const r of [1, 4, 7, 11, 14, 17]) for (let c = 1; c < 44; c++) g[r][c] = '.';
    for (const c of [21, 22, 23]) { g[1][c] = '#'; g[17][c] = '#'; }
    for (const [r0, cols] of Object.entries(spec)) {
        const rows = Number(r0) === 8 ? [8, 9, 10] : [Number(r0), Number(r0) + 1];
        for (const r of rows) for (const c of cols) g[r][c] = '.';
    }
    for (let c = 0; c < 5; c++) { g[9][c] = ' '; g[9][W - 1 - c] = ' '; }
    for (let c = 17; c < 28; c++) { g[8][c] = '#'; g[10][c] = '#'; g[7][c] = ' '; }
    g[9][17] = '#'; g[9][27] = '#';
    for (let c = 18; c < 27; c++) g[9][c] = 'P';
    g[8][22] = '-';
    for (const r of [8, 9, 10]) { g[r][16] = ' '; g[r][28] = ' '; }
    for (const [r, c] of [[1, 1], [1, 43], [17, 1], [17, 43]]) g[r][c] = 'o';
    g[14][22] = 'S';
    return g.map((r) => r.join(''));
}
const isRoad = (ch) => ch === '.' || ch === ' ' || ch === 'o' || ch === 'S';
const wrapX = (x) => ((x % W) + W) % W;

/** distances (in steps) from a cell to every street cell; through the station's door too unless `streets` */
function distances(grid, from, streets) {
    const d = Array.from({ length: H }, () => Array(W).fill(Infinity));
    const q = [[from.x, from.y]];
    d[from.y][from.x] = 0;
    while (q.length) {
        const [x, y] = q.shift();
        for (const k of ORDER) {
            const nx = wrapX(x + DIRS[k][0]), ny = y + DIRS[k][1];
            if (ny < 0 || ny >= H || d[ny][nx] !== Infinity) continue;
            const ch = grid[ny][nx];
            if (!isRoad(ch) && (streets || (ch !== '-' && ch !== 'P'))) continue;
            d[ny][nx] = d[y][x] + 1;
            q.push([nx, ny]);
        }
    }
    return d;
}

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.diff = DIFF[o.difficulty] || DIFF.normal;
        this.score = 0; this.lives = LIVES; this.level = 0; this.extra = false;
        this.over = false;
        this.events = [];
        this.startLevel(1);
    }
    startLevel(n) {
        this.level = n;
        this.grid = city(n - 1);
        this.dots = new Set();
        this.grid.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '.' || ch === 'o') this.dots.add(x + ',' + y); }));
        this.total = this.dots.size;
        this.eaten = 0;
        this.home = distances(this.grid, OUTSIDE);
        this.bonusN = 0; this.bonus = null;
        this.events.push({ type: 'level', level: n });
        this.resetActors();
    }
    resetActors() {
        const s = this.find('S');
        this.car = { x: s.x, y: s.y, dir: 'L', want: 'L', t: 0, moving: true };
        this.evs = NAMES.map((name, i) => {
            const h = i === 0 ? OUTSIDE : HOME[i];
            return { i, name, x: h.x, y: h.y, dir: i === 0 ? 'L' : 'U', t: 0, state: i === 0 ? 'out' : 'home', wait: [0, 1500, 5000, 9000][i] * this.diff.release, script: null };
        });
        this.modeIx = 0; this.modeT = 0;
        this.fright = 0; this.chain = 0;
        this.t = 0;
        this.pause = 1600;           // a moment before it goes (the lights)
        this.freeze = 0;
        this.dying = 0;
    }
    find(ch) { for (let y = 0; y < H; y++) { const x = this.grid[y].indexOf(ch); if (x >= 0) return { x, y }; } return null; }
    cell(x, y) { return y < 0 || y >= H ? '#' : this.grid[y][wrapX(x)]; }
    open(x, y, who) {
        const ch = this.cell(x, y);
        if (isRoad(ch)) return true;
        return who === 'ev-in' && (ch === '-' || ch === 'P');
    }
    mode() { return MODES[Math.min(this.modeIx, MODES.length - 1)][0]; }

    /* ---------- speeds (cells a second) ---------- */
    lvl() { return Math.min(this.level - 1, 8); }
    carSpeed() { return 8 + this.lvl() * 0.2; }
    evSpeed(e) {
        if (e.state === 'back') return 16;
        if (e.state === 'scared') return 4.6 * this.diff.speed;
        const inTunnel = e.y === 9 && (e.x < 5 || e.x > W - 6);
        return (inTunnel ? 4 : 6.4 + this.lvl() * 0.25) * this.diff.speed;
    }
    frightMs() { return Math.max(2000, 7000 - this.lvl() * 600) * this.diff.fright; }

    steer(d) { if (DIRS[d]) { this.car.want = d; if (d === BACK[this.car.dir] && this.car.moving) this._reverse(this.car); } }
    _reverse(a) {
        const [dx, dy] = DIRS[a.dir];
        if (a.t > 0) { a.x = wrapX(a.x + dx); a.y += dy; a.t = 1 - a.t; }
        a.dir = BACK[a.dir];
    }
    /** where an actor is, in cells (floats) */
    at(a) { const [dx, dy] = DIRS[a.dir]; return { x: a.x + dx * a.t, y: a.y + dy * a.t }; }

    /** move an actor `dist` cells; at every cell centre `choose(a)` gives the way on (null: stop there) */
    _travel(a, dist, choose) {
        let guard = 0;
        while (dist > 1e-9 && guard++ < 8) {
            if (a.t === 0) {
                const d = choose(a);
                if (!d) return false;
                a.dir = d;
            }
            const need = 1 - a.t;
            if (dist < need) { a.t += dist; return true; }
            dist -= need;
            const [dx, dy] = DIRS[a.dir];
            a.x = wrapX(a.x + dx); a.y += dy; a.t = 0;
            this._arrive(a);
            if (a.script) return true;                           // into the station: scripted from here
        }
        return true;
    }
    _arrive(a) {
        if (a !== this.car) {
            // a car back at the station's gate goes in to charge
            if (a.state === 'back' && a.x === OUTSIDE.x && a.y === OUTSIDE.y) { a.state = 'enter'; this._script(a, [{ x: 22, y: 9 }], 6); }
            return;
        }
        const k = a.x + ',' + a.y;
        if (!this.dots.has(k)) return;
        this.dots.delete(k);
        this.eaten++;
        const nitro = this.grid[a.y][a.x] === 'o';
        this.score += nitro ? POINTS.nitro : POINTS.dot;
        this.events.push({ type: nitro ? 'nitro' : 'dot', x: a.x, y: a.y });
        if (nitro) this._nitro();
        if (BONUS_AT[this.bonusN] === this.eaten) { this.bonusN++; this.bonus = { ...BONUS[Math.min(this.level - 1, BONUS.length - 1)], x: 22, y: 11, until: this.t + BONUS_MS }; this.events.push({ type: 'bonus', kind: this.bonus.kind }); }
        this._extra();
    }
    _extra() { if (!this.extra && this.score >= EXTRA_AT) { this.extra = true; this.lives++; this.events.push({ type: 'extra' }); } }
    _nitro() {
        this.fright = this.frightMs(); this.chain = 0;
        for (const e of this.evs) if (e.state === 'out' || e.state === 'scared') { if (e.state === 'out') this._reverse(e); e.state = 'scared'; }
        this.events.push({ type: 'fright', ms: this.fright });
    }

    /* ---------- the electric cars ---------- */
    target(e) {
        const c = this.car, [dx, dy] = DIRS[c.dir];
        if (this.mode() === 'roam') return { x: CORNERS[e.i][0], y: CORNERS[e.i][1] };
        if (e.i === 0) return { x: c.x, y: c.y };
        if (e.i === 1) return { x: c.x + dx * 4, y: c.y + dy * 4 };
        if (e.i === 2) return { x: c.x - dx * 4, y: c.y - dy * 4 };
        const far = Math.hypot(e.x - c.x, e.y - c.y) > 8;
        return far ? { x: c.x, y: c.y } : { x: CORNERS[3][0], y: CORNERS[3][1] };
    }
    _choose(e) {
        const ways = ORDER.filter((d) => d !== BACK[e.dir] && this.open(e.x + DIRS[d][0], e.y + DIRS[d][1], e.state === 'back' ? 'ev-in' : 'ev'));
        if (!ways.length) return BACK[e.dir];
        if (e.state === 'scared') return ways[Math.floor(this.rng() * ways.length)];
        if (e.state === 'back') {
            let best = ways[0], bd = Infinity;
            for (const d of ways) { const v = this.home[e.y + DIRS[d][1]][wrapX(e.x + DIRS[d][0])]; if (v < bd) { bd = v; best = d; } }
            return best;
        }
        const t = this.target(e);
        let best = ways[0], bd = Infinity;
        for (const d of ways) {
            const nx = e.x + DIRS[d][0], ny = e.y + DIRS[d][1], v = (nx - t.x) ** 2 + (ny - t.y) ** 2;
            if (v < bd) { bd = v; best = d; }
        }
        return best;
    }
    /** scripted moves in and out of the station: a straight line to each point in turn */
    _script(e, pts, speed) { e.script = { pts, speed }; e.t = 0; }
    _runScript(e, dist) {
        const s = e.script;
        while (dist > 0 && s.pts.length) {
            const p = s.pts[0], dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy);
            if (d <= dist) { e.x = p.x; e.y = p.y; dist -= d; s.pts.shift(); continue; }
            e.x += dx / d * dist; e.y += dy / d * dist;
            e.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
            dist = 0;
        }
        if (!s.pts.length) { e.script = null; e.x = Math.round(e.x); e.y = Math.round(e.y); return true; }
        return false;
    }
    _stepEv(e, ms) {
        const dist = this.evSpeed(e) * ms / 1000;
        if (e.state === 'home') {
            e.wait -= ms;
            if (e.wait <= 0 && !e.script) this._script(e, [{ x: 22, y: 9 }, { x: 22, y: 7 }], 3);
            if (e.script && this._runScript(e, 3 * ms / 1000)) { e.state = this.fright > 0 ? 'scared' : 'out'; e.dir = 'L'; e.t = 0; }
            return;
        }
        if (e.state === 'enter') {
            if (this._runScript(e, 6 * ms / 1000)) { e.state = 'home'; e.wait = 800; e.dir = 'U'; }
            return;
        }
        this._travel(e, dist, (a) => this._choose(a));
    }

    /* ---------- the world ---------- */
    step(ms) {
        if (this.over) return;
        this.t += ms;
        if (this.pause > 0) { this.pause -= ms; return; }
        if (this.freeze > 0) { this.freeze -= ms; return; }      // a moment on a car caught
        if (this.dying > 0) {
            this.dying -= ms;
            if (this.dying <= 0) {
                if (this.lives <= 0) { this.over = true; this.events.push({ type: 'over', score: this.score }); } else this.resetActors();
            }
            return;
        }
        if (this.cleared > 0) {
            this.cleared -= ms;
            if (this.cleared <= 0) { this.cleared = 0; this.startLevel(this.level + 1); }
            return;
        }
        // hunting and roaming in turns (held while the nitro lasts)
        if (this.fright > 0) {
            this.fright -= ms;
            if (this.fright <= 0) { this.fright = 0; for (const e of this.evs) if (e.state === 'scared') e.state = 'out'; this.events.push({ type: 'charged' }); }
        } else {
            this.modeT += ms;
            const m = MODES[Math.min(this.modeIx, MODES.length - 1)];
            if (this.modeT >= m[1]) { this.modeT = 0; this.modeIx++; for (const e of this.evs) if (e.state === 'out' && e.t > 0) this._reverse(e); }
        }
        // the M car: turns as soon as it can, stops at a wall
        const c = this.car;
        const moved = this._travel(c, this.carSpeed() * ms / 1000, (a) => {
            if (this.open(a.x + DIRS[a.want][0], a.y + DIRS[a.want][1])) return a.want;
            if (this.open(a.x + DIRS[a.dir][0], a.y + DIRS[a.dir][1])) return a.dir;
            return null;
        });
        c.moving = moved;
        for (const e of this.evs) this._stepEv(e, ms);
        this._collide();
        if (this.bonus && this.t > this.bonus.until) this.bonus = null;
        if (this.bonus && c.t < 0.5 && c.x === this.bonus.x && c.y === this.bonus.y) {
            this.score += this.bonus.pts;
            this.events.push({ type: 'bonusEaten', kind: this.bonus.kind, pts: this.bonus.pts, x: this.bonus.x, y: this.bonus.y });
            this.bonus = null;
            this._extra();
        }
        if (!this.dots.size && !this.cleared) { this.cleared = 2000; this.events.push({ type: 'cleared', level: this.level }); }
    }
    _collide() {
        const p = this.at(this.car);
        for (const e of this.evs) {
            if (e.state !== 'out' && e.state !== 'scared') continue;
            const q = e.script ? { x: e.x, y: e.y } : this.at(e);
            let dx = Math.abs(p.x - q.x);
            dx = Math.min(dx, W - dx);
            if (dx * dx + (p.y - q.y) ** 2 > 0.6 * 0.6) continue;
            if (e.state === 'scared') {
                const pts = POINTS.chain[Math.min(this.chain, 3)];
                this.chain++;
                this.score += pts;
                e.state = 'back';
                this.events.push({ type: 'caught', i: e.i, pts, x: q.x, y: q.y });
                this._extra();
                this.freeze = 450;
            } else {
                this.lives--;
                this.dying = 1800;
                this.events.push({ type: 'crash', x: p.x, y: p.y, by: e.i });
                return;
            }
        }
    }
}

function loadBest(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('apex_chase: best scores not read: ' + e.message);
        return {};
    }
}
function saveBest(file, best) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(best));
    fs.renameSync(file + '.tmp', file);
}

module.exports = { Game, DT, W, H, DIRS, BACK, LIVES, POINTS, BONUS, NAMES, CITIES, OUTSIDE, city, distances, isRoad, wrapX, loadBest, saveBest };
