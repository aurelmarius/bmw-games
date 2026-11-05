#!/usr/bin/env node
'use strict';
/**
 * screenshots.js - the README's screenshots (docs/screenshots/*.png), drawn by the built games on a
 * PC: seeded games played by an autopilot, a car that stands still (a fake SOME/IP). No head unit needed.
 *
 *   python3 kit/tools/build.py aurelm_snake aurelm_track_defender aurelm_pit_wall aurelm_lucky_sevens aurelm_blackjack aurelm_solitaire aurelm_apex_chase aurelm_street_siege aurelm_pinball aurelm_ridge_duel && node tools/screenshots.js
 *
 * Each game runs in its own process (the fake clock replaces Date.now and the timers).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

if (!process.argv[2]) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const app of ['snake', 'track_defender', 'pit_wall', 'lucky_sevens', 'blackjack', 'solitaire', 'apex_chase', 'street_siege', 'pinball', 'ridge_duel']) {
        process.stdout.write(execFileSync(process.execPath, [__filename, app], { encoding: 'utf8' }));
    }
    process.exit(0);
}

const which = process.argv[2];
// (the games' ids carry the aurelm_ prefix; the arguments and the pictures' names don't)
const stage = path.join(ROOT, 'dist', 'aurelm_' + which, 'source', 'javascript');
if (!fs.existsSync(stage)) { console.error('build it first: python3 kit/tools/build.py aurelm_' + which); process.exit(1); }
const { Canvas } = require(path.join(stage, 'kit', 'canvas'));
const { theme } = require(path.join(stage, 'kit', 'themes'));
const shot = (name, cv) => { fs.writeFileSync(path.join(OUT, name + '.png'), cv.png()); console.log('docs/screenshots/' + name + '.png'); };


/* ---------- fake clock (setImmediate stays real: it drives the promise chains) ---------- */
let now = Date.UTC(2026, 9, 30, 15, 42);
Date.now = () => now;
const timers = [];
global.setInterval = (fn, ms) => { const t = { fn, ms, next: now + ms }; timers.push(t); return t; };
global.setTimeout = (fn, ms) => { const t = { fn, ms, next: now + (ms || 0), once: true }; timers.push(t); return t; };
global.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
global.clearInterval = global.clearTimeout;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms, every) {
    const end = now + ms;
    while (now < end) {
        now = Math.min(end, now + 50);
        for (const t of timers.slice()) if (t.next <= now) { if (t.once) timers.splice(timers.indexOf(t), 1); else t.next += t.ms; t.fn(); }
        if (now % 1000 === 0) { if (every) every(); await flush(); }
    }
}

/* ---------- the car ---------- */
const H = {};
let respond = null;
const car = { km: 48211.3, oil: 78, soc: 47 };
const frame = (ecu, uds) => ({ udsResponse: [0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds), errorCode: 'NO_ERROR' });
const signals = {
    watch: (iface, inst, handlers) => { H[iface] = Object.assign(H[iface] || {}, handlers); return Promise.resolve({ available: true, error: null }); },
    proxy: () => Promise.resolve({}),
    on: (p, name, fn) => { respond = fn; return Promise.resolve(); },
    onAvailable: (p, fn) => { fn(true); return Promise.resolve(); },
    call: (p, method, q) => {
        const d = Array.from(q.udsData), ecu = q.targetAddress, sid = q.serviceID;
        setImmediate(() => {
            if (ecu === 7 && sid === 0x22 && d[0] === 0xDD && d[1] === 0xBC) { const raw = car.soc * 10; return respond(frame(ecu, [0x62, 0xDD, 0xBC, raw >> 8, raw & 255])); }
            if (ecu === 0x12 && sid === 0x01 && d[0] === 0xA6) { const raw = Math.round(car.km * 10); return respond(frame(ecu, [0x41, 0xA6, (raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255])); }
            respond(frame(ecu, [0x7F, sid, 0x31]));
        });
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    },
};
const send = (iface, field, v) => H[iface] && H[iface][field] && H[iface][field](v);

/* ---------- the app, as the build lays it out ---------- */
const APP = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-'));
const DATA = path.join(APP, 'data');
fs.cpSync(stage, APP, { recursive: true });
fs.mkdirSync(DATA);
fs.writeFileSync(path.join(APP, 'kit', 'mgu.js'), 'module.exports = { run: (app) => { global.__app = app; } };');
process.on('exit', () => fs.rmSync(APP, { recursive: true, force: true }));

const spec = JSON.parse(fs.readFileSync(path.join(APP, 'kit', 'app-spec.json'), 'utf8'));
const values = {};
spec.settings.forEach((s) => { values[s.key] = s.default; });
Object.assign(values, { demo: 'off' });
const clicks = {};
let last = null, lastRec = null;
// the app draws on the kit's recorder (as on the car); the recording is played into a canvas for the PNG
const { Recorder, play } = require(path.join(APP, 'kit', 'record'));
const { Canvas: AppCanvas } = require(path.join(APP, 'kit', 'canvas'));
const toCanvas = (r) => { const cv = new AppCanvas(r.w, r.h); play(r.words(), cv); return cv; };
// the last frame drawn, played into a canvas only when it is shot (the games draw hundreds before)
Object.defineProperty(global, 'lastFrame', { get: () => (lastRec ? (last = toCanvas(lastRec), lastRec = null, last) : last) });
const ctx = {
    ui: { onClick: (n, fn) => { clicks[n] = fn; }, image: (n, r) => { lastRec = r; return Promise.resolve(); }, onVisible() {}, text: async () => {} },
    settings: { get: (k) => values[k], set: (k, v) => { values[k] = v; }, onChange() {} },
    dataDir: DATA, signals, spec,
    log: { info() {}, warn() {}, error() {} },
    theme: () => theme(values.theme),
    canvas: (w, h) => { const r = new Recorder(w, h, { textScale: 1 }); r.reset(); return r; },
    loop: (n, fps, fn) => { ctx.draw = fn; }, hasClients: () => true,
};

/* ---------- Pit Wall: a seeded game, the wing under the ball, caught in a combo ---------- */
if (which === 'pit_wall') {
    let seed = 5;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'pit_wall_best.json'), JSON.stringify({ normal: 9850 }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        clicks.BTN_PLAY();
        // up to level 4, then a frame just after a panel broke in a combo of x3 or more (or after 20 minutes)
        for (let i = 0; i < 75000; i++) {
            now += 16;
            const b = g.balls.find((q) => !q.held) || g.balls[0];
            g.moveTo(b.x + Math.sin(now / 1900) * g.wing.w * 0.3);
            const before = g.score;
            await ctx.draw();
            if (g.over) clicks.BTN_NEW();
            if (g.level >= 4 && g.mult() >= 3 && g.score > before && g.bricks.length < 45) break;
        }
        for (let k = 0; k < 5; k++) { now += 16; await ctx.draw(); }
        shot('pit_wall-game', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Lucky Sevens: seeded spins, the reels caught running, then a win on several lines ---------- */
if (which === 'lucky_sevens') {
    let seed = 7;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'lucky_sevens.json'), JSON.stringify({
        credits: 48320, coin: 5, jackpot: 24870.5,
        stats: { spins: 1284, bet: 412650, won: 398420, bestWin: 12500, streak: 0, bestStreak: 9, freeRounds: 6, jackpots: 0, bestJackpot: 0 },
    }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms) => { for (let t = 0; t < ms; t += 16) { now += 16; await ctx.draw(); } };
        // the reels running: the last ones still a blur
        clicks.BTN_SPIN();
        await frames(1150);
        shot('lucky_sevens-spin', lastFrame);
        // spins until one pays three sevens or more and on other lines too; its first moment: every line lit
        for (let i = 0; i < 3000; i++) {
            while (g.spinning) await frames(16);
            const r = g.result;
            if (r.wins.length >= 2 && r.level === 'win' && r.wins.some((w) => w.sym === 'seven' && w.count >= 3)) break;
            await frames(1500);
            g.credits = Math.max(g.credits, 5000);
            clicks.BTN_SPIN();
        }
        await frames(450);
        shot('lucky_sevens-win', lastFrame);
        // on to free spins: three WILDs, their announcement
        for (let i = 0; i < 5000; i++) {
            await frames(1500);
            g.credits = Math.max(g.credits, 5000);
            if (g.free.left) g.free.left = 0;
            clicks.BTN_SPIN();
            while (g.spinning) await frames(16);
            if (g.result.award && !g.result.free) break;
        }
        // the announcement comes after the win on show has counted (main.js: countMs + 500)
        const r = g.result, mult = (r.win + r.jackpotWin) / r.bet;
        await frames((r.win ? Math.min(5000, 500 + mult * 90) + 500 : 250) + 900);
        shot('lucky_sevens-free', lastFrame);
        // the statistics
        await frames(8000);
        while (g.spinning || g.free.left) { await frames(500); if (!g.spinning) g.free.left = 0; }
        clicks.BTN_STATS();
        await frames(200);
        shot('lucky_sevens-stats', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Blackjack: seeded hands, one in play with the hint, then a split that won ---------- */
if (which === 'blackjack') {
    let seed = 12;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'blackjack.json'), JSON.stringify({
        credits: 4250, bet: 50,
        stats: { hands: 312, won: 139, lost: 148, pushes: 25, blackjacks: 14, bet: 17650, paid: 17480, bestWin: 300, streak: 2, bestStreak: 7, doubles: 31, splits: 9 },
    }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms) => { for (let t = 0; t < ms; t += 16) { now += 16; await ctx.draw(); } };
        const play = async () => {                  // basic strategy, as a player who follows the hint
            for (let k = 0; k < 30 && (g.phase === 'play' || g.phase === 'insurance'); k++) {
                if (g.phase === 'insurance') clicks.BTN_STAND(); else ({ hit: clicks.BTN_MAIN, stand: clicks.BTN_STAND, double: clicks.BTN_DOUBLE, split: clicks.BTN_SPLIT })[g.advice()]();
                await frames(1200);
            }
        };
        // a hand to double: 10 or 11 against a small card
        for (let i = 0; i < 400; i++) {
            clicks.BTN_MAIN();
            await frames(2400);
            if (g.phase === 'play' && g.advice() === 'double') break;
            await play();
            await frames(2600);
        }
        await frames(300);
        shot('blackjack-play', lastFrame);
        await play();
        await frames(2600);
        // a split that won
        for (let i = 0; i < 2000; i++) {
            clicks.BTN_MAIN();
            await frames(2400);
            const split = g.phase === 'play' && g.advice() === 'split';
            await play();
            await frames(3000);
            if (split && g.hands.length >= 2 && g.hands.every((h) => h.result === 'win' || h.result === 'push') && g.hands.some((h) => h.result === 'win')) break;
        }
        await frames(300);
        shot('blackjack-split', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Solitaire: seeded deals played by the hint, through the bar buttons; mid-game, then a win ---------- */
if (which === 'solitaire') {
    let seed = 31;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'solitaire.json'), JSON.stringify({ stats: { played: 41, won: 17, bestTime: 214, bestScore: 5630, streak: 2, bestStreak: 4 } }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    const PL = ['s', 'w', 'f0', 'f1', 'f2', 'f3', 't0', 't1', 't2', 't3', 't4', 't5', 't6'];
    let cur = 1;
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms) => { for (let t = 0; t < ms; t += 16) { now += 16; await ctx.draw(); } };
        /** one step of the hint, played the way a player would: to the pile, then "Move" (or "Draw") */
        const step = async (ms) => {
            const h = g.hint();
            if (!h) return false;
            if (h.draw) { if (g.recycles > 12) return false; clicks.BTN_DRAW(); } else {
                const want = PL.indexOf(h.from.k + (h.from.i === undefined ? '' : h.from.i));
                while (cur !== want) { clicks.BTN_NEXT(); cur = (cur + 1) % PL.length; }
                clicks.BTN_MOVE();
            }
            await frames(ms);
            return true;
        };
        await frames(2500);                         // the deal
        for (let i = 0; i < 46; i++) if (!(await step(300))) break;
        g.ms = 154000;
        await frames(600);
        shot('solitaire-game', lastFrame);
        // deals until one is won (the cards go up by themselves at the end)
        for (let d = 0; d < 60 && !g.won(); d++) {
            for (let i = 0; i < 1500 && !g.won() && !g.canFinish(); i++) if (!(await step(16))) break;
            if (g.canFinish()) { g.ms = 263000; for (let t = 0; t < 600 && !g.won(); t++) await frames(16); }
            if (!g.won()) { clicks.BTN_NEW(); clicks.BTN_NEW(); cur = 1; await frames(2500); }
        }
        await frames(3800);
        shot('solitaire-win', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Apex Chase: an autopilot that collects drops and keeps away from the electric cars ---------- */
if (which === 'apex_chase') {
    let seed = 17;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'apex_chase_best.json'), JSON.stringify({ normal: 18450 }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    /** at the crossing ahead: away from hunting cars that are close, else to scared ones or the nearest drop */
    function pilot() {
        const c = g.car;
        // decide for the crossing ahead (the cell the car is heading into)
        const nx0 = c.t > 0 ? M.wrapX(c.x + M.DIRS[c.dir][0]) : c.x, ny0 = c.t > 0 ? c.y + M.DIRS[c.dir][1] : c.y;
        const cell = (d, e) => d[Math.round(e.y)][M.wrapX(Math.round(e.x))];
        const here = M.distances(g.grid, { x: nx0, y: ny0 }, true);
        const ways = ['U', 'L', 'D', 'R'].filter((d) => g.open(nx0 + M.DIRS[d][0], ny0 + M.DIRS[d][1]));
        const threats = g.evs.filter((e) => e.state === 'out' && cell(here, e) < 6);
        const score = (d) => {
            const from = M.distances(g.grid, { x: M.wrapX(nx0 + M.DIRS[d][0]), y: ny0 + M.DIRS[d][1] }, true);
            if (threats.length) return Math.min(...threats.map((e) => cell(from, e))) * 10;
            const prey = g.evs.filter((e) => e.state === 'scared' && g.fright > 1200);
            if (prey.length) return -Math.min(...prey.map((e) => cell(from, e)));
            let best = 1e9; for (const k of g.dots) { const [x, y] = k.split(',').map(Number); best = Math.min(best, from[y][x]); } return -best;
        };
        let bd = null, bv = -1e9; for (const d of ways) { const v = score(d); if (v > bv) { bv = v; bd = d; } }
        if (bd) g.steer(bd);
    }

    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms, until) => { for (let t = 0; t < ms; t += 16) { now += 16; pilot(); await ctx.draw(); if (until && until()) return true; } return false; };
        clicks.BTN_PLAY();
        // the chase under way: about a third of the drops gone, the four cars out
        const calm = () => !g.fright && !g.dying && g.pause <= 0 && g.evs.filter((e) => e.state === 'out').length >= 3 && !g.evs.some((e) => e.state === 'back');
        await frames(120000, () => g.eaten > 90 && calm());
        shot('apex_chase-game', lastFrame);
        // a nitro (given: the autopilot doesn't plan for one), a car caught, the others fleeing
        await frames(3000);
        const near = () => { const d = M.distances(g.grid, { x: g.car.x, y: g.car.y }, true); return g.evs.filter((e) => d[Math.round(e.y)][M.wrapX(Math.round(e.x))] < 7).length; };
        await frames(90000, () => calm() && g.evs.filter((e) => e.state === 'out').length === 4 && near() >= 2);
        g._nitro();
        await frames(7000, () => g.fright > 2100 && g.evs.some((e) => e.state === 'back') && g.evs.some((e) => e.state === 'scared'));
        await frames(250);
        shot('apex_chase-nitro', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Ridge Duel: a seeded match, your shots worked out (and missed by a little) ---------- */
if (which === 'ridge_duel') {
    let seed = 41;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'ridge_duel_stats.json'), JSON.stringify({ normal: { played: 6, won: 4, streak: 2, best: 3, shots: 40, hits: 17 } }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(Object.assign({}, o, { rng: M.seeded(7) })); g = this; } };
    const best = () => {
        const me = g.cars[0], you = g.cars[1];
        let b = null;
        for (let a = 15; a <= 80; a += 2.5) for (let p = 0.35; p <= 1.001; p += 0.025) { const l = g.landing(me, a, p), d = l.car ? 0 : Math.abs(l.x - you.x); if (!b || d < b.d) b = { a, p, d }; }
        return b;
    };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms, until) => { for (let t = 0; t < ms; t += 16) { now += 16; await ctx.draw(); if (until && until()) return true; } return false; };
        clicks.BTN_PLAY();
        await frames(2000);
        // a few shots each way: craters, damage
        for (let k = 0; k < 3; k++) {
            await frames(20000, () => g.mine());
            const b = best(); g.cars[0].aim = b.a + (k < 2 ? 4 : 0); g.fire(0, b.p);
            await frames(20000, () => !g.mine() && g.phase === 'aim' && g.turn === 1);
        }
        // your turn: the gun up, the guide out, power being held
        await frames(20000, () => g.mine());
        g.cars[0].aim = 52; g.cars[0].power = 0.72; g.cars[0].shell = 'cluster';
        await frames(300);
        shot('ridge_duel-aim', lastFrame);
        // the SUV in white: a heavy shell going off on the rival
        g.cars[0].body = 'suv'; g.cars[0].settle(g.ground); values.paint = 'white'; values.car = 'suv';
        const b = best(); g.cars[0].shell = 'heavy'; g.cars[0].ammo.heavy = 1; g.cars[0].aim = b.a; g.fire(0, b.p);
        await frames(20000, () => g.events.some((e) => e.type === 'boom') || g.phase !== 'flight');
        await frames(90);
        shot('ridge_duel-hit', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- M Pinball: an autopilot on the flippers ---------- */
if (which === 'pinball') {
    let seed = 31;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'pinball_best.json'), JSON.stringify({ 'normal-3': 2384150 }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    const held = [0, 0];
    const pilot = () => {
        for (let s = 0; s < 2; s++) {
            const p = M.PIVOTS[s], tip = g.flipperTip(s, M.FLIP.rest);
            const flip = (up) => Game.prototype.flipper.call(g, s, up);
            if (held[s] > 0) { held[s] -= 16; if (held[s] <= 0) { flip(false); held[s] = -220; } else flip(true); continue; }
            if (held[s] < 0) { held[s] = Math.min(0, held[s] + 16); continue; }
            const near = g.balls.some((b) => { if (b.plunger || b.ramp || b.hold) return false; const q = M.closest([p.u, p.v], tip, b.u + b.vu * 0.03, b.v + b.vv * 0.03); return Math.hypot(b.u + b.vu * 0.03 - q[0], b.v + b.vv * 0.03 - q[1]) < 30 && q[2] > 0.3; });
            if (near) { held[s] = 200; flip(true); }
        }
        if (g.onPlunger() && g.ms - g.waitSince > 900) { g.setPull(0.55 + Math.random() * 0.4); g.launch(); }
        g.saveUntil = 1e12;
    };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms, until) => { for (let t = 0; t < ms; t += 16) { now += 16; pilot(); await ctx.draw(); if (until && until()) return true; } return false; };
        await frames(400);
        clicks.BTN_PLAY();
        g.flipper = () => {};                       // (the autopilot holds the flippers, not the controller)
        g.saveUntil = 1e12;                         // (the autopilot isn't good: for the pictures it can't lose)
        // a ball in play among the wheels, some lamps lit, a flipper up
        g.lanes = [true, false, true]; g.gear = 3; g.targets = [true, true, true, false, true, false];
        await frames(120000, () => g.score > 60000 && g.balls.some((b) => !b.plunger && !b.ramp && b.u > 150 && b.u < 420 && b.v > 380 && b.v < 560 && Math.hypot(b.vu, b.vv) > 500));
        shot('pinball-game', lastFrame);
        // SAFETY CAR MULTIBALL: a ball on the ramp, two on the table
        g.pitLit = true;
        const b0 = g.balls.find((b) => !b.plunger) || g.balls[0];
        b0.plunger = false; b0.u = M.PIT.u; b0.v = M.PIT.v; b0.vu = b0.vv = 0;
        await frames(30000, () => g.balls.length >= 3 && g.balls.every((b) => !b.plunger && !b.hold && !b.inLane));
        await frames(700);
        const r = g.balls.find((b) => b.v > 300) || g.balls[0];
        r.ramp = { s: M.RAMP_S[M.RAMP_TOP] * 0.7, sp: 900 };
        await frames(200);
        shot('pinball-multiball', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Street Siege: an autopilot that lines up under the car nearest the garage and fires ---------- */
if (which === 'street_siege') {
    let seed = 23;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'street_siege_best.json'), JSON.stringify({ normal: 12600 }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    const pilot = () => {
        const c = g.car;
        if (!c.alive) return;
        const es = g.cars.filter((e) => e.state === 'on');
        if (!es.length) { g.drive(null); return; }
        const e = es.sort((a, b) => Math.hypot(a.x - M.BASE.x, a.y - M.BASE.y) - Math.hypot(b.x - M.BASE.x, b.y - M.BASE.y))[0];
        const dx = e.x - c.x, dy = e.y - c.y;
        if (Math.abs(dx) < 1 && dy < 0) { g.drive(null); c.dir = 'U'; g.fire(); return; }
        if (Math.abs(dy) < 1) { g.drive(null); c.dir = dx < 0 ? 'L' : 'R'; g.fire(); return; }
        g.drive(Math.abs(dx) < 1 ? (dy > 0 ? 'D' : 'U') : dx < 0 ? 'L' : 'R');
        if (c.x === c._lx && c.y === c._ly) { g.drive(Math.random() < 0.5 ? 'U' : 'D'); g.fire(); }
        c._lx = c.x; c._ly = c.y;
    };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        const frames = async (ms, until) => { for (let t = 0; t < ms; t += 16) { now += 16; pilot(); await ctx.draw(); if (until && until()) return true; } return false; };
        clicks.BTN_PLAY();
        // the siege under way: four cars in, shots flying, a car just blown up
        g.car.shield = 1e9;                         // (the autopilot only defends; for the pictures it can't lose)
        await frames(90000, () => { return g.t > 20000 && g.cars.filter((e) => e.state === 'on').length >= 3 && g.shots.length >= 2 && g.killed >= 2; });
        g.car.shield = 0;
        shot('street_siege-game', lastFrame);
        // a power-up taken: the shield on the car, the others frozen by NITRO
        g.car.shield = 8000; g.nitro = 6000; g.power = 2;
        g._drop();
        await frames(900);
        await frames(600, () => Math.floor(now / 250) % 2 === 0);   // (the power-up blinks: shown)
        shot('street_siege-power', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Track Defender: a seeded game, the car under the nearest drone ---------- */
if (which === 'track_defender') {
    let seed = 11;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'track_defender_best.json'), JSON.stringify({ normal: 2140 }));
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        for (;;) {
            clicks.BTN_NEW();
            // into wave 3, then a moment just after a drone went down (its particles in the air)
            let scored = false;
            while (!g.over && (g.wave < 3 || g.enemies.length > 26 || !scored)) {
                now += 16;
                const e = g.enemies.filter((q) => q.state !== 'enter').sort((a, b) => b.y - a.y)[0];
                if (e) g.moveTo(e.x);
                const before = g.score;
                await ctx.draw();
                scored = g.score > before;
                if (now % 160000 < 16) process.stderr.write('wave ' + g.wave + ' score ' + g.score + ' lives ' + g.lives + '\n');
            }
            for (let k = 0; k < 6 && !g.over; k++) { now += 16; await ctx.draw(); }
            if (!g.over) break;
        }
        shot('track_defender-game', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

/* ---------- Snake: a seeded game played by a simple autopilot ---------- */
if (which === 'snake') {
    let seed = 7;
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    fs.writeFileSync(path.join(DATA, 'snake_best.json'), JSON.stringify({ 'normal/wrap': 31 }));
    // the game the app plays, to steer it
    const M = require(path.join(APP, 'model'));
    let g = null;
    const Game = M.Game;
    M.Game = class extends Game { constructor(o) { super(o); g = this; } };
    M.Game.stepMs = Game.stepMs;
    const wrapD = (a, b, n) => { const d = ((b - a) % n + n) % n; return d > n / 2 ? d - n : d; };
    const free = (d) => {
        const [dx, dy] = M.DIRS[d], h = g.snake[0];
        const x = (h.x + dx + g.cols) % g.cols, y = (h.y + dy + g.rows) % g.rows;
        return !g.snake.slice(0, -1).some((c) => c.x === x && c.y === y);
    };
    function steer() {
        if (g.queue.length) return;
        const h = g.snake[0], dx = wrapD(h.x, g.food.x, g.cols), dy = wrapD(h.y, g.food.y, g.rows);
        const want = [dx > 0 ? 'E' : dx < 0 ? 'W' : null, dy > 0 ? 'S' : dy < 0 ? 'N' : null, g.dir, 'N', 'E', 'S', 'W'].filter(Boolean);
        const d = want.find((x) => x !== { N: 'S', S: 'N', E: 'W', W: 'E' }[g.dir] && free(x));
        if (d && d !== g.dir) g.turn(d);
    }
    (async () => {
        require(path.join(APP, 'app.js'));
        ctx.display = { own: () => true };          // as where the kit runs the screen (mgu-render): touch hints
        await global.__app.start(ctx);
        // frames 16 ms apart until the snake is long, then one caught between two steps; a crash plays again
        for (;;) {
            clicks.BTN_NEW();
            while (g.score < 20 && !g.over) { now += 16; steer(); await ctx.draw(); }
            for (let k = 0; k < 4 && !g.over; k++) { now += 16; steer(); await ctx.draw(); }
            if (!g.over) break;
        }
        shot('snake-game', lastFrame);
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
    return;
}

console.error('unknown game: ' + which);
process.exit(1);
