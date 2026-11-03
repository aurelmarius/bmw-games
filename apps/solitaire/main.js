'use strict';
/**
 * Solitaire (Klondike), drawn by the GPU renderer every frame (mgu-render: up to 60 fps). Parked only.
 *
 * The rules are in model.js (tests/solitaire.test.js); this file shows them: every card has a place on
 * the screen that slides to where the rules put it, so a move, a draw, an undo or a deal flies by
 * itself; a card turned over flips; a finished game sends the cards bouncing off the foundations.
 *
 * Steering - one move at a time, the best one (the rules choose where the cards go):
 *   iDrive controller (held by the game on screen): turn = from pile to pile (the stock, the waste, the
 *     foundations, the seven columns), press = the best move for that pile (on the stock: draw),
 *     push up = undo, push down = hint, push right = draw, push left = leave. Statistics: press or push
 *     down closes them, a turn lets go of the controller (over to the bar and the header).
 *   touchscreen (where the kit runs the screen): tap a card for its best move, or drag cards where you
 *     want them; the panel's keys (undo, hint, new game, statistics) and DRAW.
 *   bar buttons (where the kit doesn't run the screen): "Next pile", "Move", "Draw", "Undo", "New game".
 *
 * When nothing is hidden any more the cards go up by themselves. The game in progress, the time and the
 * statistics are kept in a file between drives; the clock runs only while the game is on screen and
 * the car stands still.
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
const STATE_FILE = 'solitaire.json';
const GOLD = '#ffd36e', CYAN = '#7fe8ff';
const HINT_MS = 1800, CONFIRM_MS = 3000, FINISH_STEP = 120;
// the 13 places the cursor goes: stock, waste, four foundations, seven columns
const PLACES = [{ k: 's' }, { k: 'w' }].concat([0, 1, 2, 3].map((i) => ({ k: 'f', i }))).concat([0, 1, 2, 3, 4, 5, 6].map((i) => ({ k: 't', i })));

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const clock = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const same = (a, b) => a && b && a.k === b.k && (a.i || 0) === (b.i || 0);

mgu.run({
    async start(ctx) {
        const { ui, settings, dataDir, log } = ctx;
        const parked = parkedWatch(ctx, log);
        const display = ctx.display || null;
        const stateFile = path.join(dataDir, STATE_FILE);
        const S = (k, d) => String(settings.get(k) || d);
        const drawMode = () => (S('draw', '1') === '3' ? 3 : 1);

        const saved = M.loadState(stateFile, log);
        let stats = Object.assign({}, M.STATS, saved.stats || {});
        let game = saved.game && saved.game.tab ? new M.Game({ state: saved.game }) : new M.Game({ draw: drawMode() });

        let visible = false, menu = false, showStats = false;
        let toast = null, toastUntil = 0;
        let pressed = null, pressedAt = 0;
        let cursor = 1;
        let hint = null;               // { move, at }
        let nope = 0;                  // when a press found no move (the cursor shakes)
        let confirmNew = 0;
        let finishAt = 0;              // the auto finish: next step
        let winAt = 0, bouncers = [], launched = 0;
        let drag = null;               // { from, n, ids, dx, dy, x, y, moved }
        let frameT = Date.now(), saveAt = 0;
        // where each card is drawn: id -> { x, y, up, flipAt, wait }
        const pos = new Map();

        function showToast(msg, ms) { toast = msg; toastUntil = Date.now() + (ms || 2500); }
        const own = () => !!(display && display.own && display.own());
        function save() {
            try { M.saveState(stateFile, { game: game.won() ? null : game.toJSON(), stats }); } catch (e) { log.warn('solitaire: not saved: ' + e.message); }
        }
        function syncGrab() { if (ctx.controller) ctx.controller.grab(visible && !menu); }
        const press = (k) => { pressed = k; pressedAt = Date.now(); };
        const playing = () => !game.won() && !showStats;

        /* ---------- where the cards go ---------- */
        /** the places of the cards of tableau column i: [x, y] each (face-up ones spread less when it's long) */
        function columnYs(col) {
            const down = col.filter((c) => !c.up).length, up = col.length - down;
            const room = A.BOTTOM - A.TAB_Y - A.CARD.h;
            const dStep = 9, uStep = up > 1 ? Math.max(11, Math.min(27, (room - down * dStep) / (up - 1))) : 27;
            let y = A.TAB_Y;
            return col.map((c) => { const v = y; y += c.up ? uStep : dStep; return v; });
        }
        /** the target of every card: id -> { x, y, z } (z: drawing order), for the game's layout now */
        function targets() {
            const t = new Map();
            let z = 0;
            const sx = A.colX(0), wx = A.colX(1);
            game.stock.forEach((c, i) => t.set(c.id, { x: sx - Math.floor(i / 8) * 0.6, y: A.TOP_Y - Math.floor(i / 8), z: z++, hidden: i < game.stock.length - 2 }));
            const fan = game.drawN === 3 ? Math.min(3, game.waste.length) : 1;
            game.waste.forEach((c, i) => {
                const k = i - (game.waste.length - fan);
                t.set(c.id, { x: wx + Math.max(0, k) * 20, y: A.TOP_Y, z: z++, hidden: k < -1 });
            });
            game.found.forEach((f, fi) => f.forEach((c, i) => t.set(c.id, { x: A.colX(3 + fi), y: A.TOP_Y, z: z++, hidden: i < f.length - 2 })));
            game.tab.forEach((col, ci) => { const ys = columnYs(col); col.forEach((c, i) => t.set(c.id, { x: A.colX(ci), y: ys[i], z: z++ })); });
            return t;
        }
        /** a new deal: every card leaves the stock in the order a dealer deals them */
        function dealOut(now) {
            pos.clear();
            let k = 0;
            for (let row = 0; row < 7; row++) for (let ci = row; ci < 7; ci++) {
                const c = game.tab[ci][row];
                pos.set(c.id, { x: A.colX(0), y: A.TOP_Y, up: false, flipAt: 0, wait: now + k++ * 45 });
            }
            for (const c of game.stock) pos.set(c.id, { x: A.colX(0), y: A.TOP_Y, up: false, flipAt: 0, wait: 0 });
        }

        /* ---------- actions ---------- */
        function afterMove(now) {
            hint = null;
            for (const ev of game.events.splice(0)) {
                if (ev.type === 'won') won(now);
            }
            if (game.canFinish() && !finishAt) finishAt = now + 500;
            save();
        }
        function won(now) {
            game.score += game.bonus();
            stats = M.record(stats, game, true);
            winAt = now; launched = 0; bouncers = [];
            log.info('solitaire: won in ' + clock(game.ms) + ', ' + game.moves + ' moves, score ' + game.score);
        }
        function guard() {
            if (parked.moving()) { showToast('Parked only: the cards wait until the car stands still'); return false; }
            return true;
        }
        function act(fn, key) {
            if (!guard()) return false;
            if (!playing()) return false;
            menu = false; syncGrab();
            const ok = fn();
            if (key) press(key);
            if (ok) afterMove(Date.now()); else nope = Date.now();
            return ok;
        }
        const draw = () => act(() => game.drawStock(), 'draw');
        const undo = () => act(() => game.undo(), 'undo');
        /** the best move for the pile at the cursor (or tapped): draw on the stock */
        const moveAt = (place, n) => act(() => game.auto(place, n));
        function showHint() {
            if (!playing()) return;
            press('hint');
            const h = game.hint();
            if (!h) { showToast('No moves left: a new game?', 3500); return; }
            hint = { move: h, at: Date.now() };
            const at = h.draw ? 0 : PLACES.findIndex((p) => same(p, h.from));
            if (at >= 0) cursor = at;
        }
        function newGame(force) {
            const now = Date.now();
            press('new');
            if (!force && game.started && !game.won() && now - confirmNew > CONFIRM_MS) { confirmNew = now; showToast('Press NEW GAME again to give this game up', CONFIRM_MS); return; }
            if (game.started && !game.won()) stats = M.record(stats, game, false);
            game = new M.Game({ draw: drawMode() });
            hint = null; finishAt = 0; winAt = 0; bouncers = []; confirmNew = 0; showStats = false; cursor = 1;
            dealOut(now);
            save();
        }
        function toggleStats() { press('stats'); showStats = !showStats; menu = false; syncGrab(); }

        /* ---------- input ---------- */
        ui.onClick('BTN_NEXT', () => { cursor = (cursor + 1) % PLACES.length; });
        ui.onClick('BTN_MOVE', () => (game.won() ? newGame(true) : moveAt(PLACES[cursor])));
        ui.onClick('BTN_DRAW', draw);
        ui.onClick('BTN_UNDO', undo);
        ui.onClick('BTN_NEW', () => newGame(false));

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
            const leave = () => Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('leave: ' + e));
            if (showStats) {
                if (pr || tilt === 'S') { showStats = false; return; }
                if (d) { showStats = false; menu = true; syncGrab(); }
                if (tilt === 'W') leave();
                return;
            }
            if (game.won()) { if (pr) newGame(true); if (tilt === 'W') leave(); return; }
            if (d) { cursor = ((cursor + (d > 0 ? 1 : -1)) % PLACES.length + PLACES.length) % PLACES.length; hint = null; }
            if (pr) { const p = PLACES[cursor]; if (p.k === 's') draw(); else moveAt(p); }
            if (tilt === 'N') undo(); else if (tilt === 'S') showHint(); else if (tilt === 'E') draw(); else if (tilt === 'W') leave();
        });

        /** what's under the finger: { place, n } (n: the cards from the touched one to the top) */
        function hit(x, y) {
            const inCard = (cx, cy) => x >= cx && x < cx + A.CARD.w && y >= cy && y < cy + A.CARD.h;
            if (inCard(A.colX(0), A.TOP_Y)) return { place: { k: 's' }, n: 1 };
            const wx = A.colX(1) + (game.drawN === 3 ? Math.max(0, Math.min(3, game.waste.length) - 1) * 20 : 0);
            if (game.waste.length && x >= A.colX(1) && x < wx + A.CARD.w && y >= A.TOP_Y && y < A.TOP_Y + A.CARD.h) return { place: { k: 'w' }, n: 1 };
            for (let i = 0; i < 4; i++) if (inCard(A.colX(3 + i), A.TOP_Y)) return { place: { k: 'f', i }, n: 1 };
            for (let i = 0; i < 7; i++) {
                if (x < A.colX(i) || x >= A.colX(i) + A.CARD.w) continue;
                const col = game.tab[i], ys = columnYs(col);
                for (let j = col.length - 1; j >= 0; j--) if (y >= ys[j] && y < ys[j] + A.CARD.h) return { place: { k: 't', i }, n: col.length - j, j };
                if (!col.length && inCard(A.colX(i), A.TAB_Y)) return { place: { k: 't', i }, n: 0 };
            }
            return null;
        }
        /** the pile the dragged cards are dropped on (where their middle is) */
        function dropOn(x, y) {
            const cx = x + A.CARD.w / 2, cy = y + 30;
            if (cy < A.TAB_Y - 10 && cx > A.colX(3) - 60) return { k: 'f', i: -1 };                 // a foundation: its suit's (below)
            if (cy < A.TAB_Y - 10) return null;
            let best = null, bd = 1e9;
            for (let i = 0; i < 7; i++) { const d = Math.abs(cx - A.colX(i) - A.CARD.w / 2); if (d < bd) { bd = d; best = { k: 't', i }; } }
            return bd < 74 ? best : null;
        }
        const inRect = (q, x, y) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h;
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            const now = Date.now();
            if (phase === 1) {
                drag = null;
                if (showStats) { if (!inRect(A.KEYS[3], x, y)) showStats = false; drag = { done: true }; return; }
                const ki = A.KEYS.findIndex((q) => inRect(q, x, y));
                if (ki >= 0) { const id = A.KEYS[ki].id; drag = { done: true }; if (id === 'undo') undo(); else if (id === 'hint') showHint(); else if (id === 'new') newGame(false); else toggleStats(); return; }
                if (Math.hypot(x - A.DRAW_BTN.x, y - A.DRAW_BTN.y) < A.DRAW_BTN.r + 12) { drag = { done: true }; draw(); return; }
                if (game.won()) { drag = { done: true }; if (now - winAt > 1200) newGame(true); return; }
                const h = hit(x, y);
                if (!h) return;
                const ci = PLACES.findIndex((p) => same(p, h.place));
                if (ci >= 0) cursor = ci;
                if (h.place.k === 's' || !h.n) { drag = { tap: h, x0: x, y0: y }; return; }
                const cards = game.take(h.place, h.n);
                if (!cards) { drag = { tap: h, x0: x, y0: y }; return; }
                const p0 = pos.get(cards[0].id) || { x, y };
                drag = { from: h.place, n: h.n, ids: cards.map((c) => c.id), dx: x - p0.x, dy: y - p0.y, x0: x, y0: y, tap: h };
                return;
            }
            if (!drag || drag.done) return;
            if (phase === 2 && drag.ids) {
                if (Math.hypot(x - drag.x0, y - drag.y0) > 12) drag.moved = true;
                drag.x = x - drag.dx; drag.y = y - drag.dy;
                return;
            }
            if (phase !== 3) return;
            const d = drag;
            drag = null;
            if (d.moved && d.ids) {
                const to = dropOn(x - d.dx, y - d.dy);
                if (to && to.k === 'f') { const c = game.top(d.from); to.i = c ? M.SUITS.indexOf(c.s) : 0; }
                if (to && guard() && playing() && game.canMove(d.from, d.n, to)) { game.move(d.from, d.n, to); afterMove(now); } else nope = now;
                return;
            }
            const t = d.tap;
            if (!t) return;
            if (t.place.k === 's') draw(); else if (t.n) moveAt(t.place, t.n);
        });

        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            visible = v;
            if (!v) { menu = false; save(); }
            syncGrab();
        });
        visible = !!(ui.isVisible && ui.isVisible('MAIN'));
        syncGrab();
        settings.onChange((k) => {
            if (k !== 'draw') return;
            if (!game.started || game.won()) newGame(true);
            else showToast((drawMode() === 3 ? 'Draw three' : 'Draw one') + ' from the next game on', 3500);
        });

        /* ---------- the clock: time played, the auto finish, the celebration ---------- */
        function advance(now, dt) {
            const going = game.started && !game.won() && visible && !parked.moving() && !showStats && !(display && display.sheet);
            if (going) game.ms += dt;
            if (finishAt && now >= finishAt && !parked.moving()) {
                if (game.canFinish()) {
                    if (game.autoStep()) afterMove(now);
                    finishAt = game.won() ? 0 : now + FINISH_STEP;
                } else finishAt = 0;
            }
            if (now - saveAt > 10000 && game.started) { saveAt = now; save(); }
        }

        /* ---------- drawing ---------- */
        function ease(o, t, dt) { const f = 1 - Math.exp(-dt / 55); o.x += (t.x - o.x) * f; o.y += (t.y - o.y) * f; }
        function drawCard(cv, c, o, back, now) {
            const k = o.flipAt ? (now - o.flipAt) / 260 : 1;
            if (k < 1) A.drawFlip(cv, c, Math.round(o.x), Math.round(o.y), k, back);
            else cv.blit(c.up ? A.cardLayer(c) : A.backLayer(back), o.x, o.y);
        }
        const allCards = () => game.stock.concat(game.waste, ...game.found, ...game.tab);
        function drawCards(cv, now, dt) {
            const back = S('cardBack', 'm'), T = targets(), flying = [], dragged = new Set(drag && drag.moved && drag.ids ? drag.ids : []);
            const cards = allCards().sort((a, b) => T.get(a.id).z - T.get(b.id).z);
            if (!game.stock.length) A.drawRecycle(cv, A.colX(0), A.TOP_Y, game.waste.length > 0);
            for (const c of cards) {
                const t = T.get(c.id);
                let o = pos.get(c.id);
                if (!o) { o = { x: t.x, y: t.y, up: c.up, flipAt: 0, wait: 0 }; pos.set(c.id, o); }
                if (o.up !== c.up) { if (c.up) o.flipAt = now; o.up = c.up; }
                if (dragged.has(c.id)) continue;
                if (!o.wait || now >= o.wait) ease(o, t, dt);
                const far = Math.hypot(o.x - t.x, o.y - t.y) > 3;
                if (far) { flying.push(c); continue; }
                if (t.hidden && !(o.flipAt && now - o.flipAt < 260)) continue;
                drawCard(cv, c, o, back, now);
            }
            // cards on their way (over the rest), then the dragged ones under the finger
            for (const c of flying) drawCard(cv, c, pos.get(c.id), back, now);
            if (dragged.size) {
                drag.ids.forEach((id, i) => {
                    const c = cards.find((q) => q.id === id), o = pos.get(id);
                    o.x = drag.x; o.y = drag.y + i * 26;
                    cv.roundRect(o.x + 6, o.y + 10, A.CARD.w, A.CARD.h, 8, withAlpha('#000000', 0.25));
                    drawCard(cv, c, o, back, now);
                });
            }
        }
        function rectOf(place) {
            if (place.k === 's') return { x: A.colX(0), y: A.TOP_Y, h: A.CARD.h };
            if (place.k === 'w') return { x: A.colX(1) + (game.drawN === 3 ? Math.max(0, Math.min(3, game.waste.length) - 1) * 20 : 0), y: A.TOP_Y, h: A.CARD.h };
            if (place.k === 'f') return { x: A.colX(3 + place.i), y: A.TOP_Y, h: A.CARD.h };
            const col = game.tab[place.i], ys = columnYs(col);
            if (!col.length) return { x: A.colX(place.i), y: A.TAB_Y, h: A.CARD.h };
            return { x: A.colX(place.i), y: ys[ys.length - 1], h: A.CARD.h, top: ys[ys.length - 1] };
        }
        function drawMarks(cv, now) {
            // the hint: the cards to move and where they go, in cyan
            if (hint && now - hint.at < HINT_MS) {
                const a = 0.6 + 0.4 * Math.sin((now - hint.at) / 120);
                if (hint.move.draw) cv.strokeRoundRect(A.colX(0) - 4, A.TOP_Y - 4, A.CARD.w + 8, A.CARD.h + 8, 10, 3, withAlpha(CYAN, a));
                else {
                    const m = hint.move, r = rectOf(m.from);
                    let y0 = r.y;
                    if (m.from.k === 't') { const ys = columnYs(game.tab[m.from.i]); y0 = ys[ys.length - m.n]; }
                    cv.strokeRoundRect(r.x - 4, y0 - 4, A.CARD.w + 8, r.y - y0 + A.CARD.h + 8, 10, 3, withAlpha(CYAN, a));
                    const d = rectOf(m.to);
                    cv.strokeRoundRect(d.x - 4, d.y - 4, A.CARD.w + 8, A.CARD.h + 8, 10, 3, withAlpha(CYAN, a * 0.8));
                    A.glow(cv, d.x + A.CARD.w / 2, d.y + A.CARD.h / 2, 70, CYAN, 0.3 * a);
                }
            } else hint = null;
            // the controller's cursor (where the controller drives), shaking when the press found nothing
            if ((ctx.controller || !own()) && !game.won()) {
                const r = rectOf(PLACES[cursor]), sh = now - nope < 300 ? Math.sin((now - nope) / 20) * 5 : 0;
                const c = now - nope < 300 ? '#ff6a6a' : GOLD;
                cv.strokeRoundRect(r.x - 5 + sh, r.y - 5, A.CARD.w + 10, A.CARD.h + 10, 11, 3, c);
                A.glow(cv, r.x + A.CARD.w / 2 + sh, r.y - 6, 14, c, 0.6);
            }
        }
        /** the celebration: the cards leave the foundations one by one and bounce away, leaving a trail */
        function drawWin(cv, now, dt) {
            if (!winAt) return;
            const s = dt / 1000;
            while (launched < 52 && now - winAt > 400 + launched * 170) {
                const fi = launched % 4, f = game.found[fi], c = f[f.length - 1 - Math.floor(launched / 4)];
                if (c) bouncers.push({ c, x: A.colX(3 + fi), y: A.TOP_Y, vx: (Math.random() < 0.5 ? -1 : 1) * (160 + Math.random() * 260), vy: -120 - Math.random() * 260, trail: [], t: 0 });
                launched++;
            }
            const floor = A.TABLE.y + A.TABLE.h - 16 - A.CARD.h;
            for (const b of bouncers) {
                b.vy += 1500 * s; b.x += b.vx * s; b.y += b.vy * s;
                if (b.y > floor) { b.y = floor; b.vy = -b.vy * 0.78; }
                if (b.y < A.TABLE.y + 14) { b.y = A.TABLE.y + 14; b.vy = Math.abs(b.vy); }
                b.t += dt;
                if (b.t > 40) { b.t = 0; b.trail.push([b.x, b.y]); if (b.trail.length > 12) b.trail.shift(); }
            }
            bouncers = bouncers.filter((b) => b.x > A.TABLE.x - A.CARD.w && b.x < A.TABLE.x + A.TABLE.w);
            // what's left on the foundations
            for (let fi = 0; fi < 4; fi++) {
                const gone = launched > fi ? Math.floor((launched - fi - 1) / 4) + 1 : 0, f = game.found[fi];
                if (gone < 13) cv.blit(A.cardLayer(f[12 - gone]), A.colX(3 + fi), A.TOP_Y);
            }
            cv.clip(A.TABLE.x, A.TABLE.y, A.TABLE.w, A.TABLE.h);
            for (const b of bouncers) {
                for (const [x, y] of b.trail) cv.blit(A.cardLayer(b.c), x, y);
                cv.blit(A.cardLayer(b.c), b.x, b.y);
            }
            cv.noclip();
            // the result
            const t = now - winAt, a = Math.min(1, t / 400), cx = A.TABLE.x + A.TABLE.w / 2, cy = 250;
            cv.alpha(a);
            A.glow(cv, cx, cy, 300, GOLD, 0.45);
            cv.roundRect(cx - 300, cy - 70, 600, 150, 24, withAlpha('#06030a', 0.82));
            cv.strokeRoundRect(cx - 300, cy - 70, 600, 150, 24, 2, GOLD);
            A.outlined(cv, 'YOU WIN!', cx, cy - 8, 56, '#fff3c4', '#a8701a', 3, { spacing: 4, literal: true });
            cv.text('SCORE ' + fmt(game.score) + '  ·  TIME ' + clock(game.ms) + '  ·  ' + game.moves + ' MOVES', cx, cy + 34, 20, '#ffffff', { font: 'bold', align: 'center', spacing: 1.5, literal: true });
            cv.text(own() ? 'Tap for a new game' : 'Press for a new game', cx, cy + 62, 16, withAlpha('#ffffff', 0.6), { align: 'center' });
            for (let i = 0; i < 8; i++) { const ang = i / 8 * Math.PI * 2 + now / 800; A.sparkle(cv, cx + Math.cos(ang) * 330, cy + Math.sin(ang) * 90, 9 + 3 * Math.sin(now / 130 + i), '#fff3c4'); }
            cv.alpha(1);
        }
        function drawPanel(cv, now) {
            cv.blit(A.panelLayer(), A.PANEL.x, A.PANEL.y);
            const lcd = (q, v) => { A.glow(cv, q.x + q.w - 70, q.y + 29, 56, q.color, 0.12); cv.text(v, q.x + q.w - 14, q.y + 44, 38, q.color, { font: 'num', align: 'right', literal: true }); };
            lcd(A.LCD.score, fmt(game.score));
            lcd(A.LCD.time, clock(game.ms));
            lcd(A.LCD.moves, fmt(game.moves));
            const P = A.PANEL;
            const info = (game.drawN === 3 ? 'DRAW THREE' : 'DRAW ONE') + '  ·  STOCK ' + game.stock.length + '  ·  BEST ' + (stats.bestTime ? clock(stats.bestTime * 1000) : '-');
            cv.text(info, P.x + 28, P.y + 218, 15, withAlpha('#ffffff', 0.55), { font: 'bold', spacing: 1.2, literal: true });
            const down = (k) => pressed === k && now - pressedAt < 140;
            A.KEYS.forEach((q, i) => {
                const off = (q.id === 'undo' && (!game.history.length || game.won())) || (q.id === 'hint' && !playing());
                const st = down(q.id) ? 'down' : off ? 'off' : (q.id === 'stats' && showStats) || (q.id === 'new' && now - confirmNew < CONFIRM_MS) ? 'lit' : 'up';
                cv.blit(A.keyLayer(i, st), q.x, q.y);
            });
            const D = A.DRAW_BTN, can = playing() && (game.stock.length || game.waste.length) && !parked.moving();
            cv.blit(A.drawLayer(game.stock.length || !game.waste.length ? 'DRAW' : 'TURN', down('draw') ? 'down' : can ? 'on' : 'off'), D.x - D.r - 2, D.y - D.r - 2);
        }
        function drawHint(cv, touch) {
            const P = A.PANEL;
            const lines = touch ? ['Tap a card: its best move', 'or drag it where you want'] : ['Turn: pile · press: best move', 'Up: undo · down: hint · right: draw'];
            lines.forEach((l, i) => cv.text(l, P.x + 24, P.y + 386 + i * 18, 13, withAlpha('#ffffff', 0.45), { font: 'label' }));
        }
        function drawStatsPage(cv) {
            if (!showStats) return;
            const st = stats;
            A.drawStats(cv, [
                ['GAMES PLAYED', fmt(st.played)],
                ['GAMES WON', fmt(st.won), '#5ff0a6'],
                ['WIN RATE', st.played ? (st.won / st.played * 100).toFixed(1) + ' %' : '-'],
            ], [
                ['BEST TIME', st.bestTime ? clock(st.bestTime * 1000) : '-', GOLD],
                ['BEST SCORE', fmt(st.bestScore), GOLD],
                ['WINNING STREAK  ·  LONGEST', fmt(st.streak) + '  ·  ' + fmt(st.bestStreak)],
            ], 'Klondike  ·  ' + (game.drawN === 3 ? 'draw three' : 'draw one') + '  ·  the waste goes back over as often as you like  ·  undo as far as you like');
        }
        function drawParked(cv) {
            if (!parked.moving() || game.won()) return;
            const cx = A.TABLE.x + A.TABLE.w / 2;
            cv.roundRect(A.TABLE.x + 60, 180, A.TABLE.w - 120, 130, 16, withAlpha('#000000', 0.72));
            cv.text('PARKED ONLY', cx, 242, 52, '#ffb020', { font: 'bold', align: 'center', spacing: 5 });
            cv.text('The cards wait (and the clock too) until the car stands still.', cx, 282, 21, withAlpha('#ffffff', 0.75), { align: 'center' });
        }

        function render() {
            const now = Date.now(), dt = Math.min(100, now - frameT);
            frameT = now;
            advance(now, dt);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear('#07040a');
            A.setTextScale(cv.textScale);
            const touch = !!cv.own || own();
            cv.gradientRect(0, 40, W, H - 40, [[0, '#14100c'], [0.6, '#0a0806'], [1, '#040302']]);
            cv.blit(A.tableLayer(S('felt', 'green')), A.TABLE.x, A.TABLE.y);
            if (!winAt) { drawCards(cv, now, dt); drawMarks(cv, now); }
            drawWin(cv, now, dt);
            drawParked(cv);
            drawPanel(cv, now);
            drawHint(cv, touch);
            drawStatsPage(cv);
            G.frame(cv, t, ['Solitaire'], 0, [toast && now < toastUntil && { text: toast, color: 'accent' }]);
            return ui.image('MAIN_GFX', cv);
        }

        if (!saved.game) dealOut(Date.now());
        ctx.loop('MAIN', 8, render);
        Promise.resolve().then(render).then(() => log.info('Solitaire first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
