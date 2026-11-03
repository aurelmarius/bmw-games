'use strict';
/**
 * M Pinball's look: the whole table seen in perspective from where the player stands, so it all fits on
 * the wide screen. A deep blue playfield with the three stripes across it and a fine carbon weave; chrome
 * rails, wheels for bumpers, slingshots in white plastic, standup targets, lamps under clear inserts that
 * glow when lit; the CHICANE ramp in clear blue plastic with red and white kerbs and its wire return;
 * the cabinet's side rails with their LED strips. The panel: a dot-matrix display, the M-POWER lamps,
 * the balls, the plunger's power, NUDGE and LAUNCH.
 *
 * The table, the ramp, every lamp lit, the panel and the display's frames are cached layers; per frame
 * only the flippers, the balls, the plunger and the effects are drawn.
 */
const { Canvas, withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const M = require('./model');

let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const BOARD = { x: 24, y: 46, w: 1116, h: 462 };
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const DMD = { x: PANEL.x + 20, y: PANEL.y + 20, cols: 94, rows: 43, pitch: 4 };
DMD.w = DMD.cols * DMD.pitch; DMD.h = DMD.rows * DMD.pitch;
const LAUNCH_BTN = { x: PANEL.x + 336, y: PANEL.y + 400, r: 46 };
const NUDGE_BTN = { x: PANEL.x + 22, y: PANEL.y + 366, w: 150, h: 68 };
const POWER_BAR = { x: PANEL.x + 196, y: PANEL.y + 366, w: 64, h: 68 };
const ZONES = [{ x: 36, y: 400, w: 172, h: 96 }, { x: 956, y: 400, w: 172, h: 96 }];
const M3 = ['#81c4ff', '#16588e', '#e7222e'];
const CHROME = [[0, '#22252b'], [0.2, '#8a919c'], [0.4, '#ffffff'], [0.6, '#9aa2ae'], [0.85, '#3b4049'], [1, '#111216']];
const STEEL = [[0, '#1e2228'], [0.3, '#6d7684'], [0.62, '#d9dfe7'], [0.85, '#ffffff'], [1, '#ffffff']];

/* ---------- the perspective: table (u, v) -> page (x, y) ---------- */
const K = 0.42, SB = 1.18, HS = 448, BY = 506, CX = 582;
let OFF = [0, 0];                                 // subtracted while drawing into a layer (or the shake)
let SHIFT = [0, 0];
/** the table shaken by a nudge: what's drawn per frame moves by (x, y) */
function setShift(x, y) { SHIFT = [-x, -y]; OFF = SHIFT; }
function P(u, v) {
    const q = (M.TL - v) / M.TL, den = 1 + K * q;
    return [CX + (u - M.TW / 2) * SB / den - OFF[0], BY - HS * q * (1 + K) / den - OFF[1]];
}
const S = (v) => SB / (1 + K * (M.TL - v) / M.TL);
const W = (pts) => pts.map(([u, v]) => P(u, v));
function circW(u, v, r, n) { const o = []; n = n || 28; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; o.push([u + Math.cos(a) * r, v + Math.sin(a) * r]); } return o; }

/* ---------- helpers ---------- */
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
const fillW = (cv, pts, c) => poly(cv, W(pts), c);
function lineW(cv, u0, v0, u1, v1, w, c) { const a = P(u0, v0), b = P(u1, v1); cv.line(a[0], a[1], b[0], b[1], w * S((v0 + v1) / 2), c); }
function glowW(cv, u, v, r, c, a, n) { n = n || 7; for (let i = n; i >= 1; i--) fillW(cv, circW(u, v, r * i / n, 24), withAlpha(c, a * 0.2)); }
function textW(cv, s, u, v, size, c, o) { const p = P(u, v); cv.text(s, p[0], p[1], size * S(v), c, Object.assign({ align: 'center', font: 'bold', literal: true }, o || {})); }
function hull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
}
function ball(cv, cx, cy, r, stops, lx, ly) {
    lx = lx === undefined ? -0.35 : lx; ly = ly === undefined ? -0.4 : ly;
    const n = Math.max(6, Math.min(16, Math.round(r * 0.6)));
    for (let i = 0; i <= n; i++) { const t = i / n; cv.circle(cx + lx * r * t * 0.9, cy + ly * r * t * 0.9, Math.max(0.6, r * (1 - t)), gradAt(stops, t)); }
}
function glow(cv, cx, cy, r, c, a) { for (let i = 6; i >= 1; i--) cv.circle(cx, cy, r * i / 6, withAlpha(c, a * (1 - i / 7) * 0.4)); }
function moulding(cv, x, y, w, h, r, width, profile) {
    for (let k = 0; k < width; k++) cv.strokeRoundRect(x + k, y + k, w - 2 * k, h - 2 * k, Math.max(2, r - k), 1.6, gradAt(profile, k / (width - 1)));
}
function outlined(cv, s, x, y, size, fill, edge, ew, o) {
    o = Object.assign({ font: 'bold', align: 'center', literal: true }, o || {});
    for (let a = 0; a < 12; a++) cv.text(s, x + Math.cos(a / 12 * 6.283) * ew, y + Math.sin(a / 12 * 6.283) * ew, size, edge, o);
    cv.text(s, x, y, size, fill, o);
}
const hash = (i, k) => { const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); };

/* ---------- the lamps: an insert in the playfield each, drawn dark in the table and lit on top ---------- */
const LAMPS = {};
const lamp = (id, o) => { LAMPS[id] = Object.assign({ id, r: 14 }, o); };
M.LANES.forEach((u, i) => lamp('lane' + i, { u, v: 160, shape: 'round', c: '#ffd23a', text: String(i + 1), r: 15 }));
M.LANES.forEach((u, i) => lamp('skill' + i, { u, v: 160, shape: 'round', c: '#ff3a44', text: String(i + 1), r: 15, hidden: true }));
M.TARGETS.forEach((t, i) => lamp('letter' + i, { u: t.u + t.face[0] * 44, v: t.v + t.face[1] * 42, shape: 'round', c: '#81c4ff', text: t.letter, ts: 13 }));
['2X', '3X', '4X', '5X'].forEach((s, i) => lamp('mult' + i, { u: 205 + i * 48, v: 860, shape: 'diamond', c: '#ffd23a', text: s, r: 18 }));
[0, 1, 2].forEach((i) => lamp('pit' + i, { u: 112 + i * 9, v: 628 + i * 36, shape: 'chevron', c: '#ff8a1a', dir: [-0.25, -1] }));
lamp('extra', { u: 160, v: 575, shape: 'pill', c: '#5ff0a6', text: 'EXTRA', r: 13 });
[0, 1, 2].forEach((i) => lamp('ramp' + i, { u: 420, v: 652 + i * 38, shape: 'chevron', c: '#ff3a44', dir: [0, -1] }));
lamp('jackpot', { u: 420, v: 784, shape: 'pill', c: '#ffd23a', text: 'JACKPOT', r: 14 });
lamp('again', { u: 277.5, v: 1126, shape: 'round', c: '#ff3a44', r: 13 });
[0, 1, 2, 3].forEach((i) => lamp('shoot' + i, { u: 577.5, v: 1030 - i * 64, shape: 'chevron', c: '#ffd23a', dir: [0, -1], r: 11 }));

function drawInsert(cv, L, lit) {
    const { u, v, r } = L;
    const base = lit ? L.c : mix(L.c, '#06102a', 0.78);
    if (L.shape === 'round') {
        fillW(cv, circW(u, v, r + 2.5, 28), '#c9d0da');
        fillW(cv, circW(u, v, r, 28), base);
        fillW(cv, circW(u - r * 0.3, v - r * 0.35, r * 0.35, 14), withAlpha('#ffffff', lit ? 0.5 : 0.08));
    } else if (L.shape === 'diamond') {
        fillW(cv, [[u, v - r - 3], [u + r + 3, v], [u, v + r + 3], [u - r - 3, v]], '#c9d0da');
        fillW(cv, [[u, v - r], [u + r, v], [u, v + r], [u - r, v]], base);
    } else if (L.shape === 'pill') {
        const w = 34;
        const pts = hull(circW(u - w, v, r, 18).concat(circW(u + w, v, r, 18)));
        fillW(cv, hull(circW(u - w, v, r + 2.5, 18).concat(circW(u + w, v, r + 2.5, 18))), '#c9d0da');
        fillW(cv, pts, base);
    } else if (L.shape === 'chevron') {
        const [du, dv] = L.dir, l = Math.hypot(du, dv), fu = du / l, fv = dv / l, su = -fv, sv = fu, a = r * 1.25, b = r * 0.9;
        const tip = [u + fu * a, v + fv * a], lft = [u - fu * b + su * a, v - fv * b + sv * a], rgt = [u - fu * b - su * a, v - fv * b - sv * a], mid = [u - fu * b * 0.1, v - fv * b * 0.1];
        fillW(cv, [tip, lft, mid], base); fillW(cv, [tip, mid, rgt], base);
    }
    if (L.text) textW(cv, L.text, u, v + r * 0.42, L.ts || (L.shape === 'pill' ? 13 : L.text.length > 1 ? 13 : 17), lit ? '#140c00' : mix(L.c, '#06102a', 0.45));
}
/** a lit lamp: its glow and the bright insert, in a layer of its own; returns { L, x, y } to blit */
function lampLayer(id) {
    const L = LAMPS[id], g = L.r * 2.6;
    const a = P(L.u - g, L.v - g), b = P(L.u + g, L.v + g);
    const x = Math.floor(Math.min(a[0], P(L.u - g, L.v + g)[0])), y = Math.floor(a[1]);
    const w = Math.ceil(Math.max(b[0], P(L.u + g, L.v - g)[0]) - x) + 2, h = Math.ceil(b[1] - y) + 2;
    const layer = lay('pb-lamp|' + id, w, h, (c) => {
        OFF = [x, y];
        glowW(c, L.u, L.v, g, L.c, 0.55);
        drawInsert(c, L, true);
        OFF = SHIFT;
    });
    return { L: layer, x, y };
}

/* ---------- the table ---------- */
function drawCabinet(c) {
    c.roundRect(0, 0, BOARD.w, BOARD.h, 16, '#07080c');
    for (let i = 0; i < 14; i++) c.roundRect(i * 3, i * 2, BOARD.w - i * 6, BOARD.h - i * 2, 16, withAlpha('#1b2a44', 0.03));
    // the side rails, in perspective, with LED strips
    fillW(c, [[-74, -34], [0, -34], [0, 1230], [-74, 1230]], '#121318');
    fillW(c, [[600, -34], [674, -34], [674, 1230], [600, 1230]], '#121318');
    fillW(c, [[-74, -64], [674, -64], [674, -22], [-74, -22]], '#16171c');
    for (let v = 0; v < 1220; v += 24) {
        const k = Math.floor(v / 24) % 3;
        fillW(c, [[-46, v + 3], [-36, v + 3], [-36, v + 18], [-46, v + 18]], withAlpha(M3[k], 0.85));
        fillW(c, [[636, v + 3], [646, v + 3], [646, v + 18], [636, v + 18]], withAlpha(M3[k], 0.85));
    }
    for (const u of [-8, 608]) { lineW(c, u, -26, u, 1232, 9, '#8a919c'); lineW(c, u - 1.5, -26, u - 1.5, 1232, 2.5, '#ffffff'); }
    // the lockdown bar at the bottom edge
    const a = P(-74, 1226), b = P(674, 1226);
    c.gradientRect(a[0], a[1], b[0] - a[0], BOARD.h - a[1], [[0, '#9aa2ae'], [0.3, '#ffffff'], [1, '#3b4049']]);
}
function drawPlayfield(c) {
    const BANDS = 90;
    for (let i = 0; i < BANDS; i++) {
        const v0 = i * M.TL / BANDS, v1 = (i + 1) * M.TL / BANDS + 1.5, t = i / BANDS;
        fillW(c, [[0, v0], [M.TW, v0], [M.TW, v1], [0, v1]], mix('#0e275c', '#050e26', t));
    }
    glowW(c, 280, 380, 300, '#3d7bff', 0.32, 9);
    glowW(c, 280, 820, 230, '#2a5fd0', 0.2, 8);
    // the three stripes across it
    for (let k = 0; k < 3; k++) { const o = k * 46; fillW(c, [[0, 770 + o], [0, 810 + o], [555, 530 + o], [555, 490 + o]], withAlpha(M3[k], 0.3)); }
    // a fine carbon weave and some dust of light
    for (let v = 0; v < 1200; v += 10) lineW(c, 0, v, 555, v, 0.6, withAlpha('#ffffff', 0.022));
    for (let u = 0; u < 555; u += 10) lineW(c, u, 0, u, 1200, 0.5, withAlpha('#000000', 0.06));
    for (let i = 0; i < 260; i++) { const p = P(hash(i, 1) * 555, hash(i, 2) * 1200); c.fillRect(p[0], p[1], 1.2, 1.2, withAlpha('#9cc8ff', 0.12)); }
    // the arch: the corners outside it are cabinet
    const arc = (a0, a1, n) => { const o = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push([M.ARCH.u + Math.cos(a) * M.ARCH.r, M.ARCH.v + Math.sin(a) * M.ARCH.r]); } return o; };
    const left = arc(Math.PI, Math.PI * 1.5, 24), right = arc(Math.PI * 1.5, Math.PI * 2, 24);
    for (let i = 0; i < 24; i++) { fillW(c, [[0, 0], left[i], left[i + 1]], '#121318'); fillW(c, [[600, 0], right[i], right[i + 1]], '#121318'); }
    fillW(c, [[-2, -30], [602, -30], [602, 0], [-2, 0]], '#121318');
    // the labels painted on it
    textW(c, 'GEARS', 237.5, 214, 15, withAlpha('#81c4ff', 0.8), { spacing: 3 });
    textW(c, 'PIT LANE', 100, 610, 14, '#ff8a1a', { spacing: 2 });
    textW(c, 'M-POWER', 220, 738, 12, withAlpha('#81c4ff', 0.55), { spacing: 3 });
    drawTrackMap(c);
    textW(c, 'BONUS', 277.5, 905, 12, withAlpha('#ffd23a', 0.6), { spacing: 3 });
}
/** a circuit's map in fine light lines, a chequered flag on its straight */
function drawTrackMap(c) {
    const pts = [[150, 800], [170, 760], [215, 752], [250, 770], [282, 760], [330, 758], [360, 778], [352, 812], [318, 826], [290, 812], [258, 826], [200, 832], [160, 826]];
    for (const w of [[6, withAlpha('#81c4ff', 0.08)], [2.2, withAlpha('#c8e6ff', 0.5)]]) for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; lineW(c, a[0], a[1], b[0], b[1], w[0], w[1]); }
    for (let k = 0; k < 6; k++) for (let j = 0; j < 2; j++) fillW(c, [[176 + k * 5, 752 + j * 5], [181 + k * 5, 752 + j * 5], [181 + k * 5, 757 + j * 5], [176 + k * 5, 757 + j * 5]], (k + j) % 2 ? withAlpha('#ffffff', 0.7) : withAlpha('#000000', 0.5));
}
function drawRails(c) {
    // the arch and the side walls: chrome rails
    const N = 48;
    for (let i = 0; i < N; i++) {
        const a0 = Math.PI + i / N * Math.PI, a1 = Math.PI + (i + 1) / N * Math.PI;
        const p0 = [M.ARCH.u + Math.cos(a0) * M.ARCH.r, M.ARCH.v + Math.sin(a0) * M.ARCH.r], p1 = [M.ARCH.u + Math.cos(a1) * M.ARCH.r, M.ARCH.v + Math.sin(a1) * M.ARCH.r];
        lineW(c, p0[0], p0[1], p1[0], p1[1], 8, '#8a919c');
        lineW(c, p0[0], p0[1] + 2, p1[0], p1[1] + 2, 2.5, '#ffffff');
    }
    for (const u of [0, 600]) { lineW(c, u, 300, u, 1200, 8, '#8a919c'); lineW(c, u + (u ? -2 : 2), 300, u + (u ? -2 : 2), 1200, 2.5, '#ffffff'); }
    for (const w of M.WALLS) {
        if (w.kind === 'sling' || w.kind === 'target') continue;
        if (w.a[1] < 300 && w.b[1] < 300 && w.kind === 'wall' && w.r === 3 && (w.a[0] < 1 || w.a[0] > 599 || Math.hypot(w.a[0] - 300, w.a[1] - 300) > 296)) continue;   // the arch, done
        if ((w.a[0] === 0 || w.a[0] === 600) && w.b[0] === w.a[0]) continue;
        const rub = w.kind === 'rubber' || w.kind === 'post';
        lineW(c, w.a[0] + 4, w.a[1] + 6, w.b[0] + 4, w.b[1] + 6, w.r * 2 + 3, withAlpha('#000000', 0.45));
        if (w.kind === 'gate') { lineW(c, w.a[0], w.a[1], w.b[0], w.b[1], 4, '#d9dfe7'); continue; }
        lineW(c, w.a[0], w.a[1], w.b[0], w.b[1], w.r * 2 + 2, rub ? '#0b0c0f' : '#8a919c');
        lineW(c, w.a[0], w.a[1], w.b[0], w.b[1], rub ? 2 : 2.5, rub ? '#3a3d44' : '#ffffff');
        for (const p of [w.a, w.b]) { fillW(c, circW(p[0], p[1], w.r + 3, 14), rub ? '#f4f6f8' : '#c9d0da'); fillW(c, circW(p[0], p[1], 2.5, 10), rub ? '#e7222e' : '#ffffff'); }
    }
}
function drawShooter(c) {
    fillW(c, [[556, 345], [599, 345], [599, 1200], [556, 1200]], withAlpha('#000000', 0.25));
    fillW(c, [[560, 1114], [596, 1114], [596, 1200], [560, 1200]], '#07080b');
    textW(c, 'PULL', 577.5, 1180, 10, withAlpha('#ffffff', 0.35), { spacing: 1 });
}
function drawWheel(c, u, v, r, lit) {
    if (!lit) fillW(c, circW(u + 7, v + 10, r + 4), withAlpha('#000000', 0.5));
    if (lit) glowW(c, u, v, r * 2.2, '#81c4ff', 0.6);
    fillW(c, circW(u, v, r + 4, 40), '#0b0c0f');                          // the tyre
    fillW(c, circW(u, v, r + 1, 40), '#1d2026');
    for (let k = 0; k < 20; k++) {                                         // its tread
        const a = k / 20 * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        lineW(c, u + ca * (r + 0.5), v + sa * (r + 0.5), u + ca * (r + 3.5), v + sa * (r + 3.5), 1.5, '#2c3038');
    }
    fillW(c, circW(u, v, r - 2, 40), lit ? '#e6f2ff' : '#b9c0c8');         // the rim
    fillW(c, circW(u - 2, v - 2, r - 6, 36), lit ? '#ffffff' : '#dfe4ea');
    for (let k = 0; k < 5; k++) {                                         // five double spokes
        const a = k / 5 * Math.PI * 2 - Math.PI / 2, b = a + 0.3, e = a + 0.6;
        const pt = (ang, rr) => [u + Math.cos(ang) * rr, v + Math.sin(ang) * rr];
        fillW(c, [pt(a, 8), pt(a, r - 5), pt(b, r - 5), pt(b, 8)], lit ? '#9aa8bc' : '#5a616c');
        fillW(c, [pt(b, 8), pt(b, r - 5), pt(e, r - 5), pt(e, 8)], lit ? '#4a5a72' : '#1a1d22');
    }
    fillW(c, circW(u, v, 9.5, 20), lit ? '#c8e6ff' : '#16588e');           // the cap
    fillW(c, circW(u - 2.5, v - 2.5, 4, 14), withAlpha('#ffffff', 0.75));
}
function drawSling(c, S, side, lit) {
    const sh = (p) => [p[0] + 6, p[1] + 9];
    if (!lit) fillW(c, [sh(S.a), sh(S.b), sh(S.c)], withAlpha('#000000', 0.45));
    fillW(c, [S.a, S.b, S.c], lit ? '#ffffff' : '#e9edf2');
    const f = (t) => [S.a[0] + (S.c[0] - S.a[0]) * t, S.a[1] + (S.c[1] - S.a[1]) * t];
    const g = (t) => [S.a[0] + (S.b[0] - S.a[0]) * t, S.a[1] + (S.b[1] - S.a[1]) * t];
    M3.forEach((col, k) => { const t0 = 0.25 + k * 0.17, t1 = t0 + 0.12; fillW(c, [g(t0), f(t0), f(t1), g(t1)], lit ? mix(col, '#ffffff', 0.4) : col); });
    lineW(c, S.a[0], S.a[1], S.c[0], S.c[1], 9, '#0b0c0f');                   // the rubber
    lineW(c, S.a[0], S.a[1], S.c[0], S.c[1], 3.5, lit ? '#ffd23a' : '#f4f6f8');
    for (const p of [S.a, S.b, S.c]) { fillW(c, circW(p[0], p[1], 7), '#f4f6f8'); fillW(c, circW(p[0], p[1], 3), '#e7222e'); }
    if (lit) glowW(c, (S.a[0] + S.c[0]) / 2, (S.a[1] + S.c[1]) / 2, 50, '#ffd23a', 0.35);
}
function drawTarget(c, t, i) {
    const [fu, fv] = t.face;
    const back = (p) => [p[0] - fu * 7, p[1] - fv * 7];
    fillW(c, [[t.a[0] + 5, t.a[1] + 8], [t.b[0] + 5, t.b[1] + 8], [t.b[0] + 1, t.b[1] + 14], [t.a[0] + 1, t.a[1] + 14]], withAlpha('#000000', 0.45));
    fillW(c, [back(t.a), back(t.b), t.b, t.a], '#2a2e35');                     // its body
    const ou = fu * 3, ov = fv * 3;
    fillW(c, [t.a, t.b, [t.b[0] + ou, t.b[1] + ov], [t.a[0] + ou, t.a[1] + ov]], i < 3 ? '#f4f6f8' : '#f4f6f8');
    lineW(c, t.a[0] + ou, t.a[1] + ov, t.b[0] + ou, t.b[1] + ov, 3, M3[2]);
}
function drawSaucer(c) {
    const { u, v } = M.PIT;
    glowW(c, u, v, 44, '#ff8a1a', 0.3);
    fillW(c, circW(u, v, 25, 32), '#c9d0da');
    fillW(c, circW(u, v, 21, 32), '#4a4f58');
    fillW(c, circW(u, v, 18, 32), '#050506');
    fillW(c, circW(u + 3, v + 3, 11, 20), '#000000');
}
function drawApron(c) {
    const L = [[0, 1112], [176, 1150], [176, 1200], [0, 1200]], R = [[555, 1112], [379, 1150], [379, 1200], [555, 1200]];
    fillW(c, L, '#0b0c10'); fillW(c, R, '#0b0c10');
    fillW(c, [[176, 1162], [379, 1162], [379, 1200], [176, 1200]], '#0b0c10');
    lineW(c, 0, 1112, 176, 1150, 3, '#3a4250'); lineW(c, 555, 1112, 379, 1150, 3, '#3a4250');
    lineW(c, 176, 1162, 379, 1162, 2, '#3a4250');
    textW(c, 'SHOOT AGAIN', 277.5, 1190, 11, '#7a2a30', { spacing: 1 });
    textW(c, 'M PINBALL', 80, 1182, 13, withAlpha('#ffffff', 0.5), { spacing: 2 });
    textW(c, 'M PINBALL', 475, 1182, 13, withAlpha('#ffffff', 0.5), { spacing: 2 });
}
function tableLayer() {
    return lay('pb-table', BOARD.w, BOARD.h, (c) => {
        OFF = [BOARD.x, BOARD.y];
        drawCabinet(c);
        drawPlayfield(c);
        drawShooter(c);
        for (const id of Object.keys(LAMPS)) if (!LAMPS[id].hidden) drawInsert(c, LAMPS[id], false);
        drawSaucer(c);
        // the ramp's shadow on the playfield
        for (let i = 0; i < M.RAMP_TOP; i++) {
            const a = M.RAMP[i], b = M.RAMP[i + 1], h = 14 + i * 4;
            lineW(c, a[0] + h, a[1] + h * 1.2, b[0] + h + 4, b[1] + (h + 4) * 1.2, 66, withAlpha('#000000', 0.18));
        }
        drawRails(c);
        M.TARGETS.forEach((t, i) => drawTarget(c, t, i));
        drawSling(c, M.SLING_L, 0, false); drawSling(c, M.SLING_R, 1, false);
        for (const b of M.BUMPERS) drawWheel(c, b.u, b.v, b.r - 4, false);
        drawApron(c);
        OFF = SHIFT;
    });
}
/** a bumper lit (it was hit), a sling lit: layers at their place */
function boxOf(u, v, r) {
    const a = P(u - r, v - r), b = P(u + r, v + r), x = Math.floor(Math.min(a[0], P(u - r, v + r)[0])), y = Math.floor(a[1]);
    return { x, y, w: Math.ceil(Math.max(b[0], P(u + r, v - r)[0]) - x) + 2, h: Math.ceil(b[1] - y) + 2 };
}
function bumperLayer(i) {
    const q = M.BUMPERS[i], bx = boxOf(q.u, q.v, q.r * 2.3);
    return { L: lay('pb-bumper|' + i, bx.w, bx.h, (c) => { OFF = [bx.x, bx.y]; drawWheel(c, q.u, q.v, q.r - 4, true); OFF = SHIFT; }), x: bx.x, y: bx.y };
}
function slingLayer(side) {
    const S = side ? M.SLING_R : M.SLING_L, cu = (S.a[0] + S.c[0]) / 2, cv = (S.a[1] + S.c[1]) / 2, bx = boxOf(cu, cv, 110);
    return { L: lay('pb-sling|' + side, bx.w, bx.h, (c) => { OFF = [bx.x, bx.y]; drawSling(c, S, side, true); OFF = SHIFT; }), x: bx.x, y: bx.y };
}

/* ---------- the ramp: clear blue plastic with kerbs, then the wire ---------- */
function rampLayer() {
    return lay('pb-ramp', BOARD.w, BOARD.h, (c) => {
        OFF = [BOARD.x, BOARD.y];
        const path = M.RAMP.slice(0, M.RAMP_TOP + 1), RW = 36;
        const lift = (i) => i / M.RAMP_TOP * 26;                       // raised: drawn higher up the page
        const up = (p, i) => [p[0], p[1] - lift(i)];
        const edges = path.map((p, i) => {
            const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
            const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv);
            return [up([p[0] - dv / l * RW, p[1] + du / l * RW], i), up([p[0] + dv / l * RW, p[1] - du / l * RW], i)];
        });
        // the plastic, its kerbs
        for (let i = 0; i < path.length - 1; i++) fillW(c, [edges[i][0], edges[i][1], edges[i + 1][1], edges[i + 1][0]], withAlpha('#5aa8ff', 0.3));
        for (let i = 0; i < path.length - 1; i++) {
            fillW(c, [edges[i][0], edges[i][1], edges[i + 1][1], edges[i + 1][0]].map((p, k) => [p[0] + (k < 2 ? 0 : 0), p[1]]), withAlpha('#ffffff', 0.03));
            for (const s of [0, 1]) {
                const a = edges[i][s], b = edges[i + 1][s];
                for (let k = 0; k < 4; k++) {
                    const t0 = k / 4, t1 = (k + 1) / 4;
                    const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
                    lineW(c, p0[0], p0[1], p1[0], p1[1], 10, (i * 4 + k) % 2 ? '#ffffff' : '#e7222e');
                }
            }
        }
        // the entrance's lip, a sign over it
        fillW(c, [edges[0][0], edges[0][1], [edges[0][1][0], edges[0][1][1] + 10], [edges[0][0][0], edges[0][0][1] + 10]], '#c9d0da');
        const sg = up([path[1][0], path[1][1]], 1), su = sg[0] - 4, sv = sg[1] + 26;
        fillW(c, [[su - 46, sv - 16], [su + 46, sv - 16], [su + 46, sv + 8], [su - 46, sv + 8]], '#0b0c10');
        lineW(c, su - 46, sv + 8, su + 46, sv + 8, 2, '#e7222e');
        textW(c, 'CHICANE', su, sv + 3, 15, '#ffffff', { spacing: 2 });
        // the wire: two chrome rails from the ramp's end down to the left inlane
        const wire = M.RAMP.slice(M.RAMP_TOP);
        const hgt = (k) => 26 * (1 - k / (wire.length - 1) * 0.9);
        for (let i = 0; i < wire.length - 1; i++) {
            const a = wire[i], b = wire[i + 1], du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv), nu = -dv / l * 9, nv = du / l * 9;
            const ha = hgt(i), hb = hgt(i + 1);
            lineW(c, a[0] + 12, a[1] + 12, b[0] + 12, b[1] + 12, 2.5, withAlpha('#000000', 0.3));
            for (const s of [-1, 1]) {
                lineW(c, a[0] + nu * s, a[1] + nv * s - ha, b[0] + nu * s, b[1] + nv * s - hb, 2.4, '#6d7684');
                lineW(c, a[0] + nu * s, a[1] + nv * s - ha - 0.6, b[0] + nu * s, b[1] + nv * s - hb - 0.6, 1.1, '#ffffff');
            }
            const steps = Math.max(1, Math.round(l / 70));
            for (let k = 0; k < steps; k++) {
                const t = k / steps, cu = a[0] + du * t, cv = a[1] + dv * t, h = ha + (hb - ha) * t;
                lineW(c, cu - nu * 1.2, cv - nv * 1.2 - h, cu + nu * 1.2, cv + nv * 1.2 - h, 1.2, withAlpha('#8a919c', 0.8));
            }
        }
        OFF = SHIFT;
    });
}

/* ---------- moving parts ---------- */
function drawFlipper(cv, side, ang) {
    const p = M.PIVOTS[side], F = M.FLIP;
    const dir = side === 0 ? ang : Math.PI - ang;
    const tu = p.u + Math.cos(dir) * F.len, tv = p.v + Math.sin(dir) * F.len;
    const cap = (r0, r1, du, dv) => hull(circW(p.u + (du || 0), p.v + (dv || 0), r0, 18).concat(circW(tu + (du || 0), tv + (dv || 0), r1, 12)));
    fillW(cv, cap(F.r0 + 2, F.r1 + 2, 6, 10), withAlpha('#000000', 0.45));
    fillW(cv, cap(F.r0 + 1.5, F.r1 + 1.5), '#e7222e');                   // the rubber
    fillW(cv, cap(F.r0 - 1.5, F.r1 - 1.2), '#f4f6f8');                   // the bat
    const ca = Math.cos(dir), sa = Math.sin(dir), nu = -sa, nv = ca;
    M3.forEach((col, k) => {
        const o = (k - 1) * 2.8, w = 1.1;
        const A = [p.u + nu * o + ca * 15, p.v + nv * o + sa * 15], B = [tu + nu * o * 0.55 - ca * 9, tv + nv * o * 0.55 - sa * 9];
        fillW(cv, [[A[0] - nu * w, A[1] - nv * w], [B[0] - nu * w * 0.6, B[1] - nv * w * 0.6], [B[0] + nu * w * 0.6, B[1] + nv * w * 0.6], [A[0] + nu * w, A[1] + nv * w]], col);
    });
    fillW(cv, circW(p.u, p.v, 6, 14), '#8a919c'); fillW(cv, circW(p.u - 1.5, p.v - 1.5, 3, 10), '#ffffff');
}
/** a steel ball; h = how high it is above the playfield (on the ramp: 0..1) */
function drawBall(cv, u, v, h, blur) {
    h = h || 0;
    const s = S(v), r = M.R * s * (1 + h * 0.14), p = P(u, v - h * 26), lift = 0;      // (raised as the ramp is)
    fillW(cv, circW(u + 6 + h * 18, v + 10 + h * 26, M.R * 0.95, 16), withAlpha('#000000', 0.5 - h * 0.2));
    if (blur) for (let k = 3; k >= 1; k--) cv.circle(p[0] - blur[0] * k, p[1] - lift - blur[1] * k, r * (1 - k * 0.08), withAlpha('#b9c6d6', 0.13));
    ball(cv, p[0], p[1] - lift, r, STEEL);
    cv.circle(p[0] + r * 0.32, p[1] - lift + r * 0.42, r * 0.34, withAlpha('#81c4ff', 0.22));   // the playfield in it
    cv.circle(p[0] - r * 0.36, p[1] - lift - r * 0.4, r * 0.18, '#ffffff');
}
function drawPlunger(cv, pull) {
    const top = 1114 + pull * 36;
    fillW(cv, [[569, top], [586, top], [586, top + 10], [569, top + 10]], '#e7222e');
    fillW(cv, [[569, top], [586, top], [586, top + 3], [569, top + 3]], '#ff8a92');
    const coils = 9, len = 1200 - top - 10;
    for (let i = 0; i < coils; i++) { const v = top + 10 + i * len / coils; lineW(cv, 566, v, 589, v + len / coils * 0.6, 2.2, i % 2 ? '#8a919c' : '#c9d0da'); }
}

/* ---------- the panel ---------- */
function panelLayer() {
    return lay('pb-panel', PANEL.w, PANEL.h, (c) => {
        const ox = -PANEL.x, oy = -PANEL.y, w = PANEL.w, h = PANEL.h;
        c.card(0, 0, w, h, 22, [[0, '#24242c'], [0.5, '#121218'], [1, '#08080b']]);
        for (let i = 0; i < 88; i++) c.fillRect(8, 12 + i * 5, w - 16, 1, withAlpha(i % 3 ? '#ffffff' : '#000000', 0.018));
        moulding(c, 0, 0, w, h, 22, 8, CHROME);
        // the display: a bezel, the dark dots
        const dx = DMD.x + ox, dy = DMD.y + oy;
        moulding(c, dx - 10, dy - 10, DMD.w + 20, DMD.h + 20, 10, 5, CHROME);
        c.roundRect(dx - 5, dy - 5, DMD.w + 10, DMD.h + 10, 6, '#020101');
        for (let y = 0; y < DMD.rows; y++) for (let x = 0; x < DMD.cols; x++) c.circle(dx + x * DMD.pitch + 2, dy + y * DMD.pitch + 2, 1.5, '#1e0e04');
        c.text('M-POWER', 26 , 232, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, literal: true });
        c.text('BALL', 26, 316, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, literal: true });
        c.text('BEST', w - 26, 316, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, literal: true, align: 'right' });
        // the power gauge's frame
        const px = POWER_BAR.x + ox, py = POWER_BAR.y + oy;
        c.card(px, py, POWER_BAR.w, POWER_BAR.h, 10, [[0, '#050608'], [1, '#101318']]);
        moulding(c, px - 3, py - 3, POWER_BAR.w + 6, POWER_BAR.h + 6, 12, 3, CHROME);
        c.text('POWER', px + POWER_BAR.w / 2, py + POWER_BAR.h + 18, 12, withAlpha('#ffffff', 0.5), { font: 'label', spacing: 1, align: 'center', literal: true });
        // the launch button's chrome ring
        const sx = LAUNCH_BTN.x + ox, sy = LAUNCH_BTN.y + oy, r = LAUNCH_BTN.r;
        c.circle(sx + 4, sy + 7, r + 9, withAlpha('#000000', 0.6));
        ball(c, sx, sy, r + 9, [[0, '#2b2f36'], [0.4, '#8a919c'], [0.8, '#e2e6ec'], [1, '#ffffff']], 0.2, 0.3);
        c.circle(sx, sy, r + 1, '#14040a');
    });
}
function launchLayer(label, state) {
    const r = LAUNCH_BTN.r, S2 = 2 * r + 4;
    return lay('pb-launch|' + label + '|' + state, S2, S2, (c) => {
        const cx = S2 / 2, cy = S2 / 2 + (state === 'down' ? 2 : 0), rr = state === 'down' ? r - 2 : r, dark = state === 'off';
        ball(c, cx, cy, rr, dark ? [[0, '#200004'], [0.5, '#4a0a12'], [1, '#6a2a30']] : [[0, '#4a0008'], [0.35, '#b0001a'], [0.75, '#ff2a3a'], [1, '#ff8a92']]);
        poly(c, ellipsePts(cx - rr * 0.12, cy - rr * 0.5, rr * 0.55, rr * 0.24), withAlpha('#ffffff', dark ? 0.12 : 0.3));
        outlined(c, label, cx, cy + 7, label.length > 6 ? 15 : 18, dark ? '#a08a8c' : '#fff6f6', '#5a0010', 1.5);
    });
}
function nudgeLayer(state) {
    const B = NUDGE_BTN;
    return lay('pb-nudge|' + state, B.w + 8, B.h + 8, (c) => {
        const d = state === 'down' ? 2 : 0;
        c.roundRect(4, 7, B.w, B.h, 14, withAlpha('#000000', 0.5));
        c.card(2, 2 + d, B.w, B.h - d, 14, state === 'warn' ? [[0, '#5a3a08'], [1, '#2a1a04']] : [[0, '#323944'], [1, '#161a21']]);
        c.strokeRoundRect(2, 2 + d, B.w, B.h - d, 14, 1.5, withAlpha('#ffffff', 0.22));
        c.gradientRect(8, 5 + d, B.w - 12, 16, [[0, withAlpha('#ffffff', 0.1)], [1, withAlpha('#ffffff', 0)]]);
        c.text('NUDGE', 2 + B.w / 2, 2 + d + B.h / 2 + 8, 22, state === 'warn' ? '#ffb020' : '#f4f7fb', { font: 'bold', align: 'center', spacing: 2, literal: true });
    });
}
function ellipsePts(cx, cy, rx, ry, n) { n = n || 24; const p = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } return p; }
function letterLayer(ch, lit) {
    return lay('pb-letter|' + ch + '|' + lit, 52, 52, (c) => {
        if (lit) for (let k = 6; k >= 1; k--) c.circle(26, 26, 18 * k / 6 + 6, withAlpha('#81c4ff', 0.06));
        ball(c, 26, 26, 19, lit ? [[0, '#16588e'], [0.6, '#81c4ff'], [1, '#e6f4ff']] : [[0, '#06142c'], [1, '#14305a']]);
        c.text(ch, 26, 33, 20, lit ? '#06142c' : '#3a5a8a', { font: 'bold', align: 'center', literal: true });
    });
}
function ballIconLayer(on) {
    return lay('pb-bicon|' + on, 26, 26, (c) => { if (on) ball(c, 13, 13, 10, STEEL); else c.circle(13, 13, 10, withAlpha('#ffffff', 0.07)); });
}

/* ---------- the dot-matrix display: lines of text lit as dots, a layer per content ---------- */
const dmdCanvas = new Canvas(DMD.cols, DMD.rows);
/** lines: [[text, x, y (baseline), size, align, level 0..1]] */
function dmdLayer(lines, key) {
    return lay('pb-dmd|' + (key || JSON.stringify(lines)), DMD.w, DMD.h, (c) => {
        const d = dmdCanvas;
        d.clear('#000000');
        for (const [s, x, y, size, align, lv] of lines) d.text(s, x, y, size, mix('#000000', '#ffffff', lv === undefined ? 1 : lv), { font: 'bold', align: align || 'left', literal: true });
        for (let y = 0; y < DMD.rows; y++) for (let x = 0; x < DMD.cols; x++) {
            const b = d.d[(y * DMD.cols + x) * 4] / 255;
            if (b < 0.1) continue;
            const q = Math.min(1, Math.round(b * 4) / 4 + 0.1);
            c.circle(x * DMD.pitch + 2, y * DMD.pitch + 2, 1.65, mix('#3a1a04', '#ffb040', q));
        }
    });
}

module.exports = {
    setTextScale, setShift, BOARD, PANEL, DMD, LAUNCH_BTN, NUDGE_BTN, POWER_BAR, ZONES, LAMPS, M3,
    P, S, tableLayer, rampLayer, lampLayer, bumperLayer, slingLayer, panelLayer, launchLayer, nudgeLayer, letterLayer, ballIconLayer, dmdLayer,
    drawFlipper, drawBall, drawPlunger, glow, poly, ball, outlined,
};
