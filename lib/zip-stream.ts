// lib/zip-stream.ts
// Builds a .zip as a stream, one file at a time, without holding the files in memory.
// Store-only (no compression): JPG/PNG/PDF are already compressed, and the client gets the
// exact bytes that are on the ClickUp card. Needed because Vercel caps non-streamed responses
// at 4.5 MB (one poster PDF alone is ~9 MB).
//
// Format: local header with "data descriptor" flag (sizes/CRC written after the data, so we
// don't need to know them up front), UTF-8 file names (å ä ö), central directory at the end.
// Not ZIP64: total size must stay under 4 GB, which review jobs never get near.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc: number, buf: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export type ZipEntry = {
  /** Path inside the zip, e.g. "MVK-annonser/Stora-Coop_V48_MVK_01.jpg" */
  name: string;
  /** Called when it's this file's turn; returns the file's bytes as a stream. */
  open: () => Promise<ReadableStream<Uint8Array>>;
};

/**
 * Stream a zip of `entries`. A file that fails to open is skipped (logged via onError),
 * so one broken attachment doesn't kill the whole download.
 */
export function zipStream(entries: ZipEntry[], onError?: (name: string, e: unknown) => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  let i = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const push = (b: Uint8Array) => { controller.enqueue(b); offset += b.length; };

      // Find the next file that opens. (A pull() that enqueues nothing is not called again,
      // so skipping must happen inside this loop, not by returning.)
      let entry: ZipEntry | null = null;
      let body: ReadableStream<Uint8Array> | null = null;
      while (i < entries.length && !body) {
        entry = entries[i++];
        try {
          body = await entry.open();
        } catch (e) {
          onError?.(entry.name, e);
        }
      }

      if (entry && body) {

        const nameBytes = enc.encode(entry.name);
        const start = offset;
        const FLAGS = 0x0008 | 0x0800; // data descriptor + UTF-8 names

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);       // version needed
        local.setUint16(6, FLAGS, true);
        local.setUint16(8, 0, true);        // method: store
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        // crc + sizes = 0 here, real values go in the data descriptor
        local.setUint16(26, nameBytes.length, true);
        push(new Uint8Array(local.buffer));
        push(nameBytes);

        let crc = 0;
        let size = 0;
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            crc = crc32Update(crc, value);
            size += value.length;
            push(value);
          }
        } catch (e) {
          // The stream broke mid-file: the zip can't be repaired at this point.
          onError?.(entry.name, e);
          controller.error(e);
          return;
        }

        const desc = new DataView(new ArrayBuffer(16));
        desc.setUint32(0, 0x08074b50, true);
        desc.setUint32(4, crc, true);
        desc.setUint32(8, size, true);
        desc.setUint32(12, size, true);
        push(new Uint8Array(desc.buffer));

        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true);
        cd.setUint16(4, 20, true);          // version made by
        cd.setUint16(6, 20, true);          // version needed
        cd.setUint16(8, FLAGS, true);
        cd.setUint16(10, 0, true);
        cd.setUint16(12, time, true);
        cd.setUint16(14, date, true);
        cd.setUint32(16, crc, true);
        cd.setUint32(20, size, true);
        cd.setUint32(24, size, true);
        cd.setUint16(28, nameBytes.length, true);
        cd.setUint32(42, start, true);      // offset of local header
        const rec = new Uint8Array(46 + nameBytes.length);
        rec.set(new Uint8Array(cd.buffer), 0);
        rec.set(nameBytes, 46);
        central.push(rec);
        count++;
        return;
      }

      // all files written: central directory + end record
      const cdStart = offset;
      for (const rec of central) push(rec);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, count, true);
      end.setUint16(10, count, true);
      end.setUint32(12, offset - cdStart, true);
      end.setUint32(16, cdStart, true);
      push(new Uint8Array(end.buffer));
      controller.close();
    },
  });
}

/** Make zip paths unique ("a.jpg", "a (2).jpg") and safe (no leading slash, no ".."). */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Map<string, number>();
  return paths.map((p) => {
    const clean = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..").join("/") || "fil";
    const key = clean.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === 1) return clean;
    const dot = clean.lastIndexOf(".");
    return dot > clean.lastIndexOf("/") ? `${clean.slice(0, dot)} (${n})${clean.slice(dot)}` : `${clean} (${n})`;
  });
}
