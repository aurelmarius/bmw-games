'use strict';
/**
 * Lap Record's look: the circuit from above on a sunny afternoon, the camera on the car. Mown grass in
 * stripes, asphalt with its grain and the dark rubbered racing line, white edge lines, red and white kerbs
 * with a lit top edge, gravel traps on the outside of the corners, tyre walls and armco, boards, braking
 * markers before the hairpins, grandstands full of people, the pit building with its garages, firs and
 * oaks casting their shadows; the start gantry over the line.
 *
 * The world is drawn once in square tiles (cached layers, made as the camera reaches them); per frame only
 * the cars, their tyre marks and smoke are drawn over it. The panel: the lap's time, the best, the gap to
 * it, the sectors, speed and gear, the circuit's map.
 */
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const M = require('./model');

let TS = 1;
const setTextScale = (v) => { TS = v || 1; };
const lay = (key, w, h, draw) => G.layer(key, w, h, draw, TS);

/* ---------- layout (page px; the kit's header is above y = 44) ---------- */
const BOARD = { x: 24, y: 46, w: 1116, h: 462 };
const PANEL = { x: 1160, y: 46, w: 416, h: 462 };
const Z = 7;                                      // px per metre
const TILE = 512;
const MARGIN = 60;                                // m of land round the circuit
const PEDALS = [{ kind: 'brake', x: PANEL.x + 22, y: PANEL.y + 398, w: 120, h: 52 }, { kind: 'gas', x: PANEL.x + 150, y: PANEL.y + 398, w: 120, h: 52 }];
const MAP = { x: PANEL.x + 236, y: PANEL.y + 280, w: 160, h: 112 };
const M3 = ['#81c4ff', '#16588e', '#e7222e'];
const CHROME = [[0, '#22252b'], [0.2, '#8a919c'], [0.4, '#ffffff'], [0.6, '#9aa2ae'], [0.85, '#3b4049'], [1, '#111216']];
const PAINTS = {
    blue: ['#5f9cf2', '#2f6fd4', '#1a4a9e', '#0c2a5c'],
    white: ['#ffffff', '#eef1f5', '#c3cad3', '#7a828e'],
    black: ['#5a6270', '#2a2e35', '#16181c', '#08090b'],
    grey: ['#d9dfe7', '#9aa2ae', '#6a7280', '#2a2e35'],
    green: ['#6ad09a', '#2f9a64', '#17603c', '#08301c'],
    red: ['#ff7a7a', '#d4222e', '#8a0a12', '#40050a'],
    yellow: ['#ffe28a', '#f2b81a', '#a8740a', '#4a3204'],
};
const hash = (i, k) => { const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); };
const SECTOR_C = { purple: '#c99bff', green: '#5ff0a6', yellow: '#ffd23a' };

function gradAt(stops, t) {
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
    return mix(a[1], b[1], b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))));
}
/** a convex polygon: the canvas fills it; the GPU recorder takes quads (a fan of them) */
function poly(cv, pts, c) {
    if (cv.convex) return cv.convex(pts, c);
    const n = pts.length;
    if (n === 4) return cv.quad(pts, c);
    if (n === 3) return cv.quad([pts[0], pts[1], [(pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2], pts[2]], c);
    const cx = pts.reduce((a, p) => a + p[0], 0) / n, cy = pts.reduce((a, p) => a + p[1], 0) / n;
    for (let i = 0; i < n; i += 2) cv.quad([[cx, cy], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]], c);
    return cv;
}
function moulding(cv, x, y, w, h, r, width) {
    for (let k = 0; k < width; k++) cv.strokeRoundRect(x + k, y + k, w - 2 * k, h - 2 * k, Math.max(2, r - k), 1.6, gradAt(CHROME, k / (width - 1)));
}
function glow(cv, cx, cy, r, c, a) { for (let i = 7; i >= 1; i--) cv.circle(cx, cy, r * i / 7, withAlpha(c, a * 0.18)); }
function outlined(cv, s, x, y, size, fill, edge, ew, o) {
    o = Object.assign({ font: 'bold', align: 'center', literal: true }, o || {});
    for (let a = 0; a < 12; a++) cv.text(s, x + Math.cos(a / 12 * 6.283) * ew, y + Math.sin(a / 12 * 6.283) * ew, size, edge, o);
    cv.text(s, x, y, size, fill, o);
}

/* ---------- what's round a circuit: worked out once ---------- */
const geoCache = {};
function geo(track) {
    if (geoCache[track.id]) return geoCache[track.id];
    const S = track.s, N = S.length, W2 = M.WIDTH / 2, b = track.bounds;
    const X0 = b.x0 - MARGIN, Y0 = b.y0 - MARGIN;
    const P = (q, lat) => [q.x + q.nx * lat, q.y + q.ny * lat];
    // the racing line: out, to the apex, out again (where the rubber is)
    const race = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        let c = 0;
        for (let k = -4; k <= 14; k++) c += track.at(i + k).curv;
        race[i] = Math.max(-1, Math.min(1, c / 19 * 80)) * (W2 - 2.2);          // to the inside (+ = right) at the apex
    }
    for (let p = 0; p < 4; p++) for (let i = 0; i < N; i++) race[i] = (race[(i - 1 + N) % N] + race[i] * 2 + race[(i + 1) % N]) / 4;
    const rng = (k) => hash(k, track.length);
    const clear = (x, y, r) => Math.abs(track.nearest(x, y).lat) > W2 + M.RUNOFF + r;
    // the pit building and the grandstands: along the main straight (the first 260 m), each on a side
    const side = (() => { const q = track.at(40); const l = clear(q.x + q.nx * 60, q.y + q.ny * 60, 4), r = clear(q.x - q.nx * 60, q.y - q.ny * 60, 4); return l && !r ? 1 : -1; })();
    const pit = { from: 6, to: 100, side, off: W2 + M.RUNOFF + 7, depth: 12 };
    const stands = [{ from: 20, to: 70, side: -side, off: W2 + M.RUNOFF + 5, depth: 11 }, { from: 76, to: 112, side: -side, off: W2 + M.RUNOFF + 5, depth: 11 }];
    // the hairpins: the tightest corners; a grandstand on the outside of the tightest, braking boards before them
    const corners = [];
    for (let i = 0; i < N; i++) {
        const c = Math.abs(S[i].curv);
        if (c > 0.03 && c >= Math.abs(track.at(i - 1).curv) && c >= Math.abs(track.at(i + 1).curv) && !corners.some((k) => Math.abs(k - i) < 40 || Math.abs(k - i) > N - 40)) corners.push(i);
    }
    const boards = [];
    for (const k of corners) for (const [m, label] of [[75, '3'], [50, '2'], [25, '1']]) {
        const i = (k - m - 12 + N) % N, q = S[i], o = track.at(k).outside;
        boards.push({ i, x: q.x + q.nx * o * (W2 + 4), y: q.y + q.ny * o * (W2 + 4), h: Math.atan2(q.ty, q.tx), label });
    }
    if (corners.length) {
        const k = corners.reduce((a, c) => (Math.abs(S[c].curv) > Math.abs(S[a].curv) ? c : a), corners[0]), o = S[k].outside;
        const fromI = (k - 14 + N) % N;
        stands.push({ from: fromI, to: fromI + 28, side: o, off: W2 + M.RUNOFF + 6, depth: 9 });
    }
    const inStand = (x, y) => [pit].concat(stands).some((st) => { for (let i = st.from; i <= st.to; i += 2) { const q = track.at(i); const [px, py] = P(q, st.side * (st.off + st.depth / 2)); if (Math.hypot(px - x, py - y) < st.depth + 6) return true; } return false; });
    // trees, in clumps, off the run-off
    const trees = [];
    for (let k = 0; k < 260; k++) {
        const cx = X0 + rng(k * 3 + 1) * (b.x1 - b.x0 + 2 * MARGIN), cy = Y0 + rng(k * 3 + 2) * (b.y1 - b.y0 + 2 * MARGIN), n = 2 + Math.floor(rng(k * 3 + 3) * 7);
        for (let j = 0; j < n; j++) {
            const x = cx + (rng(k * 31 + j) - 0.5) * 34, y = cy + (rng(k * 37 + j) - 0.5) * 34, r = 2.4 + rng(k * 41 + j) * 3.2;
            if (!clear(x, y, r + 5) || inStand(x, y)) continue;
            trees.push({ x, y, r, fir: rng(k * 43 + j) < 0.35, tone: rng(k * 47 + j) });
        }
    }
    trees.sort((a, c) => a.y - c.y);
    const g = { X0, Y0, wpx: (b.x1 - b.x0 + 2 * MARGIN) * Z, hpx: (b.y1 - b.y0 + 2 * MARGIN) * Z, race, pit, stands, boards, trees, corners, P };
    geoCache[track.id] = g;
    return g;
}

/* ---------- a tile of the world ---------- */
function tileLayer(track, tx, ty) {
    return lay('lr-tile|' + track.id + '|' + tx + '|' + ty, TILE, TILE, (c) => {
        const g = geo(track), S = track.s, N = S.length, W2 = M.WIDTH / 2;
        const ox = tx * TILE, oy = ty * TILE;                         // the tile's corner, in world px
        const wx = (x) => (x - g.X0) * Z - ox, wy = (y) => (y - g.Y0) * Z - oy;
        const T = ([x, y]) => [wx(x), wy(y)];
        const inTile = (x, y, m) => { const px = wx(x), py = wy(y); return px > -m && px < TILE + m && py > -m && py < TILE + m; };
        // grass: mown in stripes, its grain
        c.fillRect(0, 0, TILE, TILE, '#3a6a2c');
        const band = 12 * Z;
        for (let k = Math.floor(ox / band) - 1; k <= Math.ceil((ox + TILE) / band) + 1; k++) {
            if (k % 2) continue;
            const x = k * band - ox;
            poly(c, [[x, 0], [x + band, 0], [x + band - TILE * 0.3, TILE], [x - TILE * 0.3, TILE]], '#427632');
        }
        for (let i = 0; i < 1400; i++) {
            const x = hash(i, tx * 7 + ty * 13 + 1) * TILE, y = hash(i, tx * 11 + ty * 5 + 2) * TILE, t = hash(i, 3 + tx + ty);
            c.fillRect(x, y, 1.6, 1.6, withAlpha(t < 0.5 ? '#5f9a44' : '#24481c', 0.35));
        }
        // the segments of the circuit that reach this tile (with their run-off)
        const reach = (W2 + M.RUNOFF + 4) * Z;
        const segs = [];
        for (let i = 0; i < N; i++) { const q = S[i]; if (inTile(q.x, q.y, reach + 10)) segs.push(i); }
        const quad = (i, l0, l1, col, j) => { const a = S[i], b2 = track.at(j === undefined ? i + 1 : j); poly(c, [T(g.P(a, l0)), T(g.P(b2, l0)), T(g.P(b2, l1)), T(g.P(a, l1))], col); };
        // gravel traps on the outside of the corners
        for (const i of segs) {
            const q = S[i];
            if (!q.gravel) continue;
            const s = q.gravel;
            quad(i, s * (W2 + M.KERB + 0.5), s * (W2 + M.RUNOFF - 1.5), '#cdbb8c');
            quad(i, s * (W2 + M.RUNOFF - 1.5), s * (W2 + M.RUNOFF - 0.5), '#a8956a');
            for (let k = 0; k < 7; k++) {
                const lat = s * (W2 + M.KERB + 0.8 + hash(i, k) * (M.RUNOFF - 2.6)), along = hash(k, i) * M.STEP;
                const [x, y] = g.P(q, lat);
                c.fillRect(wx(x + q.tx * along), wy(y + q.ty * along), 1.4, 1.4, withAlpha(k % 2 ? '#8a7a56' : '#f2e6c4', 0.8));
            }
        }
        // the asphalt, its grain; the rubber on the racing line
        for (const i of segs) {
            const tone = (hash(i, 9) - 0.5) * 0.04;
            quad(i, -W2 - 0.05, W2 + 0.05, mix('#484b51', tone > 0 ? '#5a5d63' : '#34373c', Math.abs(tone) * 8));
        }
        for (const i of segs) {
            const q = S[i];
            for (let k = 0; k < 9; k++) {
                const [x, y] = g.P(q, (hash(i, k + 20) - 0.5) * (M.WIDTH - 1));
                const along = hash(k + 20, i) * M.STEP;
                c.fillRect(wx(x + q.tx * along), wy(y + q.ty * along), 1.2, 1.2, withAlpha(k % 3 ? '#7a7d84' : '#26282c', 0.5));
            }
        }
        for (const i of segs) {
            const r0 = g.race[i], r1 = g.race[(i + 1) % N], a = S[i], b2 = track.at(i + 1);
            for (const [w, al] of [[2.2, 0.16], [1.2, 0.2]]) poly(c, [T(g.P(a, r0 - w)), T(g.P(b2, r1 - w)), T(g.P(b2, r1 + w)), T(g.P(a, r0 + w))], withAlpha('#141518', al));
        }
        // the white lines at the edges
        for (const i of segs) { quad(i, W2 - 0.6, W2 - 0.15, '#e9ecef'); quad(i, -W2 + 0.15, -W2 + 0.6, '#e9ecef'); }
        // kerbs: red and white blocks, lit along their top
        for (const i of segs) {
            const q = S[i];
            if (!q.kerb) continue;
            const col = Math.floor(i / 2) % 2 ? '#f4f6f8' : '#d4222e';
            for (const s of [1, -1]) {
                quad(i, s * (W2 - 0.1), s * (W2 + M.KERB), col);
                quad(i, s * (W2 + M.KERB - 0.35), s * (W2 + M.KERB), withAlpha('#000000', 0.25));
                quad(i, s * (W2 - 0.1), s * (W2 + 0.25), withAlpha('#ffffff', 0.35));
            }
        }
        // the start: the chequered line, the grid
        if (segs.includes(0) || segs.includes(N - 1)) {
            const q = S[0];
            for (let r = 0; r < 12; r++) for (let k = 0; k < 2; k++) {
                const lat = -W2 + r, al = k * 1 - 1;
                const p = (l, a2) => T([q.x + q.nx * l + q.tx * a2, q.y + q.ny * l + q.ty * a2]);
                poly(c, [p(lat, al), p(lat + 1, al), p(lat + 1, al + 1), p(lat, al + 1)], (r + k) % 2 ? '#ffffff' : '#111214');
            }
            for (let k = 1; k <= 6; k++) {
                const gi = (N - Math.round((M.GRID_BACK + (k - 1) * 8 - 4) / M.STEP)) % N, gq = S[gi], s = k % 2 ? 1 : -1;
                const p = (l, a2) => T([gq.x + gq.nx * l + gq.tx * a2, gq.y + gq.ny * l + gq.ty * a2]);
                poly(c, [p(s * 1.2, 0), p(s * 4.6, 0), p(s * 4.6, 0.35), p(s * 1.2, 0.35)], '#e9ecef');
                poly(c, [p(s * 1.2, 0), p(s * 1.55, 0), p(s * 1.55, -2.4), p(s * 1.2, -2.4)], '#e9ecef');
                poly(c, [p(s * 4.25, 0), p(s * 4.6, 0), p(s * 4.6, -2.4), p(s * 4.25, -2.4)], '#e9ecef');
            }
        }
        // the barriers: tyre walls at the corners, armco along the straights, boards on them
        for (const i of segs) {
            const q = S[i];
            for (const [k, s] of [[0, 1], [1, -1]]) {
                if (!q.wall[k]) continue;
                const lat = s * (W2 + M.RUNOFF);
                if (q.gravel === s || q.kerb) {
                    quad(i, lat - s * 0.2, lat + s * 1.6, withAlpha('#000000', 0.3));
                    quad(i, lat + s * 2.4, lat + s * 2.55, withAlpha('#c9d0da', 0.7));          // the catch fence
                    if (i % 37 === 0) {                                                        // a marshal's post
                        const [x, y] = g.P(q, lat + s * 4), px = wx(x), py = wy(y);
                        c.fillRect(px - 0.9 * Z + 3, py - 0.9 * Z + 4, 1.8 * Z, 1.8 * Z, withAlpha('#000000', 0.35));
                        c.fillRect(px - 0.9 * Z, py - 0.9 * Z, 1.8 * Z, 1.8 * Z, '#f28a1a');
                        c.fillRect(px - 0.9 * Z, py - 0.9 * Z, 1.8 * Z, 0.5 * Z, '#ffd9a0');
                    }
                    for (let r = 0; r < 2; r++) for (let t = 0; t < 3; t++) {
                        const [x, y] = g.P(q, lat + s * r * 0.75), px = wx(x + q.tx * t * 0.67), py = wy(y + q.ty * t * 0.67);
                        if (px < -6 || py < -6 || px > TILE + 6 || py > TILE + 6) continue;
                        c.circle(px + 1.5, py + 2, 0.42 * Z, withAlpha('#000000', 0.35));
                        c.circle(px, py, 0.42 * Z, '#141416');
                        c.circle(px, py, 0.2 * Z, (i * 3 + t) % 6 === 0 ? '#e7222e' : (i * 3 + t) % 6 === 3 ? '#f4f6f8' : '#2a2c30');
                    }
                } else {
                    quad(i, lat + s * 0.6, lat + s * 0.9, withAlpha('#000000', 0.3));
                    quad(i, lat, lat + s * 0.45, '#b9c0c8');
                    quad(i, lat, lat + s * 0.12, '#ffffff');
                    if (i % 3 === 0) { const [x, y] = g.P(q, lat + s * 0.6); c.fillRect(wx(x) - 1, wy(y) - 1, 2, 2, '#5a616c'); }
                    if (i % 20 < 4) {
                        const ins = lat - s * 0.5;
                        quad(i, ins - s * 0.6, ins, i % 40 < 4 ? '#0c0d10' : '#f4f6f8');
                        // a dark board with the three stripes on it
                        if (i % 40 < 4) M3.forEach((col, m) => { const l0 = ins - s * (0.12 + m * 0.14), l1 = l0 - s * 0.1; quad(i, l0, l1, col); });
                    }
                }
            }
        }
        // braking boards before the hairpins
        for (const bd of g.boards) {
            if (!inTile(bd.x, bd.y, 30)) continue;
            const px = wx(bd.x), py = wy(bd.y);
            c.fillRect(px - 5 + 2, py - 4 + 3, 10, 8, withAlpha('#000000', 0.35));
            c.fillRect(px - 5, py - 4, 10, 8, '#f4f6f8');
            c.text(bd.label, px, py + 3, 8, '#111214', { font: 'bold', align: 'center', literal: true });
        }
        // the pit building and the grandstands
        const block = (st, kind) => {
            for (let i = st.from; i < st.to; i++) {
                const a = track.at(i), b2 = track.at(i + 1);
                if (!inTile(a.x, a.y, (st.off + st.depth + 8) * Z)) continue;
                const l0 = st.side * st.off, l1 = st.side * (st.off + st.depth);
                const corners = [T(g.P(a, l0)), T(g.P(b2, l0)), T(g.P(b2, l1)), T(g.P(a, l1))];
                poly(c, corners.map(([x, y]) => [x + 6, y + 8]), withAlpha('#000000', 0.3));
                if (kind === 'pit') {
                    poly(c, corners, '#d9dfe7');
                    const lm = st.side * (st.off + 1.2);
                    poly(c, [T(g.P(a, l0)), T(g.P(b2, l0)), T(g.P(b2, lm)), T(g.P(a, lm))], i % 4 === 0 ? '#2a2e35' : ['#16588e', '#3a3f48', '#e7222e', '#3a3f48'][Math.floor(i / 4) % 4]);
                    poly(c, [T(g.P(a, st.side * (st.off + st.depth - 1))), T(g.P(b2, st.side * (st.off + st.depth - 1))), T(g.P(b2, l1)), T(g.P(a, l1))], '#9aa2ae');
                    // the pit lane's line and wall
                    const wl = st.side * (st.off - 3);
                    poly(c, [T(g.P(a, wl)), T(g.P(b2, wl)), T(g.P(b2, wl - st.side * 0.5)), T(g.P(a, wl - st.side * 0.5))], '#c9d0da');
                } else {
                    poly(c, corners, '#5a616c');
                    for (let r = 0; r < 5; r++) {
                        const la = st.side * (st.off + 1 + r * 1.8), lb = la + st.side * 1.3;
                        for (let k = 0; k < 2; k++) {
                            const f0 = k / 2, f1 = (k + 1) / 2, col = ['#e7222e', '#f4f6f8', '#81c4ff', '#ffd23a', '#16588e', '#2a2e35', '#f2a07a'][Math.floor(hash(i * 2 + k, r + st.from) * 7)];
                            const pa = (f, l) => T([a.x + (b2.x - a.x) * f + a.nx * l, a.y + (b2.y - a.y) * f + a.ny * l]);
                            poly(c, [pa(f0, la), pa(f1, la), pa(f1, lb), pa(f0, lb)], col);
                        }
                    }
                    poly(c, [T(g.P(a, l1 - st.side * 1.4)), T(g.P(b2, l1 - st.side * 1.4)), T(g.P(b2, l1)), T(g.P(a, l1))], '#c9d0da');
                }
            }
        };
        block(g.pit, 'pit');
        g.stands.forEach((st) => block(st, 'stand'));
        // trees, with their shadows
        for (const t of g.trees) {
            if (!inTile(t.x, t.y, (t.r + 4) * Z)) continue;
            const px = wx(t.x), py = wy(t.y), r = t.r * Z;
            c.circle(px + r * 0.5, py + r * 0.65, r * 1.02, withAlpha('#0c1a08', 0.45));
            if (t.fir) {
                for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; poly(c, [[px, py], [px + Math.cos(a) * r, py + Math.sin(a) * r], [px + Math.cos(a + 0.4) * r * 0.55, py + Math.sin(a + 0.4) * r * 0.55]], mix('#1a3a1e', '#2a5a2a', (Math.cos(a + 2.4) + 1) / 2)); }
                c.circle(px, py, r * 0.22, '#2a4a24');
            } else {
                const base = mix('#26502a', '#3a6a30', t.tone);
                c.circle(px, py, r, mix(base, '#000000', 0.25));
                for (let k = 0; k < 5; k++) c.circle(px + (hash(k, t.x) - 0.5) * r * 0.9, py + (hash(t.y, k) - 0.5) * r * 0.9, r * 0.55, mix(base, '#5a8a40', 0.15 + k * 0.08));
                c.circle(px - r * 0.3, py - r * 0.35, r * 0.4, withAlpha('#9ac870', 0.3));
            }
        }
    });
}
/** the world under the camera: the tiles it covers */
function drawWorld(cv, track, cam) {
    const g = geo(track);
    const px = (cam.x - g.X0) * Z - BOARD.w / 2, py = (cam.y - g.Y0) * Z - BOARD.h / 2;
    for (let ty = Math.floor(py / TILE); ty <= Math.floor((py + BOARD.h) / TILE); ty++) {
        for (let tx = Math.floor(px / TILE); tx <= Math.floor((px + BOARD.w) / TILE); tx++) {
            cv.blit(tileLayer(track, tx, ty), BOARD.x + tx * TILE - px, BOARD.y + ty * TILE - py);
        }
    }
}
/** world (m) to the page (px), for this camera */
const toScreen = (cam) => (x, y) => [BOARD.x + BOARD.w / 2 + (x - cam.x) * Z, BOARD.y + BOARD.h / 2 + (y - cam.y) * Z];

/* ---------- the car from above: a sport sedan ---------- */
function drawCar(cv, sx, sy, h, o) {
    o = o || {};
    const P = PAINTS[o.paint] || PAINTS.blue, k = Z * 0.5, c = Math.cos(h), s = Math.sin(h);
    const R = (pts) => pts.map(([x, y]) => [sx + (x * c - y * s) * k, sy + (x * s + y * c) * k]);
    const F = (pts, col) => poly(cv, R(pts), col);
    const ghost = !!o.ghost, a = ghost ? 0.38 : 1, tint = (col) => (ghost ? withAlpha('#9ac8ff', a) : col);
    // local units: half metres; x forward, y to the right. 4.7 m x 1.9 m
    if (!ghost) F([[-4.4, -1.7], [4.8, -1.7], [4.8, 2.3], [-4.4, 2.3]].map(([x, y]) => [x + 0.5, y + 0.9]), withAlpha('#000000', 0.38));
    // the wheels: the front ones steered
    const st = (o.steer || 0) * 0.45;
    for (const [wx, front] of [[3, true], [-2.9, false]]) for (const wy of [-1.85, 1.85]) {
        const cs = Math.cos(front ? st : 0), sn = Math.sin(front ? st : 0);
        F([[-0.75, -0.32], [0.75, -0.32], [0.75, 0.32], [-0.75, 0.32]].map(([x, y]) => [wx + x * cs - y * sn, wy + x * sn + y * cs]), ghost ? withAlpha('#9ac8ff', 0.2) : '#0b0b0d');
    }
    // the body: a long bonnet, the cabin set back, a short tail
    F([[-4.55, -1.6], [-4.3, -1.85], [3.6, -1.85], [4.5, -1.45], [4.7, -0.7], [4.7, 0.7], [4.5, 1.45], [3.6, 1.85], [-4.3, 1.85], [-4.55, 1.6]], tint(P[2]));
    F([[-4.35, -1.45], [-4.1, -1.65], [3.4, -1.65], [4.3, -1.3], [4.45, -0.6], [4.45, 0.6], [4.3, 1.3], [3.4, 1.65], [-4.1, 1.65], [-4.35, 1.45]], tint(P[1]));
    // the bonnet's power bulge, lit
    F([[1.4, -0.55], [4.0, -0.4], [4.0, 0.4], [1.4, 0.55]], tint(mix(P[1], P[0], 0.5)));
    F([[1.6, -0.15], [3.9, -0.12], [3.9, 0.12], [1.6, 0.15]], tint(P[0]));
    if (!ghost) {
        // the glass: the windscreen, the carbon roof, the rear window; the side windows' edges
        F([[0.4, -1.45], [1.55, -1.25], [1.55, 1.25], [0.4, 1.45]], '#101820');
        F([[0.55, -1.2], [1.35, -1.05], [1.35, -0.4], [0.55, -0.5]], withAlpha('#8ab4ff', 0.25));
        F([[-1.9, -1.35], [0.4, -1.35], [0.4, 1.35], [-1.9, 1.35]], '#1c1e22');
        for (let i = 0; i < 5; i++) F([[-1.8 + i * 0.45, -1.3], [-1.6 + i * 0.45, -1.3], [-1.6 + i * 0.45, 1.3], [-1.8 + i * 0.45, 1.3]], withAlpha('#3a3d44', 0.6));
        F([[-2.9, -1.3], [-1.9, -1.35], [-1.9, 1.35], [-2.9, 1.3]], '#101820');
        F([[-2.75, -1.1], [-2.1, -1.15], [-2.1, -0.5], [-2.75, -0.45]], withAlpha('#8ab4ff', 0.2));
        // the boot's lip spoiler, the mirrors
        F([[-4.4, -1.5], [-4.0, -1.5], [-4.0, 1.5], [-4.4, 1.5]], '#16181c');
        F([[0.9, -1.85], [1.4, -1.85], [1.3, -2.35], [0.95, -2.3]], '#16181c');
        F([[0.9, 1.85], [1.4, 1.85], [1.3, 2.35], [0.95, 2.3]], '#16181c');
        // lights: the headlights; the tail lights, bright when braking
        F([[4.15, -1.45], [4.6, -1.0], [4.5, -0.8], [4.05, -1.15]], '#eaf6ff');
        F([[4.15, 1.45], [4.6, 1.0], [4.5, 0.8], [4.05, 1.15]], '#eaf6ff');
        const tl = o.braking ? '#ff3a44' : '#8a0a12';
        F([[-4.5, -1.55], [-4.2, -1.65], [-4.2, -0.95], [-4.5, -1.0]], tl);
        F([[-4.5, 1.55], [-4.2, 1.65], [-4.2, 0.95], [-4.5, 1.0]], tl);
        if (o.braking) for (const y of [-1.3, 1.3]) { const p = R([[-4.7, y]])[0]; glow(cv, p[0], p[1], 5, '#ff2a3a', 0.6); }
    }
}

/* ---------- the panel ---------- */
function panelLayer() {
    return lay('lr-panel', PANEL.w, PANEL.h, (c) => {
        const ox = -PANEL.x, oy = -PANEL.y, w = PANEL.w, h = PANEL.h;
        c.card(0, 0, w, h, 22, [[0, '#24242c'], [0.5, '#121218'], [1, '#08080b']]);
        for (let i = 0; i < 88; i++) c.fillRect(8, 12 + i * 5, w - 16, 1, withAlpha(i % 3 ? '#ffffff' : '#000000', 0.018));
        moulding(c, 0, 0, w, h, 22, 8);
        const lcd = (x, y, lw, lh, label, size) => {
            c.text(label, x + 4, y - 9, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, literal: true });
            moulding(c, x - 4, y - 4, lw + 8, lh + 8, 13, 4);
            c.card(x, y, lw, lh, 10, [[0, '#050608'], [1, '#101318']]);
            c.gradientRect(x + 4, y + 3, lw - 8, 12, [[0, withAlpha('#ffffff', 0.07)], [1, withAlpha('#ffffff', 0)]]);
            c.text('8:88.888', x + lw - 14, y + lh / 2 + size * 0.36, size, withAlpha('#ffffff', 0.035), { font: 'num', align: 'right', literal: true });
        };
        lcd(24, 34, w - 48, 58, 'LAP TIME', 40);
        lcd(24, 124, (w - 60) / 2, 46, 'BEST', 28);
        lcd(36 + (w - 60) / 2, 124, (w - 60) / 2, 46, 'GAP TO BEST', 28);
        c.text('SECTORS', 26, 200, 14, withAlpha('#ffffff', 0.55), { font: 'label', spacing: 2, literal: true });
        // the map's frame
        const mx = MAP.x + ox, my = MAP.y + oy;
        moulding(c, mx - 4, my - 4, MAP.w + 8, MAP.h + 8, 12, 3);
        c.card(mx, my, MAP.w, MAP.h, 9, [[0, '#0a1410'], [1, '#050806']]);
        c.text('km/h', 26 + 112, 318, 14, withAlpha('#ffffff', 0.5), { font: 'label', literal: true });
        c.text('GEAR', 172, 332, 11, withAlpha('#ffffff', 0.5), { font: 'label', spacing: 1, literal: true });
    });
}
/** the circuit's map: its line, the start, scaled into the map's frame */
function mapGeo(track) {
    const b = track.bounds, k = Math.min((MAP.w - 20) / (b.x1 - b.x0), (MAP.h - 20) / (b.y1 - b.y0));
    const ox = MAP.x + (MAP.w - (b.x1 - b.x0) * k) / 2, oy = MAP.y + (MAP.h - (b.y1 - b.y0) * k) / 2;
    return { at: (x, y) => [ox + (x - b.x0) * k, oy + (y - b.y0) * k] };
}
function mapLayer(track) {
    return lay('lr-map|' + track.id, MAP.w, MAP.h, (c) => {
        const m = mapGeo(track);
        for (const [w, col] of [[5, '#2a2e35'], [2.4, '#c9d0da']]) for (let i = 0; i < track.s.length; i += 2) {
            const a = m.at(track.s[i].x, track.s[i].y), b = m.at(track.at(i + 2).x, track.at(i + 2).y);
            c.line(a[0] - MAP.x, a[1] - MAP.y, b[0] - MAP.x, b[1] - MAP.y, w, col);
        }
        const s0 = m.at(track.s[0].x, track.s[0].y);
        c.fillRect(s0[0] - MAP.x - 1.5, s0[1] - MAP.y - 5, 3, 10, '#ffffff');
    });
}
function pedalLayer(kind, state) {
    const B = PEDALS[0];
    return lay('lr-pedal|' + kind + '|' + state, B.w + 4, B.h + 6, (c) => {
        const d = state === 'down' ? 2 : 0, col = kind === 'gas' ? '#5ff0a6' : '#ff5a5f';
        c.roundRect(4, 6, B.w - 2, B.h - 2, 12, withAlpha('#000000', 0.5));
        c.card(2, 2 + d, B.w, B.h - d, 12, state === 'down' ? [[0, mix(col, '#000000', 0.5)], [1, mix(col, '#000000', 0.75)]] : [[0, '#323944'], [1, '#161a21']]);
        c.strokeRoundRect(2, 2 + d, B.w, B.h - d, 12, 1.5, withAlpha(col, state === 'down' ? 0.9 : 0.35));
        for (let i = 0; i < 4; i++) c.fillRect(16, 12 + d + i * 8, B.w - 28, 3, withAlpha('#ffffff', 0.06));
        c.text(kind === 'gas' ? 'GAS' : 'BRAKE', 2 + B.w / 2, 2 + d + B.h / 2 + 7, 18, state === 'off' ? withAlpha('#ffffff', 0.3) : '#ffffff', { font: 'bold', align: 'center', spacing: 2, literal: true });
    });
}

module.exports = {
    setTextScale, BOARD, PANEL, PEDALS, MAP, Z, PAINTS, SECTOR_C, M3,
    geo, tileLayer, drawWorld, toScreen, drawCar, panelLayer, mapLayer, mapGeo, pedalLayer, glow, outlined, poly,
};
