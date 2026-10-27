// Small DOM and formatting helpers.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const svgNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) { if (c == null || c === false) continue; node.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  return node;
}

export const fmt = {
  int(n) { return n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'); },
  tokens(n) { if (n == null) return '–'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k'; return Math.round(n).toLocaleString('en-US'); },
  ms(ms) { if (ms == null || !Number.isFinite(ms)) return '–'; if (ms < 1000) return Math.round(ms) + ' ms'; if (ms < 60000) return (ms / 1000).toFixed(1) + ' s'; if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's'; return (ms / 3600000).toFixed(1) + ' h'; },
  usd(v) { return v == null ? '–' : '$' + Number(v).toFixed(2); },
  time(ts) { return ts == null ? '–' : new Date(ts).toLocaleTimeString('en-US', { hour12: false }); },
  date(ts) { return ts == null ? '–' : new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); },
  bytes(b) { if (b == null) return '–'; if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB'; if (b > 1e3) return (b / 1e3).toFixed(0) + ' kB'; return b + ' B'; },
  pct(x) { return x == null || !Number.isFinite(x) ? '–' : (x * 100).toFixed(0) + '%'; },
  ago(ts) { if (ts == null) return '–'; const d = Date.now() - ts; if (d < 60000) return 'just now'; if (d < 3600000) return Math.floor(d / 60000) + ' min ago'; if (d < 86400000) return Math.floor(d / 3600000) + ' h ago'; return Math.floor(d / 86400000) + ' d ago'; },
};

export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Pretty JSON with light syntax colouring, for the inspector.
export function highlightJson(obj) {
  const text = JSON.stringify(obj, null, 2);
  return escapeHtml(text).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
    let cls = 'j-num';
    if (/^"/.test(m)) cls = /:$/.test(m) ? 'j-key' : 'j-str';
    else if (/true|false/.test(m)) cls = 'j-bool';
    else if (/null/.test(m)) cls = 'j-null';
    return `<span class="${cls}">${m}</span>`;
  });
}

export function copyText(text) { try { navigator.clipboard.writeText(text); } catch { /* ignore */ } }

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
