import fsp from 'node:fs/promises';

// Byte-offset tailer. Reads whole files once, then only appended bytes.
export class Tailer {
  constructor({ intervalMs = 750 } = {}) {
    this.files = new Map(); // path -> {offset, partial, onRecord, onError}
    this.intervalMs = intervalMs;
    this.timer = null;
    this.busy = false;
  }

  // onRecord(record, byteStart, byteLength) for every complete line.
  async readAll(file, onRecord) {
    const fh = await fsp.open(file, 'r');
    let pos = 0, partial = '';
    try {
      const stream = fh.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 });
      for await (const chunk of stream) {
        partial += chunk;
        let i;
        while ((i = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, i); partial = partial.slice(i + 1);
          const len = Buffer.byteLength(line, 'utf8');
          if (line.trim()) { try { onRecord(JSON.parse(line), pos, len); } catch { /* skip bad line */ } }
          pos += len + 1;
        }
      }
    } finally { await fh.close(); }
    return { offset: pos, partial };
  }

  watch(file, state, onRecord) {
    this.files.set(file, { offset: state.offset, pos: state.offset - Buffer.byteLength(state.partial || '', 'utf8'), partial: state.partial || '', onRecord });
    if (!this.timer) this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  unwatch(file) { this.files.delete(file); if (!this.files.size && this.timer) { clearInterval(this.timer); this.timer = null; } }

  async poll() {
    if (this.busy) return; this.busy = true;
    try {
      for (const [file, f] of this.files) {
        let st; try { st = await fsp.stat(file); } catch { continue; }
        if (st.size < f.offset) { f.offset = 0; f.pos = 0; f.partial = ''; } // truncated/rewritten
        if (st.size === f.offset) continue;
        const fh = await fsp.open(file, 'r');
        try {
          const len = st.size - f.offset;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, f.offset);
          f.offset += bytesRead;
          f.partial += buf.subarray(0, bytesRead).toString('utf8');
          let i;
          while ((i = f.partial.indexOf('\n')) >= 0) {
            const line = f.partial.slice(0, i); f.partial = f.partial.slice(i + 1);
            const len = Buffer.byteLength(line, 'utf8');
            if (line.trim()) { try { f.onRecord(JSON.parse(line), f.pos, len); } catch { /* skip */ } }
            f.pos += len + 1;
          }
        } finally { await fh.close(); }
      }
    } finally { this.busy = false; }
  }
}
