'use strict';
/**
 * Lap Record - time trial on a circuit seen from above, the camera on the car: lap after lap against your
 * best, its ghost on the track, the gap to it live, the sectors in purple, green and yellow. Drawn by the
 * GPU renderer (mgu-render). Parked only.
 *
 * The physics and the timing are in model.js (tests/lap_record.test.js), the look in art.js.
 *
 * Driving it:
 *   iDrive controller (held by the game on screen): the knob is the steering wheel (it comes back to the
 *     middle by itself when you let it be); push left / right and hold = full lock that way.
 *     Throttle "automatic" (the default): the car accelerates by itself, press and hold = brake.
 *     Throttle "manual": press and hold = throttle, push down and hold = brake.
 *     Push up and hold = pause. Not driving: press starts / goes on, push left leaves, a turn lets go of
 *     the controller.
 *   touchscreen (where the kit runs the screen): a finger on the left / right half of the track steers that
 *     way while it's down; BRAKE and GAS on the panel.
 *   bar buttons (where the kit doesn't run the screen): "Left", "Right", "Brake", "Start".
 *
 * The session pauses when the screen goes, a sheet (Settings) opens over it or the car drives off
 * (kit/parked.js). The best lap of each circuit is kept, with its ghost.
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
const RECORDS_FILE = 'lap_record_best.json';
const PARKED_MS = 500;
const NOTCH = 0.12;                  // a notch of the knob, of full lock
const CENTRE = 1.8;                  // full lock a second: the wheel coming back to the middle
const LET_BE_MS = 160;               // the knob let be this long: the wheel comes back
const GOLD = '#ffd36e', RED = '#e7222e', GREEN = '#5ff0a6';

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;
        const circuit = () => (M.CIRCUITS[String(settings.get('circuit'))] ? String(settings.get('circuit')) : 'riverside');
        const manual = () => String(settings.get('throttle') || 'auto') === 'manual';
        const paint = () => { const p = String(settings.get('paint') || 'blue'); return A.PAINTS[p] ? p : 'blue'; };
        const ghostOn = () => String(settings.get('ghost') || 'on') === 'on';
        const recFile = path.join(dataDir, RECORDS_FILE);
        let records = M.loadRecords(recFile, log);

        const fresh = () => { const r = records[circuit()] || {}; return new M.Game({ circuit: circuit(), best: r.best, bestSectors: r.sectors }); };
        let game = fresh();
        let state = 'ready';
        let acc = 0, lastT = Date.now(), frameT = Date.now();
        let visible = false, menu = false;
        let toast = null, toastUntil = 0;
        const cam = { x: game.car.x, y: game.car.y };
        // the controls
        let wheel = 0, lastNotch = 0;
        const held = { ccu: 0, press: false, down: false, touch: 0, gas: false, brake: false, pulse: [0, 0] };
        // what's drawn over the world
        let marks = [], parts = [], pops = [], banner = null, sectors = [null, null, null], invalidAt = 0, wrongAt = 0, shake = 0;

        function showToast(s, ms) { toast = s; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());
        function setState(s) {
            if (s === state) return;
            state = s; menu = false;
            Promise.resolve(ui.text('BTN_PLAY', s === 'playing' ? 'Pause' : s === 'paused' ? 'Go on' : 'Start')).catch(() => {});
            syncGrab();
        }
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        function play() {
            if (parked.moving()) { showToast('Parked only: the circuit opens when the car stands still'); return; }
            if (state === 'playing') return;
            lastT = Date.now();
            setState('playing');
        }
        function pause() { if (state === 'playing') { setState('paused'); Object.assign(held, { ccu: 0, press: false, down: false, touch: 0, gas: false, brake: false }); } }
        function newSession() {
            game = fresh();
            acc = 0; marks = []; parts = []; pops = []; banner = null; sectors = [null, null, null]; wheel = 0;
            cam.x = game.car.x; cam.y = game.car.y;
            setState('ready');
        }
        function saveRecord() {
            records[game.track.id] = { best: game.best, sectors: game.bestSectors.map((x) => (isFinite(x) ? x : null)) };
            try { M.saveRecords(recFile, records); } catch (e) { log.warn('lap_record: not saved: ' + e.message); }
        }

        /* ---------- input ---------- */
        ui.onClick('BTN_PLAY', () => { if (state === 'playing') pause(); else play(); });
        ui.onClick('BTN_LEFT', () => { if (state !== 'playing') play(); held.pulse[0] = Date.now() + 250; });
        ui.onClick('BTN_RIGHT', () => { if (state !== 'playing') play(); held.pulse[1] = Date.now() + 250; });
        ui.onClick('BTN_BRAKE', () => { if (state !== 'playing') play(); held.brakePulse = Date.now() + 500; });
        if (ctx.hideButton) for (const b of ['BTN_LEFT', 'BTN_RIGHT', 'BTN_BRAKE']) ctx.hideButton(b);

        let ccu = null;
        if (ctx.controller) ctx.controller.onInput((v) => {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            const L = ccu;
            ccu = { k, pb, df };
            if (pb === 15 && df === 15) return;                  // no controller behind it
            let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
            if (Math.abs(d) > 64) d = 0;
            const down = (x) => x === 1 || x === 2;
            const pressed = down(pb) && !(L && down(L.pb));
            const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
            if (state === 'playing') {
                held.ccu = TILT[df] === 'W' ? -1 : TILT[df] === 'E' ? 1 : 0;
                held.down = TILT[df] === 'S';
                held.press = down(pb);
                if (df === 2 && !(L && L.df === 2)) { pause(); return; }       // pushed up and held: pause
                if (d) { wheel = Math.max(-1, Math.min(1, wheel + d * NOTCH)); lastNotch = Date.now(); }
                return;
            }
            Object.assign(held, { ccu: 0, press: false, down: false });
            if (pressed) play();
            else if (tilt === 'W') Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            else if (d) { menu = true; syncGrab(); }
        });
        let finger = null;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) {
                const p = A.PEDALS.find((q) => x >= q.x - 4 && x <= q.x + q.w + 4 && y >= q.y - 4 && y <= q.y + q.h + 4);
                if (state !== 'playing') { play(); finger = null; return; }
                if (p) { held[p.kind] = true; finger = { kind: p.kind }; return; }
                if (x >= A.PANEL.x) { finger = null; return; }
                finger = { kind: 'steer' };
            }
            if (!finger) return;
            if (finger.kind === 'steer') held.touch = phase === 3 ? 0 : x < A.BOARD.x + A.BOARD.w / 2 ? -1 : 1;
            if (phase === 3) { if (finger.kind !== 'steer') held[finger.kind] = false; finger = null; }
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { pause(); menu = false; }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => { if (k === 'circuit') newSession(); });
        setInterval(() => { if (state === 'playing' && parked.moving()) { pause(); showToast('Paused: parked only', 4000); } }, PARKED_MS);

        /* ---------- the clock ---------- */
        function controls(now, dt) {
            // the steering wheel: the knob's place, back to the middle when let be; a push is full lock
            if (now - lastNotch > LET_BE_MS) wheel -= Math.sign(wheel) * Math.min(Math.abs(wheel), CENTRE * dt / 1000);
            let steer = wheel;
            const push = held.ccu || held.touch || (now < held.pulse[0] ? -1 : now < held.pulse[1] ? 1 : 0);
            if (push) steer = push;
            let gas, brake;
            const tBrake = held.brake || now < (held.brakePulse || 0);
            if (manual()) { gas = held.press || held.gas ? 1 : 0; brake = held.down || tBrake ? 1 : 0; } else { brake = held.press || held.down || tBrake ? 1 : 0; gas = brake ? 0 : 1; }
            if (held.gas) { gas = 1; brake = 0; }
            game.control(steer, gas, brake);
        }
        function advance(now) {
            if (state !== 'playing') { lastT = now; return; }
            if (display && display.sheet) { pause(); return; }
            const dt = Math.min(100, now - lastT);
            lastT = now;
            controls(now, dt);
            acc += dt;
            while (acc >= M.DT) { game.step(M.DT); acc -= M.DT; trail(); }
            for (const ev of game.events.splice(0)) effect(ev, now);
        }
        /** tyre marks and smoke from the rear wheels while it slides (or brakes hard); dust off the track */
        function trail() {
            const c = game.car, cs = Math.cos(c.h), sn = Math.sin(c.h);
            const hard = c.sliding || (c.braking && c.v > 18);
            for (const side of [-1, 1]) {
                const x = c.x - cs * 1.45 - sn * side * 0.8, y = c.y - sn * 1.45 + cs * side * 0.8;
                const lastM = c['_m' + side];
                if (hard && c.surface !== 'grass' && c.surface !== 'gravel' && lastM) marks.push([lastM[0], lastM[1], x, y, c.sliding ? 0.5 : 0.3]);
                c['_m' + side] = hard ? [x, y] : null;
                if (c.sliding && Math.random() < 0.5 && c.surface === 'asphalt') parts.push({ x, y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 900, age: 0, r: 0.6, grow: 2.2, c: '#e6e6ea', a: 0.3 });
                if ((c.surface === 'grass' || c.surface === 'gravel') && c.v > 6 && Math.random() < 0.6) parts.push({ x, y, vx: -cs * c.v * 0.1 + (Math.random() - 0.5) * 2, vy: -sn * c.v * 0.1 + (Math.random() - 0.5) * 2, life: 700, age: 0, r: 0.4, grow: 1.4, c: c.surface === 'gravel' ? '#cdbb8c' : '#6a8a40', a: 0.5 });
            }
            if (marks.length > 900) marks.splice(0, marks.length - 900);
        }
        function effect(ev, now) {
            switch (ev.type) {
            case 'go': banner = { s: 'GO!', c: GREEN, at: now, ms: 900 }; break;
            case 'lap': sectors = [null, null, null]; break;
            case 'sector':
                sectors[ev.k] = { ms: ev.ms, colour: ev.colour };
                if (ev.k < 2) pops.push({ s: 'S' + (ev.k + 1) + '  ' + (ev.ms / 1000).toFixed(3) + (ev.delta !== null ? '   ' + M.fmtDelta(ev.delta) : ''), c: A.SECTOR_C[ev.colour], at: now, ms: 2200 });
                break;
            case 'lapDone':
                banner = ev.record ? { s: 'NEW RECORD', sub: M.fmtTime(ev.time), c: '#c99bff', at: now, ms: 2600 }
                    : { s: ev.valid ? 'LAP ' + ev.n : 'LAP NOT COUNTED', sub: M.fmtTime(ev.time) + (ev.valid && ev.delta !== null ? '   ' + M.fmtDelta(ev.delta) : ev.valid ? '' : '   off the track'), c: ev.valid ? '#ffffff' : RED, at: now, ms: 2200 };
                if (ev.record) saveRecord();
                else if (ev.valid) saveRecord();                  // (the best sectors)
                break;
            case 'invalid': invalidAt = now; break;
            case 'wrongWay': wrongAt = now; break;
            case 'wall':
                shake = Math.min(8, ev.v / 4);
                for (let i = 0; i < 14; i++) parts.push({ x: ev.x, y: ev.y, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, life: 300, age: 0, r: 0.15, grow: 0, c: '#ffd36e', a: 1, spark: true });
                break;
            default: break;
            }
        }

        /* ---------- drawing ---------- */
        function drawBoard(cv, now, dt) {
            const c = game.car;
            // the camera: ahead of the car, the faster the further
            const look = Math.min(1, c.v / 60) * 0.9;
            const tx = c.x + Math.cos(c.dir) * c.v * look, ty = c.y + Math.sin(c.dir) * c.v * look * 0.75;
            const k = Math.min(1, dt / 1000 * 3);
            cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
            shake = Math.max(0, shake - dt * 0.02);
            const view = { x: cam.x + (shake ? (Math.random() - 0.5) * shake / A.Z : 0), y: cam.y + (shake ? (Math.random() - 0.5) * shake / A.Z : 0) };
            if (cv.clip) cv.clip(A.BOARD.x, A.BOARD.y, A.BOARD.w, A.BOARD.h);
            A.drawWorld(cv, game.track, view);
            const S = A.toScreen(view), inView = (p) => p[0] > A.BOARD.x - 40 && p[0] < A.BOARD.x + A.BOARD.w + 40 && p[1] > A.BOARD.y - 40 && p[1] < A.BOARD.y + A.BOARD.h + 40;
            // the tyre marks
            for (const m of marks) { const a = S(m[0], m[1]), b = S(m[2], m[3]); if (inView(a)) cv.line(a[0], a[1], b[0], b[1], 2.2, withAlpha('#0c0c0e', m[4])); }
            // the start gantry's lights, over the line
            const q0 = game.track.s[0], g0 = S(q0.x, q0.y);
            if (inView(g0)) {
                const ga = S(q0.x + q0.nx * (M.WIDTH / 2 + 2), q0.y + q0.ny * (M.WIDTH / 2 + 2)), gb = S(q0.x - q0.nx * (M.WIDTH / 2 + 2), q0.y - q0.ny * (M.WIDTH / 2 + 2));
                cv.line(ga[0] + 4, ga[1] + 6, gb[0] + 4, gb[1] + 6, 7, withAlpha('#000000', 0.3));
                cv.line(ga[0], ga[1], gb[0], gb[1], 6, '#2a2e35');
                for (let i = 0; i < 5; i++) { const f = 0.3 + i * 0.1, x = ga[0] + (gb[0] - ga[0]) * f, y = ga[1] + (gb[1] - ga[1]) * f, on = !game.lights.go && i < game.lights.n; cv.circle(x, y, 2.4, on ? '#ff2a3a' : '#0b0c0f'); if (on) A.glow(cv, x, y, 9, '#ff2a3a', 0.6); }
            }
            // the ghost of the best lap, then the car
            const gh = ghostOn() ? game.ghost() : null;
            if (gh) { const p = S(gh.x, gh.y); if (inView(p)) A.drawCar(cv, p[0], p[1], gh.h, { ghost: true }); }
            const p = S(c.x, c.y);
            A.drawCar(cv, p[0], p[1], c.h, { paint: paint(), braking: c.braking, steer: c.steer });
            // smoke, dust, sparks
            const s = dt / 1000;
            parts = parts.filter((q) => (q.age += dt) < q.life);
            if (parts.length > 500) parts.splice(0, parts.length - 500);
            for (const q of parts) {
                q.x += q.vx * s; q.y += q.vy * s; q.vx *= 0.96; q.vy *= 0.96;
                const a = 1 - q.age / q.life, pp = S(q.x, q.y);
                if (!inView(pp)) continue;
                if (q.spark) cv.line(pp[0], pp[1], pp[0] - q.vx * 0.15, pp[1] - q.vy * 0.15, 1.6, withAlpha(q.c, a));
                else cv.circle(pp[0], pp[1], (q.r + q.grow * (1 - a)) * A.Z, withAlpha(q.c, q.a * a));
            }
            // a soft dark at the edges of the view
            for (let i = 0; i < 6; i++) {
                const k2 = withAlpha('#000000', 0.05);
                cv.fillRect(A.BOARD.x, A.BOARD.y, A.BOARD.w, 8 + i * 6, k2); cv.fillRect(A.BOARD.x, A.BOARD.y + A.BOARD.h - 8 - i * 6, A.BOARD.w, 8 + i * 6, k2);
                cv.fillRect(A.BOARD.x, A.BOARD.y, 10 + i * 8, A.BOARD.h, k2); cv.fillRect(A.BOARD.x + A.BOARD.w - 10 - i * 8, A.BOARD.y, 10 + i * 8, A.BOARD.h, k2);
            }
            if (cv.noclip) cv.noclip();
            // (where the clip isn't kept: the world's edges covered, the board's corners rounded)
            cv.fillRect(0, 36, A.BOARD.x, H - 36, '#050608'); cv.fillRect(A.BOARD.x + A.BOARD.w, 36, W, H - 36, '#050608');
            cv.fillRect(0, 36, W, A.BOARD.y - 36, '#050608'); cv.fillRect(0, A.BOARD.y + A.BOARD.h, W, H, '#050608');
            for (const [x, y, sx, sy] of [[A.BOARD.x, A.BOARD.y, 1, 1], [A.BOARD.x + A.BOARD.w, A.BOARD.y, -1, 1], [A.BOARD.x, A.BOARD.y + A.BOARD.h, 1, -1], [A.BOARD.x + A.BOARD.w, A.BOARD.y + A.BOARD.h, -1, -1]]) {
                const pts = [[x, y]];
                for (let i = 0; i <= 6; i++) { const t = i / 6 * Math.PI / 2; pts.push([x + sx * 14 * (1 - Math.cos(t)), y + sy * 14 * (1 - Math.sin(t))]); }
                A.poly(cv, pts, '#050608');
            }
        }
        function drawHud(cv, now) {
            const cx = A.BOARD.x + A.BOARD.w / 2;
            // the start lights, big
            if (state === 'playing' && !game.lights.go) {
                cv.roundRect(cx - 170, A.BOARD.y + 24, 340, 74, 16, withAlpha('#05060a', 0.85));
                for (let i = 0; i < 5; i++) {
                    const x = cx - 128 + i * 64, y = A.BOARD.y + 61, on = i < game.lights.n;
                    cv.circle(x, y, 24, '#16181c');
                    cv.circle(x, y, 19, on ? '#ff2a3a' : '#2a0a0e');
                    if (on) { A.glow(cv, x, y, 40, '#ff2a3a', 0.5); cv.circle(x - 5, y - 6, 6, withAlpha('#ffffff', 0.35)); }
                }
            }
            if (banner && now - banner.at < banner.ms) {
                const k = (now - banner.at) / banner.ms, a = k > 0.8 ? (1 - k) / 0.2 : 1;
                A.outlined(cv, banner.s, cx, A.BOARD.y + 150, banner.s.length > 4 ? 40 : 64, withAlpha(banner.c, a), withAlpha('#05060a', a), 2.5, { spacing: 5 });
                if (banner.sub) A.outlined(cv, banner.sub, cx, A.BOARD.y + 190, 26, withAlpha('#ffffff', a), withAlpha('#05060a', a), 2, { spacing: 1 });
            }
            pops = pops.filter((q) => now - q.at < q.ms);
            pops.forEach((q) => {
                const k = (now - q.at) / q.ms, a = k > 0.75 ? (1 - k) / 0.25 : 1;
                cv.roundRect(cx - 160, A.BOARD.y + 16, 320, 36, 18, withAlpha('#05060a', 0.75 * a));
                cv.text(q.s, cx, A.BOARD.y + 41, 20, withAlpha(q.c, a), { font: 'bold', align: 'center', spacing: 1, literal: true });
            });
            if (game.invalid && state === 'playing') {
                const blink = now - invalidAt < 1500 ? Math.floor(now / 200) % 2 : 1;
                if (blink) { cv.roundRect(A.BOARD.x + 18, A.BOARD.y + 16, 190, 30, 15, withAlpha('#5a0a10', 0.85)); cv.text('LAP NOT COUNTED', A.BOARD.x + 113, A.BOARD.y + 37, 14, '#ffb0b0', { font: 'bold', align: 'center', spacing: 1, literal: true }); }
            }
            if (now - wrongAt < 2500 && game.wrong > 0) A.outlined(cv, 'WRONG WAY', cx, A.BOARD.y + 250, 44, RED, '#05060a', 2.5, { spacing: 5 });
        }
        function drawOverlay(cv, now, touch) {
            if (state === 'playing') return;
            const cx = A.BOARD.x + A.BOARD.w / 2, cy = A.BOARD.y + 200;
            const moving = parked.moving(), best = game.best;
            let title, lines, col = '#ffffff';
            if (moving) { title = 'PARKED ONLY'; col = '#ffb020'; lines = ['The circuit waits while the car is moving.', 'It opens when you stop.']; } else if (state === 'ready') {
                title = game.track.name;
                lines = [(game.track.length / 1000).toFixed(2) + ' km  ·  best lap ' + (best ? M.fmtTime(best.time) : 'none yet') + (best && ghostOn() ? '  ·  its ghost drives with you' : ''),
                    touch ? 'The knob is the wheel · ' + (manual() ? 'hold the press: throttle, push down: brake' : 'the car accelerates by itself, hold the press: brake') : 'Steer with Left / Right, Brake in the bar',
                    'Press to go to the line'];
            } else { title = 'PAUSED'; lines = [touch ? 'Press or tap to go on' : 'Press "Go on"', 'Push left to leave  ·  turn for the menu']; }
            const w = 820, h = 86 + lines.length * 30;
            cv.roundRect(cx - w / 2, cy - 62, w, h, 18, withAlpha('#05060a', 0.82));
            cv.strokeRoundRect(cx - w / 2, cy - 62, w, h, 18, 1.5, withAlpha('#ffffff', 0.15));
            A.outlined(cv, title, cx, cy - 4, 46, col, '#05060a', 2, { spacing: 5 });
            lines.forEach((l, i) => cv.text(l, cx, cy + 34 + i * 30, 18, withAlpha('#ffffff', 0.75), { align: 'center', literal: true }));
        }
        function drawPanel(cv, now, touch) {
            const P = A.PANEL, c = game.car;
            cv.blit(A.panelLayer(), P.x, P.y);
            const lcd = (x, y, w, h, v, col, size) => { A.glow(cv, x + w - 80, y + h / 2, 56, col, 0.12); cv.text(v, x + w - 14, y + h / 2 + size * 0.36, size, col, { font: 'num', align: 'right', literal: true }); };
            lcd(P.x + 24, P.y + 34, P.w - 48, 58, M.fmtTime(game.lap ? game.lapT : 0), game.invalid ? '#ff8a8a' : '#ffffff', 40);
            const hw = (P.w - 60) / 2;
            lcd(P.x + 24, P.y + 124, hw, 46, game.best ? M.fmtTime(game.best.time) : '-:--.---', '#c99bff', 28);
            const d = game.delta();
            lcd(P.x + 36 + hw, P.y + 124, hw, 46, d === null ? '--.---' : M.fmtDelta(d), d === null ? withAlpha('#ffffff', 0.4) : d <= 0 ? GREEN : RED, 28);
            // the sectors of this lap
            for (let k = 0; k < 3; k++) {
                const x = P.x + 22 + k * 126, y = P.y + 208, s = sectors[k], col = s ? A.SECTOR_C[s.colour] : '#3a3f48';
                cv.roundRect(x, y, 118, 36, 8, withAlpha(col, s ? 0.22 : 0.3));
                const live = game.lap && game.sector === k && !s;
                cv.roundRect(x, y + 30, 118 * (s ? 1 : live ? 0.5 + 0.5 * Math.sin(now / 200) * 0 : 0), 6, 3, col);
                cv.text('S' + (k + 1), x + 10, y + 23, 14, withAlpha('#ffffff', 0.7), { font: 'bold', literal: true });
                cv.text(s ? (s.ms / 1000).toFixed(3) : live ? '···' : '', x + 108, y + 23, 16, '#ffffff', { font: 'bold', align: 'right', literal: true });
            }
            // speed and gear, the revs
            cv.text(String(Math.round(c.v * 3.6)), P.x + 130, P.y + 318, 50, '#ffffff', { font: 'num', align: 'right', literal: true });
            cv.text(String(c.gear), P.x + 172, P.y + 318, 40, '#81c4ff', { font: 'num', literal: true });
            for (let i = 0; i < 14; i++) {
                const on = c.rpm * 14 > i;
                cv.roundRect(P.x + 26 + i * 14.5, P.y + 340, 11, 8, 2, on ? (i < 8 ? GREEN : i < 12 ? '#ffd23a' : RED) : withAlpha('#ffffff', 0.08));
            }
            cv.text('LAP ' + Math.max(1, game.lap) + (game.last ? '   LAST ' + M.fmtTime(game.last.time) + (game.last.valid ? '' : ' *') : ''), P.x + 26, P.y + 380, 13, withAlpha('#ffffff', 0.6), { font: 'bold', spacing: 1, literal: true });
            // the map: the car and the ghost on it
            cv.blit(A.mapLayer(game.track), A.MAP.x, A.MAP.y);
            const m = A.mapGeo(game.track);
            const gh = ghostOn() ? game.ghost() : null;
            if (gh) { const q = m.at(gh.x, gh.y); cv.circle(q[0], q[1], 3.5, withAlpha('#9ac8ff', 0.8)); }
            const q = m.at(c.x, c.y);
            A.glow(cv, q[0], q[1], 10, '#ffd36e', 0.5); cv.circle(q[0], q[1], 4, GOLD);
            // the pedals (for the finger)
            const gas = game.ctrl.throttle > 0 && state === 'playing', brk = game.ctrl.brake > 0 && state === 'playing';
            A.PEDALS.forEach((b) => cv.blit(A.pedalLayer(b.kind, (b.kind === 'gas' ? gas : brk) ? 'down' : 'up'), b.x - 2, b.y - 2));
            cv.text(manual() ? 'manual' : 'auto gas', P.x + 336, P.y + 430, 12, withAlpha('#ffffff', 0.45), { font: 'label', align: 'center', literal: true });
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear('#050608');
            A.setTextScale(cv.textScale);
            const touch = !!cv.own || own();
            drawBoard(cv, now, state === 'playing' ? dt : 16);
            drawHud(cv, now);
            drawOverlay(cv, now, touch);
            drawPanel(cv, now, touch);
            G.frame(cv, t, ['Lap Record'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }, { text: game.track.name + '  ·  LAP ' + Math.max(1, game.lap), color: 'cold' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Lap Record first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
