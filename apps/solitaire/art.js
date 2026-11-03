'use strict';
/**
 * Solitaire's look: a card table. Felt lit from above in a dark wooden frame with a brass inlay, the
 * places for the piles printed on it, cards with real pips (suits drawn as shapes), court cards in a
 * gold frame with a crown, a lattice back; a control panel with LCD read-outs and keys.
 *
 * Everything is drawn from rects, rounded rects, gradients, quads, arcs, lines and text
 * (kit/record.js); the table, every card face, the back, the panel and the keys are cached layers,
 * so a frame is mostly layer blits.
 */
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');

let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const TABLE = { x: 24, y: 46, w: 1116, h: 462 };
const CARD = { w: 80, h: 112, r: 7 };
const colX = (i) => 98 + i * 148;
const TOP_Y = 62, TAB_Y = 192, BOTTOM = 500;
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const DRAW_BTN = { x: PANEL.x + 322, y: 446, r: 44 };
const FELTS = {
    green: ['#1c8a4e', '#0b5d33', '#03301a'],
    blue: ['#1d5f9c', '#0b3d6b', '#041d36'],
    red: ['#9c1d2e', '#6b0b1a', '#33040b'],
    black: ['#3a3a42', '#1e1e22', '#0a0a0c'],
};
const RED = '#c8102e', BLACK = '#15151a';
const RANK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const WOOD = [[0, '#120804'], [0.2, '#4a2a14'], [0.45, '#7a4a26'], [0.6, '#5a3419'], [0.85, '#2a160a'], [1, '#0a0503']];

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

/* ---------- suits and cards ---------- */
function suit(cv, s, cx, cy, size, color) {
    const k = size;
    if (s === 'H') {
        cv.circle(cx - 0.25 * k, cy - 0.12 * k, 0.27 * k, color);
        cv.circle(cx + 0.25 * k, cy - 0.12 * k, 0.27 * k, color);
        poly(cv, [[cx - 0.515 * k, cy - 0.04 * k], [cx + 0.515 * k, cy - 0.04 * k], [cx, cy + 0.56 * k]], color);
    } else if (s === 'D') {
        poly(cv, [[cx, cy - 0.56 * k], [cx + 0.42 * k, cy], [cx, cy + 0.56 * k], [cx - 0.42 * k, cy]], color);
    } else if (s === 'S') {
        cv.circle(cx - 0.25 * k, cy + 0.1 * k, 0.26 * k, color);
        cv.circle(cx + 0.25 * k, cy + 0.1 * k, 0.26 * k, color);
        poly(cv, [[cx - 0.5 * k, cy + 0.04 * k], [cx + 0.5 * k, cy + 0.04 * k], [cx, cy - 0.56 * k]], color);
        poly(cv, [[cx - 0.05 * k, cy + 0.15 * k], [cx + 0.05 * k, cy + 0.15 * k], [cx + 0.18 * k, cy + 0.56 * k], [cx - 0.18 * k, cy + 0.56 * k]], color);
    } else {
        cv.circle(cx, cy - 0.25 * k, 0.23 * k, color);
        cv.circle(cx - 0.26 * k, cy + 0.08 * k, 0.23 * k, color);
        cv.circle(cx + 0.26 * k, cy + 0.08 * k, 0.23 * k, color);
        cv.circle(cx, cy, 0.14 * k, color);
        poly(cv, [[cx - 0.05 * k, cy + 0.05 * k], [cx + 0.05 * k, cy + 0.05 * k], [cx + 0.18 * k, cy + 0.56 * k], [cx - 0.18 * k, cy + 0.56 * k]], color);
    }
}
const suitColor = (s) => (s === 'H' || s === 'D' ? RED : BLACK);
// pip positions on a card (fractions of the pip area), per rank
const PIPS = {
    2: [[0.5, 0], [0.5, 1]], 3: [[0.5, 0], [0.5, 0.5], [0.5, 1]],
    4: [[0, 0], [1, 0], [0, 1], [1, 1]], 5: [[0, 0], [1, 0], [0.5, 0.5], [0, 1], [1, 1]],
    6: [[0, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [1, 1]], 7: [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
    8: [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0.5, 0.75], [0, 1], [1, 1]],
    9: [[0, 0], [1, 0], [0, 1 / 3], [1, 1 / 3], [0.5, 0.5], [0, 2 / 3], [1, 2 / 3], [0, 1], [1, 1]],
    10: [[0, 0], [1, 0], [0.5, 1 / 6], [0, 1 / 3], [1, 1 / 3], [0, 2 / 3], [1, 2 / 3], [0.5, 5 / 6], [0, 1], [1, 1]],
};
function cardBase(c, w, h) {
    c.roundRect(2, 3, w, h, CARD.r, withAlpha('#000000', 0.35));
    c.card(0, 0, w, h, CARD.r, [[0, '#ffffff'], [0.6, '#f7f5ef'], [1, '#e9e5da']]);
    c.strokeRoundRect(0, 0, w, h, CARD.r, 1, withAlpha('#000000', 0.25));
}
function drawFace(c, card) {
    const w = CARD.w, h = CARD.h, k = w / 92, col = suitColor(card.s), rk = RANK[card.r];
    cardBase(c, w, h);
    const rs = (rk === '10' ? 20 : 22) * k / 0.87;
    c.text(rk, 11, 23, rs * 0.92, col, { font: 'bold', align: 'center', literal: true });
    suit(c, card.s, 11, 35, 10, col);
    c.text(rk, w - 11, h - 14, rs * 0.92, col, { font: 'bold', align: 'center', literal: true });
    suit(c, card.s, w - 11, h - 27, 10, col);
    const n = card.r;
    if (n >= 2 && n <= 10) {
        const x0 = 29, x1 = w - 29, y0 = 21, y1 = h - 21, ps = n >= 9 ? 14 : 16;
        for (const [fx, fy] of PIPS[n]) suit(c, card.s, x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy, ps, col);
    } else if (n === 1) {
        suit(c, card.s, w / 2, h / 2, 40, col);
        if (card.s === 'S') c.circle(w / 2, h / 2 + 2, 3.5, '#ffffff');
    } else {
        const fx = 20, fy = 19, fw = w - 40, fh = h - 38;
        c.card(fx, fy, fw, fh, 4, [[0, mix(col, '#ffffff', 0.85)], [1, mix(col, '#ffffff', 0.7)]]);
        c.strokeRoundRect(fx, fy, fw, fh, 4, 2, '#c9a24a');
        c.strokeRoundRect(fx + 3, fy + 3, fw - 6, fh - 6, 3, 1, withAlpha('#c9a24a', 0.7));
        const cx = w / 2, cy = fy + 22;
        poly(c, [[cx - 13, cy + 7], [cx + 13, cy + 7], [cx + 15, cy - 6], [cx - 15, cy - 6]], '#e2b33c');
        for (const dx of [-15, 0, 15]) { poly(c, [[cx + dx - 5, cy - 5], [cx + dx + 5, cy - 5], [cx + dx, cy - 15]], '#e2b33c'); c.circle(cx + dx, cy - 15, 2.5, '#e2b33c'); }
        c.fillRect(cx - 13, cy + 1, 26, 2.5, mix(col, '#000000', 0.2));
        c.circle(cx, cy - 1, 2, '#ffffff');
        c.text(rk, cx, fy + fh - 13, 30, col, { font: 'bold', align: 'center', literal: true });
        suit(c, card.s, fx + 9, fy + fh - 10, 8, col);
        suit(c, card.s, fx + fw - 9, fy + fh - 10, 8, col);
    }
}
function drawBack(c, w, h, colour) {
    const b = colour === 'blue' ? ['#1f4fa8', '#0c2a66'] : ['#a3132a', '#5c0714'];
    c.roundRect(2, 3, w, h, CARD.r, withAlpha('#000000', 0.35));
    c.card(0, 0, w, h, CARD.r, [[0, '#ffffff'], [1, '#ece8de']]);
    c.card(5, 5, w - 10, h - 10, 5, [[0, b[0]], [1, b[1]]]);
    const iw = w - 10, ih = h - 10;
    for (let k = -ih; k < iw; k += 8) { const x0 = Math.max(0, k), x1 = Math.min(iw, k + ih); c.line(5 + x0, 5 + x0 - k, 5 + x1, 5 + x1 - k, 1, withAlpha('#ffffff', 0.12)); }
    for (let k = 0; k < iw + ih; k += 8) { const x0 = Math.min(iw, k), y0 = Math.max(0, k - iw), x1 = Math.max(0, k - ih), y1 = Math.min(ih, k); c.line(5 + x0, 5 + y0, 5 + x1, 5 + y1, 1, withAlpha('#ffffff', 0.12)); }
    c.strokeRoundRect(9, 9, w - 18, h - 18, 4, 1.5, withAlpha('#ffffff', 0.5));
    poly(c, ellipse(w / 2, h / 2, 15, 20), '#e2b33c');
    poly(c, ellipse(w / 2, h / 2, 11.5, 16.5), b[1]);
    suit(c, 'S', w / 2, h / 2, 15, '#e2b33c');
    c.roundRect(4, 2, w - 8, 9, 4.5, withAlpha('#ffffff', 0.08));
}
function cardLayer(card) { return lay('sol-card|' + card.r + card.s, CARD.w + 4, CARD.h + 5, (c) => drawFace(c, card)); }
function backLayer(colour) { return lay('sol-back|' + colour, CARD.w + 4, CARD.h + 5, (c) => drawBack(c, CARD.w, CARD.h, colour)); }
/** a card turning over: k 0..1, the back narrowing to its edge then the face widening */
function drawFlip(cv, card, x, y, k, colour) {
    const w = CARD.w * Math.abs(Math.cos(k * Math.PI)), cx = x + CARD.w / 2;
    if (w < 2) return;
    if (k < 0.5) {
        const b = colour === 'blue' ? ['#1f4fa8', '#0c2a66'] : ['#a3132a', '#5c0714'];
        cv.card(cx - w / 2, y, w, CARD.h, Math.min(CARD.r, w / 2), [[0, '#ffffff'], [1, '#ece8de']]);
        if (w > 12) cv.card(cx - w / 2 + 5 * w / CARD.w, y + 5, w - 10 * w / CARD.w, CARD.h - 10, 4, [[0, b[0]], [1, b[1]]]);
    } else {
        cv.card(cx - w / 2, y, w, CARD.h, Math.min(CARD.r, w / 2), [[0, '#ffffff'], [0.6, '#f7f5ef'], [1, '#e9e5da']]);
        if (w > CARD.w * 0.85) cv.blit(cardLayer(card), x, y);
    }
}

/* ---------- the table (a cached layer) ---------- */
function slot(c, x, y, label, s) {
    c.roundRect(x, y, CARD.w, CARD.h, CARD.r, withAlpha('#000000', 0.18));
    c.strokeRoundRect(x, y, CARD.w, CARD.h, CARD.r, 2, withAlpha('#f4ead0', 0.28));
    c.strokeRoundRect(x + 5, y + 5, CARD.w - 10, CARD.h - 10, 4, 1, withAlpha('#f4ead0', 0.12));
    if (s) suit(c, s, x + CARD.w / 2, y + CARD.h / 2 - 6, 30, withAlpha('#f4ead0', 0.16));
    if (label) c.text(label, x + CARD.w / 2, y + CARD.h - 14, s ? 18 : 30, withAlpha('#f4ead0', 0.22), { font: 'bold', align: 'center', literal: true });
}
function drawTable(c, felt) {
    const f = FELTS[felt] || FELTS.green, w = TABLE.w, h = TABLE.h;
    c.roundRect(4, 6, w - 4, h - 6, 22, withAlpha('#000000', 0.55));
    c.card(0, 0, w, h, 22, [[0, '#3a2210'], [1, '#1a0e06']]);
    // the felt: darker toward its edges, lit from above its middle
    const fx = 16, fy = 14, fw = w - 32, fh = h - 28;
    c.card(fx, fy, fw, fh, 14, [[0, f[1]], [1, f[2]]]);
    for (let k = 1; k <= 30; k++) {
        const s = 1 - k / 34, rw = fw * s, rh = fh * s * 0.95;
        c.roundRect(fx + (fw - rw) / 2, fy + (fh - rh) / 2 - fh * 0.08 * (1 - s), rw, rh, 14 + 200 * (1 - s), withAlpha(f[0], 0.045));
    }
    for (let y = fy + 2; y < fy + fh; y += 4) c.fillRect(fx, y, fw, 1, withAlpha('#000000', 0.03));
    // the frame: dark wood with a brass inlay, the felt's edge in shadow
    for (let k = 0; k < 14; k++) c.strokeRoundRect(k, k, w - 2 * k, h - 2 * k, Math.max(4, 22 - k), 1.6, gradAt(WOOD, k / 13));
    c.strokeRoundRect(fx - 3, fy - 3, fw + 6, fh + 6, 16, 2, '#c9a24a');
    for (let k = 0; k < 6; k++) c.strokeRoundRect(fx + k, fy + k, fw - 2 * k, fh - 2 * k, 14, 1, withAlpha('#000000', 0.12 * (6 - k) / 6));
    // the places for the piles
    const ox = -TABLE.x, oy = -TABLE.y;
    slot(c, colX(0) + ox, TOP_Y + oy, '', null);
    slot(c, colX(1) + ox, TOP_Y + oy, '', null);
    ['S', 'H', 'D', 'C'].forEach((s, i) => slot(c, colX(3 + i) + ox, TOP_Y + oy, 'A', s));
    for (let i = 0; i < 7; i++) slot(c, colX(i) + ox, TAB_Y + oy, 'K', null);
    // the separation of the top row
    c.fillRect(colX(0) + ox, TAB_Y + oy - 14, colX(6) + CARD.w - colX(0), 1, withAlpha('#f4ead0', 0.1));
}
function tableLayer(felt) { return lay('sol-table|' + felt, TABLE.w, TABLE.h, (c) => drawTable(c, felt)); }
/** the empty stock: a circular arrow (turn the waste over), dim when nothing is left to turn */
function drawRecycle(cv, x, y, on) {
    const cx = x + CARD.w / 2, cy = y + CARD.h / 2, c = withAlpha('#f4ead0', on ? 0.55 : 0.15);
    cv.arc(cx, cy, 15, 20, 40, 330, c);
    poly(cv, [[cx - 2, cy - 26], [cx + 12, cy - 17], [cx - 2, cy - 9]], c);
}

/* ---------- the panel ---------- */
const LCD = {
    score: { x: PANEL.x + 24, y: PANEL.y + 46, w: PANEL.w - 48, label: 'SCORE', color: '#5ff0a6' },
    time: { x: PANEL.x + 24, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'TIME', color: '#ffd36e' },
    moves: { x: PANEL.x + 36 + (PANEL.w - 60) / 2, y: PANEL.y + 136, w: (PANEL.w - 60) / 2, label: 'MOVES', color: '#7fd1ff' },
};
const KEYS = [
    { x: PANEL.x + 24, y: PANEL.y + 236, w: 178, h: 50, label: 'UNDO', id: 'undo' },
    { x: PANEL.x + 214, y: PANEL.y + 236, w: 178, h: 50, label: 'HINT', id: 'hint' },
    { x: PANEL.x + 24, y: PANEL.y + 298, w: 178, h: 50, label: 'NEW GAME', id: 'new' },
    { x: PANEL.x + 214, y: PANEL.y + 298, w: 178, h: 50, label: 'STATS', id: 'stats' },
];
function panelLayer() {
    return lay('sol-panel', PANEL.w, PANEL.h, (c) => {
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
        const sx = DRAW_BTN.x + ox, sy = DRAW_BTN.y + oy, r = DRAW_BTN.r;
        c.circle(sx + 4, sy + 7, r + 9, withAlpha('#000000', 0.6));
        ball(c, sx, sy, r + 9, [[0, '#2b2f36'], [0.4, '#8a919c'], [0.8, '#e2e6ec'], [1, '#ffffff']], 0.2, 0.3);
        c.circle(sx, sy, r + 1, '#04080e');
    });
}
function keyLayer(i, state) {
    const q = KEYS[i];
    return lay('sol-key|' + i + '|' + state, q.w + 6, q.h + 8, (c) => {
        const down = state === 'down', lit = state === 'lit', off = state === 'off', dy = down ? 3 : 0;
        if (!down) c.roundRect(2, 5, q.w, q.h, 12, withAlpha('#000000', 0.6));
        c.card(0, dy, q.w, q.h, 12, lit ? [[0, '#ffe08a'], [0.5, '#d98c00'], [1, '#8a5a0a']] : off ? [[0, '#2a2c32'], [1, '#16171b']] : [[0, '#5a5f6b'], [0.5, '#2c2f36'], [1, '#1a1c21']]);
        c.roundRect(3, dy + 2, q.w - 6, q.h * 0.36, 8, withAlpha('#ffffff', lit ? 0.3 : off ? 0.04 : 0.12));
        c.text(q.label, q.w / 2, dy + q.h / 2 + 7, 20, lit ? '#2a1800' : off ? '#5a5d66' : '#e9edf2', { font: 'bold', align: 'center' });
    });
}
/** the round button: DRAW (blue), lit or dark, or pressed */
function drawLayer(label, state) {
    const r = DRAW_BTN.r, S = 2 * r + 4;
    return lay('sol-draw|' + label + '|' + state, S, S, (c) => {
        const cx = S / 2, cy = S / 2 + (state === 'down' ? 2 : 0), rr = state === 'down' ? r - 2 : r, dark = state === 'off';
        ball(c, cx, cy, rr, dark ? [[0, '#020812'], [0.5, '#0a1a2e'], [1, '#243446']] : [[0, '#001a3a'], [0.35, '#0a4f9a'], [0.75, '#2a8ad4'], [1, '#9ad4ff']]);
        poly(c, ellipse(cx - rr * 0.12, cy - rr * 0.5, rr * 0.55, rr * 0.24), withAlpha('#ffffff', dark ? 0.1 : 0.3));
        poly(c, ellipse(cx - rr * 0.2, cy - rr * 0.55, rr * 0.25, rr * 0.09), withAlpha('#ffffff', dark ? 0.25 : 0.75));
        outlined(c, label, cx, cy + 9, 24, dark ? '#7a8a9a' : '#f4f8ff', '#001a3a', 1.6, { shadow: false });
    });
}
/** the statistics, on dark glass over the table */
function drawStats(cv, left, right, footer) {
    const x = TABLE.x + 40, y = 70, w = TABLE.w - 80, h = 340;
    cv.roundRect(x, y, w, h, 12, withAlpha('#06030a', 0.94));
    cv.strokeRoundRect(x + 6, y + 6, w - 12, h - 12, 9, 1.5, withAlpha('#ffd36e', 0.35));
    outlined(cv, 'STATISTICS', x + w / 2, y + 46, 30, '#fff3c4', '#a8701a', 1.5, { spacing: 4, shadow: false });
    const col = (rows, cx) => rows.forEach(([k, v, c], i) => {
        const ry = y + 96 + i * 38;
        cv.text(k, cx, ry, 18, withAlpha('#ffffff', 0.6), { font: 'bold', spacing: 1 });
        cv.text(v, cx + 440, ry, 22, c || '#ffffff', { font: 'num', align: 'right', literal: true });
        cv.fillRect(cx, ry + 11, 440, 1, withAlpha('#ffffff', 0.06));
    });
    col(left, x + 40);
    col(right, x + w / 2 + 20);
    cv.text(footer, x + w / 2, y + h - 18, 15, withAlpha('#ffffff', 0.45), { align: 'center' });
}
function sparkle(cv, x, y, r, c) {
    poly(cv, [[x, y - r], [x + r * 0.22, y], [x, y + r], [x - r * 0.22, y]], c || '#ffffff');
    poly(cv, [[x - r, y], [x, y - r * 0.22], [x + r, y], [x, y + r * 0.22]], c || '#ffffff');
}

module.exports = {
    setTextScale, TABLE, CARD, colX, TOP_Y, TAB_Y, BOTTOM, PANEL, DRAW_BTN, FELTS, LCD, KEYS, RANK,
    tableLayer, cardLayer, backLayer, drawFlip, drawRecycle, panelLayer, keyLayer, drawLayer, drawStats, sparkle,
    glow, outlined, moulding, GOLD, suit, poly, ellipse, drawFace, drawBack,
};
