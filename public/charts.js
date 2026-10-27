// Hand-drawn SVG charts. Colours come from CSS custom properties so light and
// dark themes both work. Series colours are assigned by entity, never by rank.
import { svg, el, fmt } from './util.js';

let tip;
function tooltip() {
  if (!tip) { tip = el('div', { class: 'tooltip', role: 'status' }); document.body.append(tip); }
  return tip;
}
export function showTip(evt, html) {
  const t = tooltip(); t.innerHTML = html; t.style.display = 'block';
  const pad = 12, w = t.offsetWidth, h = t.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
export function hideTip() { if (tip) tip.style.display = 'none'; }

// Stacked vertical bars. series: [{key, label, color}], data: [{x, label, values:{key:n}, meta}]
export function stackedBars({ data, series, height = 220, yLabel = '', markers = [], onClick, formatY = fmt.tokens }) {
  const W = 900, H = height, padL = 56, padR = 12, padT = 14, padB = 28;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = Math.max(1, data.length);
  const max = Math.max(1, ...data.map((d) => series.reduce((a, s) => a + (d.values[s.key] || 0), 0)));
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': yLabel });
  // grid
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const y = padT + innerH - (innerH * i) / ticks;
    root.append(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'grid' }));
    root.append(svg('text', { x: padL - 6, y: y + 4, class: 'axis-label', 'text-anchor': 'end' }, formatY((max * i) / ticks)));
  }
  const bw = innerW / n;
  const gap = bw > 6 ? 2 : bw > 2 ? 1 : 0;
  data.forEach((d, i) => {
    let yTop = padT + innerH;
    const g = svg('g', { class: 'bar-group', onClick: () => onClick && onClick(d), onMousemove: (e) => showTip(e, d.tip || d.label), onMouseleave: hideTip });
    for (const s of series) {
      const v = d.values[s.key] || 0; if (!v) continue;
      const h = (v / max) * innerH; yTop -= h;
      g.append(svg('rect', { x: padL + i * bw + gap / 2, y: yTop, width: Math.max(0.5, bw - gap), height: Math.max(0, h - (gap ? 1 : 0)), fill: s.color, rx: bw > 8 ? 2 : 0 }));
    }
    // invisible hit target spanning the column
    g.append(svg('rect', { x: padL + i * bw, y: padT, width: bw, height: innerH, fill: 'transparent' }));
    root.append(g);
  });
  for (const m of markers) {
    const x = padL + (m.index + 0.5) * bw;
    root.append(svg('line', { x1: x, x2: x, y1: padT, y2: padT + innerH, class: 'marker', stroke: m.color || 'var(--status-serious)' }));
    if (m.label) root.append(svg('text', { x: x + 4, y: padT + 10, class: 'axis-label', fill: m.color || 'var(--status-serious)' }, m.label));
  }
  root.append(svg('line', { x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH, class: 'axis' }));
  const xl = (i) => padL + (i + 0.5) * bw;
  if (n > 1) {
    root.append(svg('text', { x: xl(0), y: H - 8, class: 'axis-label', 'text-anchor': 'start' }, data[0].x));
    root.append(svg('text', { x: xl(n - 1), y: H - 8, class: 'axis-label', 'text-anchor': 'end' }, data[n - 1].x));
    root.append(svg('text', { x: W / 2, y: H - 8, class: 'axis-label', 'text-anchor': 'middle' }, 'API call index →'));
  }
  return root;
}

export function legend(series) {
  return el('div', { class: 'legend' }, series.map((s) => el('span', { class: 'legend-item' }, el('i', { class: 'swatch', style: { background: s.color } }), s.label)));
}

// Horizontal bars: data [{label, value, sub, color}]
export function hBars({ data, formatV = fmt.int, color = 'var(--series-2)', maxBars = 20, onClick }) {
  const rows = data.slice(0, maxBars);
  const max = Math.max(1, ...rows.map((d) => d.value));
  const rowH = 24, W = 900, labelW = 230, padR = 70;
  const H = rows.length * rowH + 6;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart hbar', style: `height:${H}px` });
  rows.forEach((d, i) => {
    const y = i * rowH + 3;
    const w = ((W - labelW - padR) * d.value) / max;
    const g = svg('g', { class: 'bar-group', onClick: () => onClick && onClick(d), onMousemove: (e) => showTip(e, d.tip || `${d.label}: ${formatV(d.value)}`), onMouseleave: hideTip });
    g.append(svg('text', { x: labelW - 8, y: y + 15, class: 'axis-label row-label', 'text-anchor': 'end' }, d.label.length > 34 ? d.label.slice(0, 33) + '…' : d.label));
    g.append(svg('rect', { x: labelW, y: y + 3, width: Math.max(1, w), height: rowH - 8, fill: d.color || color, rx: 3 }));
    g.append(svg('text', { x: labelW + w + 6, y: y + 15, class: 'axis-label value-label' }, formatV(d.value) + (d.sub ? ' ' + d.sub : '')));
    root.append(g);
  });
  return root;
}

// Waterfall: rows [{label, start, end, color, depth, sub, kind, tip, onClick, segments:[{start,end,color,pattern}]}], t0, t1
export function waterfall({ rows, t0, t1, rowH = 22, labelW = 260 }) {
  const W = 1000, padR = 16, H = rows.length * rowH + 26;
  const span = Math.max(1, t1 - t0);
  const x = (t) => labelW + ((t - t0) / span) * (W - labelW - padR);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart waterfall', style: `height:${H}px` });
  // time axis
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + (span * i) / ticks; const xx = x(t);
    root.append(svg('line', { x1: xx, x2: xx, y1: 18, y2: H, class: 'grid' }));
    root.append(svg('text', { x: xx, y: 12, class: 'axis-label', 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, '+' + fmt.ms(t - t0)));
  }
  rows.forEach((r, i) => {
    const y = 20 + i * rowH;
    const g = svg('g', { class: 'bar-group' + (r.onClick ? ' clickable' : ''), onClick: () => r.onClick && r.onClick(), onMousemove: (e) => showTip(e, r.tip || r.label), onMouseleave: hideTip });
    if (i % 2) g.append(svg('rect', { x: 0, y, width: W, height: rowH, class: 'row-stripe' }));
    const indent = 10 + (r.depth || 0) * 14;
    g.append(svg('text', { x: indent, y: y + 15, class: 'axis-label row-label' + (r.kind ? ' k-' + r.kind : '') }, (r.label || '').length > 40 ? r.label.slice(0, 39) + '…' : r.label));
    const xs = x(r.start), xe = Math.max(x(r.end), xs + 2);
    g.append(svg('rect', { x: xs, y: y + 4, width: xe - xs, height: rowH - 8, fill: r.color, rx: 3, opacity: r.open ? 0.5 : 1 }));
    for (const s of r.segments || []) {
      const a = x(s.start), b = Math.max(x(s.end), a + 1);
      g.append(svg('rect', { x: a, y: y + 4, width: b - a, height: rowH - 8, fill: s.color, rx: 3 }));
    }
    if (r.sub) g.append(svg('text', { x: xe + 6, y: y + 15, class: 'axis-label value-label' }, r.sub));
    root.append(g);
  });
  return root;
}
