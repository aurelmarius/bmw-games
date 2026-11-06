'use strict';
/**
 * Street Siege's look: an industrial yard at night seen from above. Asphalt with painted bays, drains
 * and cracks; stacks of race tyres (painted red and white), concrete barriers with hazard stripes, a
 * canal, trees whose crowns hide the cars under them, oil patches with a sheen; the M garage with its
 * striped roof. The cars carry a cannon on the roof: the M car (white with the three stripes), hatchbacks,
 * vans, pick-ups and armoured SUVs (no make's badge on any of them). Each car is drawn for every way it
 * can face; the yard, the trees, the cars and the panel are cached layers (the yard again when a brick
 * is shot away).
 */
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const M = require('./model');

let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const B = 16;                                            // a brick in px
const K = B / 12;                                        // (the cars and tyres were drawn for 12 px bricks)
const BOARD = { x: 24, y: 46, w: 1116, h: 462 };
const OX = BOARD.x + (BOARD.w - M.BW * B) / 2, OY = BOARD.y + (BOARD.h - M.BH * B) / 2;
const bx = (x) => OX + x * B, by = (y) => OY + y * B;     // a brick's corner on the page
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const FIRE_BTN = { x: PANEL.x + 322, y: 446, r: 44 };
const M_STRIPES = ['#81c4ff', '#16588e', '#e7222e'];
const PAINT = { white: ['#f4f6f8', '#b9c0c8'], blue: ['#2a6fd6', '#103a7a'], green: ['#1f8a5a', '#0b4a2e'], red: ['#d4222e', '#7a0a12'], yellow: ['#f2c21a', '#9a6a00'] };
const ENEMY = { hatch: ['#f2c21a', '#8a6a00'], van: ['#e6e8ec', '#8a929c'], pickup: ['#c8202c', '#5a0a10'], suv: ['#2e3a2e', '#141a14'] };
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

function rrPts(x0, y0, x1, y1, r, n) {
    n = n || 4;
    const out = [], cs = [[x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180], [x1 - r, y0 + r, 270]];
    for (const [cx, cy, a0] of cs) for (let i = 0; i <= n; i++) { const a = (a0 + i * 90 / n) * Math.PI / 180; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    return out;
}
const hash = (i, k) => { const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); };

/* ---------- the cars: drawn pointing right (+x), turned to face `dir`; a cannon on the roof ---------- */
/** body shapes by kind: [length/2, width/2, corner radius, cabin from, cabin to] */
const SHAPE = { m: [14, 9, 5, -6, 3], hatch: [12, 8.5, 5, -7, 4], van: [15, 9.5, 3, -2, 10], pickup: [15, 9, 3, 0, 8], suv: [14.5, 10, 3.5, -8, 5] };
function drawCar(c, cx, cy, dir, kind, paint, o) {
    o = o || {};
    const a = ANGLE[dir], ca = Math.cos(a) * K, sa = Math.sin(a) * K;
    const T = (pts) => pts.map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
    const P = (pts, col) => poly(c, T(pts), col);
    const [L, Wd, r, c0, c1] = SHAPE[kind];
    P(rrPts(-L + 1, -Wd + 2, L + 2, Wd + 3, r), withAlpha('#000000', 0.45));          // shadow
    for (const wx of [-L * 0.6, L * 0.6]) for (const wy of [-Wd - 1.2, Wd - 1.8]) P(rrPts(wx - 3.5, wy, wx + 3.5, wy + 3, 1), '#0c0c0e');
    P(rrPts(-L, -Wd, L, Wd, r), paint[1]);
    P(rrPts(-L + 0.6, -Wd + 0.8, L - 0.6, Wd - 0.8, r - 0.5), paint[0]);
    P(rrPts(-L + 2, -Wd + 0.8, L - 2, -Wd + 3, 1.2), withAlpha('#ffffff', 0.22));
    if (kind === 'pickup') { P(rrPts(-L + 1.5, -Wd + 2, -1, Wd - 2, 1.5), mix(paint[1], '#000000', 0.35)); for (let k = 0; k < 3; k++) P([[-L + 3 + k * 4, -Wd + 2.5], [-L + 4 + k * 4, -Wd + 2.5], [-L + 4 + k * 4, Wd - 2.5], [-L + 3 + k * 4, Wd - 2.5]], withAlpha('#000000', 0.25)); }
    if (kind === 'm') M_STRIPES.forEach((col, k) => P([[c1 + 1, -2.4 + k * 1.6], [L - 1, -2.4 + k * 1.6], [L - 1, -1.1 + k * 1.6], [c1 + 1, -1.1 + k * 1.6]], col));
    if (kind === 'suv') { P([[-L + 2, -Wd + 1.5], [L - 2, -Wd + 1.5], [L - 2, -Wd + 2.5], [-L + 2, -Wd + 2.5]], '#5a6a5a'); P([[-L + 2, Wd - 2.5], [L - 2, Wd - 2.5], [L - 2, Wd - 1.5], [-L + 2, Wd - 1.5]], '#5a6a5a'); }
    // the cabin's glass
    P(rrPts(c0, -Wd + 2, c1, Wd - 2, 2), '#0e1a26');
    P(rrPts(c0 + 2, -Wd + 2.6, c1 - 1.5, Wd - 2.6, 1.5), mix(paint[0], '#000000', 0.15));
    // lights
    P([[L - 1.5, -Wd + 1], [L, -Wd + 2.5], [L, -Wd + 4.5], [L - 1.5, -Wd + 4]], '#e8f4ff');
    P([[L - 1.5, Wd - 1], [L, Wd - 2.5], [L, Wd - 4.5], [L - 1.5, Wd - 4]], '#e8f4ff');
    P([[-L, -Wd + 2], [-L + 1.2, -Wd + 1.5], [-L + 1.2, -Wd + 4], [-L, -Wd + 4]], '#ff2a3a');
    P([[-L, Wd - 2], [-L + 1.2, Wd - 1.5], [-L + 1.2, Wd - 4], [-L, Wd - 4]], '#ff2a3a');
    // the roof cannon: a turret and its barrel, forward
    const tx = (c0 + c1) / 2;
    P(ellipse(tx, 0, 4.2, 4.2, 14), '#22252b');
    P(ellipse(tx - 0.6, -0.6, 3, 3, 12), '#4a4f58');
    P([[tx + 2, -1.1], [L + 4, -1.1], [L + 4, 1.1], [tx + 2, 1.1]], '#2a2d33');
    P([[L + 2.5, -1.6], [L + 4.5, -1.6], [L + 4.5, 1.6], [L + 2.5, 1.6]], '#15171b');
    if (o.flash) P(rrPts(-L, -Wd, L, Wd, r), withAlpha('#ff3a3a', 0.45));
}
const CAR_BOX = 58;
function carLayer(kind, dir, paint, variant) {
    // (an SUV hit goes rusty, then scorched)
    const p = kind === 'm' ? PAINT[paint] || PAINT.white : variant === 'hurt' ? ['#5a4630', '#241a10'] : variant === 'hurt2' ? ['#3a2a20', '#140c08'] : ENEMY[kind];
    return lay('ss-car|' + kind + '|' + dir + '|' + paint + '|' + (variant || ''), CAR_BOX, CAR_BOX, (c) => drawCar(c, CAR_BOX / 2, CAR_BOX / 2, dir, kind, p, { flash: variant === 'flash' }));
}

/* ---------- the yard ---------- */
/** each district's ground: its colour and what's painted on it */
const GROUND = {
    yard: [[0, '#3c4049'], [1, '#30333b']],
    docks: [[0, '#565c64'], [1, '#454a52']],
    warehouses: [[0, '#2f3238'], [1, '#26292e']],
    parking: [[0, '#383b41'], [1, '#2c2f34']],
    scrapyard: [[0, '#4a4034'], [1, '#3a3229']],
};
function drawGround(c, level) {
    const W = M.BW * B, H = M.BH * B, ox = OX - BOARD.x, oy = OY - BOARD.y, th = M.theme(level);
    c.roundRect(0, 0, BOARD.w, BOARD.h, 16, '#07080b');
    c.card(ox - 6, oy - 6, W + 12, H + 12, 10, [[0, '#24272e'], [1, '#17191e']]);
    c.card(ox, oy, W, H, 4, GROUND[th]);
    if (th === 'docks') {
        // concrete slabs, a rail track across, yellow safety lines
        for (let x = 0; x < M.BW; x += 4) c.fillRect(ox + x * B, oy, 1, H, withAlpha('#000000', 0.18));
        for (let y = 0; y < M.BH; y += 4) c.fillRect(ox, oy + y * B, W, 1, withAlpha('#000000', 0.18));
        for (const ry of [9, 17]) {
            for (let x = 0; x < W; x += 10) c.fillRect(ox + x, oy + ry * B - 4, 5, 20, '#4a3a2a');
            c.fillRect(ox, oy + ry * B, W, 2.5, '#9aa0a8'); c.fillRect(ox, oy + ry * B + 9, W, 2.5, '#9aa0a8');
        }
        for (let y = 2; y < M.BH - 4; y += 7) c.fillRect(ox + 8, oy + y * B, W - 16, 2, withAlpha('#f2c21a', 0.35));
    } else if (th === 'warehouses') {
        // loading bays: hatched yellow, arrows
        for (let k = 0; k < 10; k++) {
            const x = ox + hash(k, 21 + level) * (W - 90), y = oy + hash(k, 22) * (H - 50);
            c.strokeRoundRect(x, y, 80, 40, 2, 2, withAlpha('#f2c21a', 0.35));
            for (let i = 0; i < 8; i++) c.line(x + 4 + i * 10, y + 36, x + 14 + i * 10, y + 4, 2, withAlpha('#f2c21a', 0.18));
        }
        for (let k = 0; k < 8; k++) { const x = ox + 30 + hash(k, 23 + level) * (W - 60), y = oy + 20 + hash(k, 24) * (H - 40); c.fillRect(x - 2, y, 4, 18, withAlpha('#ffffff', 0.25)); poly(c, [[x - 8, y], [x + 8, y], [x, y - 10]], withAlpha('#ffffff', 0.25)); }
    } else if (th === 'parking') {
        // the bays' white lines in rows, P painted
        for (let row = 1; row < M.BH - 2; row += 6) for (let x = 2; x < M.BW - 2; x += 3) c.fillRect(ox + x * B, oy + row * B, 2, 3 * B, withAlpha('#ffffff', 0.22));
        for (let row = 1; row < M.BH - 2; row += 6) c.fillRect(ox + 2 * B, oy + row * B, W - 4 * B, 2, withAlpha('#ffffff', 0.18));
        for (let k = 0; k < 6; k++) c.text('P', ox + 60 + k * 180, oy + 4 * B + (k % 2) * 12 * B, 28, withAlpha('#ffffff', 0.12), { font: 'bold', align: 'center', literal: true });
    } else if (th === 'scrapyard') {
        // dirt: gravel, tyre tracks, puddles
        for (let k = 0; k < 1800; k++) c.fillRect(ox + hash(k, 31 + level) * W, oy + hash(k, 32) * H, 2, 2, withAlpha(k % 3 ? '#6a5a44' : '#2a2219', 0.45));
        for (let k = 0; k < 7; k++) { const y = oy + hash(k, 33 + level) * H; for (let x = 0; x < W; x += 6) { const yy = y + Math.sin(x * 0.02 + k) * 18; c.fillRect(ox + x, yy, 5, 3, withAlpha('#1e1810', 0.35)); c.fillRect(ox + x, yy + 14, 5, 3, withAlpha('#1e1810', 0.35)); } }
        for (let k = 0; k < 9; k++) { const x = ox + hash(k, 34 + level) * W, y = oy + hash(k, 35) * H; c.circle(x, y, 10 + hash(k, 36) * 14, withAlpha('#1a1d22', 0.6)); c.circle(x - 4, y - 3, 5, withAlpha('#7a8aa8', 0.12)); }
    }
    // light from the yard's lamps: warm pools
    for (let k = 0; k < 6; k++) { const x = ox + (k + 0.5) * W / 6, y = oy + (k % 2 ? H * 0.3 : H * 0.7); for (let i = 12; i >= 1; i--) c.circle(x, y, i * 12, withAlpha('#ffd89a', 0.009)); }
    for (let k = 0; k < 700; k++) c.fillRect(ox + hash(k, 1 + level) * W, oy + hash(k, 2) * H, 1.5, 1.5, withAlpha(k % 3 ? '#ffffff' : '#000000', 0.05));
    // painted bays along the sides, a few cracks, drains
    for (let y = 4; y < M.BH - 6; y += 6) {
        c.fillRect(ox + 6, oy + y * B, 34, 2, withAlpha('#f4e7b0', 0.18));
        c.fillRect(ox + W - 40, oy + y * B, 34, 2, withAlpha('#f4e7b0', 0.18));
    }
    for (let k = 0; k < 18; k++) {
        let x = ox + hash(k, 7 + level) * W, y = oy + hash(k, 8) * H;
        for (let s = 0; s < 4; s++) { const nx = x + (hash(k, s) - 0.5) * 30, ny = y + (hash(s, k) - 0.5) * 30; c.line(x, y, nx, ny, 1, withAlpha('#000000', 0.35)); x = nx; y = ny; }
    }
    for (let k = 0; k < 6; k++) { const x = ox + 40 + hash(k, 11 + level) * (W - 80), y = oy + 30 + hash(k, 12) * (H - 60); c.roundRect(x - 7, y - 4, 14, 8, 2, '#141518'); for (let i = 0; i < 4; i++) c.fillRect(x - 5 + i * 3, y - 3, 1.5, 6, '#2a2c31'); }
    // the way in at the top: a painted gate
    for (const s of M.SPAWNS) { const x = ox + s.x * B, y = oy; c.fillRect(x - 4, y, 2 * B + 8, 3, withAlpha('#ffd36e', 0.35)); }
}
/** the yard's bricks: tyres, concrete, the canal, oil, the garage (layer per level and version) */
function drawBricks(c, grid, garageHp) {
    const ox = OX - BOARD.x, oy = OY - BOARD.y;
    for (let y = 0; y < M.BH; y++) for (let x = 0; x < M.BW; x++) {
        const ch = grid[y][x], X = ox + x * B, Y = oy + y * B;
        if (ch === 'w') {
            c.gradientRect(X, Y, B, B, [[0, '#14507a'], [1, '#0b3556']]);
            if (grid[y - 1] && grid[y - 1][x] !== 'w') c.fillRect(X, Y, B, 2, '#3a4048');
            if (grid[y + 1] && grid[y + 1][x] !== 'w') c.fillRect(X, Y + B - 2, B, 2, '#3a4048');
        } else if (ch === 'c') {
            c.card(X, Y, B, B, 1, [[0, '#9aa0a8'], [1, '#6a7078']]);
            c.fillRect(X, Y, B, 1, withAlpha('#ffffff', 0.35));
            c.fillRect(X + B - 1, Y, 1, B, withAlpha('#000000', 0.3));
            if ((x + y) % 4 === 0) c.quad([[X + 1, Y + B - 1], [X + 4, Y + B - 1], [X + B - 1, Y + 4], [X + B - 1, Y + 1]], withAlpha('#f2c21a', 0.55));
        } else if (ch === 't') {
            // a race tyre seen from above, painted red or white on the stacks' outside rows
            const painted = (x >> 1) % 2 === (y >> 1) % 2;
            const m = B / 2;
            c.circle(X + m + 1.5, Y + m + 2.5, m * 1.08, withAlpha('#000000', 0.5));
            c.circle(X + m, Y + m, m * 1.08, '#0e0e10');
            c.circle(X + m, Y + m, m * 0.88, painted ? '#d4222e' : '#eef0f3');
            c.circle(X + m, Y + m, m * 0.6, '#1a1b1e');
            c.circle(X + m, Y + m, m * 0.36, '#050506');
            c.arc(X + m, Y + m, m * 0.88, m * 1.08, 280, 360, withAlpha('#ffffff', 0.25));
        }
    }
    // oil: one glossy puddle for each patch, a rainbow sheen on it (flat on the ground: nothing like a tyre)
    const oiled = new Set();
    for (let y = 0; y < M.BH; y++) for (let x = 0; x < M.BW; x++) {
        if (grid[y][x] !== 'o' || oiled.has(x + ',' + y)) continue;
        let x0 = x, x1 = x, y0 = y, y1 = y;
        const q = [[x, y]]; oiled.add(x + ',' + y);
        while (q.length) {
            const [a, b2] = q.pop();
            x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b2); y1 = Math.max(y1, b2);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = (a + dx) + ',' + (b2 + dy); if (grid[b2 + dy] && grid[b2 + dy][a + dx] === 'o' && !oiled.has(k)) { oiled.add(k); q.push([a + dx, b2 + dy]); } }
        }
        const cx = ox + (x0 + x1 + 1) * B / 2, cy = oy + (y0 + y1 + 1) * B / 2, rx = (x1 - x0 + 1) * B / 2, ry = (y1 - y0 + 1) * B / 2;
        for (let k = 0; k < 7; k++) {
            const px = cx + (hash(k, x0) - 0.5) * rx, py = cy + (hash(y0, k) - 0.5) * ry, r = Math.min(rx, ry) * (0.45 + hash(k, k + x0) * 0.4);
            poly(c, ellipse(px, py, r * 1.25, r * 0.85, 18), withAlpha('#07070a', 0.55));
        }
        poly(c, ellipse(cx, cy, rx * 0.8, ry * 0.7, 22), withAlpha('#030305', 0.6));
        ['#7a3aff', '#2a9aff', '#2affb0', '#ffd02a', '#ff6a2a'].forEach((col, k) => c.arc(cx - rx * 0.15, cy - ry * 0.1, rx * (0.25 + k * 0.07), rx * (0.25 + k * 0.07) + 1.6, 200 + k * 8, 300 - k * 6, withAlpha(col, 0.35)));
        c.circle(cx - rx * 0.35, cy - ry * 0.3, 2, withAlpha('#ffffff', 0.35));
    }
    // fences: posts and a mesh you can see (and shoot) through
    for (let y = 0; y < M.BH; y++) for (let x = 0; x < M.BW; x++) {
        if (grid[y][x] !== 'n') continue;
        const X = ox + x * B, Y = oy + y * B, across = grid[y][x - 1] === 'n' || grid[y][x + 1] === 'n';
        for (let i = 0; i < 4; i++) {
            if (across) { c.line(X + i * 4, Y + 4, X + i * 4 + 4, Y + 12, 0.8, withAlpha('#c9d0da', 0.55)); c.line(X + i * 4 + 4, Y + 4, X + i * 4, Y + 12, 0.8, withAlpha('#c9d0da', 0.55)); }
            else { c.line(X + 4, Y + i * 4, X + 12, Y + i * 4 + 4, 0.8, withAlpha('#c9d0da', 0.55)); c.line(X + 12, Y + i * 4, X + 4, Y + i * 4 + 4, 0.8, withAlpha('#c9d0da', 0.55)); }
        }
        if (across) { c.fillRect(X, Y + 3, B, 1.5, '#9aa0a8'); c.fillRect(X, Y + 12, B, 1.5, '#9aa0a8'); } else { c.fillRect(X + 3, Y, 1.5, B, '#9aa0a8'); c.fillRect(X + 12, Y, 1.5, B, '#9aa0a8'); }
        if ((across ? x : y) % 2 === 0) { c.circle(X + 8 + 1, Y + 8 + 2, 2.6, withAlpha('#000000', 0.4)); c.circle(X + 8, Y + 8, 2.4, '#5a616c'); c.circle(X + 7.4, Y + 7.4, 1, '#c9d0da'); }
    }
    // pallets: stacks of planks
    for (let y = 0; y < M.BH; y++) for (let x = 0; x < M.BW; x++) {
        if (grid[y][x] !== 'p') continue;
        const X = ox + x * B, Y = oy + y * B, v = hash(x, y) < 0.5;
        c.fillRect(X + 2, Y + 3, B - 1, B - 1, withAlpha('#000000', 0.45));
        c.fillRect(X + 0.5, Y + 0.5, B - 1, B - 1, '#7a5a32');
        for (let i = 0; i < 3; i++) v ? c.fillRect(X + 1.5 + i * 5, Y + 1, 3.5, B - 2, mix('#c89a5a', '#a07040', hash(i, x + y))) : c.fillRect(X + 1, Y + 1.5 + i * 5, B - 2, 3.5, mix('#c89a5a', '#a07040', hash(i, x + y)));
        c.fillRect(X + 0.5, Y + 0.5, B - 1, 1, withAlpha('#ffffff', 0.25));
    }
    // containers, warehouses, wrecks: each block drawn whole
    const seen = new Set();
    for (let y = 0; y < M.BH; y++) for (let x = 0; x < M.BW; x++) {
        const ch = grid[y][x];
        if (!'khx'.includes(ch) || seen.has(x + ',' + y)) continue;
        let x0 = x, x1 = x, y0 = y, y1 = y;
        const q = [[x, y]]; seen.add(x + ',' + y);
        while (q.length) {
            const [a, b] = q.pop();
            x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = (a + dx) + ',' + (b + dy); if (grid[b + dy] && grid[b + dy][a + dx] === ch && !seen.has(k)) { seen.add(k); q.push([a + dx, b + dy]); } }
        }
        const X = ox + x0 * B, Y = oy + y0 * B, w = (x1 - x0 + 1) * B, h = (y1 - y0 + 1) * B, along = w >= h;
        if (ch === 'h') drawWarehouse(c, X, Y, w, h, along);
        else if (ch === 'k') { const n = Math.max(1, Math.round((along ? w : h) / (6 * B))), rows = Math.max(1, Math.round((along ? h : w) / (2 * B))); for (let i = 0; i < n; i++) for (let r = 0; r < rows; r++) { const L = (along ? w : h) / n, S = (along ? h : w) / rows; drawContainer(c, along ? X + i * L : X + r * S, along ? Y + r * S : Y + i * L, along ? L : S, along ? S : L, along, hash(x0 + i * 7 + r, y0)); } }
        else { const n = Math.max(1, Math.round((along ? w : h) / (4 * B))), rows = Math.max(1, Math.round((along ? h : w) / (2 * B))); for (let i = 0; i < n; i++) for (let r = 0; r < rows; r++) { const L = (along ? w : h) / n, S = (along ? h : w) / rows; drawWreck(c, along ? X + i * L : X + r * S, along ? Y + r * S : Y + i * L, along ? L : S, along ? S : L, along, hash(x0 + i * 5, y0 + r)); } }
    }
    // the garage: walls, a striped roof, its door to the yard; damaged: scorched
    const gx = ox + M.BASE.x * B, gy = oy + M.BASE.y * B, gw = M.BASE.w * B, gh = M.BASE.h * B;
    c.roundRect(gx + 2, gy + 3, gw, gh, 4, withAlpha('#000000', 0.5));
    c.card(gx, gy, gw, gh, 4, [[0, '#d9dde4'], [1, '#8a919c']]);
    c.card(gx + 3, gy + 3, gw - 6, gh - 12, 3, [[0, '#2a2d33'], [1, '#16181c']]);
    M_STRIPES.forEach((col, k) => c.fillRect(gx + 8 + k * 6, gy + 6, 5, gh - 18, col));
    c.text('M', gx + gw - 12, gy + 22, 14, '#e9edf2', { font: 'bold', align: 'center', literal: true });
    c.fillRect(gx + 6, gy + gh - 8, gw - 12, 6, '#3a3f48');
    for (let k = 0; k < 4; k++) c.fillRect(gx + 7, gy + gh - 7 + k * 1.5, gw - 14, 0.6, withAlpha('#ffffff', 0.2));
    if (garageHp < M.GARAGE_HP) {
        for (let k = 0; k < (M.GARAGE_HP - garageHp) * 5; k++) c.circle(gx + 6 + hash(k, 3) * (gw - 12), gy + 6 + hash(k, 4) * (gh - 12), 3 + hash(k, 5) * 4, withAlpha('#000000', 0.45));
    }
}
/** a shipping container from above: ribbed steel, its doors at one end */
function drawContainer(c, X, Y, w, h, along, k) {
    const col = ['#b8322a', '#2a6aa8', '#2f8a5a', '#d48a1a', '#6a6f78', '#e2e4e8', '#7a3a8a'][Math.floor(k * 7)];
    c.fillRect(X + 4, Y + 5, w - 2, h - 2, withAlpha('#000000', 0.5));
    c.card(X + 1, Y + 1, w - 2, h - 2, 1.5, [[0, mix(col, '#ffffff', 0.18)], [1, mix(col, '#000000', 0.25)]]);
    for (let i = 4; i < (along ? w : h) - 4; i += 4) along ? c.fillRect(X + i, Y + 2, 1.2, h - 4, withAlpha('#000000', 0.22)) : c.fillRect(X + 2, Y + i, w - 4, 1.2, withAlpha('#000000', 0.22));
    if (along) { c.fillRect(X + w - 5, Y + 2, 2, h - 4, withAlpha('#000000', 0.35)); c.fillRect(X + 1, Y + 1, w - 2, 1.5, withAlpha('#ffffff', 0.3)); } else { c.fillRect(X + 2, Y + h - 5, w - 4, 2, withAlpha('#000000', 0.35)); c.fillRect(X + 1, Y + 1, 1.5, h - 2, withAlpha('#ffffff', 0.3)); }
    for (const [cx, cy] of [[X + 3, Y + 3], [X + w - 3, Y + 3], [X + 3, Y + h - 3], [X + w - 3, Y + h - 3]]) c.fillRect(cx - 1.5, cy - 1.5, 3, 3, mix(col, '#000000', 0.5));
}
/** a warehouse from above: a ridged roof, skylights, vents */
function drawWarehouse(c, X, Y, w, h, along) {
    c.fillRect(X + 6, Y + 8, w, h, withAlpha('#000000', 0.5));
    c.card(X, Y, w, h, 2, [[0, '#8a929c'], [1, '#5a616c']]);
    if (along) { c.gradientRect(X + 2, Y + 2, w - 4, h / 2 - 2, [[0, '#a0a8b2'], [1, '#7a828c']]); c.fillRect(X + 2, Y + h / 2 - 1, w - 4, 2, '#4a515c'); }
    else { c.fillRect(X + w / 2 - 1, Y + 2, 2, h - 4, '#4a515c'); c.fillRect(X + 2, Y + 2, w / 2 - 3, h - 4, withAlpha('#ffffff', 0.12)); }
    for (let i = 10; i < (along ? w : h) - 10; i += 22) {
        if (along) { c.roundRect(X + i, Y + 5, 12, h / 2 - 9, 2, withAlpha('#9ad0ff', 0.4)); c.circle(X + i + 6, Y + h * 0.75, 3, '#3a3f48'); }
        else { c.roundRect(X + 5, Y + i, w / 2 - 9, 12, 2, withAlpha('#9ad0ff', 0.4)); c.circle(X + w * 0.75, Y + i + 6, 3, '#3a3f48'); }
    }
    c.strokeRoundRect(X, Y, w, h, 2, 1.5, '#3a3f48');
}
/** an abandoned car from above: faded paint, rust, broken glass, a wheel gone */
function drawWreck(c, X, Y, w, h, along, k) {
    const paint = [['#8a5a3a', '#4a2a1a'], ['#5a6a7a', '#2a3440'], ['#8a8a6a', '#4a4a3a'], ['#6a2a2a', '#3a1414'], ['#4a5a4a', '#202a20']][Math.floor(k * 5)];
    const L = (along ? w : h) - 6, S = (along ? h : w) - 8, cx = X + w / 2, cy = Y + h / 2;
    const R = (lx, ly) => (along ? [cx + lx, cy + ly] : [cx + ly, cy + lx]);
    const rect = (x0, y0, x1, y1, col) => { const a = R(x0, y0), b = R(x1, y1); c.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), col); };
    rect(-L / 2 + 2, -S / 2 + 3, L / 2 + 2, S / 2 + 3, withAlpha('#000000', 0.45));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) if (!(sx === 1 && sy === 1 && k > 0.5)) rect(sx * L * 0.3 - 3, sy * S / 2 - 1.5, sx * L * 0.3 + 3, sy * S / 2 + 1.5, '#0c0c0e');
    rect(-L / 2, -S / 2, L / 2, S / 2, paint[1]);
    rect(-L / 2 + 1, -S / 2 + 1, L / 2 - 1, S / 2 - 1, paint[0]);
    rect(-L * 0.12, -S / 2 + 2, L * 0.22, S / 2 - 2, '#1a2026');
    rect(-L * 0.05, -S / 2 + 3, L * 0.08, S / 2 - 3, withAlpha('#c8dcff', 0.25));
    for (let i = 0; i < 6; i++) { const p = R((hash(i, k) - 0.5) * L * 0.9, (hash(k, i) - 0.5) * S * 0.8); c.circle(p[0], p[1], 1.5 + hash(i, i + k) * 2.5, withAlpha(i % 2 ? '#7a3a14' : '#2a1a10', 0.7)); }
}
function groundLayer(level) { return lay('ss-ground|' + level, BOARD.w, BOARD.h, (c) => drawGround(c, level)); }
function bricksLayer(level, version, grid, hp) { return lay('ss-bricks|' + level + '|' + version + '|' + hp, BOARD.w, BOARD.h, (c) => drawBricks(c, grid, hp)); }
/** the trees' crowns, over the cars */
function treesLayer(level, grid) {
    return lay('ss-trees|' + level, BOARD.w, BOARD.h, (c) => {
        const ox = OX - BOARD.x, oy = OY - BOARD.y;
        for (let y = 0; y < M.BH; y += 2) for (let x = 0; x < M.BW; x += 2) {
            if (grid[y][x] !== 'f') continue;
            const X = ox + x * B + B, Y = oy + y * B + B;
            c.circle(X + 3, Y + 4, 20, withAlpha('#000000', 0.35));
            c.circle(X, Y, 20, '#1a4a2a');
            for (let k = 0; k < 6; k++) c.circle(X + (hash(x * 7 + k, y) - 0.5) * 22, Y + (hash(y * 5 + k, x) - 0.5) * 22, 8 + hash(k, x + y) * 4, k % 2 ? '#2a6a3a' : '#22603a');
            c.circle(X - 7, Y - 7, 5, withAlpha('#6ab07a', 0.35));
        }
    });
}

/* ---------- power-ups ---------- */
const POWER = {
    star: { label: 'CANNON', c: ['#ffd36e', '#a8701a'] }, shield: { label: 'SHIELD', c: ['#7fd1ff', '#1f5fc4'] },
    nitro: { label: 'NITRO', c: ['#7fe8ff', '#1f6fd6'] }, fortify: { label: 'FORTRESS', c: ['#c3c9d2', '#5a6068'] },
    life: { label: '+1 CAR', c: ['#5ff0a6', '#0f8f52'] }, emp: { label: 'EMP', c: ['#c99bff', '#6a33c4'] },
};
function powerLayer(kind) {
    return lay('ss-power|' + kind, 34, 34, (c) => {
        const p = POWER[kind].c;
        glow(c, 17, 17, 17, p[0], 0.6);
        c.card(4, 4, 26, 26, 7, [[0, p[0]], [1, p[1]]]);
        c.strokeRoundRect(4, 4, 26, 26, 7, 1.5, '#ffffff');
        const w = '#ffffff';
        if (kind === 'star') { const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 4 : 9; pts.push([17 + Math.cos(a) * r, 17 + Math.sin(a) * r]); } for (let i = 0; i < 10; i++) poly(c, [[17, 17], pts[i], pts[(i + 1) % 10]], w); }
        else if (kind === 'shield') { poly(c, [[10, 10], [24, 10], [24, 18], [17, 26], [10, 18]], w); poly(c, [[13, 12], [21, 12], [21, 17.5], [17, 22], [13, 17.5]], p[1]); }
        else if (kind === 'nitro') { c.roundRect(12, 9, 10, 17, 3, w); c.roundRect(14.5, 6.5, 5, 3, 1, w); c.fillRect(12, 15, 10, 3, p[1]); }
        else if (kind === 'fortify') { for (let r = 0; r < 3; r++) for (let k = 0; k < 2; k++) c.fillRect(9 + k * 8 + (r % 2) * 4, 10 + r * 5, 7, 4, w); }
        else if (kind === 'life') { c.roundRect(9, 13, 16, 9, 3, w); c.roundRect(12, 10, 10, 5, 2, w); c.circle(12.5, 23, 2.2, p[1]); c.circle(21.5, 23, 2.2, p[1]); }
        else { poly(c, [[19, 7], [11, 18], [16, 18], [14, 27], [23, 15], [18, 15]], w); }
    });
}

/* ---------- the panel ---------- */
const LCD = {
    score: { x: PANEL.x + 24, y: PANEL.y + 46, w: PANEL.w - 48, label: 'SCORE', color: '#5ff0a6' },
    best: { x: PANEL.x + 24, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'BEST', color: '#ffd36e' },
    level: { x: PANEL.x + 36 + (PANEL.w - 60) / 2, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'LEVEL', color: '#7fd1ff' },
};
function panelLayer() {
    return lay('ss-panel', PANEL.w, PANEL.h, (c) => {
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
        c.text('CARS TO STOP', 28, 236, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2 });
        c.text('LIVES', 28, 318, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2 });
        c.text('GARAGE', 168, 318, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2 });
        const sx = FIRE_BTN.x + ox, sy = FIRE_BTN.y + oy, r = FIRE_BTN.r;
        c.circle(sx + 4, sy + 7, r + 9, withAlpha('#000000', 0.6));
        ball(c, sx, sy, r + 9, [[0, '#2b2f36'], [0.4, '#8a919c'], [0.8, '#e2e6ec'], [1, '#ffffff']], 0.2, 0.3);
        c.circle(sx, sy, r + 1, '#14040a');
    });
}
function fireLayer(label, state) {
    const r = FIRE_BTN.r, S = 2 * r + 4;
    return lay('ss-fire|' + label + '|' + state, S, S, (c) => {
        const cx = S / 2, cy = S / 2 + (state === 'down' ? 2 : 0), rr = state === 'down' ? r - 2 : r, dark = state === 'off';
        ball(c, cx, cy, rr, dark ? [[0, '#200004'], [0.5, '#4a0a12'], [1, '#6a2a30']] : [[0, '#4a0008'], [0.35, '#b0001a'], [0.75, '#ff2a3a'], [1, '#ff8a92']]);
        poly(c, ellipse(cx - rr * 0.12, cy - rr * 0.5, rr * 0.55, rr * 0.24), withAlpha('#ffffff', dark ? 0.12 : 0.3));
        poly(c, ellipse(cx - rr * 0.2, cy - rr * 0.55, rr * 0.25, rr * 0.09), withAlpha('#ffffff', dark ? 0.3 : 0.75));
        outlined(c, label, cx, cy + 8, label.length > 5 ? 17 : 21, dark ? '#a08a8c' : '#fff6f6', '#5a0010', 1.6, { shadow: false });
    });
}
/** a small enemy silhouette for the panel's count */
function iconLayer() { return lay('ss-icon', 18, 14, (c) => { c.roundRect(2, 3, 14, 8, 3, '#8a929c'); c.roundRect(5, 1, 7, 12, 2, '#8a929c'); c.circle(9, 7, 2, '#2a2d33'); }); }
function houseLayer(on) { return lay('ss-house|' + on, 26, 22, (c) => { const col = on ? '#5ff0a6' : '#3a3f48'; poly(c, [[3, 10], [13, 2], [23, 10]], col); c.fillRect(5, 10, 16, 10, col); c.fillRect(11, 14, 4, 6, '#101318'); }); }
function sparkle(cv, x, y, r, col) {
    poly(cv, [[x, y - r], [x + r * 0.22, y], [x, y + r], [x - r * 0.22, y]], col || '#ffffff');
    poly(cv, [[x - r, y], [x, y - r * 0.22], [x + r, y], [x, y + r * 0.22]], col || '#ffffff');
}

module.exports = {
    setTextScale, B, BOARD, OX, OY, bx, by, PANEL, FIRE_BTN, LCD, PAINT, ENEMY, POWER, CAR_BOX, M_STRIPES,
    carLayer, groundLayer, bricksLayer, treesLayer, powerLayer, panelLayer, fireLayer, iconLayer, houseLayer,
    glow, outlined, sparkle, poly, ellipse,
};
