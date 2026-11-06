'use strict';
/**
 * Street Siege's rules, without drawing or the car (tested in tests/street_siege.test.js).
 *
 *   const g = new Game({ difficulty: 'normal' });
 *   g.drive('U' | 'D' | 'L' | 'R' | null)   // the way the M car drives (null: it stands)
 *   g.fire()                                // a shot from its roof cannon (if one is ready)
 *   g.step(DT)                              // advance the world DT ms (main.js steps it at 60 Hz)
 *   g.events.splice(0)                      // what happened, for the drawing
 *
 * An industrial yard at night, seen from above. The M car defends the M garage at the bottom of the
 * yard against twenty cars a level, which come in from the top, four at a time at most: hatchbacks
 * (fast), vans, pick-ups (they fire twice as often) and armoured SUVs (four hits). Stacks of tyres stop
 * cars and shots and fall apart brick by brick when shot; concrete stops everything (but a fully
 * upgraded cannon); the canal stops cars, not shots; trees hide what drives under them; oil makes a
 * car slide on. The garage stands three hits (it smokes; a moment between two hits it shrugs off):
 * lost, or with no cars left, the game is over.
 * Three of the twenty cars flash: hit, they leave a power-up: a cannon upgrade, a shield, NITRO (the
 * others stand still), concrete round the garage, a spare car, an EMP (every car on the yard gone).
 *
 * Units are bricks (16 px): the yard is BW x BH bricks; a car is 2 x 2 bricks, x and y its top left.
 * Every level's yard is built by build(level): symmetric, reachable everywhere.
 */
const DT = 1000 / 60;
const BW = 66, BH = 28;                                 // the yard in bricks (33 x 14 tiles of 2 x 2)
const TW = BW / 2, TH = BH / 2;
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const LIVES = 3, PER_LEVEL = 20, ON_YARD = 4, GARAGE_HP = 3;
const TYPES = {
    hatch: { speed: 7, hp: 1, pts: 200, fire: 1800 },
    van: { speed: 4.6, hp: 1, pts: 100, fire: 1600 },
    pickup: { speed: 5, hp: 1, pts: 300, fire: 800 },
    suv: { speed: 4, hp: 4, pts: 400, fire: 1500 },
};
const POWERS = ['star', 'shield', 'nitro', 'fortify', 'life', 'emp'];
// the other cars' speed, how long between their shots, between their coming in
const DIFF = { easy: { speed: 0.85, fire: 1.8, spawn: 1.4 }, normal: { speed: 1, fire: 1.3, spawn: 1.15 }, hard: { speed: 1.12, fire: 0.9, spawn: 0.85 } };
const PLAYER = { speed: 5, x: 24, y: 26 };
const BASE = { x: 31, y: 24, w: 4, h: 4 };
const RING = { x: 29, y: 22, w: 8, h: 6 };              // the tyres round the garage
const SPAWNS = [{ x: 22, y: 0 }, { x: 42, y: 0 }, { x: 64, y: 0 }, { x: 0, y: 0 }];      // (none over the garage)
const SHOT_SPEED = [16, 24, 24, 24];                    // bricks a second, by cannon level
// what stops a car, what stops a shot (fences let shots through), what a shot breaks (concrete and wrecks: the heavy one)
const BLOCKS_CAR = 'tcwGkhnpx', BLOCKS_SHOT = 'tcGkhpx', BREAKS = 'tp', BREAKS_HEAVY = 'tpcx';

/* ---------- the yards ---------- */
/** a small random generator that a level's number makes the same every time */
function seeded(s) { return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
/** tiles (2 x 2 bricks) the yard keeps clear: the way in at the top, the garage, the M car's start */
function reserved(tx, ty) {
    if (ty <= 1 && (tx <= 2 || tx >= TW - 3 || (tx >= 10 && tx <= 12) || (tx >= 20 && tx <= 22))) return true;
    if (ty >= 11 && tx >= 12 && tx <= 20) return true;
    return false;
}
/** each level is in a district of its own, in turn */
const THEMES = ['yard', 'docks', 'warehouses', 'parking', 'scrapyard'];
const theme = (n) => THEMES[(Math.max(1, n) - 1) % THEMES.length];
// what blocks the way in a yard (fences: cars, not shots), what counts towards a yard's fill
const SOLID_TILE = 'cwkhnx', FILLS = 'tcwkhnpx';
/**
 * What fills a block of w x h tiles in a district: [[dx, dy, ch], ...]. Solid things, a whole block or most
 * of it (an L, a half), sometimes a gap (a little square); never a slot a car can't turn in.
 */
function blockFill(th, w, h, y, rnd) {
    const out = [], R = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const rect = (x0, y0, ww, hh, ch) => { for (let i = 0; i < ww; i++) for (let j = 0; j < hh; j++) out.push([x0 + i, y0 + j, ch]); };
    const shape = (ch) => {
        const r = rnd();
        if (r < 0.5 || w < 3 || h < 3) rect(0, 0, w, h, ch);                                     // the whole block
        else if (r < 0.75) { rect(0, 0, w, 1, ch); rect(0, 1, 1, h - 1, ch); rect(1, h - 1, w - 1, 1, ch); }   // an L / a C open to one side
        else rect(0, 0, w, Math.ceil(h / 2), ch);                                                    // half of it
    };
    const r = rnd();
    if (th === 'docks') {
        if (r < 0.6) rect(0, 0, w, h, 'k');                                                         // a stack of containers
        else if (r < 0.75 && y > 2 && y < 9) rect(0, 0, w, h, 'w');                                  // a dock basin
        else if (r < 0.9) shape('n');                                                               // fenced off
        else shape('t');
    } else if (th === 'warehouses') {
        if (r < 0.55) rect(0, 0, w, h, 'h');                                                        // a warehouse
        else if (r < 0.8) shape('p');                                                               // pallets
        else if (r < 0.9) shape('n');
        else rect(0, 0, w, h, 'c');
    } else if (th === 'parking') {
        if (r < 0.6) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([i, j, 'x']); }    // parked rows, wreck by wreck
        else if (r < 0.8) { rect(0, 0, w, h, 'c'); for (let i = 0; i < w; i++) out.push([i, -0, 'f']); }  // an island with trees
        else shape('t');
    } else if (th === 'scrapyard') {
        if (r < 0.35) shape('t');                                                                   // a heap of tyres
        else if (r < 0.6) rect(0, 0, w, h, 'x');
        else if (r < 0.75) rect(0, 0, w, h, 'k');
        else if (r < 0.9) shape('p');
        else { rect(0, 0, w, h, 't'); out.push([R(0, w - 1), h, 'o']); }
    } else {
        if (r < 0.4) shape('t');                                                                    // tyres
        else if (r < 0.6) shape('c');                                                               // concrete
        else if (r < 0.72 && y > 2 && y < 9) rect(0, 0, w, h, 'w');                                  // the canal
        else if (r < 0.88) rect(0, 0, w, h, 'f');                                                   // trees (cover, not a wall)
        else { shape('t'); out.push([w, R(0, h - 1), 'o']); }
    }
    // (trees on an island: on its top row only, over the concrete)
    return out.filter(([dx, dy, ch], k, a) => ch !== 'f' || th !== 'parking' || !a.some(([x2, y2, c2]) => x2 === dx && y2 === dy && c2 !== 'f'));
}
/**
 * The yard of level n: rows of BW chars - '.' ground, 't' tyres, 'c' concrete, 'w' water, 'f' trees,
 * 'o' oil, 'k' containers, 'h' warehouses, 'n' fences, 'p' pallets, 'x' wrecks, 'G' the garage.
 * Laid out as a town: blocks of 2-4 tiles with streets two tiles wide between them (a car is one), on the
 * left half and mirrored; some streets closed between two blocks (longer walls, dead ends); a block or a
 * closing is kept only if every open tile can still be reached (what a shot breaks counts as open).
 */
function build(n) {
    const th = theme(n), rnd = seeded(7919 * n + 13), R = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const half = Math.ceil(TW / 2);
    for (let attempt = 0; attempt < 80; attempt++) {
        const T = Array.from({ length: TH }, () => Array(TW).fill('.'));
        const open = (tx, ty) => tx >= 0 && ty >= 0 && tx < TW && ty < TH && !SOLID_TILE.includes(T[ty][tx]);
        const connected = () => {
            const seen = new Set(['11,0']), q = [[11, 0]];
            while (q.length) {
                const [x, y] = q.pop();
                for (const [dx, dy] of Object.values(DIRS)) { const k = (x + dx) + ',' + (y + dy); if (open(x + dx, y + dy) && !seen.has(k)) { seen.add(k); q.push([x + dx, y + dy]); } }
            }
            for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) if (open(x, y) && !seen.has(x + ',' + y)) return false;
            return true;
        };
        /** open tiles with a wall on both sides (a slot one tile wide: no room to turn) */
        const wall = (x, y) => x < 0 || y < 0 || x >= TW || y >= TH || FILLS.includes(T[y][x]);
        const slots = () => { let k = 0; for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) if (!wall(x, y) && ((wall(x - 1, y) && wall(x + 1, y)) || (wall(x, y - 1) && wall(x, y + 1)))) k++; return k; };
        /** put cells (mirrored); undone if the yard falls apart or gets a slot one tile wide */
        const place = (cells) => {
            const done = [], before = slots();
            for (const [x, y, ch] of cells) {
                if (x < 0 || y < 0 || x >= half || y >= TH || reserved(x, y) || reserved(TW - 1 - x, y) || T[y][x] !== '.') continue;
                T[y][x] = ch; T[y][TW - 1 - x] = ch; done.push([x, y]);
            }
            if (connected() && slots() <= before) return done.length;
            for (const [x, y] of done) { T[y][x] = '.'; T[y][TW - 1 - x] = '.'; }
            return 0;
        };
        // the town plan: blocks across and down, streets of two between
        const cols = [], rows = [];
        // (no slot one tile wide: at the yard's edges, nor in the middle between a block and its mirror)
        for (let x = 2 * R(0, 1); x < half; ) { let w = R(2, 4); if (x + w - 1 === half - 2) w++; if (x + w > half) w = half - x; cols.push([x, w]); x += w + 2; }
        for (let y = 2; y < TH - 1; ) { let h = R(2, 3); if (y + h === TH - 1) h++; rows.push([y, Math.min(h, TH - y)]); y += h + 2; }
        const blocks = [];
        for (const [x, w] of cols) for (const [y, h] of rows) blocks.push({ x, y, w, h });
        for (const b of blocks) {
            if (rnd() < 0.12) continue;                                              // a square
            // not all the same size: some a tile shorter one way (the street there wider)
            if (rnd() < 0.35 && b.w > 2) { if (rnd() < 0.5) b.x++; b.w--; }
            if (rnd() < 0.35 && b.h > 2) { if (rnd() < 0.5) b.y++; b.h--; }
            place(blockFill(th, b.w, b.h, b.y, rnd).map(([dx, dy, ch]) => [b.x + dx, b.y + dy, ch]));
        }
        // some streets closed between two blocks: longer walls, dead ends
        for (let k = 0; k < 14 + Math.min(n, 8); k++) {
            const b = blocks[Math.floor(rnd() * blocks.length)], across = rnd() < 0.5;
            const ch = T[b.y][b.x];
            if (!FILLS.includes(ch)) continue;
            const cells = [];
            if (across) for (let j = 0; j < b.h; j++) { cells.push([b.x + b.w, b.y + j, ch], [b.x + b.w + 1, b.y + j, ch]); }
            else for (let i = 0; i < b.w; i++) { cells.push([b.x + i, b.y + b.h, ch], [b.x + i, b.y + b.h + 1, ch]); }
            // only where the far side is a block too (so the wall joins two blocks, no stub)
            const far = across ? [b.x + b.w + 2, b.y] : [b.x, b.y + b.h + 2];
            if (!T[far[1]] || !FILLS.includes(T[far[1]][far[0]]) || (across && b.x + b.w + 1 >= half)) continue;
            place(cells);
        }
        let filled = 0;
        for (const r of T) for (const ch of r) if (FILLS.includes(ch)) filled++;
        if (filled < 0.28 * TW * TH) continue;
        // into bricks; the garage and its ring of tyres
        const g = Array.from({ length: BH }, (_, by) => Array.from({ length: BW }, (_, bx) => T[by >> 1][bx >> 1]));
        for (let y = RING.y; y < RING.y + RING.h; y++) for (let x = RING.x; x < RING.x + RING.w; x++) g[y][x] = 't';
        for (let y = BASE.y; y < BASE.y + BASE.h; y++) for (let x = BASE.x; x < BASE.x + BASE.w; x++) g[y][x] = 'G';
        return g.map((r) => r.join(''));
    }
    throw new Error('no yard for level ' + n);
}

/** the twenty cars of level n, in the order they come */
function convoy(n) {
    const rnd = seeded(31 * n + 5), out = [];
    const w = { hatch: 2 + n * 0.3, van: Math.max(1, 6 - n * 0.4), pickup: 1 + n * 0.4, suv: Math.max(0, n - 1) * 0.5 };
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    for (let i = 0; i < PER_LEVEL; i++) {
        let r = rnd() * sum, kind = 'van';
        for (const [k, v] of Object.entries(w)) { if (r < v) { kind = k; break; } r -= v; }
        out.push(kind);
    }
    return out;
}

class Game {
    constructor(o) {
        o = o || {};
        this.rng = o.rng || Math.random;
        this.diff = DIFF[o.difficulty] || DIFF.normal;
        this.autoFire = o.autoFire !== false;
        this.score = 0; this.lives = LIVES; this.power = 0; this.garage = GARAGE_HP;
        this.over = false; this.lost = null;
        this.events = [];
        this.startLevel(1);
    }
    startLevel(n) {
        this.level = n;
        this.grid = build(n).map((r) => r.split(''));
        this.version = 0;                                   // changes with every brick shot away
        this.queue = convoy(n);
        this.flashers = new Set([3, 10, 17]);
        this.come = 0;                                       // cars that came in
        this.killed = 0;
        this.cars = [];                                     // the enemies on the yard
        this.shots = [];
        this.bonus = null;
        this.t = 0; this.spawnAt = 1200; this.spawnIx = 0;
        this.nitro = 0; this.fortify = 0; this.clearAt = 0;
        this.kills = { hatch: 0, van: 0, pickup: 0, suv: 0 };
        this._spawnPlayer();
        this.events.push({ type: 'level', level: n });
    }
    _spawnPlayer() {
        this.car = { x: PLAYER.x, y: PLAYER.y, dir: 'U', want: null, shield: 3000, cool: 0, slide: 0, alive: true, moving: false };
    }

    /* ---------- the yard ---------- */
    at(x, y) { return x < 0 || y < 0 || x >= BW || y >= BH ? '#' : this.grid[y][x]; }
    /** does a 2 x 2 car at (x, y) fit (no block, no other car)? */
    fits(x, y, self) {
        if (x < 0 || y < 0 || x > BW - 2 || y > BH - 2) return false;
        for (let by = Math.floor(y); by < Math.ceil(y + 2 - 1e-6); by++) for (let bx = Math.floor(x); bx < Math.ceil(x + 2 - 1e-6); bx++) if (BLOCKS_CAR.includes(this.at(bx, by))) return false;
        for (const o of this.allCars()) {
            if (o === self || !o.solid) continue;
            if (Math.abs(o.x - x) < 2 - 1e-6 && Math.abs(o.y - y) < 2 - 1e-6) return false;
        }
        return true;
    }
    allCars() { const out = this.cars.slice(); if (this.car.alive) out.push(Object.assign(this.car, { solid: true })); return out; }

    /** move a car `dist` bricks its way, turning onto the brick grid; true if it went all the way */
    _drive(c, dir, dist) {
        if (dir !== c.dir) {
            // a turn across: onto the grid the other way (if it fits there)
            const across = (DIRS[dir][0] !== 0) !== (DIRS[c.dir][0] !== 0);
            if (across) {
                const nx = DIRS[dir][0] === 0 ? Math.round(c.x) : c.x, ny = DIRS[dir][1] === 0 ? Math.round(c.y) : c.y;
                if (this.fits(nx, ny, c)) { c.x = nx; c.y = ny; }
            }
            c.dir = dir;
        }
        const [dx, dy] = DIRS[dir];
        let moved = 0;
        while (moved < dist - 1e-9) {
            const s = Math.min(0.25, dist - moved);
            if (!this.fits(c.x + dx * s, c.y + dy * s, c)) {
                // right up to the block: the next whole brick that way, if it's nearer than a step
                const nx = dx > 0 ? Math.ceil(c.x - 1e-9) : dx < 0 ? Math.floor(c.x + 1e-9) : c.x;
                const ny = dy > 0 ? Math.ceil(c.y - 1e-9) : dy < 0 ? Math.floor(c.y + 1e-9) : c.y;
                if ((nx !== c.x || ny !== c.y) && this.fits(nx, ny, c)) { c.x = nx; c.y = ny; }
                return false;
            }
            c.x += dx * s; c.y += dy * s; moved += s;
        }
        return true;
    }

    /* ---------- the M car ---------- */
    drive(d) { this.car.want = d && DIRS[d] ? d : null; }
    fire() { return this._fire(this.car, 'p'); }
    _fire(c, team) {
        if (c.cool > 0) return false;
        const mine = this.shots.filter((s) => s.owner === c).length;
        const max = team === 'p' ? (this.power >= 2 ? 2 : 1) : c.kind === 'pickup' ? 2 : 1;
        if (mine >= max) return false;
        const [dx, dy] = DIRS[c.dir];
        this.shots.push({ x: c.x + 1 + dx * 1.1, y: c.y + 1 + dy * 1.1, dir: c.dir, team, owner: c, speed: team === 'p' ? SHOT_SPEED[this.power] : 14, heavy: team === 'p' && this.power >= 3 });
        c.cool = team === 'p' ? (this.power >= 1 ? 220 : 320) : 400;
        this.events.push({ type: 'fire', team, x: c.x + 1 + dx * 1.2, y: c.y + 1 + dy * 1.2, dir: c.dir });
        return true;
    }
    _stepPlayer(ms) {
        const c = this.car;
        if (!c.alive) { c.respawn -= ms; if (c.respawn <= 0) { this._spawnPlayer(); this.events.push({ type: 'respawn' }); } return; }
        c.cool -= ms; c.shield = Math.max(0, c.shield - ms);
        const onOil = this.at(Math.round(c.x + 0.5), Math.round(c.y + 0.5)) === 'o';
        let d = c.want;
        if (!d && c.slide > 0) { d = c.dir; c.slide -= ms; } // sliding on oil
        c.moving = !!d;
        if (d) {
            this._drive(c, d, PLAYER.speed * ms / 1000);
            if (c.want && onOil) c.slide = 350;
        }
        if (!c.want && !onOil) c.slide = 0;
        if (this.autoFire && this.lined(c)) this._fire(c, 'p');
        // a power-up under the car
        const b = this.bonus;
        if (b && Math.abs(b.x - c.x) < 2 && Math.abs(b.y - c.y) < 2) this._power(b.kind);
    }
    /** an enemy ahead of the car, in its line of fire (for the automatic fire) */
    lined(c) {
        const [dx, dy] = DIRS[c.dir];
        return this.cars.some((e) => {
            if (e.state !== 'on') return false;
            const ax = e.x - c.x, ay = e.y - c.y;
            return dx ? Math.abs(ay) < 1.6 && ax * dx > 0 : Math.abs(ax) < 1.6 && ay * dy > 0;
        });
    }
    _power(kind) {
        const c = this.car;
        this.bonus = null;
        this.score += 500;
        if (kind === 'star') this.power = Math.min(3, this.power + 1);
        else if (kind === 'shield') c.shield = 10000;
        else if (kind === 'nitro') this.nitro = 8000;
        else if (kind === 'fortify') { this.fortify = 15000; this._ring('c'); } else if (kind === 'life') this.lives++;
        else if (kind === 'emp') for (const e of this.cars.slice()) if (e.state === 'on') this._destroy(e, false);
        this.events.push({ type: 'power', kind, x: c.x + 1, y: c.y + 1 });
    }
    /** the bricks round the garage: all tyres again, or concrete */
    _ring(ch) {
        for (let y = RING.y; y < RING.y + RING.h; y++) for (let x = RING.x; x < RING.x + RING.w; x++) {
            if (x >= BASE.x && x < BASE.x + BASE.w && y >= BASE.y) continue;
            if (this.allCars().some((o) => x >= o.x - 0.01 && x < o.x + 2 && y >= o.y - 0.01 && y < o.y + 2)) continue;
            this.grid[y][x] = ch;
        }
        this.version++;
    }

    /* ---------- the other cars ---------- */
    _spawn() {
        if (this.come >= PER_LEVEL || this.cars.length >= ON_YARD) return;
        for (let k = 0; k < SPAWNS.length; k++) {
            const p = SPAWNS[(this.spawnIx + k) % SPAWNS.length];
            if (!this.fits(p.x, p.y, null)) continue;
            this.spawnIx = (this.spawnIx + k + 1) % SPAWNS.length;
            const kind = this.queue[this.come], T = TYPES[kind];
            const e = { kind, x: p.x, y: p.y, dir: 'D', hp: T.hp, state: 'in', wait: 900, cool: 600 + this.rng() * 1200, turnIn: 800, flash: this.flashers.has(this.come), solid: false };
            this.come++;
            this.cars.push(e);
            this.events.push({ type: 'spawn', x: p.x + 1, y: p.y + 1 });
            return;
        }
    }
    _choose(e) {
        const p = this.car, ways = Object.keys(DIRS);
        const free = ways.filter((d) => this.fits(e.x + DIRS[d][0] * 0.3, e.y + DIRS[d][1] * 0.3, e));
        const pick = (d) => (free.includes(d) || !free.length ? d : null);
        const r = this.rng();
        if (r < 0.3) return pick('D') || free[Math.floor(this.rng() * free.length)] || 'D';
        if (r < 0.65 && p.alive) {
            const toward = Math.abs(p.x - e.x) > Math.abs(p.y - e.y) ? (p.x > e.x ? 'R' : 'L') : (p.y > e.y ? 'D' : 'U');
            return pick(toward) || free[Math.floor(this.rng() * free.length)] || toward;
        }
        if (r < 0.8) {
            const toward = BASE.x + 1 > e.x ? 'R' : 'L';
            return pick(toward) || free[Math.floor(this.rng() * free.length)] || toward;
        }
        return free.length ? free[Math.floor(this.rng() * free.length)] : ways[Math.floor(this.rng() * 4)];
    }
    _stepEnemy(e, ms) {
        if (e.state === 'in') { e.wait -= ms; if (e.wait <= 0) { e.state = 'on'; e.solid = true; } return; }
        if (this.nitro > 0) return;
        const T = TYPES[e.kind];
        e.cool -= ms;
        e.turnIn -= ms;
        const went = this._drive(e, e.dir, T.speed * this.diff.speed * ms / 1000);
        if (!went || e.turnIn <= 0) { e.dir = this._choose(e); e.turnIn = 600 + this.rng() * 2600; }
        // fire: often when lined up with the M car, else now and then
        const p = this.car;
        let lined = (p.alive && ((e.dir === 'D' && Math.abs(p.x - e.x) < 1.2 && p.y > e.y) || (e.dir === 'U' && Math.abs(p.x - e.x) < 1.2 && p.y < e.y) ||
            (e.dir === 'L' && Math.abs(p.y - e.y) < 1.2 && p.x < e.x) || (e.dir === 'R' && Math.abs(p.y - e.y) < 1.2 && p.x > e.x)));
        // (not lined up when the garage stands between: the shot would hit that)
        if (lined && this._garageBetween(e, p)) lined = false;
        if (e.cool <= 0) {
            if (this._fire(e, 'e')) e.cool = T.fire * this.diff.fire * (lined ? 0.4 : 0.9 + this.rng() * 1.1);
            else e.cool = 100;
        }
    }
    _garageBetween(e, p) {
        const ex = e.x + 1, ey = e.y + 1, px = p.x + 1, py = p.y + 1, gx0 = BASE.x, gx1 = BASE.x + BASE.w, gy0 = BASE.y, gy1 = BASE.y + BASE.h;
        if (e.dir === 'L' || e.dir === 'R') return ey > gy0 - 1 && ey < gy1 + 1 && Math.min(ex, px) < gx0 && Math.max(ex, px) > gx1;
        return ex > gx0 - 1 && ex < gx1 + 1 && Math.min(ey, py) < gy0 && Math.max(ey, py) > gy1;
    }
    _destroy(e, scored) {
        this.cars.splice(this.cars.indexOf(e), 1);
        this.killed++;
        this.kills[e.kind]++;
        const pts = scored ? TYPES[e.kind].pts : 0;
        this.score += pts;
        this.events.push({ type: 'boom', x: e.x + 1, y: e.y + 1, kind: e.kind, pts });
        if (e.flash) this._drop();
    }
    _drop() {
        for (let k = 0; k < 40; k++) {
            const x = 2 + Math.floor(this.rng() * (BW - 6)) & ~1, y = 4 + Math.floor(this.rng() * (BH - 12)) & ~1;
            if (!this.fits(x, y, null)) continue;
            this.bonus = { kind: POWERS[Math.floor(this.rng() * POWERS.length)], x, y, until: this.t + 15000 };
            this.events.push({ type: 'bonus', kind: this.bonus.kind, x: x + 1, y: y + 1 });
            return;
        }
    }

    /* ---------- shots ---------- */
    _stepShots(ms) {
        for (const s of this.shots.slice()) {
            if (!this.shots.includes(s)) continue;
            const [dx, dy] = DIRS[s.dir];
            let left = s.speed * ms / 1000;
            while (left > 0 && this.shots.includes(s)) {
                const d = Math.min(0.4, left);
                s.x += dx * d; s.y += dy * d; left -= d;
                this._hit(s);
            }
        }
    }
    _removeShot(s) { const i = this.shots.indexOf(s); if (i >= 0) this.shots.splice(i, 1); }
    _hit(s) {
        if (s.x < 0 || s.y < 0 || s.x > BW || s.y > BH) { this._removeShot(s); this.events.push({ type: 'spark', x: Math.max(0, Math.min(BW, s.x)), y: Math.max(0, Math.min(BH, s.y)) }); return; }
        // the bricks under the shot's width: two side by side across its way
        const vertical = s.dir === 'U' || s.dir === 'D';
        const bx = Math.floor(s.x), by = Math.floor(s.y);
        const cells = vertical ? [[Math.round(s.x) - 1, by], [Math.round(s.x), by]] : [[bx, Math.round(s.y) - 1], [bx, Math.round(s.y)]];
        let hit = false, base = false;
        for (const [x, y] of cells) {
            const ch = this.at(x, y);
            if (!BLOCKS_SHOT.includes(ch)) continue;
            hit = true;
            if (ch === 'G') base = s.team === 'e';                    // (the M car's own shots don't hurt its garage)
            else if ((s.heavy ? BREAKS_HEAVY : BREAKS).includes(ch)) { this.grid[y][x] = '.'; this.version++; this.events.push({ type: 'brick', x, y, was: ch }); }
        }
        if (base && !this.lost) {
            this._removeShot(s);
            if (this.t - (this.garageAt || -1e9) < 1500) { this.events.push({ type: 'spark', x: s.x, y: s.y }); return; }
            this.garageAt = this.t;
            this.garage--;
            this.events.push({ type: 'garage', hp: this.garage, x: s.x, y: s.y });
            if (this.garage <= 0) { this.lost = 'garage'; this._end(); }
            return;
        }
        if (hit) { this._removeShot(s); this.events.push({ type: 'spark', x: s.x, y: s.y }); return; }
        // cars
        const targets = s.team === 'p' ? this.cars.filter((e) => e.state === 'on') : (this.car.alive ? [this.car] : []);
        for (const c of targets) {
            if (s.x < c.x - 0.1 || s.x > c.x + 2.1 || s.y < c.y - 0.1 || s.y > c.y + 2.1) continue;
            this._removeShot(s);
            if (s.team === 'p') {
                if (c.flash) { c.flash = false; this._drop(); }
                c.hp--;
                if (c.hp <= 0) this._destroy(c, true); else this.events.push({ type: 'dent', x: s.x, y: s.y, hp: c.hp });
            } else if (c.shield > 0) this.events.push({ type: 'deflect', x: s.x, y: s.y });
            else this._lose();
            return;
        }
        // shots meeting shots
        for (const o of this.shots) {
            if (o === s || o.team === s.team) continue;
            if (Math.abs(o.x - s.x) < 0.7 && Math.abs(o.y - s.y) < 0.7) { this._removeShot(o); this._removeShot(s); this.events.push({ type: 'spark', x: s.x, y: s.y }); return; }
        }
    }
    _lose() {
        const c = this.car;
        c.alive = false; c.respawn = 1600;
        this.lives--; this.power = 0;
        this.events.push({ type: 'crash', x: c.x + 1, y: c.y + 1 });
        if (this.lives <= 0) { this.lost = 'cars'; this._end(); }
    }
    _end() { this.overAt = 1800; }

    /* ---------- the world ---------- */
    step(ms) {
        if (this.over) return;
        this.t += ms;
        if (this.overAt) { this.overAt -= ms; this._stepShots(ms); if (this.overAt <= 0) { this.over = true; this.events.push({ type: 'over', score: this.score, lost: this.lost }); } return; }
        if (this.clearAt) { this.clearAt -= ms; if (this.clearAt <= 0) { const lv = this.level + 1; this.startLevel(lv); } return; }
        if (this.nitro > 0) this.nitro = Math.max(0, this.nitro - ms);
        if (this.fortify > 0) { this.fortify -= ms; if (this.fortify <= 0) { this.fortify = 0; this._ring('t'); } }
        if (this.bonus && this.t > this.bonus.until) this.bonus = null;
        this.spawnAt -= ms;
        if (this.spawnAt <= 0) { this._spawn(); this.spawnAt = Math.max(1200, 3200 - this.level * 150) * this.diff.spawn; }
        this._stepPlayer(ms);
        for (const e of this.cars.slice()) this._stepEnemy(e, ms);
        this._stepShots(ms);
        if (this.killed >= PER_LEVEL && !this.cars.length && !this.clearAt) {
            this.clearAt = 3000;
            this.events.push({ type: 'cleared', level: this.level, kills: Object.assign({}, this.kills) });
        }
    }
    left() { return PER_LEVEL - this.come; }
}

function loadBest(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('street_siege: best scores not read: ' + e.message);
        return {};
    }
}
function saveBest(file, best) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(best));
    fs.renameSync(file + '.tmp', file);
}

module.exports = { THEMES, theme, Game, DT, BW, BH, TW, TH, DIRS, LIVES, GARAGE_HP, PER_LEVEL, ON_YARD, TYPES, POWERS, PLAYER, BASE, RING, SPAWNS, build, convoy, seeded, loadBest, saveBest };
