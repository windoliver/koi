export interface DetectedType {
  readonly mimeType: string;
  readonly extension: string;
  /** "strong" = magic bytes matched; "weak" = extension-only or text heuristic. */
  readonly confidence: "strong" | "weak";
}

// Extension → mime for the weak-confidence fallback path.
const EXT_MIME: Readonly<Record<string, string>> = {
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  sh: "text/x-shellscript",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  cs: "text/x-csharp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
  avif: "image/avif",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

function matchBytes(buf: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  if (buf.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (buf[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function isLikelyText(buf: Uint8Array): boolean {
  // Sample the first 512 bytes. If all are printable UTF-8 or common
  // control chars (tab, LF, CR), treat as text.
  const limit = Math.min(buf.length, 512);
  for (let i = 0; i < limit; i++) {
    const b = buf[i];
    if (b === undefined) break;
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue; // tab, LF, CR
    if (b < 0x20 || b === 0x7f) return false; // control chars
  }
  return true;
}

/**
 * Detect MIME type from raw bytes using magic-byte signatures.
 * Returns null when no signature matches and bytes are not plain text.
 */
export function detectFromBytes(bytes: Uint8Array): DetectedType | null {
  if (bytes.length === 0) return null;

  // PNG
  if (matchBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", extension: "png", confidence: "strong" };
  }

  // JPEG
  if (matchBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", extension: "jpg", confidence: "strong" };
  }

  // GIF87a or GIF89a
  if (
    matchBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38]) &&
    bytes.length >= 6 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mimeType: "image/gif", extension: "gif", confidence: "strong" };
  }

  // WebP: RIFF????WEBP
  if (
    matchBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    matchBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return { mimeType: "image/webp", extension: "webp", confidence: "strong" };
  }

  // PDF (%PDF-)
  if (matchBytes(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mimeType: "application/pdf", extension: "pdf", confidence: "strong" };
  }

  // ZIP (PK\x03\x04)
  if (matchBytes(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) {
    return { mimeType: "application/zip", extension: "zip", confidence: "strong" };
  }

  // HEIC / AVIF: ISO BMFF ftyp box at offset 4-7, brand at 8-11
  if (matchBytes(bytes, 4, [0x66, 0x74, 0x79, 0x70]) && bytes.length >= 12) {
    const b0 = bytes[8];
    const b1 = bytes[9];
    const b2 = bytes[10];
    const b3 = bytes[11];
    if (b0 !== undefined && b1 !== undefined && b2 !== undefined && b3 !== undefined) {
      const brand = String.fromCharCode(b0, b1, b2, b3);
      if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1") {
        return { mimeType: "image/heic", extension: "heic", confidence: "strong" };
      }
      if (brand === "avif" || brand === "avis") {
        return { mimeType: "image/avif", extension: "avif", confidence: "strong" };
      }
    }
  }

  // SVG / XML: scan up to 256 bytes as latin-1 for ASCII tag detection.
  // We MUST see an actual <svg root element before returning image/svg+xml —
  // a bare <?xml declaration also appears in plist, RSS, Maven POM, etc.
  const headLen = Math.min(bytes.length, 256);
  let headStr = "";
  for (let i = 0; i < headLen; i++) {
    headStr += String.fromCharCode(bytes[i] ?? 0);
  }
  const trimmed = headStr.trimStart();
  if (trimmed.startsWith("<svg")) {
    return { mimeType: "image/svg+xml", extension: "svg", confidence: "strong" };
  }
  if (trimmed.startsWith("<?xml")) {
    // Scan past the XML declaration to find the root element name.
    const afterDecl = trimmed.slice(trimmed.indexOf("?>") + 2).trimStart();
    const rootMatch = afterDecl.match(/<([\w:]+)/);
    if (rootMatch?.[1]?.toLowerCase() === "svg") {
      return { mimeType: "image/svg+xml", extension: "svg", confidence: "strong" };
    }
    return { mimeType: "application/xml", extension: "xml", confidence: "strong" };
  }

  // Plain text heuristic (weak — no magic signature)
  if (isLikelyText(bytes)) {
    return { mimeType: "text/plain", extension: "txt", confidence: "weak" };
  }

  return null;
}

/**
 * Detect MIME type using magic bytes first, path extension as fallback.
 * Always returns a result — never null.
 */
export function detectFromPath(path: string, bytes: Uint8Array): DetectedType {
  const strong = detectFromBytes(bytes);
  if (strong !== null && strong.confidence === "strong") return strong;

  // Extension fallback
  const dot = path.lastIndexOf(".");
  if (dot !== -1) {
    const ext = path.slice(dot + 1).toLowerCase();
    const mime = EXT_MIME[ext];
    if (mime !== undefined) {
      return { mimeType: mime, extension: ext, confidence: "weak" };
    }
  }

  // Prefer weak text detection over octet-stream when extension is unknown
  if (strong !== null) return strong;

  return { mimeType: "application/octet-stream", extension: "bin", confidence: "weak" };
}
