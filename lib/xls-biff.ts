// Minimal reader for legacy Excel 97-2003 (.xls, BIFF8 inside an OLE2/CFB container).
// Only cell values of the first visible worksheet are extracted: strings, numbers,
// booleans and cached formula results. Number formats are ignored, so dates arrive
// as Excel serial numbers and callers convert them explicitly.

export type XlsCell = string | number | boolean | null;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

export function isXlsBinary(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

function cfbStream(bytes: Uint8Array, names: string[]): Uint8Array {
  if (!isXlsBinary(bytes)) throw new Error('El archivo no es un Excel 97-2003 (.xls).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  const firstDirSector = view.getUint32(0x30, true);
  const miniCutoff = view.getUint32(0x38, true);
  const firstMiniFat = view.getUint32(0x3c, true);
  let difatSector = view.getUint32(0x44, true);
  const sectorOffset = (n: number) => (n + 1) * sectorSize;
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) { const s = view.getUint32(0x4c + i * 4, true); if (s !== FREE_SECTOR) fatSectors.push(s); }
  for (let guard = 0; difatSector !== END_OF_CHAIN && difatSector !== FREE_SECTOR && guard < 10000; guard++) {
    const base = sectorOffset(difatSector), per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) { const s = view.getUint32(base + i * 4, true); if (s !== FREE_SECTOR) fatSectors.push(s); }
    difatSector = view.getUint32(base + per * 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSectors) { const base = sectorOffset(s); for (let i = 0; i < sectorSize / 4; i++) fat.push(view.getUint32(base + i * 4, true)); }
  const chain = (start: number, table: number[]) => {
    const out: number[] = []; const seen = new Set<number>();
    for (let s = start; s !== END_OF_CHAIN && s !== FREE_SECTOR; s = table[s]) {
      if (seen.has(s) || s >= table.length) throw new Error('Archivo .xls dañado (cadena de sectores inválida).');
      seen.add(s); out.push(s);
    }
    return out;
  };
  const readChain = (start: number, size?: number) => {
    const sectors = chain(start, fat), out = new Uint8Array(sectors.length * sectorSize);
    sectors.forEach((s, i) => out.set(bytes.subarray(sectorOffset(s), sectorOffset(s) + sectorSize), i * sectorSize));
    return size === undefined ? out : out.subarray(0, size);
  };
  const dir = readChain(firstDirSector), dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const len = dv.getUint16(off + 64, true); let name = '';
    for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(dv.getUint16(off + i, true));
    entries.push({ name, type: dv.getUint8(off + 66), start: dv.getUint32(off + 116, true), size: dv.getUint32(off + 120, true) });
  }
  const root = entries.find(e => e.type === 5);
  const entry = entries.find(e => e.type === 2 && names.includes(e.name));
  if (!root || !entry) throw new Error('El .xls no contiene un libro de Excel legible.');
  if (entry.size >= miniCutoff) return readChain(entry.start, entry.size);
  const miniStream = readChain(root.start, root.size);
  const miniFatBytes = firstMiniFat === END_OF_CHAIN ? new Uint8Array() : readChain(firstMiniFat);
  const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  const miniFat: number[] = []; for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mv.getUint32(i, true));
  const sectors = chain(entry.start, miniFat), out = new Uint8Array(sectors.length * miniSectorSize);
  sectors.forEach((s, i) => out.set(miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize), i * miniSectorSize));
  return out.subarray(0, entry.size);
}

type Record = { type: number; data: Uint8Array; offset: number };
function records(stream: Uint8Array): Record[] {
  const out: Record[] = [], v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let off = 0; off + 4 <= stream.length;) {
    const type = v.getUint16(off, true), len = v.getUint16(off + 2, true);
    out.push({ type, data: stream.subarray(off + 4, off + 4 + len), offset: off });
    off += 4 + len;
  }
  return out;
}

// Reads across a record and its CONTINUE records. Character runs that cross a boundary
// restart with a one-byte option flag that says whether the next characters are 8 or 16 bit.
class SegmentReader {
  private seg = 0; private pos = 0;
  constructor(private segments: Uint8Array[]) {}
  private ensure() { while (this.seg < this.segments.length && this.pos >= this.segments[this.seg].length) { this.seg++; this.pos = 0; } if (this.seg >= this.segments.length) throw new Error('Tabla de textos del .xls incompleta.'); }
  u8() { this.ensure(); return this.segments[this.seg][this.pos++]; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n: number) { for (let i = 0; i < n; i++) this.u8(); }
  atSegmentEnd() { return this.seg < this.segments.length && this.pos >= this.segments[this.seg].length; }
  chars(count: number, high: boolean) {
    let s = '';
    for (let i = 0; i < count; i++) {
      if (this.atSegmentEnd()) { this.seg++; this.pos = 0; high = (this.u8() & 1) === 1; }
      s += String.fromCharCode(high ? this.u16() : this.u8());
    }
    return s;
  }
  richString() {
    const cch = this.u16(), flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0, ext = flags & 0x04 ? this.u32() : 0;
    const text = this.chars(cch, (flags & 1) === 1);
    this.skip(runs * 4 + ext);
    return text;
  }
}

function shortString(data: Uint8Array, off: number, lengthBytes: 1 | 2): string {
  const cch = lengthBytes === 1 ? data[off] : data[off] | (data[off + 1] << 8);
  const flags = data[off + lengthBytes]; const high = (flags & 1) === 1;
  let s = ''; let p = off + lengthBytes + 1;
  for (let i = 0; i < cch; i++) { s += String.fromCharCode(high ? data[p] | (data[p + 1] << 8) : data[p]); p += high ? 2 : 1; }
  return s;
}

function rk(value: number): number {
  let n: number;
  if (value & 0x02) n = value >> 2;
  else { const buf = new DataView(new ArrayBuffer(8)); buf.setUint32(4, value & 0xfffffffc, true); buf.setUint32(0, 0, true); n = buf.getFloat64(0, true); }
  return value & 0x01 ? n / 100 : n;
}

/** Returns the first worksheet of a BIFF8 .xls as a dense row/column matrix. */
export function readXlsFirstSheet(input: ArrayBuffer | Uint8Array): XlsCell[][] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const stream = cfbStream(bytes, ['Workbook', 'Book']);
  const recs = records(stream);
  const bof = recs[0];
  if (!bof || bof.type !== 0x0809 || (bof.data[0] | (bof.data[1] << 8)) !== 0x0600) throw new Error('Solo se aceptan libros Excel 97-2003 (BIFF8).');
  const sst: string[] = []; const sheets: { offset: number; hidden: boolean; type: number }[] = [];
  for (let i = 0; i < recs.length && recs[i].type !== 0x000a; i++) {
    const r = recs[i];
    if (r.type === 0x0085) { const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength); sheets.push({ offset: v.getUint32(0, true), hidden: r.data[4] !== 0, type: r.data[5] }); }
    if (r.type === 0x00fc) {
      const segs = [r.data.subarray(8)]; for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(recs[j].data);
      const unique = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength).getUint32(4, true);
      const reader = new SegmentReader(segs);
      for (let k = 0; k < unique; k++) sst.push(reader.richString());
    }
  }
  const sheet = sheets.find(s => !s.hidden && s.type === 0) ?? sheets[0];
  if (!sheet) throw new Error('El libro no tiene hojas.');
  const start = recs.findIndex(r => r.offset === sheet.offset);
  if (start < 0) throw new Error('No se encontró la hoja del reporte.');
  const rows: XlsCell[][] = [];
  const put = (row: number, col: number, value: XlsCell) => { (rows[row] ??= [])[col] = value; };
  let pendingString: { row: number; col: number } | null = null;
  for (let i = start + 1; i < recs.length && recs[i].type !== 0x000a; i++) {
    const { type, data } = recs[i]; const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const row = data.length >= 4 ? v.getUint16(0, true) : 0, col = data.length >= 4 ? v.getUint16(2, true) : 0;
    switch (type) {
      case 0x00fd: put(row, col, sst[v.getUint32(6, true)] ?? ''); break;
      case 0x0204: put(row, col, shortString(data, 6, 2)); break;
      case 0x0203: put(row, col, v.getFloat64(6, true)); break;
      case 0x027e: put(row, col, rk(v.getUint32(6, true))); break;
      case 0x00bd: { const last = v.getUint16(data.length - 2, true); for (let c = col, p = 4; c <= last; c++, p += 6) put(row, c, rk(v.getUint32(p + 2, true))); break; }
      case 0x0205: put(row, col, data[7] ? null : data[6] !== 0); break;
      case 0x0006: {
        if (v.getUint16(12, true) === 0xffff) { const kind = data[6]; if (kind === 0) pendingString = { row, col }; else if (kind === 1) put(row, col, data[8] !== 0); else put(row, col, null); }
        else put(row, col, v.getFloat64(6, true));
        break;
      }
      case 0x0207: if (pendingString) { const segs = [data]; for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(recs[j].data); const reader = new SegmentReader(segs); const cch = reader.u16(), flags = reader.u8(); put(pendingString.row, pendingString.col, reader.chars(cch, (flags & 1) === 1)); pendingString = null; } break;
    }
  }
  const width = rows.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
  return Array.from({ length: rows.length }, (_, r) => Array.from({ length: width }, (_, c) => rows[r]?.[c] ?? null));
}
