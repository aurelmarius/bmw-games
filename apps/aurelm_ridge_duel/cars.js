'use strict';
/**
 * Cars seen from the side, drawn as real silhouettes: any polygon (arches cut in, curves) filled row by
 * row with anti-aliased edges, the paint shaded by height (sky in the roof, a highlight on the shoulder
 * line, the ground's dark at the sills). A generic sport SUV and a generic full-size pick-up; no make's
 * badge or grille on either.
 *
 * In the game each car is drawn once into a layer for each tilt it stands at; its gun turns, so it's drawn
 * per frame (art.js).
 *
 * Local units: x forward (the car faces +x), y up is negative, 0 is the ground under the wheels.
 */
const { withAlpha, mix, rgba } = require('./kit/canvas');

function gradAt(stops, t) {
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
    return mix(a[1], b[1], b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))));
}
/** a convex polygon: the canvas fills it; the GPU recorder takes quads (a fan of them) */
function convex(cv, pts, c) {
    if (cv.convex) return cv.convex(pts, c);
    const n = pts.length;
    if (n === 4) return cv.quad(pts, c);
    if (n === 3) return cv.quad([pts[0], pts[1], [(pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2], pts[2]], c);
    const cx = pts.reduce((a, p) => a + p[0], 0) / n, cy = pts.reduce((a, p) => a + p[1], 0) / n;
    for (let i = 0; i < n; i += 2) cv.quad([[cx, cy], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]], c);
    return cv;
}

/* ---------- shapes ---------- */
const arc = (cx, cy, r, t0, t1, n) => { const o = []; n = n || 18; for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * i / n; o.push([cx + Math.cos(t) * r, cy - Math.sin(t) * r]); } return o; };
const quad = (a, c, b, n) => { const o = []; n = n || 10; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; o.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]); } return o; };
/** the bottom edge between the bumpers, with the wheel arches cut in (front to rear) */
function sills(front, rear, wf, wr, r, wy, sill) {
    // (the sill is below the wheel's centre: the arch starts and ends there, a little under the centre)
    const k = Math.asin(Math.min(1, (sill - wy) / r));
    return [[front, sill]].concat(arc(wf, wy, r, -k, Math.PI + k), arc(wr, wy, r, -k, Math.PI + k), [[rear, sill]]);
}

/* ---------- filling any polygon, anti-aliased, its colour by local height ---------- */
function makeXf(o) {
    const c = Math.cos(o.a || 0), s = Math.sin(o.a || 0), k = o.s || 1, m = o.flip ? -1 : 1;
    const to = ([x, y]) => [o.x + (x * m * c - y * s) * k, o.y + (x * m * s + y * c) * k];
    const back = (X, Y) => { const dx = (X - o.x) / k, dy = (Y - o.y) / k; return [(dx * c + dy * s) * m, -dx * s + dy * c]; };
    return { to, back, k };
}
function fillPoly(cv, xf, pts, color) {
    const P = pts.map(xf.to);
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (const [x, y] of P) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    const ox = Math.floor(x0) - 1, W = Math.ceil(x1) - ox + 2, cov = new Float32Array(W), SUB = 4;
    for (let py = Math.floor(y0); py <= Math.ceil(y1); py++) {
        cov.fill(0);
        for (let k = 0; k < SUB; k++) {
            const sy = py + (k + 0.5) / SUB, xs = [];
            for (let i = 0; i < P.length; i++) {
                const a = P[i], b = P[(i + 1) % P.length];
                if ((a[1] <= sy) !== (b[1] <= sy)) xs.push(a[0] + (sy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
            }
            xs.sort((p, q) => p - q);
            for (let j = 0; j + 1 < xs.length; j += 2) {
                const l = xs[j] - ox, r = xs[j + 1] - ox, li = Math.floor(l), ri = Math.floor(r);
                if (li === ri) { cov[li] += (r - l) / SUB; continue; }
                cov[li] += (li + 1 - l) / SUB;
                for (let q = li + 1; q < ri; q++) cov[q] += 1 / SUB;
                if (ri < W) cov[ri] += (r - ri) / SUB;
            }
        }
        // runs of full pixels in one rect, the edges one by one
        let q = 0;
        while (q < W) {
            if (cov[q] <= 0.002) { q++; continue; }
            const col = typeof color === 'function' ? color(xf.back(ox + q + 0.5, py + 0.5)[1], xf.back(ox + q + 0.5, py + 0.5)[0]) : color;
            if (cov[q] >= 0.998) { let e = q; while (e < W && cov[e] >= 0.998) e++; cv.fillRect(ox + q, py, e - q, 1, col); q = e; continue; }
            const c = Array.isArray(col) ? col : rgba(col);
            cv.fillRect(ox + q, py, 1, 1, [c[0], c[1], c[2], (c[3] === undefined ? 255 : c[3]) * Math.min(1, cov[q])]);
            q++;
        }
    }
}
const line = (cv, xf, a, b, w, c) => { const p = xf.to(a), q = xf.to(b); cv.line(p[0], p[1], q[0], q[1], w * xf.k, c); };
const circle = (cv, xf, p, r, c) => { const q = xf.to(p); cv.circle(q[0], q[1], r * xf.k, c); };

/* ---------- a wheel: tyre with its sidewall, a multi-spoke rim, the disc and the caliper ---------- */
function wheel(cv, xf, cx, cy, R, o) {
    o = o || {};
    const c = xf.to([cx, cy]), k = xf.k;
    cv.circle(c[0], c[1], R * k, '#0b0b0d');
    for (let i = 0; i < 6; i++) cv.arc(c[0], c[1], R * k * (0.78 + i * 0.035), R * k * (0.8 + i * 0.035), 0, 360, withAlpha('#3a3d44', 0.25));
    if (o.tread) for (let i = 0; i < 28; i++) { const t = i / 28 * Math.PI * 2; convex(cv, [[c[0] + Math.cos(t - 0.05) * R * k, c[1] + Math.sin(t - 0.05) * R * k], [c[0] + Math.cos(t + 0.05) * R * k, c[1] + Math.sin(t + 0.05) * R * k], [c[0] + Math.cos(t + 0.05) * (R + 2.2) * k, c[1] + Math.sin(t + 0.05) * (R + 2.2) * k], [c[0] + Math.cos(t - 0.05) * (R + 2.2) * k, c[1] + Math.sin(t - 0.05) * (R + 2.2) * k]], '#0b0b0d'); }
    const rr = R * (o.rim || 0.68) * k;
    cv.circle(c[0], c[1], rr + 1.2, o.rimEdge || '#8a919c');
    cv.circle(c[0], c[1], rr, o.dark ? '#1a1c20' : '#24272c');
    // the brake disc and caliper behind the spokes
    cv.circle(c[0], c[1], rr * 0.86, '#5a5f68');
    cv.arc(c[0], c[1], rr * 0.5, rr * 0.84, 0, 360, withAlpha('#9aa0a8', 0.35));
    cv.arc(c[0], c[1], rr * 0.62, rr * 0.86, -60, 10, o.caliper || '#1f5fc4', { round: true });
    // spokes: a double spoke each, lit on the top
    const n = o.spokes || 10;
    for (let i = 0; i < n; i++) {
        const t = i / n * Math.PI * 2 + (o.turn || 0), w = 0.09;
        const p = (a, r) => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
        const lit = 0.5 - 0.5 * Math.sin(t);
        convex(cv, [p(t - w * 1.6, rr * 0.3), p(t + w * 1.6, rr * 0.3), p(t + w * 0.7, rr * 0.98), p(t - w * 0.7, rr * 0.98)], mix(o.dark ? '#3a3e46' : '#9aa2ae', o.dark ? '#7a808a' : '#f4f6f8', lit));
    }
    cv.circle(c[0], c[1], rr * 0.3, o.dark ? '#2a2d33' : '#c9d0da');
    cv.circle(c[0], c[1], rr * 0.14, '#16181c');
    // the light from above on the tyre's shoulder
    cv.arc(c[0], c[1], R * k * 0.9, R * k * 0.98, 300, 400, withAlpha('#ffffff', 0.08));
}

/* ---------- the details both of our cars share ---------- */
function shadowUnder(cv, xf, len) { for (let i = 6; i >= 1; i--) fillPoly(cv, xf, arc(0, 2, 1, 0, Math.PI * 2, 24).map(([x, y]) => [x * (len + i * 4), 2 + (y - 2) * (5 + i)]), withAlpha('#000000', 0.08)); }
function wells(cv, xf, wxs, wy, r, sill) {
    for (const wx of wxs) {
        const k = Math.asin((sill - wy) / r);
        fillPoly(cv, xf, arc(wx, wy, r + 0.5, -k, Math.PI + k, 24), '#08090b');
        fillPoly(cv, xf, arc(wx, wy, r - 1, 0.5, Math.PI - 0.5, 16).concat(arc(wx, wy, r - 5, Math.PI - 0.5, 0.5, 16)), '#16181c');
    }
}
/** the gill behind the front wheel: a dark slot in a chrome frame (the stripes in it, small) */
function gill(cv, xf, x, y) {
    fillPoly(cv, xf, [[x, y], [x + 9, y - 1], [x + 8, y + 7], [x - 1, y + 8]], '#c9d0da');
    fillPoly(cv, xf, [[x + 1, y + 1], [x + 8, y], [x + 7, y + 6], [x, y + 7]], '#0b0c0f');
    ['#81c4ff', '#16588e', '#e7222e'].forEach((c, i) => fillPoly(cv, xf, [[x + 2 + i * 1.8, y + 2], [x + 3.4 + i * 1.8, y + 2], [x + 3.2 + i * 1.8, y + 3], [x + 1.8 + i * 1.8, y + 3]], c));
}
/** four tailpipes, two seen: a pair under the rear bumper */
function pipes(cv, xf, x, y) { for (const dx of [0, 7]) { const p = xf.to([x + dx, y]); cv.circle(p[0], p[1], 2.6 * xf.k, '#c9d0da'); cv.circle(p[0], p[1], 1.8 * xf.k, '#16181c'); } }
const glassShade = (top, bottom) => (y) => gradAt([[top, '#3a4a66'], [top + (bottom - top) * 0.45, '#16202e'], [bottom, '#0a0e14']], y);

/* ---------- the performance SUV (the X5 M kind of car): upright, long roof, a roof spoiler, big wheels ---------- */
function suv(cv, o) {
    const xf = makeXf(o);
    const paint = o.paint || ['#ffffff', '#e9edf2', '#b9c0c8', '#5a6270'];
    const body = [[-98, -16], [-103, -22], [-104, -38], [-103, -54]].concat(quad([-103, -54], [-102, -70], [-92, -78], 6), [[-80, -81]],
        [[8, -82]], quad([8, -82], [18, -81], [28, -73], 4), quad([28, -73], [38, -63], [50, -59], 4), quad([50, -59], [80, -57], [95, -51], 6),
        quad([95, -51], [104, -47], [105, -34], 4), [[105, -22], [100, -16]]);
    const outline = body.concat(sills(92, -92, 64, -64, 28, -22, -15).slice(1, -1));
    shadowUnder(cv, xf, 100);
    const shade = (y) => gradAt([[-82, paint[0]], [-64, paint[1]], [-58, mix(paint[0], '#ffffff', 0.7)], [-55, paint[1]], [-42, paint[2]], [-26, paint[2]], [-15, paint[3]]], y);
    fillPoly(cv, xf, outline, shade);
    // the roof spoiler over the tailgate, the black roof rails
    fillPoly(cv, xf, [[-104, -76], [-90, -80], [-80, -81], [-84, -77], [-100, -73]], '#0b0c0f');
    line(cv, xf, [-74, -83.5], [2, -84.5], 1.8, '#16181c');
    for (const x of [-64, -16]) line(cv, xf, [x, -82], [x, -84], 1.8, '#0b0c0f');
    // the glass, with the kink at the back of the last window
    const glass = [[-90, -61], [-96, -63], [-94, -69], [-86, -75], [6, -76], [16, -75], [36, -61]];
    fillPoly(cv, xf, glass, glassShade(-76, -61));
    fillPoly(cv, xf, [[-60, -75], [-44, -75], [-58, -62], [-74, -62]], withAlpha('#c8dcff', 0.12));
    fillPoly(cv, xf, [[-34, -76], [-26, -76], [-40, -62], [-48, -62]], withAlpha('#c8dcff', 0.08));
    // pillars and the window trim in gloss black (no chrome on this one)
    fillPoly(cv, xf, [[-24, -76], [-17, -76], [-17, -61], [-24, -61]], '#0b0c0f');
    fillPoly(cv, xf, [[-80, -75], [-72, -75], [-78, -61], [-86, -61]], '#0b0c0f');
    line(cv, xf, [-96, -60], [36, -60], 1.3, '#0b0c0f');
    // the mirror (in black), the doors, handles, the shoulder and the lower lines
    fillPoly(cv, xf, [[36, -61], [43, -62], [49, -58], [45, -56], [36, -57]], '#0b0c0f');
    for (const [a, b] of [[[-22, -60], [-22, -20]], [[34, -59], [32, -26]], [[-78, -60], [-82, -47]]]) line(cv, xf, a, b, 0.7, withAlpha('#2a2e35', 0.8));
    for (const x of [-38, 18]) { fillPoly(cv, xf, [[x, -53], [x + 9, -53], [x + 9, -51.5], [x, -51.5]], shade(-58)); line(cv, xf, [x, -51.3], [x + 9, -51.3], 0.6, withAlpha('#000000', 0.45)); }
    line(cv, xf, [-102, -36], [102, -33], 0.9, withAlpha('#5a6270', 0.55));
    gill(cv, xf, 40, -42);
    // a sculpted side skirt, black; the rear diffuser
    fillPoly(cv, xf, [[-90, -21], [88, -21], [86, -16], [-89, -16]], '#0b0c0f');
    fillPoly(cv, xf, [[-104, -22], [-92, -22], [-92, -15], [-100, -15]], '#16181c');
    // lights: a slim headlight with its daytime line; a long tail light into the tailgate
    fillPoly(cv, xf, [[86, -52], [102, -46], [103, -42], [90, -45]], '#0e1218');
    line(cv, xf, [88, -49], [101, -45], 1.4, '#eaf6ff');
    fillPoly(cv, xf, [[-104, -52], [-90, -54], [-88, -49], [-104, -47]], '#7a0a12');
    line(cv, xf, [-103, -51], [-90, -52.5], 1.2, '#ff3a44');
    pipes(cv, xf, -101, -17);
    wells(cv, xf, [64, -64], -22, 28, -15);
    wheel(cv, xf, 64, -21, 21, { caliper: '#1f5fc4', spokes: 10, rim: 0.74, turn: 0.3 });
    wheel(cv, xf, -64, -21, 21, { caliper: '#1f5fc4', spokes: 10, rim: 0.74, turn: 0.9 });
    return xf;
}

/* ---------- the sport sedan (the M3 kind of car): low, long bonnet, a short tail with a lip spoiler ---------- */
function sedan(cv, o) {
    const xf = makeXf(o);
    const paint = o.paint || ['#7fb0ff', '#3f7fe0', '#1f56b4', '#0c2a5c'];
    const body = [[-96, -9], [-101, -14], [-102, -27], [-100, -36]].concat([[-102, -42], [-98, -44]], quad([-98, -44], [-86, -44], [-72, -45], 3),
        quad([-72, -45], [-58, -55], [-42, -60], 6), [[2, -61]], quad([2, -61], [14, -60], [24, -53], 4), quad([24, -53], [32, -46], [44, -43], 4),
        quad([44, -43], [76, -41], [94, -36], 6), quad([94, -36], [103, -33], [104, -24], 4), [[103, -14], [97, -9]]);
    const outline = body.concat(sills(84, -84, 60, -60, 23, -17, -9).slice(1, -1));
    shadowUnder(cv, xf, 96);
    const shade = (y) => gradAt([[-61, paint[0]], [-48, paint[1]], [-41, mix(paint[0], '#ffffff', 0.6)], [-38, paint[1]], [-28, paint[2]], [-18, paint[2]], [-9, paint[3]]], y);
    fillPoly(cv, xf, outline, shade);
    // the carbon roof
    fillPoly(cv, xf, [[-42, -60.2], [2, -61.2], [8, -60.6], [6, -58.6], [-40, -57.8]], (y) => gradAt([[-61, '#3a3d44'], [-58, '#16181c']], y));
    for (let i = 0; i < 9; i++) line(cv, xf, [-38 + i * 5, -60], [-36 + i * 5, -58.5], 0.5, withAlpha('#ffffff', 0.08));
    // the glass, the kink at the back of the rear window
    const glass = [[-56, -43], [-63, -45], [-59, -50], [-44, -57], [2, -58], [12, -57], [30, -44]];
    fillPoly(cv, xf, glass, glassShade(-58, -43));
    fillPoly(cv, xf, [[-34, -57], [-22, -57], [-34, -44], [-46, -44]], withAlpha('#c8dcff', 0.12));
    fillPoly(cv, xf, [[-12, -58], [-6, -58], [-18, -44], [-24, -44]], withAlpha('#c8dcff', 0.08));
    fillPoly(cv, xf, [[-16, -58], [-10, -58], [-10, -43], [-16, -43]], '#0b0c0f');
    line(cv, xf, [-62, -42.5], [30, -42.5], 1.2, '#0b0c0f');
    // the carbon mirror, doors, handles, the shoulder line and the sill's crease
    fillPoly(cv, xf, [[30, -45], [37, -46], [42, -42], [38, -40], [30, -41]], '#16181c');
    for (const [a, b] of [[[-14, -43], [-14, -12]], [[28, -42], [27, -18]], [[-58, -42], [-63, -24]]]) line(cv, xf, a, b, 0.7, withAlpha(paint[3], 0.9));
    for (const x of [-32, 10]) { fillPoly(cv, xf, [[x, -37], [x + 8, -37], [x + 8, -35.8], [x, -35.8]], shade(-42)); line(cv, xf, [x, -35.6], [x + 8, -35.6], 0.6, withAlpha('#000000', 0.5)); }
    line(cv, xf, [-100, -30], [98, -27], 0.9, withAlpha(paint[3], 0.7));
    gill(cv, xf, 33, -30);
    // the side skirt with its carbon blade, the diffuser, the lip spoiler
    fillPoly(cv, xf, [[-82, -14], [80, -14], [79, -9.5], [-81, -9.5]], '#0b0c0f');
    fillPoly(cv, xf, [[-102, -15], [-86, -15], [-88, -8], [-98, -8]], '#16181c');
    fillPoly(cv, xf, [[-101, -42], [-94, -44.5], [-90, -44], [-98, -41.5]], '#16181c');
    // lights: a sharp headlight, an L-shaped tail light
    fillPoly(cv, xf, [[84, -38], [100, -34], [101, -30], [88, -32]], '#0e1218');
    line(cv, xf, [86, -36], [99, -33], 1.3, '#eaf6ff');
    fillPoly(cv, xf, [[-102, -40], [-90, -42], [-90, -37], [-96, -36], [-101, -35]], '#7a0a12');
    line(cv, xf, [-101, -39], [-91, -40.5], 1.1, '#ff3a44');
    line(cv, xf, [-96, -36.5], [-91, -37.5], 1.1, '#ff3a44');
    pipes(cv, xf, -99, -10);
    wells(cv, xf, [60, -60], -17, 23, -9);
    wheel(cv, xf, 60, -17, 18, { caliper: '#1f5fc4', spokes: 10, rim: 0.76, turn: 0.4, rimEdge: '#5a5f68', dark: true });
    wheel(cv, xf, -60, -17, 18, { caliper: '#1f5fc4', spokes: 10, rim: 0.76, turn: 1.2, rimEdge: '#5a5f68', dark: true });
    return xf;
}

/* ---------- a full-size pick-up ---------- */
function pickup(cv, o) {
    const xf = makeXf(o);
    const paint = o.paint || ['#5a606a', '#3a3f48', '#2a2e35', '#16181c'];
    const top = [[-112, -18], [-114, -24], [-114, -64], [-110, -66], [-48, -66], [-46, -64], [-44, -92]].concat(quad([-44, -92], [-42, -97], [-34, -97], 3),
        [[16, -97]], quad([16, -97], [24, -96], [30, -90], 3), [[46, -70]], quad([46, -70], [50, -67], [60, -67], 3), [[104, -66], [110, -62], [112, -40], [112, -26], [108, -18]]);
    const outline = top.concat(sills(103, -103, 74, -72, 31, -24, -18).slice(1, -1));
    for (let i = 6; i >= 1; i--) fillPoly(cv, xf, arc(0, 2, 1, 0, Math.PI * 2, 24).map(([x, y]) => [x * (110 + i * 4), 2 + (y - 2) * (5 + i)]), withAlpha('#000000', 0.08));
    const shade = (y) => gradAt([[-97, paint[0]], [-80, paint[1]], [-67, '#9aa2ae'], [-63, paint[1]], [-45, paint[2]], [-30, paint[2]], [-18, paint[3]]], y);
    fillPoly(cv, xf, outline, shade);
    // the bed's top rail, the tailgate's handle
    fillPoly(cv, xf, [[-112, -66], [-48, -66], [-48, -63], [-112, -63]], '#16181c');
    fillPoly(cv, xf, [[-114, -52], [-112, -52], [-112, -46], [-114, -46]], '#9aa0a8');
    // the cab's glass and pillars
    fillPoly(cv, xf, [[-40, -70], [-38, -90], [-32, -93], [16, -93], [26, -86], [40, -70]], (y) => gradAt([[-93, '#3a4a66'], [-84, '#16202e'], [-70, '#0a0e14']], y));
    fillPoly(cv, xf, [[-6, -93], [0, -93], [0, -70], [-6, -70]], '#0b0c0f');
    fillPoly(cv, xf, [[-30, -92], [-20, -92], [-32, -72], [-40, -72]], withAlpha('#c8dcff', 0.1));
    line(cv, xf, [-40, -69], [42, -69], 1.2, '#16181c');
    fillPoly(cv, xf, [[40, -71], [47, -73], [52, -66], [44, -64]], '#16181c');                 // the big mirror
    // doors, handles, the step bar, chunky arch flares
    for (const [a, b] of [[[-3, -69], [-3, -24]], [[-44, -66], [-44, -24]], [[42, -68], [40, -30]]]) line(cv, xf, a, b, 0.8, withAlpha('#0b0c0f', 0.9));
    for (const x of [-16, 26]) fillPoly(cv, xf, [[x, -62], [x + 10, -62], [x + 10, -60], [x, -60]], '#16181c');
    fillPoly(cv, xf, [[-40, -19], [40, -19], [40, -15], [-40, -15]], '#2a2d33');
    for (const [wx, wy] of [[74, -24], [-72, -24]]) {
        const k = Math.asin(6 / 31);
        fillPoly(cv, xf, arc(wx, wy, 31.5, -k, Math.PI + k, 24), '#08090b');
        // a fender flare that follows the arch and sits on the body
        fillPoly(cv, xf, arc(wx, wy, 35, -k, Math.PI + k, 22).concat(arc(wx, wy, 30.5, Math.PI + k, -k, 22)), (y) => gradAt([[wy - 35, '#2a2d33'], [wy - 10, '#0d0e11']], y));
    }
    // a tall grille of plain bars, the headlight, the tail light, a light bar on the roof
    fillPoly(cv, xf, [[104, -64], [112, -60], [112, -38], [104, -38]], '#0b0c0f');
    for (let i = 0; i < 5; i++) line(cv, xf, [105, -60 + i * 5], [112, -58 + i * 5], 1, '#5a5f68');
    fillPoly(cv, xf, [[96, -64], [106, -63], [105, -56], [96, -57]], '#e8eef6');
    fillPoly(cv, xf, [[-115, -62], [-112, -62], [-112, -48], [-115, -48]], '#c4161e');
    fillPoly(cv, xf, [[-30, -100], [12, -100], [12, -97], [-30, -97]], '#16181c');
    for (let i = 0; i < 7; i++) fillPoly(cv, xf, [[-28 + i * 6, -99.5], [-24 + i * 6, -99.5], [-24 + i * 6, -97.5], [-28 + i * 6, -97.5]], '#ffe7a0');
    line(cv, xf, [-112, -40], [110, -38], 0.8, withAlpha('#7a808a', 0.5));
    o.stripe && fillPoly(cv, xf, [[-110, -36], [100, -34], [100, -31], [-110, -33]], o.stripe);
    wheel(cv, xf, 74, -22, 22, { tread: true, rim: 0.6, dark: true, caliper: '#c4161e', spokes: 6, turn: 0.2, rimEdge: '#3a3d44' });
    wheel(cv, xf, -72, -22, 22, { tread: true, rim: 0.6, dark: true, caliper: '#c4161e', spokes: 6, turn: 1.1, rimEdge: '#3a3d44' });
    return xf;
}

module.exports = { suv, sedan, pickup, makeXf, fillPoly, convex, gradAt };
