/**
 * Pre-instantiation WebAssembly binary section scanner.
 *
 * Enforces the spec's resource-safety invariants BEFORE the module reaches
 * `WebAssembly.compile()`:
 *
 *   - reject any module that declares an internal memory (section id 5) —
 *     internal memory bypasses the host page cap, since `instance.exports.memory`
 *     is only present if the module also exports it.
 *   - require the module to import its memory from the host whenever
 *     `maxMemoryPages` is specified, so the host can size and cap the buffer
 *     directly.
 *   - reject internal table sections (section id 4) for the same reason.
 *
 * The scanner walks the binary by section header only; section bodies are
 * skipped via their LEB128 length prefix. We do not attempt full validation —
 * that's `WebAssembly.validate()`'s job — only the structural checks needed
 * for resource enforcement.
 */

export interface ImportedMemoryDescriptor {
  readonly module: string;
  readonly name: string;
  readonly limits: { readonly min: number; readonly max?: number };
}

export interface SectionScanResult {
  readonly hasInternalMemory: boolean;
  readonly hasInternalTable: boolean;
  readonly importedMemoryCount: number;
  /** First imported memory's module/name/limits, if present. */
  readonly importedMemory: ImportedMemoryDescriptor | undefined;
}

export type SectionScanError =
  | { readonly kind: "TRUNCATED"; readonly at: number }
  | { readonly kind: "INVALID_HEADER" }
  | { readonly kind: "INVALID_LEB128"; readonly at: number };

const SECTION_IMPORT = 2;
const SECTION_TABLE = 4;
const SECTION_MEMORY = 5;

const IMPORT_KIND_MEMORY = 2;

/** Decode an unsigned LEB128 varint. Returns `[value, bytesRead]` or undefined on overflow. */
const decodeLeb128 = (bytes: Uint8Array, offset: number): readonly [number, number] | undefined => {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    i++;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, i - offset];
    shift += 7;
    if (shift > 35) return undefined;
  }
  return undefined;
};

const decodeName = (bytes: Uint8Array, offset: number): readonly [string, number] | undefined => {
  const len = decodeLeb128(bytes, offset);
  if (len === undefined) return undefined;
  const start = offset + len[1];
  const end = start + len[0];
  if (end > bytes.length) return undefined;
  const slice = bytes.subarray(start, end);
  return [new TextDecoder().decode(slice), end - offset];
};

const decodeMemoryLimits = (
  bytes: Uint8Array,
  offset: number,
): readonly [{ min: number; max?: number }, number] | undefined => {
  if (offset >= bytes.length) return undefined;
  const flags = bytes[offset] as number;
  let pos = offset + 1;
  const minDec = decodeLeb128(bytes, pos);
  if (minDec === undefined) return undefined;
  pos += minDec[1];
  if ((flags & 0x01) !== 0) {
    const maxDec = decodeLeb128(bytes, pos);
    if (maxDec === undefined) return undefined;
    pos += maxDec[1];
    return [{ min: minDec[0], max: maxDec[0] }, pos - offset];
  }
  return [{ min: minDec[0] }, pos - offset];
};

const scanImportSection = (
  bytes: Uint8Array,
  start: number,
  end: number,
): { importedMemoryCount: number; importedMemory?: ImportedMemoryDescriptor } => {
  let pos = start;
  const countDec = decodeLeb128(bytes, pos);
  if (countDec === undefined) return { importedMemoryCount: 0 };
  pos += countDec[1];
  const count = countDec[0];
  let memoryCount = 0;
  let firstMemory: ImportedMemoryDescriptor | undefined;
  for (let i = 0; i < count && pos < end; i++) {
    const mod = decodeName(bytes, pos);
    if (mod === undefined) break;
    const modName = mod[0];
    pos += mod[1];
    const nm = decodeName(bytes, pos);
    if (nm === undefined) break;
    const importName = nm[0];
    pos += nm[1];
    if (pos >= end) break;
    const kind = bytes[pos] as number;
    pos++;
    if (kind === IMPORT_KIND_MEMORY) {
      memoryCount++;
      const lim = decodeMemoryLimits(bytes, pos);
      if (lim === undefined) break;
      if (firstMemory === undefined) {
        firstMemory = { module: modName, name: importName, limits: lim[0] };
      }
      pos += lim[1];
    } else if (kind === 0) {
      // typeidx
      const t = decodeLeb128(bytes, pos);
      if (t === undefined) break;
      pos += t[1];
    } else if (kind === 1) {
      // tabletype: reftype (1) + limits
      pos++;
      const lim = decodeMemoryLimits(bytes, pos);
      if (lim === undefined) break;
      pos += lim[1];
    } else if (kind === 3) {
      // globaltype: valtype (1) + mut (1)
      pos += 2;
    } else {
      break;
    }
  }
  return firstMemory === undefined
    ? { importedMemoryCount: memoryCount }
    : { importedMemoryCount: memoryCount, importedMemory: firstMemory };
};

export const scanWasmSections = (
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly value: SectionScanResult }
  | { readonly ok: false; readonly error: SectionScanError } => {
  if (bytes.length < 8) return { ok: false, error: { kind: "INVALID_HEADER" } };
  // header: \0asm + version (4 bytes)
  let pos = 8;
  let hasInternalMemory = false;
  let hasInternalTable = false;
  let importedMemoryCount = 0;
  let importedMemory: ImportedMemoryDescriptor | undefined;
  while (pos < bytes.length) {
    const id = bytes[pos] as number;
    pos++;
    const sizeDec = decodeLeb128(bytes, pos);
    if (sizeDec === undefined) return { ok: false, error: { kind: "INVALID_LEB128", at: pos } };
    pos += sizeDec[1];
    const sectionStart = pos;
    const sectionEnd = pos + sizeDec[0];
    if (sectionEnd > bytes.length) return { ok: false, error: { kind: "TRUNCATED", at: pos } };
    if (id === SECTION_MEMORY) {
      const countDec = decodeLeb128(bytes, sectionStart);
      if (countDec !== undefined && countDec[0] > 0) hasInternalMemory = true;
    } else if (id === SECTION_TABLE) {
      const countDec = decodeLeb128(bytes, sectionStart);
      if (countDec !== undefined && countDec[0] > 0) hasInternalTable = true;
    } else if (id === SECTION_IMPORT) {
      const r = scanImportSection(bytes, sectionStart, sectionEnd);
      importedMemoryCount = r.importedMemoryCount;
      importedMemory = r.importedMemory;
    }
    pos = sectionEnd;
  }
  return {
    ok: true,
    value: {
      hasInternalMemory,
      hasInternalTable,
      importedMemoryCount,
      importedMemory,
    },
  };
};
