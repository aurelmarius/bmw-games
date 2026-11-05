'use strict';
/**
 * Ridge Duel - two armed cars on hills at dusk, a turn each: aim, power, fire. Destructible ground, wind,
 * four kinds of shell, a rival aimed by the game. Your car is a sport sedan or a performance SUV (a
 * setting), each with what it's good at, in the colour you like. Drawn by the GPU renderer (mgu-render).
 * Parked only.
 *
 * The rules are in model.js (tests/ridge_duel.test.js), the look in art.js and cars.js.
 *
 * Playing it:
 *   iDrive controller (held by the game on screen), on your turn:
 *     turn = aim (faster when turned quickly); press and hold = power, let go = fire;
 *     push left / right and hold = drive (as far as the turn's fuel goes); push up / down = the shell;
 *     push up and hold = pause
 *     not playing: press starts / goes on, push left leaves, a turn lets go of the controller
 *   touchscreen (where the kit runs the screen): a finger on the hills aims the gun at it; FIRE (hold for
 *     power, let go); the shells; the DRIVE arrows (hold)
 *   bar buttons (where the kit doesn't run the screen): "Aim up", "Aim down", "Power", "Fire", "Start".
 *
 * The game pauses when the screen goes, a sheet (Settings) opens over it or the car drives off
 * (kit/parked.js), and can't be started while moving. Statistics are kept for each difficulty.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { TILT } = require('./kit/display');
const parkedWatch = require('./kit/parked').watch;
const M = require('./model');
const A = require('./art');

const W = 1600, H = 520;
const STATS_FILE = 'ridge_duel_stats.json';
const PARKED_MS = 500;
const FAST_TURN_MS = 140;            // notches closer than this turn the gun 3 degrees each
const GOLD = '#ffd36e', CYAN = '#7fe8ff', RED = '#e7222e', GREEN = '#5ff0a6';
const LABEL = { ready: 'START', playing: 'FIRE', paused: 'GO ON', over: 'AGAIN' };
const ABILITY = {
    sedan: ['AGILE', 'Drives almost twice as far in a turn; low and narrow: harder to hit'],
    suv: ['ARMOURED', 'Takes 20 % less damage, climbs steep slopes, fires from higher up'],
};

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;
        const diff = () => String(settings.get('difficulty') || 'normal');
        const body = () => (String(settings.get('car') || 'sedan') === 'suv' ? 'suv' : 'sedan');
        const paint = () => { const p = String(settings.get('paint') || 'blue'); return A.PAINTS[p] ? p : 'blue'; };
        const guide = () => String(settings.get('aimGuide') || 'on') === 'on';
        const statsFile = path.join(dataDir, STATS_FILE);
        let stats = M.loadStats(statsFile, log);

        const fresh = () => new M.Game({ difficulty: diff(), body: body() });
        let game = fresh();
        let state = 'ready';
        let acc = 0, lastT = Date.now(), frameT = Date.now();
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        let charge = null;                       // { from } while a press / FIRE is held
        let driveDir = 0, driveSrc = { ccu: 0, touch: 0 };
        let lastNotch = 0, firePressed = 0, overAt = 0;
        let parts = [], pops = [], rings = [], flash = [0, 0];
        let banner = null;                       // { s, sub, c, at, ms }

        function showToast(s, ms) { toast = s; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());
        function setState(s) {
            if (s === state) return;
            state = s; menu = false;
            Promise.resolve(ui.text('BTN_PLAY', s === 'playing' ? 'Pause' : LABEL[s].charAt(0) + LABEL[s].slice(1).toLowerCase())).catch(() => {});
            syncGrab();
        }
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        function play() {
            if (parked.moving()) { showToast('Parked only: the duel starts when the car stands still'); return; }
            if (state === 'over') newGame();
            if (state === 'playing') return;
            lastT = Date.now();
            if (state === 'ready') bannerRound();
            setState('playing');
        }
        function pause() { if (state === 'playing') { setState('paused'); charge = null; driveSrc = { ccu: 0, touch: 0 }; } }
        function newGame() { game = fresh(); acc = 0; parts = []; pops = []; rings = []; banner = null; charge = null; setState('ready'); }
        function bannerRound() { banner = { s: 'ROUND ' + game.roundNo, sub: game.turn === 0 ? 'You fire first' : 'The rival fires first', c: '#ffffff', at: Date.now(), ms: 1600 }; }

        /* ---------- aiming, power, fire ---------- */
        function aimBy(d) {
            const now = Date.now(), fast = now - lastNotch < FAST_TURN_MS;
            lastNotch = now;
            game.turnAim(d * (fast ? 3 : 1));
        }
        function startCharge() { if (game.mine() && !charge) charge = { from: Date.now() }; }
        function releaseCharge() {
            if (!charge) return;
            const p = Math.min(1, (Date.now() - charge.from) / M.CHARGE_MS);
            charge = null;
            if (game.mine()) game.fire(0, Math.max(0.05, p));
        }

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', () => { if (state === 'playing') pause(); else play(); });
        ui.onClick('BTN_UP', () => { if (state !== 'playing') play(); game.turnAim(5); });
        ui.onClick('BTN_DOWN', () => { if (state !== 'playing') play(); game.turnAim(-5); });
        ui.onClick('BTN_POWER', () => { const c = game.cars[0]; if (game.mine()) c.power = c.power >= 0.99 ? 0.3 : Math.min(1, Math.round(c.power * 10 + 1) / 10); });
        ui.onClick('BTN_FIRE', () => { if (state !== 'playing') { play(); return; } if (game.mine()) game.fire(0, game.cars[0].power); });
        if (ctx.hideButton) for (const b of ['BTN_UP', 'BTN_DOWN', 'BTN_POWER', 'BTN_FIRE']) ctx.hideButton(b);

        let ccu = null;
        if (ctx.controller) ctx.controller.onInput((v) => {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            const L = ccu;
            ccu = { k, pb, df };
            if (pb === 15 && df === 15) return;                  // no controller behind it
            let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
            if (Math.abs(d) > 64) d = 0;
            const down = (x) => x === 1 || x === 2;
            const pressed = down(pb) && !(L && down(L.pb)), letGo = !down(pb) && L && down(L.pb);
            const held = TILT[df] || null;
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            if (state === 'playing') {
                driveSrc.ccu = held === 'W' ? -1 : held === 'E' ? 1 : 0;
                if (df === 2 && !(L && L.df === 2)) { pause(); return; }       // pushed up and held: pause
                if (tilt === 'N') game.cycleShell(-1);
                if (tilt === 'S') game.cycleShell(1);
                if (pressed) { firePressed = Date.now(); startCharge(); }
                if (letGo) releaseCharge();
                if (d) aimBy(d);
                return;
            }
            driveSrc.ccu = 0;
            if (pressed) play();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (d) { menu = true; syncGrab(); }
        });
        let finger = null;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) {
                const F = A.FIRE_BTN;
                if (Math.hypot(x - F.x, y - F.y) < F.r + 14) { firePressed = Date.now(); if (state !== 'playing') { play(); finger = null; return; } finger = { kind: 'fire' }; startCharge(); return; }
                const t = A.TILES.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
                if (t) { game.choose(t.kind); finger = null; return; }
                const dv = A.DRIVE_BTNS.find((q) => x >= q.x - 4 && x <= q.x + q.w + 4 && y >= q.y - 4 && y <= q.y + q.h + 4);
                if (dv) { driveSrc.touch = dv.dir; finger = { kind: 'drive' }; return; }
                if (x >= A.PANEL.x) { finger = null; return; }
                if (state !== 'playing') { play(); finger = null; return; }
                finger = { kind: 'aim' };
            }
            if (!finger) return;
            if (finger.kind === 'aim' && phase !== 3) {
                const g = game.cars[0].gun(), px = A.BOARD.x + g.px, py = A.BOARD.y + g.py;
                const ang = Math.atan2(py - y, (x - px) * game.cars[0].facing) * 180 / Math.PI;
                game.setAim(Math.round(ang));
            }
            if (phase === 3) {
                if (finger.kind === 'fire') releaseCharge();
                if (finger.kind === 'drive') driveSrc.touch = 0;
                finger = null;
            }
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => { if (k === 'difficulty' || k === 'car') newGame(); });
        setInterval(() => { if (state === 'playing' && parked.moving()) { pause(); showToast('Paused: parked only', 4000); } }, PARKED_MS);

        /* ---------- the clock ---------- */
        function advance(now) {
            if (state !== 'playing') { lastT = now; return; }
            if (display && display.sheet) { pause(); return; }
            const dt = Math.min(100, now - lastT);
            lastT = now;
            driveDir = driveSrc.ccu || driveSrc.touch;
            if (driveDir && game.mine()) game.drive(0, driveDir, dt);
            if (charge && !game.mine()) charge = null;
            if (charge) game.cars[0].power = Math.min(1, (now - charge.from) / M.CHARGE_MS);
            acc += dt;
            while (acc >= M.DT) { game.step(M.DT); acc -= M.DT; }
            for (const ev of game.events.splice(0)) effect(ev, now);
            // smoke behind the shells
            for (const s of game.shells) parts.push({ x: A.BOARD.x + s.x, y: A.BOARD.y + s.y, vx: (Math.random() - 0.5) * 8, vy: -6, c: '#d8d0c4', life: 900, age: 0, kind: 'smoke', s: s.kind === 'heavy' ? 3 : 2, grow: 6, a: 0.22 });
            if (game.over && state === 'playing') end();
        }
        function end() {
            stats = M.record(stats, game);
            try { M.saveStats(statsFile, stats); } catch (e) { log.warn('ridge_duel: stats not saved: ' + e.message); }
            log.info('ridge_duel: match ' + game.wins.join(':') + ' (' + game.difficulty + ', ' + game.body + ')');
            overAt = Date.now();
            setState('over');
        }
        const PX = (x) => A.BOARD.x + x, PY = (y) => A.BOARD.y + y;
        function burst(x, y, n, colors, speed, o) {
            o = o || {};
            for (let i = 0; i < n; i++) {
                const a = (o.up ? -Math.PI / 2 + (Math.random() - 0.5) * 2.4 : Math.random() * Math.PI * 2), v = speed * (0.3 + Math.random());
                parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: colors[i % colors.length], life: (o.life || 500) * (0.6 + Math.random() * 0.6), age: 0, kind: o.kind || 'spark', s: (o.size || 3) * (0.5 + Math.random()), grow: o.grow || 0, g: o.g || 0, a: o.a || 1 });
            }
        }
        function effect(ev, now) {
            switch (ev.type) {
            case 'fire': {
                const g = game.cars[ev.side].gun();
                burst(PX(g.mx), PY(g.my), 10, ['#ffffff', GOLD, '#ff8a2a'], 160, { life: 200 });
                burst(PX(g.mx), PY(g.my), 10, ['#9a9aa2', '#c9c9d0'], 36, { life: 1000, size: 3, kind: 'smoke', grow: 8, a: 0.16 });
                break;
            }
            case 'boom': {
                const x = PX(ev.x), y = PY(ev.y), big = ev.kind === 'heavy';
                rings.push({ x, y, at: now, r: ev.r * 1.6, c: '#ffb020', ms: 480 });
                burst(x, y, big ? 46 : 26, ['#ffd000', '#ff7a2e', '#ff3b1f', '#ffffff'], big ? 300 : 220, { life: 650, size: 4 });
                burst(x, y, big ? 30 : 16, ['#5a4630', '#3a2a1a', '#7a6a4a'], big ? 260 : 190, { life: 1300, size: 3.5, kind: 'chip', g: 500, up: true });
                burst(x, y - 6, big ? 26 : 14, ['#3a3a40', '#55555c', '#6a6a72'], 40, { life: 2000, size: 5, kind: 'smoke', grow: big ? 18 : 12, a: 0.16 });
                for (const h of ev.hits) {
                    const c = game.cars[h.side];
                    flash[h.side] = now;
                    pops.push({ s: '-' + h.dmg, x: PX(c.x), y: PY(c.y - c.spec.height - 40), c: h.side === 0 ? RED : GOLD, at: now, ms: 1400 });
                }
                if (ev.direct) pops.push({ s: 'DIRECT HIT', x, y: y - 70, c: '#ffffff', at: now, ms: 1400, big: true });
                break;
            }
            case 'bounce': burst(PX(ev.x), PY(ev.y), 10, ['#5a4630', '#7a6a4a'], 140, { life: 700, size: 3, kind: 'chip', g: 500, up: true }); rings.push({ x: PX(ev.x), y: PY(ev.y), at: now, r: 20, c: GREEN, ms: 300 }); break;
            case 'split': burst(PX(ev.x), PY(ev.y), 12, [GOLD, '#ffffff'], 140, { life: 300 }); break;
            case 'stall': if (now - (toastUntil - 1500) > 800) showToast('Too steep to climb', 1500); break;
            case 'round': if (state === 'playing') bannerRound(); break;
            case 'roundOver':
                banner = ev.winner < 0 ? { s: 'DRAW', sub: 'Both cars out: the round again', c: '#ffffff', at: now, ms: 2400 }
                    : { s: ev.winner === 0 ? 'ROUND WON' : 'ROUND LOST', sub: 'You ' + ev.wins[0] + ' : ' + ev.wins[1] + ' Rival', c: ev.winner === 0 ? GREEN : RED, at: now, ms: 2400 };
                break;
            default: break;
            }
        }

        /* ---------- drawing ---------- */
        function drawBoard(cv, now, dt) {
            cv.blit(A.skyLayer(), A.BOARD.x, A.BOARD.y);
            cv.blit(A.groundLayer(game, game.roundNo), A.BOARD.x, A.BOARD.y);
            A.drawFlag(cv, game, now);
            game.cars.forEach((c, i) => { if (c.hp > 0 || game.phase !== 'roundOver' || Math.floor(now / 200) % 2) A.drawCar(cv, c, paint(), now - flash[i] < 160); });
            game.cars.forEach((c) => A.drawHealth(cv, c));
            // the aim guide: where the shell leaves for, the first part of its flight
            if (guide() && game.mine() && state === 'playing') {
                const c = game.cars[0], g = c.gun(), v = M.VMAX * Math.max(0.3, c.power);
                for (let i = 1; i <= 9; i++) {
                    const t = i * 0.05, x = g.mx + g.dx * v * t, y = g.my + g.dy * v * t + M.G * t * t / 2;
                    cv.circle(PX(x), PY(y), 2.6 - i * 0.15, withAlpha('#ffffff', 0.8 - i * 0.07));
                }
            }
            for (const s of game.shells) A.drawShell(cv, s);
            drawEffects(cv, dt, now);
            // the wind
            const wx = A.BOARD.x + A.BOARD.w / 2, wy = A.BOARD.y + 14;
            cv.roundRect(wx - 92, wy, 184, 34, 17, withAlpha('#05060a', 0.72));
            const w = game.wind, dir = w < 0 ? -1 : 1, ax = wx - 62;
            if (w) A.convex(cv, dir < 0 ? [[ax - 10, wy + 17], [ax + 6, wy + 8], [ax + 6, wy + 26]] : [[ax + 10, wy + 17], [ax - 6, wy + 8], [ax - 6, wy + 26]], '#81c4ff');
            else cv.circle(ax, wy + 17, 4, '#81c4ff');
            cv.text('WIND  ' + Math.abs(w) + ' km/h', wx + 10, wy + 23, 15, '#ffffff', { font: 'bold', align: 'center', spacing: 1, literal: true });
        }
        function drawEffects(cv, dt, now) {
            const s = dt / 1000;
            parts = parts.filter((q) => (q.age += dt) < q.life);
            if (parts.length > 700) parts.splice(0, parts.length - 700);
            for (const q of parts) {
                q.vy += (q.g || 0) * s;
                q.x += q.vx * s; q.y += q.vy * s;
                if (q.kind !== 'chip') { q.vx *= 0.94; q.vy *= 0.94; }
                const a = 1 - q.age / q.life;
                if (q.kind === 'spark') cv.line(q.x, q.y, q.x - q.vx * 0.04, q.y - q.vy * 0.04, 2.2, withAlpha(q.c, a));
                else if (q.kind === 'smoke') cv.circle(q.x, q.y, q.s + q.grow * (1 - a), withAlpha(q.c, q.a * a));
                else if (q.kind === 'chip') cv.fillRect(q.x - q.s / 2, q.y - q.s / 2, q.s, q.s, withAlpha(q.c, Math.min(1, a * 2)));
            }
            rings = rings.filter((q) => now - q.at < q.ms);
            for (const q of rings) {
                const k = (now - q.at) / q.ms, r = 4 + q.r * k;
                if (k < 0.25) cv.circle(q.x, q.y, r * 0.8, withAlpha('#fff2c8', 0.6 * (1 - k * 4)));
                cv.arc(q.x, q.y, r, r + 3 + 6 * (1 - k), 0, 360, withAlpha(q.c, 0.8 * (1 - k)));
            }
            pops = pops.filter((q) => now - q.at < q.ms);
            for (const q of pops) {
                const k = (now - q.at) / q.ms;
                A.outlined(cv, q.s, q.x, q.y - k * 30, q.big ? 24 : 22, withAlpha(q.c, 1 - k * k), withAlpha('#05060a', 0.85 * (1 - k * k)), 2, { spacing: q.big ? 2 : 0 });
            }
        }
        function drawOverlay(cv, now, touch) {
            const cx = A.BOARD.x + A.BOARD.w / 2, cy = A.BOARD.y + 190;
            if (state === 'playing' && banner && now - banner.at < banner.ms) {
                const k = (now - banner.at) / banner.ms, a = k > 0.8 ? (1 - k) / 0.2 : 1;
                cv.roundRect(cx - 230, cy - 50, 460, 96, 18, withAlpha('#05060a', 0.75 * a));
                A.outlined(cv, banner.s, cx, cy + 4, 44, withAlpha(banner.c, a), withAlpha('#05060a', a), 2, { spacing: 5 });
                cv.text(banner.sub, cx, cy + 34, 18, withAlpha('#ffffff', 0.75 * a), { align: 'center', literal: true });
                return;
            }
            if (state === 'playing') return;
            if (state === 'over' && now - overAt < 1200) return;
            const moving = parked.moving();
            let title, lines, col = '#ffffff';
            const ab = ABILITY[body()];
            if (moving) { title = 'PARKED ONLY'; col = '#ffb020'; lines = ['The duel waits while the car is moving.', 'It goes on when you stop.']; } else if (state === 'ready') {
                title = 'RIDGE DUEL';
                lines = [M.BODIES[body()].label + ' · ' + ab[0] + ': ' + ab[1],
                    touch ? 'Turn: aim · hold the press: power, let go: fire · push left / right: drive · up / down: shell' : 'Aim up / down, Power and Fire in the bar',
                    'First to win three rounds. Press to start'];
            } else if (state === 'paused') { title = 'PAUSED'; lines = [touch ? 'Press or tap to go on' : 'Press "Go on"', 'Push left to leave  ·  turn for the menu']; } else {
                const won = game.wins[0] >= M.WINS, s = stats[game.difficulty] || {};
                title = won ? 'VICTORY' : 'DEFEAT'; col = won ? GREEN : RED;
                lines = ['You ' + game.wins[0] + ' : ' + game.wins[1] + ' Rival  ·  hits ' + game.stats.hits + ' of ' + game.stats.shots + ' shots',
                    'Matches won ' + (s.won || 0) + ' of ' + (s.played || 0) + (s.best ? '  ·  best run ' + s.best : ''), touch ? 'Press or tap to play again' : 'Press "Again"'];
            }
            const w = 860, h = 86 + lines.length * 30;
            cv.roundRect(cx - w / 2, cy - 62, w, h, 18, withAlpha('#05060a', 0.8));
            cv.strokeRoundRect(cx - w / 2, cy - 62, w, h, 18, 1.5, withAlpha('#ffffff', 0.15));
            A.outlined(cv, title, cx, cy - 4, 50, col, '#05060a', 2, { spacing: 6 });
            lines.forEach((l, i) => cv.text(l, cx, cy + 34 + i * 30, i === 0 && state === 'ready' ? 18 : 18, withAlpha('#ffffff', i === 0 && state === 'ready' ? 0.9 : 0.72), { align: 'center', literal: true }));
        }
        function drawPanel(cv, now, touch) {
            const P = A.PANEL, me = game.cars[0], you = game.cars[1];
            cv.blit(A.panelLayer(), P.x, P.y);
            // health
            [[me, 'YOU', M.BODIES[me.body].label + ' · ' + ABILITY[me.body][0], GREEN], [you, 'RIVAL', 'PICK-UP · 10 % ARMOUR', GOLD]].forEach(([c, n, sub, col], k) => {
                const y = P.y + 26 + k * 50, f = c.hp / c.spec.hp;
                cv.text(n, P.x + 26, y + 16, 15, game.turn === k && state === 'playing' ? '#ffffff' : withAlpha('#ffffff', 0.6), { font: 'bold', spacing: 1.5, literal: true });
                cv.text(sub, P.x + 26, y + 33, 11, withAlpha('#ffffff', 0.45), { font: 'label', spacing: 1, literal: true });
                cv.roundRect(P.x + 120, y + 5, 262, 14, 7, withAlpha('#ffffff', 0.08));
                if (f > 0) cv.roundRect(P.x + 121, y + 6, 260 * f, 12, 6, f > 0.5 ? col : f > 0.25 ? '#ffd23a' : RED);
                cv.text(String(c.hp), P.x + 382, y + 34, 12, withAlpha('#ffffff', 0.6), { font: 'bold', align: 'right', literal: true });
            });
            // angle and power: yours, the rival's while it aims
            const c = game.turn === 1 && state === 'playing' ? you : me, col = c === me ? null : GOLD;
            const lcd = (x, v, cl) => { A.glow(cv, x + 110, P.y + 167, 54, cl, 0.12); cv.text(v, x + 162, P.y + 179, 32, cl, { font: 'num', align: 'right', literal: true }); };
            lcd(P.x + 24, Math.round(c.aim) + '°', col || '#81c4ff');
            lcd(P.x + 214, Math.round(c.power * 100) + '%', col || GOLD);
            for (let i = 0; i < 24; i++) {
                const on = c.power > (i + 0.5) / 24;
                cv.roundRect(P.x + 22 + i * 15.6, P.y + 210, 12, 10, 3, on ? (i < 10 ? GREEN : i < 18 ? '#ffd23a' : RED) : withAlpha('#ffffff', 0.08));
            }
            // the shells
            A.TILES.forEach((t) => {
                const n = me.ammo[t.kind], st = n <= 0 ? 'empty' : me.shell === t.kind ? 'on' : 'off';
                cv.blit(A.tileLayer(t.kind, st, n), t.x - 2, t.y - 2);
            });
            // driving: the arrows, the turn's fuel
            const mine = game.mine();
            A.DRIVE_BTNS.forEach((b) => cv.blit(A.driveLayer(b.dir, !mine || me.fuel <= 0 ? 'off' : driveDir === b.dir ? 'down' : 'up'), b.x - 2, b.y - 2));
            const fx = P.x + 22, fy = P.y + 432, fw = 176;
            cv.roundRect(fx, fy, fw, 6, 3, withAlpha('#ffffff', 0.08));
            cv.roundRect(fx, fy, fw * Math.max(0, me.fuel) / me.spec.fuel, 6, 3, mine ? CYAN : withAlpha(CYAN, 0.3));
            // FIRE
            const F = A.FIRE_BTN, can = !parked.moving();
            const label = state !== 'playing' ? LABEL[state] : mine ? 'FIRE' : 'WAIT';
            if (can && (state !== 'playing' || mine)) A.glow(cv, F.x, F.y, F.r * 1.6, '#ff2a4a', 0.3 + 0.12 * Math.sin(now / 300));
            cv.blit(A.fireLayer(label, charge || now - firePressed < 140 ? 'down' : can && (state !== 'playing' || mine) ? 'on' : 'off'), F.x - F.r - 2, F.y - F.r - 2);
            cv.text(touch ? 'Up / down: shell · hold up: pause' : 'Bar: Aim · Power · Fire', P.x + 22, P.y + 452, 11, withAlpha('#ffffff', 0.4), { font: 'label', literal: true });
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear('#050608');
            A.setTextScale(cv.textScale);
            const touch = !!cv.own || own();
            drawBoard(cv, now, state === 'playing' ? dt : 0);
            drawOverlay(cv, now, touch);
            drawPanel(cv, now, touch);
            const turnBadge = state === 'playing' && game.phase === 'aim' ? (game.turn === 0 ? { text: 'YOUR TURN', color: 'ok' } : { text: "RIVAL'S TURN", color: 'warn' }) : null;
            G.frame(cv, t, ['Ridge Duel'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }, turnBadge, { text: 'ROUND ' + game.roundNo + '  ·  ' + game.wins[0] + ' : ' + game.wins[1], color: 'cold' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Ridge Duel first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
