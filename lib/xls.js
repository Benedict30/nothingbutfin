/*
 * xls.js — just enough of the old Excel format to read the numbers on one sheet, with no dependency.
 * An .xls file is an OLE2 compound file (a small file system of 512-byte sectors) holding a "Workbook" stream
 * of BIFF8 records. Only number cells are read (a formula gives its last computed number); text, styles and
 * everything else are skipped. Anything unexpected throws: a wrong number is worse than none.
 */
'use strict';

const LAST_SECTOR = 0xFFFFFFFA; // sector numbers from here up are markers (end of chain, free, …)

/** The bytes of the first stream with one of these names in an OLE2 compound file. */
function stream(file, names) {
  if (file.length < 1024 || file.readUInt32LE(0) !== 0xE011CFD0 || file.readUInt32LE(4) !== 0xE11AB1A1) throw new Error('.xls: not an Excel 97-2003 file');
  const size = 1 << file.readUInt16LE(30), ints = size / 4;
  const sector = n => {
    const at = (n + 1) * size;
    if (at >= file.length) throw new Error('.xls: a sector is past the end of the file');
    return file.subarray(at, Math.min(at + size, file.length));
  };
  // the allocation table (which sector follows which), itself kept in sectors listed in the header and beyond
  const tableSectors = [];
  for (let i = 0; i < 109; i++) tableSectors.push(file.readUInt32LE(76 + i * 4));
  for (let next = file.readUInt32LE(68), n = 0; next < LAST_SECTOR; n++) {
    if (n > 4096) throw new Error('.xls: the sector table loops');
    const s = sector(next);
    for (let i = 0; i < ints - 1; i++) tableSectors.push(s.readUInt32LE(i * 4));
    next = s.readUInt32LE(size - 4);
  }
  const table = [];
  for (const n of tableSectors) {
    if (n >= LAST_SECTOR) continue;
    const s = sector(n);
    for (let i = 0; i + 4 <= s.length; i += 4) table.push(s.readUInt32LE(i));
  }
  const chain = start => {
    const parts = [];
    for (let s = start; s < LAST_SECTOR; s = table[s]) {
      if (s >= table.length || parts.length > table.length) throw new Error('.xls: a broken sector chain');
      parts.push(sector(s));
    }
    return Buffer.concat(parts);
  };
  const dir = chain(file.readUInt32LE(48));
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameBytes = dir.readUInt16LE(o + 64);
    if (dir[o + 66] !== 2 || nameBytes < 2 || nameBytes > 64) continue; // 2: a stream
    if (!names.includes(dir.toString('utf16le', o, o + nameBytes - 2))) continue;
    const bytes = dir.readUInt32LE(o + 120);
    if (bytes < file.readUInt32LE(56)) throw new Error('.xls: the workbook is too small to be real'); // would be in the mini stream
    const all = chain(dir.readUInt32LE(o + 116));
    if (all.length < bytes) throw new Error('.xls: the workbook is cut short');
    return all.subarray(0, bytes);
  }
  throw new Error('.xls: no workbook inside');
}

/** A number packed into 4 bytes (an "RK"): an integer or the top half of a double, either possibly ×100. */
function rk(v) {
  let n;
  if (v & 2) n = v >> 2;
  else { const b = Buffer.alloc(8); b.writeInt32LE(v & -4, 4); n = b.readDoubleLE(0); }
  return v & 1 ? n / 100 : n;
}

/**
 * The number cells of one sheet of an .xls file (a Buffer): rows[row][column] = number, both from 0,
 * with nothing at cells that are empty or hold text.
 */
function sheetNumbers(file, sheetName) {
  const wb = stream(file, ['Workbook', 'Book']);
  let at = 0;
  const record = () => {
    if (at + 4 > wb.length) throw new Error('.xls: the workbook ends mid-record');
    const id = wb.readUInt16LE(at), data = wb.subarray(at + 4, at + 4 + wb.readUInt16LE(at + 2));
    at += 4 + data.length;
    return { id, data };
  };
  const begin = () => { // each part (the workbook's own, then one per sheet) starts with a BOF record
    const bof = record();
    if (bof.id !== 0x0809 || bof.data.readUInt16LE(0) !== 0x0600) throw new Error('.xls: not an Excel 97-2003 workbook');
  };
  begin();
  let sheetAt = -1;
  for (let r = record(); r.id !== 0x000A; r = record()) { // to the EOF record
    if (r.id === 0x002F) throw new Error('.xls: password-protected');
    if (r.id !== 0x0085) continue; // BOUNDSHEET: where a sheet starts, and its name
    const chars = r.data[6], wide = r.data[7] & 1;
    const name = wide ? r.data.toString('utf16le', 8, 8 + chars * 2) : r.data.toString('latin1', 8, 8 + chars);
    if (name === sheetName) sheetAt = r.data.readUInt32LE(0);
  }
  if (sheetAt < 0) throw new Error(`.xls: no sheet named "${sheetName}"`);
  at = sheetAt;
  begin();
  const rows = [];
  const put = (row, col, v) => { if (Number.isFinite(v)) (rows[row] ||= [])[col] = v; };
  for (let depth = 1; depth > 0;) { // an embedded chart is a nested part of its own
    const { id, data: d } = record();
    if (id === 0x0809) depth++;
    else if (id === 0x000A) depth--;
    else if (depth > 1) continue;
    else if (id === 0x0203) put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6)); // NUMBER
    else if (id === 0x027E) put(d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readInt32LE(6))); // RK
    else if (id === 0x00BD) { // MULRK: a run of RKs along a row
      const row = d.readUInt16LE(0), first = d.readUInt16LE(2);
      for (let i = 0; 4 + i * 6 + 6 <= d.length - 2; i++) put(row, first + i, rk(d.readInt32LE(4 + i * 6 + 2)));
    } else if (id === 0x0006 && d.readUInt16LE(12) !== 0xFFFF) put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6)); // FORMULA with a number
  }
  return rows;
}

module.exports = { sheetNumbers };
