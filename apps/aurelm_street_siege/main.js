'use strict';
/**
 * Street Siege - the M car defends the M garage against cars that storm an industrial yard, drawn by the
 * GPU renderer every frame (mgu-render: up to 60 fps). Parked only.
 *
 * The rules are in model.js (tests/street_siege.test.js), the look in art.js. The world is stepped at a
 * fixed 60 Hz whatever the frame rate; without the renderer the frames go to the HMI as images, a few a
 * second (slowly).
 *
 * Steering:
 *   iDrive controller (held by the game on screen): push and hold = drive that way (let go: stop),
 *     press = fire; a small turn does nothing (it happens by accident while driving), a big one (PAUSE_NOTCHES
 *     within a second) pauses. Not playing: press starts / goes on, push left leaves, a turn lets go
 *     of the controller so it moves over the bar and the header.
 *   touchscreen (where the kit runs the screen): a joystick where the finger goes down on the yard (it
 *     drives while held), a tap fires; FIRE on the panel.
 *   bar buttons (where the kit doesn't run the screen): "Up", "Down", "Left", "Right" (it drives until
 *     the next), "Start".
 * With automatic fire (a setting, on by default) the cannon fires by itself at a car in its line.
 *
 * The game pauses when the screen goes, a sheet (Settings) opens over it or the car drives off
 * (kit/parked.js), and can't be started while moving. Best scores are kept for each difficulty.
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
const BEST_FILE = 'street_siege_best.json';
const PARKED_MS = 500;
const PAUSE_NOTCHES = 8;             // a turn this big within PAUSE_MS pauses the game (a small one: nothing)
const PAUSE_MS = 1000;
const GOLD = '#ffd36e', CYAN = '#7fe8ff', RED = '#e7222e', GREEN = '#5ff0a6';
const LABEL = { ready: 'START', playing: 'FIRE', paused: 'GO ON', over: 'AGAIN' };
const KIND_NAME = { hatch: 'HATCHBACK', van: 'VAN', pickup: 'PICK-UP', suv: 'ARMOURED SUV' };

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;
        const diff = () => String(settings.get('difficulty') || 'normal');
        const paint = () => String(settings.get('paint') || 'white');
        const autoFire = () => String(settings.get('autoFire') || 'on') === 'on';
        const bestFile = path.join(dataDir, BEST_FILE);
        const best = M.loadBest(bestFile, log);

        const fresh = () => new M.Game({ difficulty: diff(), autoFire: autoFire() });
        let game = fresh();
        let state = 'ready';
        let acc = 0, lastT = Date.now(), frameT = Date.now();
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        let pressed = 0, newBest = false;
        let parts = [], texts = [], rings = [], shake = 0, levelAt = Date.now(), clearedAt = 0, tally = null, overAt = 0;
        let stick = null;              // the touch joystick: { x0, y0, x, y }

        function showToast(msg, ms) { toast = msg; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());
        function setState(s) {
            if (s === state) return;
            state = s; menu = false;
            Promise.resolve(ui.text('BTN_PLAY', s === 'playing' ? 'Pause' : LABEL[s].charAt(0) + LABEL[s].slice(1).toLowerCase())).catch(() => {});
            syncGrab();
        }
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        function play() {
            if (parked.moving()) { showToast('Parked only: the siege starts when the car stands still'); return; }
            if (state === 'over') newGame();
            if (state === 'playing') return;
            lastT = Date.now();
            setState('playing');
        }
        function pause() { if (state === 'playing') { setState('paused'); game.drive(null); } }
        function newGame() {
            game = fresh();
            acc = 0; newBest = false; parts = []; texts = []; rings = []; tally = null; clearedAt = 0; levelAt = Date.now();
            setState('ready');
        }
        function end() {
            const k = diff();
            newBest = game.score > (best[k] || 0);
            if (newBest) { best[k] = game.score; try { M.saveBest(bestFile, best); } catch (e) { log.warn('street_siege: best not saved: ' + e.message); } }
            log.info('street_siege: over in level ' + game.level + ' with ' + game.score + ' (' + k + ', ' + game.lost + ')');
            overAt = Date.now();
            setState('over');
        }
        const fire = () => { pressed = Date.now(); if (state === 'playing') game.fire(); else play(); };
        const drive = (d) => { if (state === 'playing') game.drive(d); else if (d && (state === 'ready' || state === 'paused')) { play(); game.drive(d); } };

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', () => { if (state === 'playing') pause(); else play(); });
        for (const [b, d] of [['BTN_UP', 'U'], ['BTN_DOWN', 'D'], ['BTN_LEFT', 'L'], ['BTN_RIGHT', 'R']]) ui.onClick(b, () => drive(d));
        if (ctx.hideButton) for (const b of ['BTN_UP', 'BTN_DOWN', 'BTN_LEFT', 'BTN_RIGHT']) ctx.hideButton(b);

        let ccu = null, turns = [];
        if (ctx.controller) ctx.controller.onInput((v) => {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            const L = ccu;
            ccu = { k, pb, df };
            if (pb === 15 && df === 15) return;                  // no controller behind it
            let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
            if (Math.abs(d) > 64) d = 0;
            const down = (x) => x === 1 || x === 2;
            const pr = down(pb) && !(L && down(L.pb));
            const held = { N: 'U', S: 'D', E: 'R', W: 'L' }[TILT[df]] || null;      // pushed and held, or let go
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            if (state === 'playing') {
                game.drive(held);
                if (pr) fire();
                if (d) {
                    // turned by accident while driving: ignored; a deliberate big turn pauses
                    const t = Date.now();
                    turns = turns.filter((x) => t - x[0] < PAUSE_MS);
                    turns.push([t, Math.abs(d)]);
                    if (turns.reduce((a, x) => a + x[1], 0) >= PAUSE_NOTCHES) { turns = []; pause(); }
                }
                return;
            }
            if (pr) play();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (held && state !== 'over') drive(held);
            else if (d) { menu = true; syncGrab(); }
        });
        // the finger: a joystick where it goes down on the yard, a tap fires; FIRE on the panel
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            const F = A.FIRE_BTN;
            if (phase === 1) {
                if (Math.hypot(x - F.x, y - F.y) < F.r + 14) { fire(); stick = null; return; }
                if (x > A.PANEL.x) { stick = null; return; }
                stick = { x0: x, y0: y, x, y, t: Date.now(), used: false };
                return;
            }
            if (!stick) return;
            stick.x = x; stick.y = y;
            const dx = x - stick.x0, dy = y - stick.y0;
            if (phase === 2) {
                if (Math.hypot(dx, dy) > 18) { stick.used = true; drive(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U')); }
                return;
            }
            const tap = !stick.used && Date.now() - stick.t < 350;
            stick = null;
            if (state === 'playing') game.drive(null);
            if (tap) fire();
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => { if (k === 'difficulty') newGame(); if (k === 'autoFire') game.autoFire = autoFire(); });
        setInterval(() => { if (state === 'playing' && parked.moving()) { pause(); showToast('Paused: parked only', 4000); } }, PARKED_MS);

        /* ---------- the clock ---------- */
        function advance(now) {
            if (state !== 'playing') { lastT = now; return; }
            if (display && display.sheet) { pause(); return; }
            acc += Math.min(100, now - lastT);
            lastT = now;
            while (acc >= M.DT) { game.step(M.DT); acc -= M.DT; }
            for (const ev of game.events.splice(0)) effect(ev, now);
            if (game.over && state === 'playing') end();
        }
        const PX = (x) => A.OX + x * A.B, PY = (y) => A.OY + y * A.B;
        function burst(x, y, n, colors, speed, o) {
            o = o || {};
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
                parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: colors[i % colors.length], life: (o.life || 500) * (0.6 + Math.random() * 0.6), age: 0, s: (o.size || 3) * (0.5 + Math.random()), kind: o.kind || 'dot', grow: o.grow || 0 });
            }
        }
        function effect(ev, now) {
            if (ev.type === 'fire') burst(PX(ev.x), PY(ev.y), 4, ev.team === 'p' ? ['#ffffff', CYAN] : ['#ffd36e', '#ff8a2a'], 90, { life: 140, size: 2.5 });
            else if (ev.type === 'brick') { const ch = ev.was; burst(PX(ev.x + 0.5), PY(ev.y + 0.5), 6, ch === 'c' ? ['#9aa0a8', '#6a7078'] : ['#121214', '#c8202c', '#e9ecef'], 120, { life: 420, size: 3.5, kind: 'chip' }); } else if (ev.type === 'spark') burst(PX(ev.x), PY(ev.y), 6, ['#ffffff', '#ffd36e'], 140, { life: 200, kind: 'spark' });
            else if (ev.type === 'boom') {
                const x = PX(ev.x), y = PY(ev.y);
                rings.push({ x, y, at: now, r: 46, c: '#ffb020', ms: 420 });
                burst(x, y, 34, ['#ffd000', '#ff7a2e', '#ff3b1f', '#ffffff'], 220, { life: 650, size: 4 });
                burst(x, y, 10, ['#3a3a3a', '#555555'], 40, { life: 1400, size: 7, kind: 'smoke', grow: 10 });
                if (ev.pts) texts.push({ x, y, s: String(ev.pts), c: GOLD, at: now });
                shake = Math.max(shake, 5);
            } else if (ev.type === 'dent') burst(PX(ev.x), PY(ev.y), 8, ['#ffffff', '#c3c9d2'], 160, { life: 260, kind: 'spark' });
            else if (ev.type === 'crash') {
                const x = PX(ev.x), y = PY(ev.y);
                rings.push({ x, y, at: now, r: 70, c: '#ff3b1f', ms: 520 });
                burst(x, y, 50, ['#ffd000', '#ff7a2e', '#ffffff', '#81c4ff'], 260, { life: 800, size: 4 });
                burst(x, y, 14, ['#2a2a2a', '#4a4a4a'], 40, { life: 1800, size: 8, kind: 'smoke', grow: 12 });
                shake = Math.max(shake, 10);
            } else if (ev.type === 'garage') {
                const x = PX(M.BASE.x + 2), y = PY(M.BASE.y + 2);
                rings.push({ x, y, at: now, r: 80, c: RED, ms: 600 });
                burst(x, y, 40, ['#ffd000', '#ff3b1f', '#ffffff'], 240, { life: 700, size: 4 });
                texts.push({ x, y: y - 30, s: ev.hp > 0 ? 'GARAGE HIT  ·  ' + ev.hp + ' LEFT' : 'GARAGE LOST', c: RED, at: now, big: true });
                shake = Math.max(shake, 12);
            } else if (ev.type === 'spawn') rings.push({ x: PX(ev.x), y: PY(ev.y), at: now, r: 26, c: '#ffffff', ms: 900, star: true });
            else if (ev.type === 'bonus') texts.push({ x: PX(ev.x), y: PY(ev.y) - 18, s: A.POWER[ev.kind].label, c: A.POWER[ev.kind].c[0], at: now });
            else if (ev.type === 'power') {
                texts.push({ x: PX(ev.x), y: PY(ev.y) - 16, s: A.POWER[ev.kind].label + '  +500', c: A.POWER[ev.kind].c[0], at: now, big: true });
                if (ev.kind === 'emp') { rings.push({ x: PX(ev.x), y: PY(ev.y), at: now, r: 900, c: '#c99bff', ms: 700 }); shake = Math.max(shake, 8); }
            } else if (ev.type === 'cleared') { clearedAt = now; tally = ev.kills; } else if (ev.type === 'level') { levelAt = now; clearedAt = 0; tally = null; }
        }

        /* ---------- drawing ---------- */
        function drawYard(cv, now, dt) {
            shake = Math.max(0, shake - dt * 0.03);
            const sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
            cv.blit(A.groundLayer(game.level), A.BOARD.x + sx, A.BOARD.y + sy);
            // the canal's ripples (they move)
            const g = game.grid;
            for (let y = 0; y < M.BH; y++) for (let x = 0; x < M.BW; x += 2) if (g[y][x] === 'w' && (x + y) % 4 === 0) {
                const k = ((now / 900 + x * 0.13 + y * 0.31) % 1);
                cv.fillRect(PX(x) + 3 + sx, PY(y) + 4 + k * 8 + sy, 12, 1.5, withAlpha('#7fb4ff', 0.25 * (1 - Math.abs(k - 0.5) * 2)));
            }
            cv.blit(A.bricksLayer(game.level, game.version, g, game.garage), A.BOARD.x + sx, A.BOARD.y + sy);
            // the garage smokes when it's hit
            if (game.garage < M.GARAGE_HP && Math.random() < 0.25 * (M.GARAGE_HP - game.garage)) burst(PX(M.BASE.x + 1 + Math.random() * 2), PY(M.BASE.y + 1), 1, ['#3a3a3a', '#4a4a4a'], 18, { life: 1600, size: 4, kind: 'smoke', grow: 9 });
            // the power-up, blinking
            const b = game.bonus;
            if (b && Math.floor(now / 250) % 2 === 0) cv.blit(A.powerLayer(b.kind), PX(b.x + 1) - 17 + sx, PY(b.y + 1) - 17 + sy);
            // the cars: the others (flashing ones blink red), then the M car with its shield
            const box = A.CAR_BOX / 2;
            for (const e of game.cars) {
                const x = PX(e.x + 1) + sx, y = PY(e.y + 1) + sy;
                if (e.state === 'in') continue;
                const variant = e.flash && Math.floor(now / 160) % 2 ? 'flash' : e.kind === 'suv' && e.hp <= 1 ? 'hurt2' : e.kind === 'suv' && e.hp <= 2 ? 'hurt' : '';
                cv.blit(A.carLayer(e.kind, e.dir, '', variant), x - box, y - box);
                if (game.nitro > 0) { cv.circle(x, y, 20, withAlpha('#7fe8ff', 0.25)); A.sparkle(cv, x + 12, y - 12, 6, '#e6fbff'); }
            }
            const c = game.car;
            if (c.alive) {
                const x = PX(c.x + 1) + sx, y = PY(c.y + 1) + sy;
                cv.blit(A.carLayer('m', c.dir, paint(), ''), x - box, y - box);
                if (c.shield > 0 && (c.shield > 1500 || Math.floor(now / 120) % 2)) {
                    for (let k = 0; k < 6; k++) { const a0 = now / 4 % 360 + k * 60; cv.arc(x, y, 23, 26, a0, a0 + 34, withAlpha(CYAN, 0.75)); }
                    cv.circle(x, y, 24, withAlpha(CYAN, 0.08));
                }
            }
            // the shots: a glowing tracer each
            for (const s of game.shots) {
                const [dx, dy] = M.DIRS[s.dir], x = PX(s.x) + sx, y = PY(s.y) + sy, col = s.team === 'p' ? (s.heavy ? '#ffd36e' : CYAN) : '#ff8a2a';
                cv.line(x - dx * 14, y - dy * 14, x, y, 5, withAlpha(col, 0.25));
                cv.line(x - dx * 9, y - dy * 9, x, y, 2.5, col);
                cv.circle(x, y, 2.2, '#ffffff');
            }
            cv.blit(A.treesLayer(game.level, g), A.BOARD.x + sx, A.BOARD.y + sy);
            drawEffects(cv, dt, now);
        }
        function drawEffects(cv, dt, now) {
            const s = dt / 1000;
            parts = parts.filter((q) => (q.age += dt) < q.life);
            for (const q of parts) {
                q.x += q.vx * s; q.y += q.vy * s; q.vx *= 0.94; q.vy *= 0.94;
                const a = 1 - q.age / q.life;
                if (q.kind === 'spark') cv.line(q.x, q.y, q.x - q.vx * 0.05, q.y - q.vy * 0.05, 2, withAlpha(q.c, a));
                else if (q.kind === 'smoke') cv.circle(q.x, q.y, q.s + q.grow * (1 - a), withAlpha(q.c, 0.45 * a));
                else if (q.kind === 'chip') cv.fillRect(q.x - q.s / 2, q.y - q.s / 2, q.s, q.s, withAlpha(q.c, a));
                else cv.circle(q.x, q.y, q.s * a + 0.5, withAlpha(q.c, a));
            }
            rings = rings.filter((q) => now - q.at < q.ms);
            for (const q of rings) {
                const k = (now - q.at) / q.ms;
                if (q.star) { A.sparkle(cv, q.x, q.y, 6 + 14 * Math.sin(k * Math.PI), withAlpha('#ffffff', 1 - k)); continue; }
                const r = 6 + q.r * k;
                cv.arc(q.x, q.y, r, r + 3 + 6 * (1 - k), 0, 360, withAlpha(q.c, 0.8 * (1 - k)));
            }
            texts = texts.filter((q) => now - q.at < 1300);
            for (const q of texts) {
                const k = (now - q.at) / 1300;
                cv.text(q.s, q.x, q.y - 12 - k * 24, q.big ? 20 : 15, withAlpha(q.c, 1 - k * k), { font: 'bold', align: 'center', spacing: 1, literal: true });
            }
        }
        function drawOverlay(cv, now, touch) {
            const cx = A.OX + M.BW * A.B / 2, cy = A.OY + M.BH * A.B / 2 - 20;
            const box = (w, h) => cv.roundRect(cx - w / 2, cy - h / 2, w, h, 14, withAlpha('#05060a', 0.84));
            if (state === 'playing' && now - levelAt < 1800 && !clearedAt) {
                box(320, 70);
                cv.text('LEVEL ' + game.level, cx, cy + 12, 40, '#ffffff', { font: 'bold', align: 'center', spacing: 5, literal: true });
                return;
            }
            if (clearedAt && tally) {
                box(420, 200);
                cv.text('YARD CLEARED', cx, cy - 56, 32, GREEN, { font: 'bold', align: 'center', spacing: 4, literal: true });
                Object.keys(tally).forEach((k, i) => {
                    const y = cy - 18 + i * 28;
                    cv.blit(A.carLayer(k, 'R', '', ''), cx - 178, y - 29);
                    cv.text(KIND_NAME[k], cx - 120, y + 6, 16, withAlpha('#ffffff', 0.8), { font: 'bold', spacing: 1, literal: true });
                    cv.text(tally[k] + '  x  ' + M.TYPES[k].pts + '  =  ' + fmt(tally[k] * M.TYPES[k].pts), cx + 180, y + 6, 16, GOLD, { font: 'bold', align: 'right', literal: true });
                });
                return;
            }
            if (state === 'playing') return;
            const moving = parked.moving();
            let title, lines;
            if (moving) { title = 'PARKED ONLY'; lines = ['The siege waits while the car is moving.', 'It goes on when you stop.']; } else if (state === 'ready') {
                title = 'STREET SIEGE';
                lines = touch ? ['Defend the M garage: stop all twenty cars', 'Push and hold to drive · press to fire · or a finger on the yard'] : ['Press "Start" to play', 'Drive with the arrows in the bar - smooth only with mgu-render'];
            } else if (state === 'paused') { title = 'PAUSED'; lines = touch ? ['Press or tap to go on', 'Push left to leave  ·  turn for the menu'] : ['Press "Go on"']; } else {
                if (now - overAt < 600) return;
                title = game.lost === 'garage' ? 'GARAGE LOST' : 'GAME OVER';
                lines = [newBest ? 'New best: ' + fmt(game.score) : 'Score ' + fmt(game.score) + '  ·  level ' + game.level, touch ? 'Press or tap to play again' : 'Press "Again"'];
            }
            cv.roundRect(A.OX, A.OY, M.BW * A.B, M.BH * A.B, 6, withAlpha('#05060a', 0.62));
            cv.text(title, cx, cy - 6, 60, moving ? '#ffb020' : state === 'over' ? RED : '#ffffff', { font: 'bold', align: 'center', spacing: 5 });
            lines.forEach((l, i) => cv.text(l, cx, cy + 38 + i * 30, 21, i === 0 && newBest && state === 'over' ? GOLD : withAlpha('#ffffff', 0.72), { align: 'center' }));
            if (state === 'ready' && !moving) {
                Object.keys(M.TYPES).forEach((k, i) => {
                    const x = cx - 330 + i * 180, y = cy + 130;
                    cv.blit(A.carLayer(k, 'R', '', ''), x - 29, y - 29);
                    cv.text(KIND_NAME[k], x + 26, y - 1, 14, '#ffffff', { font: 'bold', spacing: 1, literal: true });
                    cv.text(M.TYPES[k].pts + ' pts' + (k === 'suv' ? ' · 4 hits' : k === 'hatch' ? ' · fast' : k === 'pickup' ? ' · fires twice' : ''), x + 26, y + 16, 12, withAlpha('#ffffff', 0.55), { literal: true });
                });
            }
        }
        function drawStick(cv) {
            if (!stick || !stick.used) return;
            cv.circle(stick.x0, stick.y0, 40, withAlpha('#ffffff', 0.08));
            cv.arc(stick.x0, stick.y0, 38, 40, 0, 360, withAlpha('#ffffff', 0.35));
            const dx = stick.x - stick.x0, dy = stick.y - stick.y0, d = Math.hypot(dx, dy), k = d > 34 ? 34 / d : 1;
            cv.circle(stick.x0 + dx * k, stick.y0 + dy * k, 16, withAlpha('#ffffff', 0.4));
        }
        function drawPanel(cv, now, touch) {
            cv.blit(A.panelLayer(), A.PANEL.x, A.PANEL.y);
            const lcd = (q, v) => { A.glow(cv, q.x + q.w - 70, q.y + 29, 56, q.color, 0.12); cv.text(v, q.x + q.w - 14, q.y + 44, 38, q.color, { font: 'num', align: 'right', literal: true }); };
            const b = best[diff()] || 0;
            lcd(A.LCD.score, fmt(game.score));
            lcd(A.LCD.best, fmt(Math.max(b, game.score)));
            lcd(A.LCD.level, String(game.level));
            const P = A.PANEL;
            // the cars still to come: two rows of ten
            const icon = A.iconLayer();
            for (let i = 0; i < game.left(); i++) cv.blit(icon, P.x + 28 + (i % 10) * 22, P.y + 246 + Math.floor(i / 10) * 18);
            // lives, the garage, the cannon's level, what's on
            for (let i = 0; i < Math.min(4, Math.max(0, game.lives - (game.car.alive ? 1 : 0))); i++) cv.blit(A.carLayer('m', 'R', paint(), ''), P.x + 8 + i * 36, P.y + 312);
            for (let i = 0; i < M.GARAGE_HP; i++) cv.blit(A.houseLayer(i < game.garage), P.x + 168 + i * 28, P.y + 326);
            for (let i = 0; i < 3; i++) A.sparkle(cv, P.x + 270 + i * 18, P.y + 306, 6, i < game.power ? GOLD : '#3a3f48');
            let ly = P.y + 384;
            for (const [k, v, full] of [['nitro', game.nitro, 8000], ['fortify', game.fortify, 15000], ['shield', game.car.alive ? game.car.shield : 0, 10000]]) {
                if (v <= 0 || (k === 'shield' && v < 100)) continue;
                const p = A.POWER[k];
                cv.text(p.label, P.x + 26, ly + 9, 12, p.c[0], { font: 'bold', literal: true });
                cv.roundRect(P.x + 100, ly, 130, 8, 4, withAlpha('#ffffff', 0.08));
                cv.roundRect(P.x + 100, ly, 130 * Math.min(1, v / full), 8, 4, p.c[0]);
                ly += 16;
            }
            const lines = touch ? ['Hold a push: drive · press: fire', 'A big turn: pause' + (autoFire() ? ' · auto fire on' : '')] : ['Bar: Up · Down · Left · Right', 'Auto fire · smooth with mgu-render'];
            lines.forEach((l, i) => cv.text(l, P.x + 24, P.y + 440 + i * 16, 12, withAlpha('#ffffff', 0.45), { font: 'label' }));
            const D = A.FIRE_BTN, can = !parked.moving();
            if (can && state !== 'playing') A.glow(cv, D.x, D.y, D.r * 1.6, '#ff2a4a', 0.3 + 0.12 * Math.sin(now / 300));
            cv.blit(A.fireLayer(LABEL[state], now - pressed < 140 ? 'down' : can ? 'on' : 'off'), D.x - D.r - 2, D.y - D.r - 2);
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear('#050608');
            A.setTextScale(cv.textScale);
            const touch = !!cv.own || own();
            drawYard(cv, now, state === 'playing' ? dt : 0);
            drawStick(cv);
            drawOverlay(cv, now, touch);
            drawPanel(cv, now, touch);
            G.frame(cv, t, ['Street Siege'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Street Siege first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
