'use strict';
/**
 * Apex Chase - the M car against four electric cars in a city at night, drawn by the GPU renderer every
 * frame (mgu-render: up to 60 fps). Parked only.
 *
 * Collect every fuel drop on the streets; a NITRO can drains the electric cars' batteries for a while,
 * and a car caught then goes back to the charging station. The rules are in model.js
 * (tests/apex_chase.test.js), the look in art.js. The world is stepped at a fixed 60 Hz whatever the
 * frame rate; without the renderer the frames go to the HMI as images, a few a second (slowly).
 *
 * Steering:
 *   iDrive controller (held by the game on screen): push up / down / left / right = that way (kept until
 *     the car can turn), turn = turn right / left; press = pause. Not playing: press starts / goes on,
 *     push left leaves, a turn lets go of the controller so it moves over the bar and the header.
 *   touchscreen (where the kit runs the screen): swipe the way to go; a tap pauses / goes on.
 *   bar buttons (where the kit doesn't run the screen): "Up", "Down", "Left", "Right", "Start".
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
const BEST_FILE = 'apex_chase_best.json';
const PARKED_MS = 500;
const GOLD = '#ffd36e', BLUE = '#7fd1ff', RED = '#e7222e', GREEN = '#5ff0a6';
const LABEL = { ready: 'START', playing: 'PAUSE', paused: 'GO ON', over: 'AGAIN' };
const RIGHT = { U: 'R', R: 'D', D: 'L', L: 'U' }, LEFT = { U: 'L', L: 'D', D: 'R', R: 'U' };
const BONUS_NAME = { flag: 'CHEQUERED FLAG', cup: 'TROPHY', wrench: 'WRENCH', tyre: 'RACE TYRE', key: 'M KEY' };

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;
        const diff = () => String(settings.get('difficulty') || 'normal');
        const paint = () => String(settings.get('paint') || 'white');
        const bestFile = path.join(dataDir, BEST_FILE);
        const best = M.loadBest(bestFile, log);

        let game = new M.Game({ difficulty: diff() });
        let state = 'ready';
        let acc = 0, lastT = Date.now(), frameT = Date.now();
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        let pressed = 0, newBest = false;
        let texts = [], parts = [], crashAt = 0, clearAt = 0, levelAt = Date.now(), frightAt = 0;

        function showToast(msg, ms) { toast = msg; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());
        function setState(s) {
            if (s === state) return;
            state = s; menu = false;
            Promise.resolve(ui.text('BTN_PLAY', LABEL[s].charAt(0) + LABEL[s].slice(1).toLowerCase())).catch(() => {});
            syncGrab();
        }
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        function play() {
            if (parked.moving()) { showToast('Parked only: the chase starts when the car stands still'); return; }
            if (state === 'over') newGame();
            if (state === 'playing') return;
            lastT = Date.now();
            setState('playing');
        }
        function pause() { if (state === 'playing') setState('paused'); }
        function newGame() {
            game = new M.Game({ difficulty: diff() });
            acc = 0; newBest = false; texts = []; parts = []; crashAt = 0; clearAt = 0; levelAt = Date.now();
            setState('ready');
        }
        function end() {
            const k = diff();
            newBest = game.score > (best[k] || 0);
            if (newBest) { best[k] = game.score; try { M.saveBest(bestFile, best); } catch (e) { log.warn('apex_chase: best not saved: ' + e.message); } }
            log.info('apex_chase: over in level ' + game.level + ' with ' + game.score + ' (' + k + ')');
            setState('over');
        }
        const toggle = () => { pressed = Date.now(); if (state === 'playing') pause(); else play(); };
        const steer = (d) => { if (state === 'playing') game.steer(d); else if (state === 'ready' || state === 'paused') { play(); game.steer(d); } };

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', toggle);
        for (const [b, d] of [['BTN_UP', 'U'], ['BTN_DOWN', 'D'], ['BTN_LEFT', 'L'], ['BTN_RIGHT', 'R']]) ui.onClick(b, () => steer(d));
        if (ctx.hideButton) for (const b of ['BTN_UP', 'BTN_DOWN', 'BTN_LEFT', 'BTN_RIGHT']) ctx.hideButton(b);

        let ccu = null;
        if (ctx.controller) ctx.controller.onInput((v) => {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            const L = ccu;
            ccu = { k, pb, df };
            if (pb === 15 && df === 15) return;                  // no controller behind it
            let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
            if (Math.abs(d) > 64) d = 0;
            const down = (x) => x === 1 || x === 2;
            const pr = down(pb) && !(L && down(L.pb));
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            const way = { N: 'U', S: 'D', E: 'R', W: 'L' }[tilt];
            if (state === 'playing') {
                if (way) game.steer(way);
                if (d) game.steer(d > 0 ? RIGHT[game.car.want] : LEFT[game.car.want]);
                if (pr) toggle();
                return;
            }
            if (pr) toggle();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (way && state !== 'over') steer(way);
            else if (d) { menu = true; syncGrab(); }
        });
        // the finger: a swipe is a way to go, a tap pauses
        let touch0 = null;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) { touch0 = { x, y, ax: x, ay: y, t: Date.now(), swiped: false }; return; }
            if (!touch0) return;
            const dx = x - touch0.ax, dy = y - touch0.ay;
            if (Math.hypot(dx, dy) > 26) {
                // a swipe steers; one that bends steers again from where it bent
                steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U'));
                touch0.ax = x; touch0.ay = y; touch0.swiped = true;
            }
            if (phase !== 3) return;
            const tap = !touch0.swiped && Date.now() - touch0.t < 400;
            touch0 = null;
            if (tap) toggle();
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => { if (k === 'difficulty') newGame(); });
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
        function burst(x, y, n, colors, speed, o) {
            o = o || {};
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
                parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: colors[i % colors.length], life: (o.life || 500) * (0.6 + Math.random() * 0.6), age: 0, s: (o.size || 3) * (0.5 + Math.random()), spark: !!o.spark });
            }
        }
        function effect(ev, now) {
            if (ev.type === 'nitro') { burst(A.px(ev.x), A.py(ev.y), 16, ['#7fd1ff', '#36b4ff', '#ffffff'], 220, { spark: true }); texts.push({ x: A.px(ev.x), y: A.py(ev.y), s: 'NITRO', c: BLUE, at: now }); } else if (ev.type === 'fright') frightAt = now;
            else if (ev.type === 'caught') { texts.push({ x: A.px(ev.x), y: A.py(ev.y), s: String(ev.pts), c: GOLD, at: now, big: true }); burst(A.px(ev.x), A.py(ev.y), 18, ['#7fe8ff', '#ffe34a', '#ffffff'], 260, { spark: true }); } else if (ev.type === 'crash') { crashAt = now; burst(A.px(ev.x), A.py(ev.y), 40, ['#ffb020', '#ff4d1a', '#ffffff', '#7fe8ff'], 300, { spark: true, life: 700 }); } else if (ev.type === 'bonus') texts.push({ x: A.px(22), y: A.py(11) - 18, s: BONUS_NAME[ev.kind], c: GOLD, at: now });
            else if (ev.type === 'bonusEaten') { texts.push({ x: A.px(ev.x), y: A.py(ev.y), s: String(ev.pts), c: GOLD, at: now, big: true }); burst(A.px(ev.x), A.py(ev.y), 14, [GOLD, '#ffffff'], 200, { spark: true }); } else if (ev.type === 'extra') texts.push({ x: A.px(22), y: A.py(14) - 20, s: 'EXTRA CAR', c: GREEN, at: now, big: true });
            else if (ev.type === 'cleared') clearAt = now;
            else if (ev.type === 'level') { levelAt = now; clearAt = 0; }
        }

        /* ---------- drawing ---------- */
        function drawBoard(cv, now, dt) {
            const n = (game.level - 1) % 2;
            cv.blit(A.cityLayer(n, game.grid, n ? 'blue' : 'night'), A.BOARD.x, A.BOARD.y);
            // a cleared city flashes
            if (clearAt && Math.floor((now - clearAt) / 220) % 2 === 0) cv.roundRect(A.OX, A.OY, M.W * A.CELL, M.H * A.CELL, 8, withAlpha('#ffffff', 0.12));
            cv.clip(A.OX, A.OY, M.W * A.CELL, M.H * A.CELL);
            // the drops and the nitro cans
            const drop = A.dropLayer(), nitro = A.nitroLayer(), pulse = Math.sin(now / 150) > -0.3;
            for (const k of game.dots) {
                const i = k.indexOf(','), x = +k.slice(0, i), y = +k.slice(i + 1);
                if (game.grid[y][x] === 'o') { if (pulse) cv.blit(nitro, A.px(x) - 15, A.py(y) - 15); } else cv.blit(drop, A.px(x) - 8, A.py(y) - 8);
            }
            if (game.bonus) cv.blit(A.bonusLayer(game.bonus.kind), A.px(game.bonus.x) - 17, A.py(game.bonus.y) - 17);
            // the electric cars
            const flash = game.fright > 0 && game.fright < 2000 && Math.floor(now / 200) % 2 === 0;
            for (const e of game.evs) {
                const p = e.script || e.state === 'home' || e.state === 'enter' ? { x: e.x, y: e.y } : game.at(e);
                const x = A.px(p.x), y = A.py(p.y), B = A.CAR_BOX / 2;
                if (e.state === 'back') { cv.blit(A.ghostLayer(e.dir), x - B, y - B); continue; }
                const st = e.state === 'scared' ? (flash ? 'flash' : 'scared') : 'out';
                if (st === 'out') cv.circle(x, y, 16, withAlpha(A.EV_PAINT[e.i][0], 0.06));
                cv.blit(A.evLayer(e.i, e.dir, st), x - B, y - B);
                if (st !== 'out' && Math.floor(now / 300) % 2 === 0) A.drawBattery(cv, x, y - 20, '#ff3b3b');
            }
            // the M car: its headlights on the street ahead, the car; spinning after a crash
            const c = game.car, p = game.at(c), x = A.px(p.x), y = A.py(p.y), B = A.CAR_BOX / 2;
            let dir = c.dir;
            if (crashAt && game.dying > 0) dir = ['R', 'D', 'L', 'U'][Math.floor((now - crashAt) / 70) % 4];
            if (!(crashAt && game.dying > 0 && game.dying < 700)) {
                const [dx, dy] = M.DIRS[dir], nx = -dy, ny = dx;
                const f = (a, b) => [x + dx * a + nx * b, y + dy * a + ny * b];
                A.poly(cv, [f(18, -7), f(18, 7), f(70, 22), f(70, -22)], withAlpha('#fff4d6', 0.07));
                A.poly(cv, [f(18, -5), f(18, 5), f(46, 12), f(46, -12)], withAlpha('#fff4d6', 0.07));
                cv.blit(A.mCarLayer(dir, paint()), x - B, y - B);
            }
            cv.noclip();
            // the tunnels' mouths over the cars going through
            for (const tx of [A.OX - 8, A.OX + M.W * A.CELL - 16]) cv.gradientRect(tx, A.py(9) - 16, 24, 32, [[0, '#050608'], [1, '#050608']]);
            drawEffects(cv, dt, now);
        }
        function drawEffects(cv, dt, now) {
            const s = dt / 1000;
            parts = parts.filter((q) => (q.age += dt) < q.life);
            for (const q of parts) {
                q.x += q.vx * s; q.y += q.vy * s; q.vx *= 0.96; q.vy *= 0.96;
                const a = 1 - q.age / q.life;
                if (q.spark) cv.line(q.x, q.y, q.x - q.vx * 0.04, q.y - q.vy * 0.04, 2, withAlpha(q.c, a));
                else cv.circle(q.x, q.y, q.s, withAlpha(q.c, a));
            }
            texts = texts.filter((q) => now - q.at < 1100);
            for (const q of texts) {
                const k = (now - q.at) / 1100;
                cv.text(q.s, q.x, q.y - 14 - k * 26, q.big ? 22 : 16, withAlpha(q.c, 1 - k * k), { font: 'bold', align: 'center', spacing: 1, literal: true });
            }
        }
        function drawOverlay(cv, now, touch) {
            const cx = A.OX + M.W * A.CELL / 2, cy = A.py(9) + 4;
            // the start: three lights in the M colours, then GO
            if (state === 'playing' && game.pause > 0 && !game.dying && !game.over) {
                const k = Math.min(3, Math.floor((1600 - game.pause) / 450) + 1);
                cv.roundRect(cx - 96, cy - 24, 192, 44, 12, withAlpha('#06070a', 0.85));
                A.M_STRIPES.forEach((col, i) => { if (i < k) A.glow(cv, cx - 50 + i * 50, cy - 2, 22, col, 0.6); cv.circle(cx - 50 + i * 50, cy - 2, 12, i < k ? col : '#1a1c22'); });
                cv.text('LEVEL ' + game.level, cx, cy + 46, 20, '#ffffff', { font: 'bold', align: 'center', spacing: 3, literal: true });
                return;
            }
            if (clearAt) { cv.text('CITY CLEARED', cx, cy + 8, 40, GREEN, { font: 'bold', align: 'center', spacing: 4, literal: true }); return; }
            if (state === 'playing') return;
            const moving = parked.moving();
            let title, lines;
            if (moving) { title = 'PARKED ONLY'; lines = ['The chase waits while the car is moving.', 'It goes on when you stop.']; } else if (state === 'ready') {
                title = 'APEX CHASE';
                lines = touch ? ['Press the controller or tap to start', 'Push or swipe the way to go  ·  collect every drop'] : ['Press "Start" to play', 'Steer with the arrows in the bar - smooth only with mgu-render'];
            } else if (state === 'paused') { title = 'PAUSED'; lines = touch ? ['Press or tap to go on', 'Push left to leave  ·  turn for the menu'] : ['Press "Go on"']; } else {
                if (now - crashAt < 900) return;
                title = 'GAME OVER';
                lines = [newBest ? 'New best: ' + fmt(game.score) : 'Score ' + fmt(game.score) + '  ·  level ' + game.level, touch ? 'Press or tap to play again' : 'Press "Again"'];
            }
            cv.roundRect(A.OX, A.OY, M.W * A.CELL, M.H * A.CELL, 10, withAlpha('#05060a', 0.66));
            cv.text(title, cx, cy - 10, 60, moving ? '#ffb020' : state === 'over' ? RED : '#ffffff', { font: 'bold', align: 'center', spacing: 5 });
            lines.forEach((l, i) => cv.text(l, cx, cy + 36 + i * 32, 22, i === 0 && newBest && state === 'over' ? GOLD : withAlpha('#ffffff', 0.7), { align: 'center' }));
            if (state === 'ready' && !moving) {
                // who's who
                M.NAMES.forEach((nm, i) => {
                    const x = cx - 300 + i * 200, y = cy + 120;
                    cv.blit(A.evLayer(i, 'R', 'out'), x - 24, y - 24);
                    cv.text(nm.toUpperCase(), x + 30, y + 6, 16, A.EV_PAINT[i][0] === '#3a3e46' ? '#9aa3ad' : A.EV_PAINT[i][0], { font: 'bold', spacing: 2, literal: true });
                });
            }
        }
        function drawPanel(cv, now, touch) {
            cv.blit(A.panelLayer(), A.PANEL.x, A.PANEL.y);
            const lcd = (q, v) => { A.glow(cv, q.x + q.w - 70, q.y + 29, 56, q.color, 0.12); cv.text(v, q.x + q.w - 14, q.y + 44, 38, q.color, { font: 'num', align: 'right', literal: true }); };
            const b = best[diff()] || 0;
            lcd(A.LCD.score, fmt(game.score));
            lcd(A.LCD.best, fmt(Math.max(b, game.score)));
            lcd(A.LCD.level, String(game.level));
            const P = A.PANEL;
            // the spare cars (the one on the street not counted)
            for (let i = 0; i < Math.min(5, Math.max(0, game.lives - 1)); i++) cv.blit(A.mCarLayer('R', paint()), P.x + 90 + i * 50, P.y + 214);
            // the nitro left
            const full = game.frightMs ? game.frightMs() : 1, k = Math.max(0, game.fright / full);
            if (k > 0) cv.roundRect(P.x + 26, P.y + 312, (P.w - 52) * k, 10, 5, k < 0.3 && Math.floor(now / 200) % 2 ? '#ffffff' : '#36b4ff');
            const lines = touch ? ['Push or swipe: the way to go', 'Turn: right / left  ·  press: pause'] : ['Bar: Up · Down · Left · Right', 'Smooth only with mgu-render'];
            lines.forEach((l, i) => cv.text(l, P.x + 24, P.y + 386 + i * 18, 13, withAlpha('#ffffff', 0.45), { font: 'label' }));
            cv.text('DIFFICULTY  ' + diff().toUpperCase(), P.x + 24, P.y + 362, 14, withAlpha(GOLD, 0.7), { font: 'bold', spacing: 1.5, literal: true });
            const D = A.PLAY_BTN, can = !parked.moving();
            if (can && state !== 'playing') A.glow(cv, D.x, D.y, D.r * 1.6, '#ff2a4a', 0.3 + 0.12 * Math.sin(now / 300));
            cv.blit(A.playLayer(LABEL[state], now - pressed < 140 ? 'down' : can ? 'on' : 'off'), D.x - D.r - 2, D.y - D.r - 2);
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
            G.frame(cv, t, ['Apex Chase'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Apex Chase first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
