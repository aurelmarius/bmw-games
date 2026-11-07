'use strict';
/**
 * Ridge Duel's look: hills at dusk seen from the side. A sky going from night blue to the sunset's orange
 * with stars, the moon and thin clouds; far ridges with a town's lights; the ground in layers of earth and
 * rock with grass on top, scorched where a shell went off; dark firs. The cars are real silhouettes
 * (cars.js); their guns are drawn per frame. The panel: health, angle and power, the shells, FIRE.
 *
 * The sky, the ground (again after every crater), each car at its tilt, the panel and its keys are
 * cached layers.
 */
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const M = require('./model');
const CARS = require('./cars');

let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);
const { gradAt, convex } = CARS;

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const BOARD = { x: 24, y: 46, w: M.W, h: M.H };
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const FIRE_BTN = { x: PANEL.x + 336, y: PANEL.y + 398, r: 44 };
const DRIVE_BTNS = [{ x: PANEL.x + 22, y: PANEL.y + 368, w: 84, h: 56, dir: -1 }, { x: PANEL.x + 114, y: PANEL.y + 368, w: 84, h: 56, dir: 1 }];
const TILES = M.ORDER.map((k, i) => ({ kind: k, x: PANEL.x + 22 + i * 94, y: PANEL.y + 262, w: 86, h: 64 }));
const M3 = ['#81c4ff', '#16588e', '#e7222e'];
const CHROME = [[0, '#22252b'], [0.2, '#8a919c'], [0.4, '#ffffff'], [0.6, '#9aa2ae'], [0.85, '#3b4049'], [1, '#111216']];
const PAINTS = {
    blue: ['#7fb0ff', '#3f7fe0', '#1f56b4', '#0c2a5c'],
    white: ['#ffffff', '#e9edf2', '#b9c0c8', '#5a6270'],
    black: ['#6a7280', '#2a2e35', '#16181c', '#08090b'],
    grey: ['#d9dfe7', '#9aa2ae', '#5f6672', '#2a2e35'],
    green: ['#8ad8a8', '#2f9a64', '#17603c', '#08301c'],
    red: ['#ff9a9a', '#d4222e', '#8a0a12', '#40050a'],
    yellow: ['#ffe9a0', '#f2b81a', '#a8740a', '#4a3204'],
};
const SHELL_C = { standard: '#ffffff', cluster: '#ffd23a', bouncer: '#5ff0a6', heavy: '#e7222e' };
const hash = (i, k) => { const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); };

function moulding(cv, x, y, w, h, r, width) {
    for (let k = 0; k < width; k++) cv.strokeRoundRect(x + k, y + k, w - 2 * k, h - 2 * k, Math.max(2, r - k), 1.6, gradAt(CHROME, k / (width - 1)));
}
function ball(cv, cx, cy, r, stops, lx, ly) {
    lx = lx === undefined ? -0.35 : lx; ly = ly === undefined ? -0.4 : ly;
    const n = Math.max(6, Math.min(18, Math.round(r * 0.6)));
    for (let i = 0; i <= n; i++) { const t = i / n; cv.circle(cx + lx * r * t * 0.9, cy + ly * r * t * 0.9, Math.max(0.6, r * (1 - t)), gradAt(stops, t)); }
}
function glow(cv, cx, cy, r, c, a) { for (let i = 7; i >= 1; i--) cv.circle(cx, cy, r * i / 7, withAlpha(c, a * 0.18)); }
function outlined(cv, s, x, y, size, fill, edge, ew, o) {
    o = Object.assign({ font: 'bold', align: 'center', literal: true }, o || {});
    for (let a = 0; a < 12; a++) cv.text(s, x + Math.cos(a / 12 * 6.283) * ew, y + Math.sin(a / 12 * 6.283) * ew, size, edge, o);
    cv.text(s, x, y, size, fill, o);
}

/* ---------- the sky ---------- */
function skyLayer() {
    return lay('rd-sky', BOARD.w, BOARD.h, (c) => {
        const W = BOARD.w, H = BOARD.h;
        c.roundRect(0, 0, W, H, 16, '#0a1230');
        for (let y = 0; y < H; y += 2) c.fillRect(0, y, W, 2, gradAt([[0, '#0a1230'], [0.35, '#1e2a5a'], [0.6, '#6a3a6a'], [0.8, '#e0704a'], [1, '#ffb060']], y / H));
        for (let i = 0; i < 150; i++) { const y = hash(i, 2) * 190; c.circle(hash(i, 1) * W, y, 0.6 + hash(i, 3) * 0.9, withAlpha('#ffffff', 0.25 + 0.55 * (1 - y / 190) * hash(i, 4))); }
        glow(c, 900, 66, 72, '#fff2d0', 0.24);
        c.circle(900, 66, 22, '#f6ecd2'); c.circle(894, 60, 5, withAlpha('#c8bc9a', 0.6)); c.circle(908, 72, 3.5, withAlpha('#c8bc9a', 0.5));
        const cloud = (x, y, w, a) => { for (let k = 0; k < 5; k++) c.roundRect(x - w / 2 + hash(k, x) * 40, y + k * 5, w - hash(x, k) * 80, 3 + hash(k, k) * 3, 2, withAlpha('#ffc8a8', a)); };
        cloud(240, 164, 300, 0.12); cloud(620, 194, 360, 0.1); cloud(980, 144, 260, 0.1); cloud(400, 114, 200, 0.06);
        const ridge = (base, amp, f, ph, col) => { for (let x = 0; x < W; x += 2) { const h = base + Math.sin(x * f + ph) * amp + Math.sin(x * f * 2.7 + ph * 2) * amp * 0.35; c.fillRect(x, h, 2, H - h, col); } };
        ridge(250, 26, 0.006, 1, '#3a2a4a');
        for (let i = 0; i < 80; i++) c.fillRect(360 + hash(i, 9) * 440, 268 + hash(i, 8) * 30, 2, 2, withAlpha(i % 3 ? '#ffd9a0' : '#ffffff', 0.65));
        ridge(290, 20, 0.009, 4, '#2a1e34');
    });
}

/* ---------- the ground: a gradient column for every x, grass on top, strata, firs ---------- */
function groundLayer(g, round) {
    // (under the ground's own id: a new match, or a round played again, starts at round 1 / the same round)
    return lay('rd-ground|' + g.ground.id + '|' + g.ground.ver, BOARD.w, BOARD.h, (c) => {
        const gr = g.ground, H = BOARD.h;
        const STOPS = [[0, '#5a4630'], [0.18, '#4a3824'], [0.5, '#33261a'], [1, '#1e160f']];
        for (let x = 0; x < BOARD.w; x++) {
            const h = gr.h[x];
            c.gradientRect(x, h, 1, H - h, STOPS);
        }
        // strata: wavy layers of rock, only under the surface
        for (let k = 0; k < 6; k++) {
            const base = 330 + k * 26 + (round * 7) % 13;
            for (let x = 0; x < BOARD.w; x += 3) {
                const y = base + Math.sin(x * 0.012 + k * 1.7 + round) * 12 + Math.sin(x * 0.041 + k) * 3;
                if (y > gr.h[x] + 7) c.fillRect(x, y, 3.5, 3, withAlpha('#8a6a46', 0.12));
            }
        }
        for (let i = 0; i < 260; i++) { const x = Math.floor(hash(i, 3 + round) * BOARD.w), y = gr.h[x] + 8 + hash(i, 4) * (H - gr.h[x] - 10); c.fillRect(x, y, 2, 2, withAlpha('#9a8a72', 0.35)); }
        // grass, lit from the sunset on the left; scorched earth where shells went off
        for (let x = 0; x < BOARD.w; x++) {
            const h = gr.h[x], sl = (gr.h[Math.min(BOARD.w - 1, x + 2)] - gr.h[Math.max(0, x - 2)]) / 4;
            if (gr.burnt[x]) { c.fillRect(x, h, 1, 5, '#16110c'); if (hash(x, 9) < 0.3) c.fillRect(x, h + 5, 1, 3, withAlpha('#3a2a1a', 0.8)); continue; }
            c.fillRect(x, h, 1, 5, mix('#3a6a2a', '#7aa04a', Math.max(0, Math.min(1, 0.5 - sl))));
            if (hash(x, 5 + round) < 0.3) c.fillRect(x, h - 2, 1, 2, '#4a7a30');
        }
        // firs standing on the ground (gone where it burnt)
        for (let i = 0; i < 9; i++) {
            const x = Math.floor(30 + hash(i, round) * (BOARD.w - 60)), s = 0.7 + hash(round, i) * 0.6;
            if (gr.burnt[x] || Math.abs(x - g.cars[0].x) < 60 || Math.abs(x - g.cars[1].x) < 60) continue;
            const y = gr.h[x];
            c.fillRect(x - 1, y - 10 * s, 2, 10 * s + 2, '#1a120c');
            convex(c, [[x, y - 36 * s], [x + 10 * s, y - 8 * s], [x - 10 * s, y - 8 * s]], '#14241a');
            convex(c, [[x, y - 44 * s], [x + 7 * s, y - 22 * s], [x - 7 * s, y - 22 * s]], '#18301e');
        }
        // round the board's corners
        for (const [cx, cy] of [[16, 16], [BOARD.w - 16, 16], [16, H - 16], [BOARD.w - 16, H - 16]]) for (let i = -16; i <= 16; i++) for (let j = -16; j <= 16; j++) {
            const px = cx + i, py = cy + j;
            if ((cx < 100) !== (px < cx) || (cy < 100) !== (py < cy)) continue;
            if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) > 16 && px >= 0 && px < BOARD.w && py >= 0 && py < H && py >= gr.h[px]) c.fillRect(px, py, 1, 1, '#050608');
        }
    });
}

/* ---------- the cars: a layer for each tilt (2 degree steps) ---------- */
const CAR_BOX = { w: 132, h: 76, ox: 66, oy: 62 };
function carLayer(body, paint, ang) {
    const q = Math.round(ang * 180 / Math.PI / 2) * 2;
    return lay('rd-car|' + body + '|' + paint + '|' + q, CAR_BOX.w, CAR_BOX.h, (c) => {
        const o = { x: CAR_BOX.ox, y: CAR_BOX.oy, a: q * Math.PI / 180, s: M.BODIES[body].scale, flip: body === 'pickup' };
        if (body === 'pickup') CARS.pickup(c, Object.assign({ stripe: '#c4161e' }, o));
        else CARS[body](c, Object.assign({ paint: PAINTS[paint] || PAINTS.blue }, o));
    });
}
/** a car where the model has it, its gun turned to its aim */
function drawCar(cv, car, paint, flash) {
    const x = BOARD.x + car.x, y = BOARD.y + car.y;
    cv.blit(carLayer(car.body, paint, car.a), x - CAR_BOX.ox, y - CAR_BOX.oy);
    // the gun: a low dome on its mount and the barrel
    const g = car.gun(), px = BOARD.x + g.px, py = BOARD.y + g.py, s = car.spec.scale, ca = Math.cos(car.a), sa = Math.sin(car.a);
    const red = car.body === 'pickup';
    const R = (lx, ly) => [px + lx * ca - ly * sa, py + lx * sa + ly * ca];
    convex(cv, [R(-24 * s, 8 * s), R(24 * s, 8 * s), R(18 * s, 3 * s), R(-18 * s, 3 * s)], '#2a2d33');
    const bw = 3.2 * s, L = car.spec.barrel;
    const B = (d, w) => [px + g.dx * d - g.dy * w, py + g.dy * d + g.dx * w];
    convex(cv, [B(0, -bw), B(L, -bw * 0.8), B(L, bw * 0.8), B(0, bw)], '#3a3e46');
    convex(cv, [B(0, -bw * 0.4), B(L, -bw * 0.4), B(L, 0), B(0, 0)], withAlpha('#ffffff', 0.18));
    convex(cv, [B(L - 7 * s, -bw * 1.3), B(L + 1, -bw * 1.3), B(L + 1, bw * 1.3), B(L - 7 * s, bw * 1.3)], '#16181c');
    const dome = []; for (let i = 0; i <= 10; i++) { const t = Math.PI * i / 10; dome.push(R(Math.cos(t) * 15 * s, 3 * s - Math.sin(t) * 15 * s)); }
    convex(cv, dome, red ? '#6a1218' : '#4a4f58');
    convex(cv, [R(-6 * s, -8 * s), R(4 * s, -8 * s), R(4 * s, -5 * s), R(-6 * s, -5 * s)], withAlpha('#ffffff', 0.25));
    if (flash) glow(cv, x, y - car.spec.height / 2, car.spec.half * 0.9, '#ff5a3a', 0.5);
}
/** the health bar over a car */
function drawHealth(cv, car) {
    const x = BOARD.x + car.x - 26, y = BOARD.y + car.y - car.spec.height - 30, k = car.hp / car.spec.hp;
    cv.roundRect(x, y, 52, 7, 3.5, withAlpha('#000000', 0.55));
    if (k > 0) cv.roundRect(x + 1, y + 1, 50 * k, 5, 2.5, k > 0.5 ? '#5ff0a6' : k > 0.25 ? '#ffd23a' : '#e7222e');
}
/** a shell in flight */
function drawShell(cv, s) {
    const x = BOARD.x + s.x, y = BOARD.y + s.y, a = Math.atan2(s.vy, s.vx), c = Math.cos(a), n = Math.sin(a);
    glow(cv, x, y, s.kind === 'heavy' ? 26 : 18, '#ffb040', 0.45);
    const r = s.kind === 'heavy' ? 1.5 : s.child ? 0.75 : 1;
    const P = (lx, ly) => [x + (lx * c - ly * n) * r, y + (lx * n + ly * c) * r];
    convex(cv, [P(-7, -3), P(5, -3), P(9, 0), P(5, 3), P(-7, 3)], '#e2e6ec');
    convex(cv, [P(-7, -3), P(-4, -3), P(-4, 3), P(-7, 3)], SHELL_C[s.kind]);
    cv.circle(x, y, 1.6, '#ffffff');
}
/** the wind on a flag: a pole on the ground in the middle, the cloth blown its way */
function drawFlag(cv, g, now) {
    const gx = Math.round(BOARD.w / 2), x = BOARD.x + gx, y = BOARD.y + g.ground.h[gx];
    cv.fillRect(x - 1, y - 58, 2, 58, '#c9d0da');
    const w = g.wind, len = 8 + Math.abs(w) * 1.6, dir = w < 0 ? -1 : 1, droop = 14 - Math.min(12, Math.abs(w) * 0.6);
    const pts = [];
    for (let i = 0; i <= 6; i++) { const t = i / 6, wave = Math.sin(now / 160 + t * 5) * 2.2 * t; pts.push([x + dir * len * t, y - 58 + droop * t * t + wave]); }
    for (let i = 0; i < 6; i++) {
        const a = pts[i], b = pts[i + 1], col = i % 2 ? '#ffffff' : '#e7222e';
        convex(cv, [a, b, [b[0], b[1] + 10 - i * 0.6], [a[0], a[1] + 10 - (i - 1) * 0.6]], col);
    }
}

/* ---------- the panel ---------- */
function panelLayer() {
    return lay('rd-panel', PANEL.w, PANEL.h, (c) => {
        const ox = -PANEL.x, oy = -PANEL.y, w = PANEL.w, h = PANEL.h;
        c.card(0, 0, w, h, 22, [[0, '#24242c'], [0.5, '#121218'], [1, '#08080b']]);
        for (let i = 0; i < 88; i++) c.fillRect(8, 12 + i * 5, w - 16, 1, withAlpha(i % 3 ? '#ffffff' : '#000000', 0.018));
        moulding(c, 0, 0, w, h, 22, 8);
        // the angle and power readouts
        for (const k of [0, 1]) {
            const x = 24 + k * 190, y = 140, lw = 176;
            c.text(k ? 'POWER' : 'ANGLE', x + 4, y - 9, 15, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, literal: true });
            moulding(c, x - 4, y - 4, lw + 8, 62, 13, 4);
            c.card(x, y, lw, 54, 10, [[0, '#050608'], [1, '#101318']]);
            c.gradientRect(x + 4, y + 3, lw - 8, 12, [[0, withAlpha('#ffffff', 0.07)], [1, withAlpha('#ffffff', 0)]]);
            c.text('888%', x + lw - 14, y + 39, 32, withAlpha(k ? '#ffd36e' : '#81c4ff', 0.04), { font: 'num', align: 'right', literal: true });
        }
        c.text('SHELL', 26, 250, 15, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, literal: true });
        c.text('DRIVE', 26, 362, 13, withAlpha('#ffffff', 0.5), { font: 'label', spacing: 2, literal: true });
        const sx = FIRE_BTN.x + ox, sy = FIRE_BTN.y + oy, r = FIRE_BTN.r;
        c.circle(sx + 4, sy + 7, r + 9, withAlpha('#000000', 0.6));
        ball(c, sx, sy, r + 9, [[0, '#2b2f36'], [0.4, '#8a919c'], [0.8, '#e2e6ec'], [1, '#ffffff']], 0.2, 0.3);
        c.circle(sx, sy, r + 1, '#14040a');
    });
}
function fireLayer(label, state) {
    const r = FIRE_BTN.r, S = 2 * r + 4;
    return lay('rd-fire|' + label + '|' + state, S, S, (c) => {
        const cx = S / 2, cy = S / 2 + (state === 'down' ? 2 : 0), rr = state === 'down' ? r - 2 : r, dark = state === 'off';
        ball(c, cx, cy, rr, dark ? [[0, '#200004'], [0.5, '#4a0a12'], [1, '#6a2a30']] : [[0, '#4a0008'], [0.35, '#b0001a'], [0.75, '#ff2a3a'], [1, '#ff8a92']]);
        const e = []; for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; e.push([cx - rr * 0.12 + Math.cos(a) * rr * 0.55, cy - rr * 0.5 + Math.sin(a) * rr * 0.24]); }
        convex(c, e, withAlpha('#ffffff', dark ? 0.12 : 0.3));
        outlined(c, label, cx, cy + 7, label.length > 5 ? 15 : 20, dark ? '#a08a8c' : '#fff6f6', '#5a0010', 1.5);
    });
}
function tileLayer(kind, state, count) {
    const T = TILES[0];
    return lay('rd-tile|' + kind + '|' + state + '|' + count, T.w + 4, T.h + 4, (c) => {
        const col = SHELL_C[kind], on = state === 'on', empty = state === 'empty';
        c.roundRect(2, 2, T.w, T.h, 10, on ? withAlpha(col, 0.18) : withAlpha('#ffffff', 0.05));
        c.strokeRoundRect(2, 2, T.w, T.h, 10, on ? 2 : 1, on ? col : withAlpha('#ffffff', 0.15));
        const x = 2, y = 2, ic = empty ? withAlpha(col, 0.25) : col;
        if (kind === 'cluster') for (let s = 0; s < 3; s++) c.circle(x + 31 + s * 12, y + 24, 4.5, ic);
        else if (kind === 'heavy') c.circle(x + 43, y + 24, 9, ic);
        else if (kind === 'bouncer') { c.circle(x + 43, y + 24, 6, ic); c.arc(x + 43, y + 30, 12, 14, 250, 470, withAlpha(ic, 0.6)); } else convex(c, [[x + 33, y + 21], [x + 49, y + 21], [x + 55, y + 24], [x + 49, y + 27], [x + 33, y + 27]], ic);
        c.text(M.SHELLS[kind].label, x + 43, y + 52, 11, empty ? withAlpha('#ffffff', 0.3) : '#ffffff', { font: 'bold', align: 'center', spacing: 0.5, literal: true });
        c.text(count === Infinity ? '' : String(count), x + 78, y + 15, 12, withAlpha('#ffffff', empty ? 0.3 : 0.7), { font: 'bold', align: 'right', literal: true });
    });
}
function driveLayer(dir, state) {
    const B = DRIVE_BTNS[0];
    return lay('rd-drive|' + dir + '|' + state, B.w + 4, B.h + 6, (c) => {
        const d = state === 'down' ? 2 : 0, off = state === 'off';
        c.roundRect(4, 6, B.w - 2, B.h - 2, 12, withAlpha('#000000', 0.5));
        c.card(2, 2 + d, B.w, B.h - d, 12, [[0, '#323944'], [1, '#161a21']]);
        c.strokeRoundRect(2, 2 + d, B.w, B.h - d, 12, 1.5, withAlpha('#ffffff', 0.2));
        const cx = 2 + B.w / 2, cy = 2 + d + B.h / 2, col = off ? withAlpha('#ffffff', 0.25) : '#f4f7fb';
        convex(c, dir < 0 ? [[cx - 16, cy], [cx + 8, cy - 13], [cx + 8, cy + 13]] : [[cx + 16, cy], [cx - 8, cy - 13], [cx - 8, cy + 13]], col);
    });
}

/* ---------- the garage: the two cars side by side, what each is good at, the paint ---------- */
const CARDS = [{ body: 'sedan', x: 44, y: 112, w: 520, h: 314 }, { body: 'suv', x: 600, y: 112, w: 520, h: 314 }];
const SWATCHES = Object.keys(PAINTS).map((p, i, all) => ({ paint: p, x: BOARD.x + BOARD.w / 2 - (all.length - 1) * 23 + i * 46 + 40, y: 462, r: 14 }));
const TAGS = { sedan: ['AGILE', 'Drives almost twice as far in a turn; low and narrow, harder to hit. No armour.'], suv: ['ARMOURED', 'Takes 20 % less damage, climbs steep slopes, fires over hills. Drives less.'] };
/** five pips for each of what a car is good at (out of the two of ours) */
function carStats(body) {
    const B = M.BODIES[body], area = (b) => M.BODIES[b].half * M.BODIES[b].height;
    const minArea = Math.min(area('sedan'), area('suv')), maxGun = Math.max(-M.BODIES.sedan.gun[1], -M.BODIES.suv.gun[1]);
    return [
        ['MOBILITY', Math.round(B.fuel / M.BODIES.sedan.fuel * 5), B.fuel + ' m a turn'],
        ['ARMOUR', Math.round(B.armour / 0.25 * 5), B.armour ? Math.round(B.armour * 100) + ' % off the damage' : 'none'],
        ['CLIMBING', Math.round(B.climb / 1.4 * 5), Math.round(Math.atan(B.climb) * 180 / Math.PI) + ' degree slopes'],
        ['HARD TO HIT', Math.round(minArea / area(body) * 5), body === 'sedan' ? 'low and narrow' : 'tall'],
        ['GUN HEIGHT', Math.round(-B.gun[1] / maxGun * 5), body === 'sedan' ? 'low' : 'high: over the hills'],
    ];
}
function bigCarLayer(body, paint) {
    return lay('rd-big|' + body + '|' + paint, 250, 124, (c) => CARS[body](c, { x: 125, y: 112, a: 0, s: 1, paint: PAINTS[paint] || PAINTS.blue }));
}
function drawGarage(cv, pick, now, touch) {
    cv.roundRect(BOARD.x, BOARD.y, BOARD.w, BOARD.h, 16, withAlpha('#05060a', 0.78));
    outlined(cv, 'CHOOSE YOUR CAR', BOARD.x + BOARD.w / 2, BOARD.y + 36, 26, '#ffffff', '#05060a', 2, { spacing: 4 });
    cv.text(touch ? 'Turn or push left / right: the car  ·  push up / down: the paint  ·  press: drive out' : 'Aim up / down: the car  ·  Start: drive out', BOARD.x + BOARD.w / 2, BOARD.y + 58, 13, withAlpha('#ffffff', 0.55), { align: 'center', literal: true });
    for (const C of CARDS) {
        const on = pick.body === C.body, x = BOARD.x + C.x, y = BOARD.y + C.y - 46;
        if (on) for (let k = 6; k >= 1; k--) cv.roundRect(x - k * 2, y - k * 2, C.w + k * 4, C.h + k * 4, 18 + k * 2, withAlpha('#81c4ff', 0.03 + 0.012 * Math.sin(now / 260)));
        cv.card(x, y, C.w, C.h, 16, on ? [[0, '#1c2534'], [1, '#0c1018']] : [[0, '#15171c'], [1, '#0a0b0e']]);
        cv.strokeRoundRect(x, y, C.w, C.h, 16, on ? 2 : 1, on ? '#81c4ff' : withAlpha('#ffffff', 0.12));
        // the car on a turntable
        const cx = x + C.w / 2;
        for (let k = 0; k < 4; k++) { const e = []; for (let i = 0; i < 28; i++) { const t = i / 28 * Math.PI * 2; e.push([cx + Math.cos(t) * (150 - k * 8), y + 128 + Math.sin(t) * (14 - k)]); } convex(cv, e, k === 0 ? withAlpha('#81c4ff', on ? 0.25 : 0.08) : withAlpha('#000000', 0.25)); }
        cv.blit(bigCarLayer(C.body, pick.paint), cx - 125, y + 12);
        // its name, what it is, its numbers
        cv.text(M.BODIES[C.body].label, x + 24, y + 166, 22, on ? '#ffffff' : withAlpha('#ffffff', 0.6), { font: 'bold', spacing: 2, literal: true });
        const tag = TAGS[C.body][0], tw = cv.textWidth(tag, 13, { font: 'bold', spacing: 2, literal: true }) + 22;
        cv.roundRect(x + C.w - 24 - tw, y + 148, tw, 24, 12, withAlpha(C.body === 'sedan' ? '#5ff0a6' : '#ffd36e', on ? 0.22 : 0.08));
        cv.text(tag, x + C.w - 24 - tw / 2, y + 165, 13, C.body === 'sedan' ? '#5ff0a6' : '#ffd36e', { font: 'bold', spacing: 2, align: 'center', literal: true });
        carStats(C.body).forEach(([n, v, t], i) => {
            const ry = y + 182 + i * 22;
            cv.text(n, x + 24, ry + 12, 12, withAlpha('#ffffff', 0.6), { font: 'label', spacing: 1, literal: true });
            for (let k = 0; k < 5; k++) cv.roundRect(x + 150 + k * 30, ry + 3, 26, 9, 3, k < v ? (on ? '#81c4ff' : withAlpha('#81c4ff', 0.45)) : withAlpha('#ffffff', 0.08));
            cv.text(t, x + 312, ry + 12, 12, withAlpha('#ffffff', on ? 0.7 : 0.45), { font: 'label', literal: true });
        });
        cv.text(TAGS[C.body][1], x + 24, y + C.h - 14, 12, withAlpha('#ffffff', on ? 0.6 : 0.35), { font: 'label', literal: true });
    }
    // the paint
    cv.text('PAINT', SWATCHES[0].x - 34, BOARD.y + SWATCHES[0].y - 46 + 5, 13, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, align: 'right', literal: true });
    for (const S of SWATCHES) {
        const x = S.x, y = BOARD.y + S.y - 46, on = pick.paint === S.paint, P = PAINTS[S.paint];
        if (on) cv.arc(x, y, S.r + 3, S.r + 6, 0, 360, '#ffffff');
        ball(cv, x, y, S.r, [[0, P[3]], [0.5, P[1]], [1, P[0]]]);
    }
}

module.exports = {
    CARDS, SWATCHES, carStats, drawGarage, bigCarLayer,
    setTextScale, BOARD, PANEL, FIRE_BTN, DRIVE_BTNS, TILES, PAINTS, SHELL_C, M3,
    skyLayer, groundLayer, carLayer, drawCar, drawHealth, drawShell, drawFlag, panelLayer, fireLayer, tileLayer, driveLayer, glow, outlined, ball, convex,
};
