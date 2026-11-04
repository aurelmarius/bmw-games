'use strict';
/**
 * M Pinball - a pinball table on the circuit: wheels for bumpers, the CHICANE ramp, the PIT LANE, the
 * M-POWER targets, SAFETY CAR MULTIBALL. Drawn by the GPU renderer every frame (mgu-render: up to 60 fps).
 * Parked only.
 *
 * The rules and the physics are in model.js (tests/pinball.test.js), the look in art.js. The world is
 * stepped at a fixed 60 Hz (in 8 sub steps) whatever the frame rate.
 *
 * Playing it:
 *   iDrive controller (held by the game on screen):
 *     push left / right and hold = that flipper up (let go: down); press and hold = both flippers
 *     the ball on the plunger: press and hold to pull it, let go to launch; or turn to pull it a notch
 *       at a time and press to let go; or push down and hold, let go to launch
 *     push up = nudge; a small turn while the ball is in play does nothing (it happens by accident while
 *       holding a flipper); a big one (PAUSE_NOTCHES within a second) pauses
 *     not playing: press starts / goes on, push left leaves, a turn lets go of the controller
 *   touchscreen (where the kit runs the screen): a finger on the left half of the table = the left
 *     flipper while it's down, the right half = the right one; LAUNCH (hold, let go), or pull the
 *     plunger down with a finger; NUDGE
 *   bar buttons (where the kit doesn't run the screen): "Left", "Right", "Launch", "Nudge", "Start".
 *
 * The game pauses when the screen goes, a sheet (Settings) opens over it or the car drives off
 * (kit/parked.js), and can't be started while moving. Best scores are kept per difficulty and balls.
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
const BEST_FILE = 'pinball_best.json';
const PARKED_MS = 500;
const CHARGE_MS = 1300;              // a full pull of the plunger
const KNOB_STEP = 0.1;               // a notch of the knob
const PAUSE_NOTCHES = 8;             // a turn this big within PAUSE_MS pauses the game (a small one: nothing)
const PAUSE_MS = 1000;
const GOLD = '#ffd36e', CYAN = '#7fe8ff', RED = '#e7222e', GREEN = '#5ff0a6', ORANGE = '#ff8a1a';
const LABEL = { ready: 'START', playing: 'LAUNCH', paused: 'GO ON', over: 'AGAIN' };

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;
        const diff = () => String(settings.get('difficulty') || 'normal');
        const nBalls = () => (String(settings.get('balls') || '3') === '5' ? 5 : 3);
        const bestKey = () => diff() + '-' + nBalls();
        const bestFile = path.join(dataDir, BEST_FILE);
        const best = M.loadBest(bestFile, log);

        const fresh = () => new M.Game({ difficulty: diff(), balls: nBalls() });
        let game = fresh();
        let state = 'ready';
        let acc = 0, lastT = Date.now(), frameT = Date.now();
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        let newBest = false, overAt = 0;
        // what holds the flippers up, the plunger's pull
        const hold = { ccu: [false, false], press: false, touch: [false, false], pulse: [0, 0] };
        let charge = null;             // { from: ms } while a press / push / LAUNCH pulls the plunger
        let knob = 0;                  // the pull set by turning the knob
        let turns = [];                // the knob's notches while the ball is in play: [ms, n]
        let drag = null;               // a finger pulling the plunger: { y0 }
        let launchDown = 0, nudgeAt = 0;
        // effects
        let parts = [], pops = [], shake = 0, shakeDir = 0, flash = { bumper: [0, 0, 0], sling: [0, 0] };
        let msg = null;                // the display's message: { lines, until, blink }
        let shownScore = 0, dmdKey = '', dmdAt = 0, dmdLayer = null;

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
            if (parked.moving()) { showToast('Parked only: the table opens when the car stands still'); return; }
            if (state === 'over') newGame();
            if (state === 'playing') return;
            lastT = Date.now();
            setState('playing');
        }
        function pause() {
            if (state !== 'playing') return;
            setState('paused');
            hold.ccu = [false, false]; hold.press = false; hold.touch = [false, false]; charge = null; drag = null;
            game.flipper(0, false); game.flipper(1, false);
        }
        function newGame() {
            game = fresh();
            acc = 0; newBest = false; parts = []; pops = []; msg = null; shownScore = 0; knob = 0; charge = null;
            setState('ready');
        }
        function end() {
            const k = bestKey();
            newBest = game.score > (best[k] || 0);
            if (newBest) { best[k] = game.score; try { M.saveBest(bestFile, best); } catch (e) { log.warn('pinball: best not saved: ' + e.message); } }
            log.info('pinball: over with ' + game.score + ' (' + k + ')');
            overAt = Date.now();
            setState('over');
        }

        /* ---------- the plunger: three ways ---------- */
        const ballWaiting = () => state === 'playing' && !!game.onPlunger();
        function startCharge() { if (!charge) charge = { from: Date.now() }; }
        function releaseCharge() {
            if (!charge) return;
            charge = null;
            if (state === 'playing' && game.onPlunger()) game.launch();
            knob = 0;
        }
        function turnKnob(d) {
            knob = Math.max(0, Math.min(1, knob + d * KNOB_STEP));
            game.setPull(knob);
        }
        function launchNow() { if (state === 'playing' && game.onPlunger()) { game.setPull(knob); game.launch(); knob = 0; } }
        function nudge() { if (state !== 'playing') return; nudgeAt = Date.now(); game.nudge(); }

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', () => { if (state === 'playing') pause(); else play(); });
        ui.onClick('BTN_LEFT', () => { if (state !== 'playing') play(); hold.pulse[0] = Date.now() + 170; });
        ui.onClick('BTN_RIGHT', () => { if (state !== 'playing') play(); hold.pulse[1] = Date.now() + 170; });
        ui.onClick('BTN_LAUNCH', () => { if (state !== 'playing') { play(); return; } if (game.onPlunger()) { game.setPull(0.75); game.launch(); } });
        ui.onClick('BTN_NUDGE', () => nudge());
        if (ctx.hideButton) for (const b of ['BTN_LEFT', 'BTN_RIGHT', 'BTN_LAUNCH', 'BTN_NUDGE']) ctx.hideButton(b);

        let ccu = null;
        if (ctx.controller) ctx.controller.onInput((v) => {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            const L = ccu;
            ccu = { k, pb, df };
            if (pb === 15 && df === 15) return;                  // no controller behind it
            let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
            if (Math.abs(d) > 64) d = 0;
            const down = (x) => x === 1 || x === 2;
            const pressed = down(pb) && !(L && down(L.pb)), let_go = !down(pb) && L && down(L.pb);
            const held = TILT[df] || null;                       // pushed and held, or let go
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            if (state === 'playing') {
                hold.ccu = [held === 'W', held === 'E'];
                if (tilt === 'N') nudge();
                // push down and hold: the plunger
                if (tilt === 'S' && game.onPlunger()) startCharge();
                if (held !== 'S' && L && TILT[L.df] === 'S') releaseCharge();
                if (pressed) {
                    if (game.onPlunger()) { if (knob > 0) launchNow(); else startCharge(); } else hold.press = true;
                }
                if (let_go) { hold.press = false; releaseCharge(); }
                if (d && game.onPlunger() && !charge) turnKnob(d);
                else if (d && !game.onPlunger()) {
                    // turned while flipping by accident: ignored; a deliberate big turn pauses
                    const now = Date.now();
                    turns = turns.filter((x) => now - x[0] < PAUSE_MS);
                    turns.push([now, Math.abs(d)]);
                    if (turns.reduce((a, x) => a + x[1], 0) >= PAUSE_NOTCHES) { turns = []; pause(); }
                }
                return;
            }
            hold.ccu = [false, false]; hold.press = false;
            if (pressed) play();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (d) { menu = true; syncGrab(); }
        });
        // the finger: a flipper for each half of the table; LAUNCH, NUDGE; the plunger pulled down
        let finger = null;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) {
                const LB = A.LAUNCH_BTN, NB = A.NUDGE_BTN;
                if (Math.hypot(x - LB.x, y - LB.y) < LB.r + 14) {
                    launchDown = Date.now();
                    if (state !== 'playing') { play(); finger = null; return; }
                    finger = { kind: 'launch' };
                    if (game.onPlunger()) { if (knob > 0) launchNow(); else startCharge(); }
                    return;
                }
                if (x >= NB.x - 8 && x <= NB.x + NB.w + 8 && y >= NB.y - 8 && y <= NB.y + NB.h + 8) { nudge(); finger = null; return; }
                if (x >= A.PANEL.x) { finger = null; return; }
                if (state !== 'playing') { play(); finger = null; return; }
                // on the plunger: pull it down
                const pl = A.P(M.PLUNGER.u, M.PLUNGER.v);
                if (game.onPlunger() && Math.abs(x - pl[0]) < 46 && y > pl[1] - 70) { drag = { y0: y }; finger = { kind: 'drag' }; return; }
                const side = x < A.P(277.5, 1100)[0] ? 0 : 1;
                finger = { kind: 'flip', side };
                hold.touch[side] = true;
                return;
            }
            if (!finger) return;
            if (phase === 2) {
                if (finger.kind === 'drag' && drag) game.setPull(Math.max(0, Math.min(1, (y - drag.y0) / 70)));
                return;
            }
            if (finger.kind === 'flip') hold.touch[finger.side] = false;
            if (finger.kind === 'launch') releaseCharge();
            if (finger.kind === 'drag') { drag = null; if (state === 'playing' && game.onPlunger() && game.pull > 0.02) game.launch(); else game.setPull(0); }
            finger = null;
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => { if (k === 'difficulty' || k === 'balls') newGame(); });
        setInterval(() => { if (state === 'playing' && parked.moving()) { pause(); showToast('Paused: parked only', 4000); } }, PARKED_MS);

        /* ---------- the clock ---------- */
        function advance(now) {
            if (state !== 'playing') { lastT = now; return; }
            if (display && display.sheet) { pause(); return; }
            // the flippers: whatever holds them
            for (let s = 0; s < 2; s++) game.flipper(s, hold.ccu[s] || hold.touch[s] || hold.press || now < hold.pulse[s]);
            // the plunger while it's pulled
            if (charge && game.onPlunger()) game.setPull(Math.min(1, (now - charge.from) / CHARGE_MS));
            else if (charge && !game.onPlunger()) charge = null;
            acc += Math.min(100, now - lastT);
            lastT = now;
            while (acc >= M.DT) { game.step(M.DT); acc -= M.DT; }
            for (const ev of game.events.splice(0)) effect(ev, now);
            if (game.over && state === 'playing') end();
        }
        function burst(u, v, n, colors, speed, o) {
            o = o || {};
            const p = A.P(u, v);
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random());
                parts.push({ x: p[0], y: p[1], vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6 - (o.up || 0), c: colors[i % colors.length], life: (o.life || 420) * (0.6 + Math.random() * 0.6), age: 0, kind: o.kind || 'spark' });
            }
        }
        function say(lines, ms, blink) { msg = { lines, until: Date.now() + (ms || 1800), blink: !!blink }; }
        function pop(s, c, ms, big) { pops.push({ s, c, at: Date.now(), ms: ms || 1500, big: !!big }); }
        function effect(ev, now) {
            switch (ev.type) {
            case 'bumper': flash.bumper[ev.i] = now; burst(ev.u, ev.v, 10, ['#ffffff', CYAN, '#81c4ff'], 260); break;
            case 'sling': flash.sling[ev.side] = now; break;
            case 'target': burst(M.TARGETS[ev.i].u, M.TARGETS[ev.i].v, 8, ['#ffffff', '#81c4ff'], 200); break;
            case 'lane': burst(M.LANES[ev.i], 160, 8, [GOLD, '#ffffff'], 180); break;
            case 'skill': say([['SKILL SHOT', 47, 22, 16, 'center'], ['100,000', 47, 38, 10, 'center']], 2200, true); pop('SKILL SHOT', GOLD, 1800, true); break;
            case 'gear': say([['GEAR UP', 47, 22, 16, 'center'], ['BONUS X' + ev.gear, 47, 38, 10, 'center']], 1800); pop('GEAR ' + ev.gear, GOLD); break;
            case 'mpower': say([['M-POWER', 47, 20, 17, 'center'], ['PIT LANE OPEN', 47, 37, 9, 'center']], 2400, true); pop('PIT LANE OPEN', ORANGE, 2000, true); break;
            case 'pit': say([['PIT STOP', 47, 22, 16, 'center'], ['25,000', 47, 38, 10, 'center']], 1400); break;
            case 'multiball': say([['SAFETY CAR', 47, 19, 15, 'center'], ['MULTIBALL', 47, 37, 12, 'center']], 3000, true); pop('MULTIBALL', CYAN, 2400, true); shake = 6; break;
            case 'multiballEnd': say([['GREEN FLAG', 47, 22, 15, 'center'], ['MULTIBALL OVER', 47, 38, 9, 'center']], 1600); break;
            case 'jackpot': say([['JACKPOT', 47, 22, 18, 'center'], [fmt(ev.pts), 47, 39, 10, 'center']], 2200, true); pop('JACKPOT', GOLD, 2000, true); shake = 8; burst(420, 600, 40, [GOLD, '#ffffff', RED], 420, { life: 700 }); break;
            case 'lap': if (ev.combo > 1) say([['COMBO X' + Math.min(ev.combo, 4), 47, 22, 15, 'center'], [fmt(ev.pts), 47, 38, 10, 'center']], 1400); else if (!msg) say([['LAP ' + ev.laps, 47, 22, 16, 'center'], [fmt(ev.pts), 47, 38, 10, 'center']], 1200); burst(58, 870, 10, ['#ffffff', RED], 180); break;
            case 'fastLap': say([['FASTEST LAP', 47, 22, 14, 'center'], ['250,000', 47, 38, 10, 'center']], 2000, true); break;
            case 'extraLit': pop('EXTRA BALL LIT', GREEN, 1800); break;
            case 'extraBall': say([['EXTRA BALL', 47, 25, 15, 'center']], 2200, true); pop('EXTRA BALL', GREEN, 2000, true); break;
            case 'saved': say([['BALL SAVED', 47, 25, 15, 'center']], 1600); pop('BALL SAVED', CYAN); break;
            case 'nudge': shake = 7; shakeDir = Math.random() < 0.5 ? -1 : 1; if (ev.warn >= 2) say([['DANGER', 47, 25, 18, 'center']], 1400, true); break;
            case 'tilt': shake = 10; say([['TILT', 47, 30, 26, 'center']], 3000, true); pop('TILT', RED, 2400, true); break;
            case 'drain':
                if (ev.tilted) break;
                say([['BONUS', 47, 14, 11, 'center'], [fmt(ev.raw) + ' X' + ev.gear, 47, 27, 10, 'center'], [fmt(ev.bonus), 47, 40, 11, 'center']], 2400);
                break;
            case 'shootAgain': pop('SHOOT AGAIN', GREEN, 1800, true); break;
            case 'over': say([['GAME OVER', 47, 22, 15, 'center'], [fmt(game.score), 47, 38, 11, 'center']], 4000); break;
            case 'launch': burst(M.PLUNGER.u, M.PLUNGER.v + 10, 6, ['#ffffff', GOLD], 120); break;
            case 'kick': burst(M.PIT.u, M.PIT.v, 14, [ORANGE, '#ffffff'], 260); break;
            default: break;
            }
        }

        /* ---------- the lamps ---------- */
        function lit(now) {
            const on = new Set();
            const blink = (ms) => Math.floor(now / ms) % 2 === 0;
            if (state !== 'playing') {
                // attract: the lamps chase round
                const ids = Object.keys(A.LAMPS).filter((id) => !A.LAMPS[id].hidden);
                const k = Math.floor(now / 90);
                ids.forEach((id, i) => { if ((i + k) % 7 === 0 || (i * 3 + k) % 11 === 0) on.add(id); });
                return on;
            }
            const g = game, waiting = !!g.onPlunger();
            for (let i = 0; i < 3; i++) if (g.lanes[i]) on.add('lane' + i);
            if (waiting && g.skillOpen) { on.delete('lane' + g.skillLane); if (blink(160)) on.add('skill' + g.skillLane); }
            g.targets.forEach((t, i) => { if (t && (!g.pitLit || blink(250))) on.add('letter' + i); });
            for (let i = 0; i < 4; i++) if (g.gear >= i + 2) on.add('mult' + i);
            if (g.pitLit) on.add('pit' + (2 - Math.floor(now / 120) % 3)), on.add('pit' + (2 - Math.floor(now / 120 + 1) % 3));
            else if (g.extraLit && blink(300)) [0, 1, 2].forEach((i) => on.add('pit' + i));
            if (g.extraLit && blink(300)) on.add('extra');
            const combo = g.ms - g.lastLap < 4000;
            if (g.multiball) { on.add('ramp' + (2 - Math.floor(now / 90) % 3)); if (blink(200)) on.add('jackpot'); } else if (combo && blink(150)) [0, 1, 2].forEach((i) => on.add('ramp' + i));
            if (g.saving() && (g.saveUntil - g.ms > 2000 || blink(150))) on.add('again');
            if (g.extra > 0) on.add('again');
            if (waiting) on.add('shoot' + Math.floor(now / 110) % 4);
            return on;
        }

        /* ---------- drawing ---------- */
        function drawTable(cv, now, dt) {
            shake = Math.max(0, shake - dt * 0.03);
            const sx = shake ? shakeDir * shake * Math.sin(now / 18) * 0.7 + (Math.random() - 0.5) * shake * 0.4 : 0, sy = shake ? (Math.random() - 0.5) * shake * 0.5 : 0;
            const at = (q) => cv.blit(q.L, q.x + sx, q.y + sy);
            cv.blit(A.tableLayer(), A.BOARD.x + sx, A.BOARD.y + sy);
            for (const id of lit(now)) at(A.lampLayer(id));
            for (let i = 0; i < 3; i++) if (now - flash.bumper[i] < 110) at(A.bumperLayer(i));
            for (let i = 0; i < 2; i++) if (now - flash.sling[i] < 90) at(A.slingLayer(i));
            A.setShift(sx, sy);
            A.drawPlunger(cv, game.pull);
            for (let s = 0; s < 2; s++) A.drawFlipper(cv, s, game.flip[s].a);
            const blur = (b) => { const sp = Math.hypot(b.vu, b.vv); return sp > 900 ? [b.vu * 0.0035 * A.S(b.v), b.vv * 0.0017 * A.S(b.v)] : null; };
            for (const b of game.balls) if (!b.ramp) A.drawBall(cv, b.u, b.v, 0, b.hold ? null : blur(b));
            cv.blit(A.rampLayer(), A.BOARD.x + sx, A.BOARD.y + sy);
            for (const b of game.balls) if (b.ramp) A.drawBall(cv, b.u, b.v, M.rampHeight(b.ramp.s), null);
            A.setShift(0, 0);
            drawEffects(cv, dt, now);
        }
        function drawEffects(cv, dt, now) {
            const s = dt / 1000;
            parts = parts.filter((q) => (q.age += dt) < q.life);
            for (const q of parts) {
                q.x += q.vx * s; q.y += q.vy * s; q.vx *= 0.93; q.vy = q.vy * 0.93 + 240 * s;
                const a = 1 - q.age / q.life;
                cv.line(q.x, q.y, q.x - q.vx * 0.03, q.y - q.vy * 0.03, 2, withAlpha(q.c, a));
            }
            pops = pops.filter((q) => now - q.at < q.ms);
            pops.forEach((q, i) => {
                const k = (now - q.at) / q.ms, cx = A.P(277.5, 700)[0], cy = 250 - i * 46;
                const sc = q.big ? (k < 0.12 ? 0.6 + k / 0.12 * 0.5 : 1.1 - Math.min(0.1, (k - 0.12) * 0.4)) : 1;
                const a = k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1;
                A.outlined(cv, q.s, cx, cy + (q.big ? 0 : -k * 30), (q.big ? 46 : 28) * sc, withAlpha(q.c, a), withAlpha('#05060a', a * 0.85), 2.5, { spacing: 3 });
            });
        }
        function drawZones(cv, touch) {
            if (!touch || state !== 'playing') return;
            A.ZONES.forEach((z, i) => {
                const on = hold.touch[i] || hold.ccu[i] || hold.press;
                cv.roundRect(z.x, z.y, z.w, z.h, 14, withAlpha('#ffffff', on ? 0.14 : 0.04));
                cv.strokeRoundRect(z.x, z.y, z.w, z.h, 14, 1.5, withAlpha('#ffffff', on ? 0.45 : 0.14));
                const cx = z.x + z.w / 2, cy = z.y + 36;
                A.poly(cv, i === 0 ? [[cx - 22, cy], [cx + 10, cy - 16], [cx + 10, cy + 16]] : [[cx + 22, cy], [cx - 10, cy - 16], [cx - 10, cy + 16]], withAlpha('#ffffff', on ? 0.9 : 0.5));
                cv.text(i === 0 ? 'LEFT FLIPPER' : 'RIGHT FLIPPER', cx, z.y + 80, 14, withAlpha('#ffffff', on ? 0.8 : 0.45), { align: 'center', font: 'bold', spacing: 1.5, literal: true });
            });
        }
        function drawOverlay(cv, now, touch) {
            if (state === 'playing') return;
            if (state === 'over' && now - overAt < 900) return;
            const cx = A.P(277.5, 600)[0], cy = 250;
            const moving = parked.moving();
            let title, lines;
            if (moving) { title = 'PARKED ONLY'; lines = ['The table waits while the car is moving.', 'It opens when you stop.']; } else if (state === 'ready') {
                title = 'M PINBALL';
                lines = touch ? ['Press, or touch START to play', 'Flippers: push left / right, or a finger on each half', 'Launch: hold the press and let go, turn and press, or pull down'] : ['Press "Start" to play', 'Smooth only with mgu-render'];
            } else if (state === 'paused') { title = 'PAUSED'; lines = touch ? ['Press or tap to go on', 'Push left to leave  ·  turn for the menu', 'While playing, a big turn of the knob pauses'] : ['Press "Go on"']; } else {
                title = 'GAME OVER';
                lines = [newBest ? 'New best: ' + fmt(game.score) : 'Score ' + fmt(game.score), touch ? 'Press or tap to play again' : 'Press "Again"'];
            }
            const w = 640, h = 82 + lines.length * 30;
            cv.roundRect(cx - w / 2, cy - 64, w, h, 18, withAlpha('#05060a', 0.82));
            cv.strokeRoundRect(cx - w / 2, cy - 64, w, h, 18, 1.5, withAlpha('#ffffff', 0.15));
            A.outlined(cv, title, cx, cy - 8, 50, moving ? '#ffb020' : state === 'over' ? RED : '#ffffff', '#05060a', 2, { spacing: 6 });
            lines.forEach((l, i) => cv.text(l, cx, cy + 32 + i * 30, 20, i === 0 && newBest && state === 'over' ? GOLD : withAlpha('#ffffff', 0.75), { align: 'center' }));
        }
        function dmdContent(now) {
            if (msg && now < msg.until) {
                if (msg.blink && Math.floor(now / 180) % 4 === 3) return { key: 'blank', lines: [] };
                return { key: JSON.stringify(msg.lines), lines: msg.lines };
            }
            msg = null;
            const g = game;
            if (state === 'ready') {
                const k = Math.floor(now / 2600) % 3;
                if (k === 0) return { key: 'a0', lines: [['M PINBALL', 47, 22, 16, 'center'], ['PRESS LAUNCH', 47, 38, 9, 'center', Math.floor(now / 400) % 2 ? 1 : 0.4]] };
                if (k === 1) return { key: 'a1', lines: [['BEST SCORE', 47, 16, 10, 'center'], [fmt(best[bestKey()] || 0), 47, 34, 15, 'center']] };
                return { key: 'a2', lines: [['SAFETY CAR', 47, 17, 11, 'center'], ['MULTIBALL', 47, 33, 14, 'center']] };
            }
            const sc = fmt(shownScore);
            let bottom;
            if (state === 'paused') bottom = 'PAUSED';
            else if (state === 'over') bottom = 'GAME OVER';
            else if (g.tilted) bottom = 'TILT';
            else if (g.multiball) bottom = 'JACKPOT ' + fmt(g.jackpot);
            else if (g.onPlunger()) bottom = g.skillOpen ? 'SKILL SHOT: LANE ' + (g.skillLane + 1) : 'LAUNCH THE BALL';
            else if (g.pitLit) bottom = 'PIT LANE OPEN';
            else if (g.extraLit) bottom = 'EXTRA BALL AT PIT';
            else bottom = 'M-POWER ' + g.targets.filter(Boolean).length + '/6   LAPS ' + g.lapsGame;
            const lines = [['BALL ' + Math.min(g.ballNo, g.ballsPerGame), 1, 8, 8, 'left', 0.8], ['X' + g.gear, 93, 8, 8, 'right', 0.8], [sc, 47, 28, sc.length > 9 ? 14 : 16, 'center'], [bottom, 47, 40, 8, 'center', 0.85]];
            return { key: JSON.stringify(lines), lines };
        }
        function drawPanel(cv, now, touch) {
            cv.blit(A.panelLayer(), A.PANEL.x, A.PANEL.y);
            // the display, refreshed a few times a second
            if (shownScore < game.score) shownScore = Math.min(game.score, shownScore + Math.max(10, Math.ceil((game.score - shownScore) * 0.2)));
            if (shownScore > game.score) shownScore = game.score;
            if (!dmdLayer || now - dmdAt > 70) {
                const c = dmdContent(now);
                if (c.key !== dmdKey || !dmdLayer) { dmdKey = c.key; dmdLayer = A.dmdLayer(c.lines, c.key); }
                dmdAt = now;
            }
            cv.blit(dmdLayer, A.DMD.x, A.DMD.y);
            for (let i = 4; i >= 1; i--) cv.roundRect(A.DMD.x - 3 - i, A.DMD.y - 3 - i, A.DMD.w + 6 + 2 * i, A.DMD.h + 6 + 2 * i, 8, withAlpha('#ff8a1a', 0.012));
            const P = A.PANEL;
            // M-POWER
            'MPOWER'.split('').forEach((ch, i) => cv.blit(A.letterLayer(ch, state === 'playing' ? !!game.targets[i] : Math.floor(now / 140) % 6 === i), P.x + 18 + i * 64, P.y + 238));
            // the ball in play and the ones to come; the best
            const left = state === 'playing' || state === 'paused' ? game.ballsLeft() : nBalls();
            cv.text(state === 'ready' ? '-' : String(Math.min(game.ballNo, game.ballsPerGame)), P.x + 82, P.y + 318, 20, '#ffffff', { font: 'bold', literal: true });
            for (let i = 0; i < Math.min(6, left); i++) cv.blit(A.ballIconLayer(true), P.x + 104 + i * 24, P.y + 298);
            cv.text(fmt(Math.max(best[bestKey()] || 0, game.score)), P.x + P.w - 26, P.y + 340, 18, GOLD, { font: 'bold', literal: true, align: 'right' });
            // the plunger's power
            const B = A.POWER_BAR, pull = game.onPlunger() ? game.pull : 0, n = 10;
            for (let i = 0; i < n; i++) {
                const on = pull > (i + 0.5) / n, y = B.y + B.h - 8 - i * 5.6;
                cv.roundRect(B.x + 10, y, B.w - 20, 4, 2, on ? (i < 5 ? GREEN : i < 8 ? GOLD : RED) : withAlpha('#ffffff', 0.07));
            }
            // NUDGE and LAUNCH
            const warn = game.tiltWarn.filter((t) => game.ms - t < 6000).length >= 2;
            cv.blit(A.nudgeLayer(now - nudgeAt < 140 ? 'down' : warn ? 'warn' : 'up'), A.NUDGE_BTN.x - 2, A.NUDGE_BTN.y - 2);
            const L = A.LAUNCH_BTN, can = !parked.moving(), label = state === 'playing' ? 'LAUNCH' : LABEL[state];
            if (can && (state !== 'playing' || game.onPlunger())) A.glow(cv, L.x, L.y, L.r * 1.6, '#ff2a4a', 0.3 + 0.12 * Math.sin(now / 300));
            cv.blit(A.launchLayer(label, (charge || now - launchDown < 140) ? 'down' : can ? 'on' : 'off'), L.x - L.r - 2, L.y - L.r - 2);
            const hint = touch ? (knob > 0 ? 'Press to let it go' : 'Hold, then let go') : 'Bar: Left · Right · Launch';
            cv.text(hint, P.x + 22, P.y + 452, 12, withAlpha('#ffffff', 0.45), { font: 'label', literal: true });
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear('#050608');
            A.setTextScale(cv.textScale);
            const touch = !!cv.own || own();
            drawTable(cv, now, state === 'playing' ? dt : Math.min(dt, 16));
            drawZones(cv, touch);
            drawOverlay(cv, now, touch);
            drawPanel(cv, now, touch);
            G.frame(cv, t, ['M Pinball'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('M Pinball first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
