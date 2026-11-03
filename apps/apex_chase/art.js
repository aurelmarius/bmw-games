'use strict';
/**
 * Apex Chase's look: a city at night seen from above. Asphalt streets with kerbs and lane marks, blocks
 * of buildings with lit windows and rooftop plant, the charging station with its posts in the middle;
 * the fuel drops glow orange, the NITRO cans blue. The M car is a coupe with the three M stripes on its
 * bonnet, the electric cars are smooth sedans with a glass roof and light bars (no make's badge on any
 * of them). Every car is drawn for each way it can face; the cars, the city and the panel are cached
 * layers, so a frame is mostly blits.
 */
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const M = require('./model');

let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const CELL = 24;
const BOARD = { x: 24, y: 46, w: 1116, h: 462 };
const OX = BOARD.x + (BOARD.w - M.W * CELL) / 2, OY = BOARD.y + (BOARD.h - M.H * CELL) / 2;
const px = (x) => OX + x * CELL + CELL / 2, py = (y) => OY + y * CELL + CELL / 2;   // a cell's centre on the page
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const PLAY_BTN = { x: PANEL.x + 322, y: 446, r: 44 };
const M_STRIPES = ['#81c4ff', '#16588e', '#e7222e'];
const PAINT = { white: ['#f4f6f8', '#b9c0c8'], blue: ['#2a6fd6', '#103a7a'], green: ['#1f8a5a', '#0b4a2e'], red: ['#d4222e', '#7a0a12'], yellow: ['#f2c21a', '#9a6a00'] };
const EV_PAINT = [['#eef2f6', '#9aa3ad'], ['#c81e2a', '#6a0a12'], ['#1f5fc4', '#0a2a66'], ['#3a3e46', '#16181c']];
const ANGLE = { R: 0, D: Math.PI / 2, L: Math.PI, U: -Math.PI / 2 };

/* ---------- light and material helpers (as Lucky Sevens) ---------- */
function gradAt(stops, t) {
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
    return mix(a[1], b[1], b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))));
}
/** a filled convex polygon as a fan of quads (the recorder draws quads only); opaque ones overlap a little */
function poly(cv, pts, c) {
    if (cv.convex) return cv.convex(pts, c);
    const n = pts.length;
    if (n === 4) return cv.quad(pts, c);
    if (n === 3) return cv.quad([pts[0], pts[1], [(pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2], pts[2]], c);
    const opaque = typeof c === 'string' ? c.length === 7 || c.length === 4 : !(c.length > 3 && c[3] < 255);
    const cx = pts.reduce((a, p) => a + p[0], 0) / n, cy = pts.reduce((a, p) => a + p[1], 0) / n;
    for (let i = 0; i < n; i += 2) {
        const q = [[cx, cy], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]];
        if (opaque) {
            const mx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, my = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
            for (const v of q) { const dx = v[0] - mx, dy = v[1] - my, l = Math.hypot(dx, dy) || 1; v[0] += dx / l * 0.7; v[1] += dy / l * 0.7; }
        }
        cv.quad(q, c);
    }
    return cv;
}
function ellipse(cx, cy, rx, ry, n) {
    n = n || 32;
    const p = [];
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    return p;
}
function ball(cv, cx, cy, r, stops, lx, ly) {
    lx = lx === undefined ? -0.35 : lx; ly = ly === undefined ? -0.4 : ly;
    const n = Math.max(8, Math.min(24, Math.round(r * 0.6)));
    for (let i = 0; i <= n; i++) { const t = i / n; cv.circle(cx + lx * r * t * 0.9, cy + ly * r * t * 0.9, Math.max(0.6, r * (1 - t)), gradAt(stops, t)); }
}
function glow(cv, cx, cy, r, c, a) { for (let i = 6; i >= 1; i--) cv.circle(cx, cy, r * i / 6, withAlpha(c, a * (1 - i / 7) * 0.4)); }
function outlined(cv, s, x, y, size, fill, edge, ew, o) {
    o = Object.assign({ font: 'bold', align: 'center' }, o || {});
    if (o.shadow !== false) for (let k = 1; k <= 3; k++) cv.text(s, x + k, y + k * 1.3, size, withAlpha('#000000', 0.25), o);
    for (let a = 0; a < 12; a++) cv.text(s, x + Math.cos(a / 12 * 6.283) * ew, y + Math.sin(a / 12 * 6.283) * ew, size, edge, o);
    cv.text(s, x, y, size, fill, o);
}
function moulding(cv, x, y, w, h, r, width, profile) {
    for (let k = 0; k < width; k++) cv.strokeRoundRect(x + k, y + k, w - 2 * k, h - 2 * k, Math.max(2, r - k), 1.6, gradAt(profile, k / (width - 1)));
}
const GOLD = [[0, '#3a2200'], [0.12, '#a8701a'], [0.3, '#ffe9a8'], [0.42, '#f1c45a'], [0.7, '#8a5a0a'], [0.88, '#d9a23b'], [1, '#2a1800']];
const CHROME = [[0, '#22252b'], [0.2, '#8a919c'], [0.4, '#ffffff'], [0.6, '#9aa2ae'], [0.85, '#3b4049'], [1, '#111216']];

/** a rounded rectangle as a polygon (for shapes that turn with the car) */
function rrPts(x0, y0, x1, y1, r, n) {
    n = n || 4;
    const out = [], cs = [[x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180], [x1 - r, y0 + r, 270]];
    for (const [cx, cy, a0] of cs) for (let i = 0; i <= n; i++) { const a = (a0 + i * 90 / n) * Math.PI / 180; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    return out;
}

/* ---------- the cars: drawn pointing right (+x), turned to face `dir` ---------- */
/**
 * The M car: a coupe, long bonnet, short tail. Length 38, width 19 (x along the car, y across).
 * paint: [top, shade]
 */
function drawMCar(c, cx, cy, dir, paint) {
    const a = ANGLE[dir], ca = Math.cos(a), sa = Math.sin(a);
    const T = (pts) => pts.map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
    const P = (pts, col) => poly(c, T(pts), col);
    P(rrPts(-17, -8, 21, 12, 6), withAlpha('#000000', 0.45));                          // shadow
    for (const wx of [-11, 11]) for (const wy of [-10.5, 7.5]) P(rrPts(wx - 4, wy, wx + 4, wy + 3, 1.2), '#0c0c0e');   // wheels
    P(rrPts(-19, -9.5, 19, 9.5, 6), paint[1]);
    P(rrPts(-18.5, -8.5, 18.5, 8.5, 5.5), paint[0]);
    P(rrPts(-17, -8.5, 17, -5, 3), withAlpha('#ffffff', 0.25));                         // the light on one side
    // the bonnet's stripes, the cabin, the windows
    M_STRIPES.forEach((col, k) => P([[4, -3 + k * 2], [17.5, -3 + k * 2], [17.5, -1.2 + k * 2], [4, -1.2 + k * 2]], col));
    P(rrPts(-10, -7, 4, 7, 3.5), mix(paint[1], '#000000', 0.25));
    P([[-1, -6.5], [5, -5.5], [5, 5.5], [-1, 6.5]], '#0e1a26');                        // windscreen
    P([[-10, -6], [-7, -6.5], [-7, 6.5], [-10, 6]], '#0e1a26');                        // rear window
    P(rrPts(-7, -6.2, -1, 6.2, 2), mix(paint[0], '#000000', 0.15));                    // roof
    P([[0, -5.8], [3.5, -5], [3.5, -3.5], [0, -4]], withAlpha('#ffffff', 0.3));        // glare
    // lights: headlights front, tail lights back, the mirrors
    P([[16.5, -8], [19, -6.5], [19, -4], [16.5, -5]], '#e8f4ff');
    P([[16.5, 8], [19, 6.5], [19, 4], [16.5, 5]], '#e8f4ff');
    P([[-19, -7.5], [-17.5, -8], [-17.5, -4], [-19, -4.5]], '#ff2a3a');
    P([[-19, 7.5], [-17.5, 8], [-17.5, 4], [-19, 4.5]], '#ff2a3a');
    P([[3, -10.5], [5, -10.5], [5, -8.5], [3, -8.5]], paint[1]);
    P([[3, 10.5], [5, 10.5], [5, 8.5], [3, 8.5]], paint[1]);
}
/**
 * An electric car: a smooth sedan, one sweep of glass from windscreen to tail, a light bar across the
 * front and the back. state: 'out' | 'scared' | 'flash' (scared, its time running out)
 */
function drawEV(c, cx, cy, dir, i, state) {
    const a = ANGLE[dir], ca = Math.cos(a), sa = Math.sin(a);
    const T = (pts) => pts.map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
    const P = (pts, col) => poly(c, T(pts), col);
    const scared = state !== 'out', paint = scared ? (state === 'flash' ? ['#e9edf2', '#8a929c'] : ['#2a3140', '#141820']) : EV_PAINT[i];
    P(rrPts(-17, -8, 20, 12, 7), withAlpha('#000000', 0.45));
    for (const wx of [-11, 11]) for (const wy of [-10.5, 7.5]) P(rrPts(wx - 4, wy, wx + 4, wy + 3, 1.2), '#0c0c0e');
    P(rrPts(-18.5, -9.5, 18.5, 9.5, 8), paint[1]);
    P(rrPts(-18, -8.5, 18, 8.5, 7.5), paint[0]);
    P(rrPts(-15, -8.5, 15, -5.5, 3), withAlpha('#ffffff', 0.22));
    // the glass: one dark sweep, a lighter line along it
    P(rrPts(-13, -6.5, 6, 6.5, 5), scared ? '#0a0c10' : '#0c1420');
    P([[-11, -5], [4, -5], [4, -3.6], [-11, -3.6]], withAlpha('#7fb4ff', scared ? 0.08 : 0.2));
    // the light bars
    P([[16, -6.5], [18.2, -5.5], [18.2, 5.5], [16, 6.5]], scared ? '#3a4a5a' : '#eaf6ff');
    P([[-18.2, -5.5], [-16.5, -6.5], [-16.5, 6.5], [-18.2, 5.5]], scared ? '#5a1a1a' : '#ff2a3a');
    if (!scared) P([[17, -1], [18.6, -1], [18.6, 1], [17, 1]], '#7fe8ff');             // a blue light in the front bar
}
/** a flat battery over a scared car (red, blinking in main.js) */
function drawBattery(c, x, y, col) {
    c.roundRect(x - 9, y - 5, 16, 10, 2, '#0a0a0c');
    c.strokeRoundRect(x - 9, y - 5, 16, 10, 2, 1.5, col);
    c.fillRect(x + 7, y - 2.5, 2.5, 5, col);
    c.fillRect(x - 7, y - 3, 3.5, 6, col);
}
/** a car going back to charge: its outline, faint, with a lightning bolt */
function drawGhost(c, cx, cy, dir) {
    const a = ANGLE[dir], ca = Math.cos(a), sa = Math.sin(a);
    const T = (pts) => pts.map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
    poly(c, T(rrPts(-18, -8.5, 18, 8.5, 7.5)), withAlpha('#7fe8ff', 0.18));
    poly(c, T([[16, -6.5], [18.2, -5.5], [18.2, 5.5], [16, 6.5]]), withAlpha('#eaf6ff', 0.8));
    poly(c, [[cx + 1, cy - 9], [cx - 5, cy + 1], [cx, cy + 1]], '#ffe34a');
    poly(c, [[cx, cy - 1], [cx + 5, cy - 1], [cx - 1, cy + 9]], '#ffe34a');
}
const CAR_BOX = 48;
function mCarLayer(dir, paint) { return lay('ac-m|' + dir + '|' + paint, CAR_BOX, CAR_BOX, (c) => drawMCar(c, CAR_BOX / 2, CAR_BOX / 2, dir, PAINT[paint] || PAINT.white)); }
function evLayer(i, dir, state) { return lay('ac-ev|' + i + '|' + dir + '|' + state, CAR_BOX, CAR_BOX, (c) => drawEV(c, CAR_BOX / 2, CAR_BOX / 2, dir, i, state)); }
function ghostLayer(dir) { return lay('ac-ghost|' + dir, CAR_BOX, CAR_BOX, (c) => drawGhost(c, CAR_BOX / 2, CAR_BOX / 2, dir)); }

/* ---------- the city (a cached layer per level's city) ---------- */
const hash = (i, k) => { const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); };
function drawCity(c, grid, colour) {
    const ox = OX - BOARD.x, oy = OY - BOARD.y, W = M.W, H = M.H;
    const wall = (x, y) => y < 0 || y >= H || x < 0 || x >= W || grid[y][x] === '#';
    // the ground: asphalt everywhere, a frame
    c.roundRect(0, 0, BOARD.w, BOARD.h, 16, '#07080b');
    c.card(ox - 6, oy - 6, W * CELL + 12, H * CELL + 12, 10, [[0, '#1c1f26'], [1, '#121419']]);
    for (let k = 0; k < 400; k++) c.fillRect(ox + hash(k, 1) * W * CELL, oy + hash(k, 2) * H * CELL, 1.5, 1.5, withAlpha('#ffffff', 0.04));
    // lane marks along the long streets
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (wall(x, y)) continue;
        const X = ox + x * CELL, Y = oy + y * CELL;
        if (!wall(x - 1, y) && !wall(x + 1, y) && wall(x, y - 1) && wall(x, y + 1) && x % 2 === 0) c.fillRect(X + 6, Y + CELL / 2 - 1, 12, 2, withAlpha('#f4e7b0', 0.16));
        if (!wall(x, y - 1) && !wall(x, y + 1) && wall(x - 1, y) && wall(x + 1, y) && y % 2 === 0) c.fillRect(X + CELL / 2 - 1, Y + 6, 2, 12, withAlpha('#f4e7b0', 0.16));
    }
    // street lamps: a warm pool of light at the crossings
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        if (wall(x, y)) continue;
        const n = [wall(x - 1, y), wall(x + 1, y), wall(x, y - 1), wall(x, y + 1)].filter((b) => !b).length;
        if (n < 3 || (x + y) % 2) continue;
        const X = ox + x * CELL + CELL / 2, Y = oy + y * CELL + CELL / 2;
        for (let k = 4; k >= 1; k--) c.circle(X, Y, k * 7, withAlpha('#ffcc77', 0.022));
    }
    // the blocks: runs of wall cells per row, joined down into rectangles where they line up
    const done = Array.from({ length: H }, () => Array(W).fill(false));
    let bi = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!wall(x, y) || done[y][x] || grid[y][x] !== '#') continue;
        let x1 = x; while (x1 + 1 < W && grid[y][x1 + 1] === '#' && !done[y][x1 + 1]) x1++;
        let y1 = y;
        while (y1 + 1 < H) { let ok = true; for (let k = x; k <= x1; k++) if (grid[y1 + 1][k] !== '#' || done[y1 + 1][k]) ok = false; if (!ok) break; y1++; }
        for (let yy = y; yy <= y1; yy++) for (let k = x; k <= x1; k++) done[yy][k] = true;
        block(c, ox + x * CELL, oy + y * CELL, (x1 - x + 1) * CELL, (y1 - y + 1) * CELL, bi++, y === 0 || y1 === H - 1 || x === 0 || x1 === W - 1, colour);
    }
    // the charging station: a lit floor, posts, its gate
    const sx = ox + 18 * CELL, sy = oy + 9 * CELL;
    c.card(sx - 2, sy - 2, 9 * CELL + 4, CELL + 4, 5, [[0, '#0e2a22'], [1, '#081a14']]);
    for (let k = 0; k < 9; k++) {
        const x = sx + k * CELL + CELL / 2;
        if (k % 2 === 0) { c.roundRect(x - 3, sy + 3, 6, 9, 2, '#d9dde4'); c.roundRect(x - 2, sy + 5, 4, 3, 1, '#5ff0a6'); }
        c.fillRect(x - CELL / 2 + 2, sy + CELL - 4, CELL - 4, 2, withAlpha('#5ff0a6', 0.35));
    }
    const gx = ox + 22 * CELL, gy = oy + 8 * CELL;
    c.fillRect(gx, gy, CELL, CELL, '#0e2a22');
    for (let k = 0; k < 4; k++) c.fillRect(gx + k * 6, gy + CELL / 2 - 2, 3, 4, k % 2 ? '#e7222e' : '#f4f6f8');
    // the tunnels: darkness at the ends of the middle avenue
    for (const tx of [0, W - 5]) c.gradientRect(ox + tx * CELL, oy + 9 * CELL - 2, 5 * CELL, CELL + 4, [[0, withAlpha('#000000', 0.15)], [1, withAlpha('#000000', 0.15)]]);
    c.gradientRect(ox - 6, oy + 9 * CELL - 4, 30, CELL + 8, [[0, '#000000'], [1, '#000000']]);
    c.gradientRect(ox + W * CELL - 24, oy + 9 * CELL - 4, 30, CELL + 8, [[0, '#000000'], [1, '#000000']]);
}
/** a block of buildings: a kerb, roofs of different heights, lit windows, plant on the roofs */
function block(c, x, y, w, h, n, edge, colour) {
    const tone = colour === 'blue' ? ['#232a3a', '#161b27'] : colour === 'warm' ? ['#2e2620', '#1c1612'] : ['#262a33', '#181b22'];
    c.roundRect(x + 1, y + 1, w - 2, h - 2, 4, '#3a3f4c');                               // the kerb
    c.card(x + 3, y + 3, w - 6, h - 6, 3, [[0, tone[0]], [1, tone[1]]]);
    if (edge) return;
    if (hash(n, 9) > 0.78 && w > 40 && h > 40) {
        // a park: grass, a path, trees
        c.card(x + 3, y + 3, w - 6, h - 6, 3, [[0, '#123a22'], [1, '#0b2616']]);
        c.fillRect(x + 3, y + h / 2 - 2, w - 6, 4, withAlpha('#c9b48a', 0.25));
        for (let k = 0; k < Math.floor(w * h / 260); k++) {
            const tx = x + 8 + hash(n * 13 + k, 4) * (w - 16), ty = y + 8 + hash(n * 17 + k, 5) * (h - 16), r = 4 + hash(k, n) * 3;
            c.circle(tx + 1.5, ty + 2, r, withAlpha('#000000', 0.3));
            c.circle(tx, ty, r, '#1f6a3a');
            c.circle(tx - r * 0.3, ty - r * 0.3, r * 0.5, '#2f8a4e');
        }
        return;
    }
    // the roofs: split along the block, each a little different
    const parts = Math.max(1, Math.round(Math.max(w, h) / 64));
    for (let k = 0; k < parts; k++) {
        const along = w >= h, s = (along ? w - 6 : h - 6) / parts;
        const rx = along ? x + 3 + k * s : x + 3, ry = along ? y + 3 : y + 3 + k * s, rw = along ? s : w - 6, rh = along ? h - 6 : s;
        const lift = hash(n * 7 + k, 3);
        c.roundRect(rx + 2, ry + 2, rw - 4, rh - 4, 2, mix(tone[0], '#ffffff', 0.03 + lift * 0.05));
        c.fillRect(rx + 2, ry + rh - 4, rw - 4, 2, withAlpha('#000000', 0.3));
        // windows lit at random, in rows
        for (let wy = ry + 6; wy < ry + rh - 6; wy += 6) for (let wx = rx + 6; wx < rx + rw - 6; wx += 7) {
            const v = hash(wx * 3 + n, wy);
            if (v > 0.72) c.fillRect(wx, wy, 3, 2, withAlpha(v > 0.94 ? '#bfe3ff' : '#ffd88a', 0.25 + v * 0.35));
        }
        if (lift > 0.5 && rw > 30 && rh > 20) { c.roundRect(rx + rw / 2 - 6, ry + rh / 2 - 4, 12, 8, 2, '#3a3f4c'); c.circle(rx + rw / 2, ry + rh / 2, 2.5, '#22252c'); }
    }
}
function cityLayer(n, grid, colour) { return lay('ac-city|' + n + '|' + colour, BOARD.w, BOARD.h, (c) => drawCity(c, grid, colour)); }

/* ---------- drops, nitro, bonus items ---------- */
function dropLayer() { return lay('ac-drop', 16, 16, (c) => { c.circle(8, 8, 6, withAlpha('#ff9a2a', 0.18)); c.circle(8, 8, 3, '#ffb03a'); c.circle(7, 7, 1.2, '#fff1c9'); }); }
function nitroLayer() {
    return lay('ac-nitro', 30, 30, (c) => {
        glow(c, 15, 15, 14, '#36b4ff', 0.7);
        c.card(9, 6, 12, 19, 3, [[0, '#7fd1ff'], [0.5, '#1f6fd6'], [1, '#0a3a8a']]);
        c.roundRect(12, 3, 6, 4, 1.5, '#c3c9d2');
        c.fillRect(9, 13, 12, 4, '#ffffff');
        c.text('N', 15, 16.5, 5, '#0a3a8a', { font: 'bold', align: 'center', literal: true });
        c.fillRect(10, 7, 2, 16, withAlpha('#ffffff', 0.35));
    });
}
function bonusLayer(kind) {
    return lay('ac-bonus|' + kind, 34, 34, (c) => {
        glow(c, 17, 17, 16, '#ffd36e', 0.5);
        if (kind === 'flag') { c.fillRect(9, 6, 2, 22, '#c3c9d2'); for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) c.fillRect(11 + i * 4, 7 + j * 4, 4, 4, (i + j) % 2 ? '#111111' : '#ffffff'); }
        else if (kind === 'cup') { c.card(10, 7, 14, 12, 6, [[0, '#ffe08a'], [1, '#a8701a']]); c.fillRect(15, 19, 4, 5, '#d9a23b'); c.roundRect(11, 24, 12, 4, 1.5, '#a8701a'); c.strokeRoundRect(6, 9, 6, 7, 3, 2, '#d9a23b'); c.strokeRoundRect(22, 9, 6, 7, 3, 2, '#d9a23b'); }
        else if (kind === 'wrench') { poly(c, [[9, 24], [22, 11], [25, 14], [12, 27]], '#c3c9d2'); c.circle(24, 10, 5, '#c3c9d2'); c.circle(26, 8, 2.5, '#07080b'); }
        else if (kind === 'tyre') { c.circle(17, 17, 11, '#141414'); c.circle(17, 17, 6, '#8a919c'); c.circle(17, 17, 2.5, '#d9dde4'); for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; c.line(17 + Math.cos(a) * 8, 17 + Math.sin(a) * 8, 17 + Math.cos(a) * 11, 17 + Math.sin(a) * 11, 1.5, '#2a2a2a'); } }
        else { c.roundRect(9, 8, 16, 10, 4, '#1a1a1e'); c.strokeRoundRect(9, 8, 16, 10, 4, 1.5, '#c3c9d2'); M_STRIPES.forEach((col, k) => c.fillRect(13 + k * 3, 11, 2, 4, col)); c.fillRect(15, 18, 4, 9, '#c3c9d2'); c.fillRect(19, 22, 3, 2, '#c3c9d2'); c.fillRect(19, 25, 3, 2, '#c3c9d2'); }
    });
}

/* ---------- the panel ---------- */
const LCD = {
    score: { x: PANEL.x + 24, y: PANEL.y + 46, w: PANEL.w - 48, label: 'SCORE', color: '#5ff0a6' },
    best: { x: PANEL.x + 24, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'BEST', color: '#ffd36e' },
    level: { x: PANEL.x + 36 + (PANEL.w - 60) / 2, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'LEVEL', color: '#7fd1ff' },
};
function panelLayer() {
    return lay('ac-panel', PANEL.w, PANEL.h, (c) => {
        const ox = -PANEL.x, oy = -PANEL.y, w = PANEL.w, h = PANEL.h;
        c.card(0, 0, w, h, 22, [[0, '#24242c'], [0.5, '#121218'], [1, '#08080b']]);
        for (let i = 0; i < 88; i++) c.fillRect(8, 12 + i * 5, w - 16, 1, withAlpha(i % 3 ? '#ffffff' : '#000000', 0.018));
        moulding(c, 0, 0, w, h, 22, 8, CHROME);
        for (const k of Object.keys(LCD)) {
            const q = LCD[k], x = q.x + ox, y = q.y + oy;
            c.text(q.label, x + 4, y - 9, 16, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2 });
            moulding(c, x - 4, y - 4, q.w + 8, 66, 13, 4, CHROME);
            c.card(x, y, q.w, 58, 10, [[0, '#050608'], [1, '#101318']]);
            c.gradientRect(x + 4, y + 3, q.w - 8, 14, [[0, withAlpha('#ffffff', 0.07)], [1, withAlpha('#ffffff', 0)]]);
            c.text('8888888', x + q.w - 14, y + 44, 38, withAlpha(q.color, 0.035), { font: 'num', align: 'right', literal: true });
        }
        c.text('LIVES', 28, 238, 16, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2 });
        c.text('NITRO', 28, 300, 16, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2 });
        c.roundRect(24, 310, w - 48, 14, 7, '#050608');
        const sx = PLAY_BTN.x + ox, sy = PLAY_BTN.y + oy, r = PLAY_BTN.r;
        c.circle(sx + 4, sy + 7, r + 9, withAlpha('#000000', 0.6));
        ball(c, sx, sy, r + 9, [[0, '#2b2f36'], [0.4, '#8a919c'], [0.8, '#e2e6ec'], [1, '#ffffff']], 0.2, 0.3);
        c.circle(sx, sy, r + 1, '#14040a');
    });
}
/** the round button: START / PAUSE / GO ON / AGAIN (M red), lit or dark, or pressed */
function playLayer(label, state) {
    const r = PLAY_BTN.r, S = 2 * r + 4;
    return lay('ac-play|' + label + '|' + state, S, S, (c) => {
        const cx = S / 2, cy = S / 2 + (state === 'down' ? 2 : 0), rr = state === 'down' ? r - 2 : r, dark = state === 'off';
        ball(c, cx, cy, rr, dark ? [[0, '#200004'], [0.5, '#4a0a12'], [1, '#6a2a30']] : [[0, '#4a0008'], [0.35, '#b0001a'], [0.75, '#ff2a3a'], [1, '#ff8a92']]);
        poly(c, ellipse(cx - rr * 0.12, cy - rr * 0.5, rr * 0.55, rr * 0.24), withAlpha('#ffffff', dark ? 0.12 : 0.3));
        poly(c, ellipse(cx - rr * 0.2, cy - rr * 0.55, rr * 0.25, rr * 0.09), withAlpha('#ffffff', dark ? 0.3 : 0.75));
        outlined(c, label, cx, cy + 8, label.length > 5 ? 17 : 21, dark ? '#a08a8c' : '#fff6f6', '#5a0010', 1.6, { shadow: false });
    });
}
function sparkle(cv, x, y, r, col) {
    poly(cv, [[x, y - r], [x + r * 0.22, y], [x, y + r], [x - r * 0.22, y]], col || '#ffffff');
    poly(cv, [[x - r, y], [x, y - r * 0.22], [x + r, y], [x, y + r * 0.22]], col || '#ffffff');
}

module.exports = {
    setTextScale, CELL, BOARD, OX, OY, px, py, PANEL, PLAY_BTN, LCD, PAINT, EV_PAINT, M_STRIPES, CAR_BOX,
    mCarLayer, evLayer, ghostLayer, cityLayer, dropLayer, nitroLayer, bonusLayer, panelLayer, playLayer,
    drawMCar, drawEV, drawBattery, glow, outlined, sparkle, poly, ellipse,
};
