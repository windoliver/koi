import { describe, expect, test } from "bun:test";
import { detectFromBytes, detectFromPath } from "./detect.js";

// ---------------------------------------------------------------------------
// Magic-byte corpus
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const GIF87_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const HEIC_BYTES = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x18, // box size
  0x66,
  0x74,
  0x79,
  0x70, // 'ftyp'
  0x68,
  0x65,
  0x69,
  0x63, // 'heic'
  0x00,
  0x00,
  0x00,
  0x00,
]);
const AVIF_BYTES = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x1c,
  0x66,
  0x74,
  0x79,
  0x70, // 'ftyp'
  0x61,
  0x76,
  0x69,
  0x66, // 'avif'
  0x00,
  0x00,
  0x00,
  0x00,
]);
const SVG_XML_BYTES = new Uint8Array(
  Array.from("<?xml version='1.0'?><svg>", (c) => c.charCodeAt(0)),
);
const SVG_DIRECT_BYTES = new Uint8Array(
  Array.from("<svg xmlns='http://www.w3.org/2000/svg'>", (c) => c.charCodeAt(0)),
);
const TEXT_BYTES = new Uint8Array(
  Array.from("hello world\nthis is plain text\n", (c) => c.charCodeAt(0)),
);
const BINARY_BLOB = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff, 0x80, 0x90]);
const XML_PLIST_BYTES = new Uint8Array(
  Array.from("<?xml version='1.0'?>\n<!DOCTYPE plist>\n<plist version='1.0'><dict/>", (c) =>
    c.charCodeAt(0),
  ),
);
const XML_RSS_BYTES = new Uint8Array(
  Array.from("<?xml version='1.0'?><rss version='2.0'>", (c) => c.charCodeAt(0)),
);

// ---------------------------------------------------------------------------
// detectFromBytes — strong magic matches
// ---------------------------------------------------------------------------

describe("detectFromBytes — strong magic", () => {
  test("detects PNG", () => {
    const r = detectFromBytes(PNG_BYTES);
    expect(r?.mimeType).toBe("image/png");
    expect(r?.extension).toBe("png");
    expect(r?.confidence).toBe("strong");
  });

  test("detects JPEG", () => {
    const r = detectFromBytes(JPEG_BYTES);
    expect(r?.mimeType).toBe("image/jpeg");
    expect(r?.confidence).toBe("strong");
  });

  test("detects GIF87a", () => {
    const r = detectFromBytes(GIF87_BYTES);
    expect(r?.mimeType).toBe("image/gif");
    expect(r?.confidence).toBe("strong");
  });

  test("detects GIF89a", () => {
    const r = detectFromBytes(GIF89_BYTES);
    expect(r?.mimeType).toBe("image/gif");
    expect(r?.confidence).toBe("strong");
  });

  test("detects WebP", () => {
    const r = detectFromBytes(WEBP_BYTES);
    expect(r?.mimeType).toBe("image/webp");
    expect(r?.confidence).toBe("strong");
  });

  test("detects PDF", () => {
    const r = detectFromBytes(PDF_BYTES);
    expect(r?.mimeType).toBe("application/pdf");
    expect(r?.extension).toBe("pdf");
    expect(r?.confidence).toBe("strong");
  });

  test("detects ZIP", () => {
    const r = detectFromBytes(ZIP_BYTES);
    expect(r?.mimeType).toBe("application/zip");
    expect(r?.confidence).toBe("strong");
  });

  test("detects HEIC", () => {
    const r = detectFromBytes(HEIC_BYTES);
    expect(r?.mimeType).toBe("image/heic");
    expect(r?.confidence).toBe("strong");
  });

  test("detects AVIF", () => {
    const r = detectFromBytes(AVIF_BYTES);
    expect(r?.mimeType).toBe("image/avif");
    expect(r?.confidence).toBe("strong");
  });

  test("detects SVG via <?xml", () => {
    const r = detectFromBytes(SVG_XML_BYTES);
    expect(r?.mimeType).toBe("image/svg+xml");
    expect(r?.confidence).toBe("strong");
  });

  test("detects SVG via <svg", () => {
    const r = detectFromBytes(SVG_DIRECT_BYTES);
    expect(r?.mimeType).toBe("image/svg+xml");
    expect(r?.confidence).toBe("strong");
  });
});

// ---------------------------------------------------------------------------
// detectFromBytes — weak / null cases
// ---------------------------------------------------------------------------

describe("detectFromBytes — weak / null", () => {
  test("plain text returns text/plain with weak confidence", () => {
    const r = detectFromBytes(TEXT_BYTES);
    expect(r?.mimeType).toBe("text/plain");
    expect(r?.confidence).toBe("weak");
  });

  test("returns null for unrecognised binary blob", () => {
    const r = detectFromBytes(BINARY_BLOB);
    expect(r).toBeNull();
  });

  test("returns null for high-bit non-UTF-8 bytes (e.g. encrypted/random data)", () => {
    // 0x80 alone is an invalid UTF-8 continuation byte — not text
    const r = detectFromBytes(new Uint8Array([0x80, 0x90, 0x81, 0xc0, 0xff, 0xfe, 0xed]));
    expect(r).toBeNull();
  });

  test("returns text/plain for valid UTF-8 with multi-byte sequences", () => {
    // "héllo" encoded as UTF-8 — should still be classified as text
    const r = detectFromBytes(new Uint8Array([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]));
    expect(r?.mimeType).toBe("text/plain");
    expect(r?.confidence).toBe("weak");
  });

  test("detects UTF-16 LE BOM (0xFF 0xFE) as text/plain", () => {
    // UTF-16 LE BOM followed by "he" encoded as UTF-16
    const r = detectFromBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x65, 0x00]));
    expect(r?.mimeType).toBe("text/plain");
    expect(r?.confidence).toBe("weak");
  });

  test("detects UTF-16 BE BOM (0xFE 0xFF) as text/plain", () => {
    // UTF-16 BE BOM followed by "he" encoded as UTF-16 BE
    const r = detectFromBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x65]));
    expect(r?.mimeType).toBe("text/plain");
    expect(r?.confidence).toBe("weak");
  });

  test("returns null for empty buffer", () => {
    const r = detectFromBytes(new Uint8Array(0));
    expect(r).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SVG vs generic XML disambiguation
// ---------------------------------------------------------------------------

describe("detectFromBytes — XML vs SVG", () => {
  test("plist XML does NOT return image/svg+xml", () => {
    const r = detectFromBytes(XML_PLIST_BYTES);
    expect(r?.mimeType).not.toBe("image/svg+xml");
    expect(r?.mimeType).toBe("application/xml");
  });

  test("RSS XML does NOT return image/svg+xml", () => {
    const r = detectFromBytes(XML_RSS_BYTES);
    expect(r?.mimeType).not.toBe("image/svg+xml");
    expect(r?.mimeType).toBe("application/xml");
  });

  test("<?xml + <svg root still detects as SVG", () => {
    const r = detectFromBytes(SVG_XML_BYTES);
    expect(r?.mimeType).toBe("image/svg+xml");
    expect(r?.confidence).toBe("strong");
  });
});

// ---------------------------------------------------------------------------
// Security: name != contents
// ---------------------------------------------------------------------------

describe("detectFromBytes — name vs content mismatch", () => {
  test("JPEG bytes named .png → still reports image/jpeg", () => {
    // Caller could use detectFromPath for the .png name, but bytes win
    const r = detectFromBytes(JPEG_BYTES);
    expect(r?.mimeType).toBe("image/jpeg");
  });

  test("PDF bytes named .txt → still reports application/pdf", () => {
    const r = detectFromBytes(PDF_BYTES);
    expect(r?.mimeType).toBe("application/pdf");
  });
});

// ---------------------------------------------------------------------------
// detectFromPath — extension fallback when bytes inconclusive
// ---------------------------------------------------------------------------

describe("detectFromPath", () => {
  test("strong byte match beats extension", () => {
    // JPEG bytes but .png extension → bytes win
    const r = detectFromPath("photo.png", JPEG_BYTES);
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.confidence).toBe("strong");
  });

  test("extension fallback for text/ts file", () => {
    const tsBytes = new Uint8Array(Array.from("export const x = 1;", (c) => c.charCodeAt(0)));
    const r = detectFromPath("module.ts", tsBytes);
    expect(r.mimeType).toBe("text/plain");
  });

  test("extension fallback for .json", () => {
    const jsonBytes = new Uint8Array(Array.from('{"key":1}', (c) => c.charCodeAt(0)));
    const r = detectFromPath("data.json", jsonBytes);
    expect(r.mimeType).toBe("application/json");
    expect(r.confidence).toBe("weak");
  });

  test("unknown binary → application/octet-stream fallback", () => {
    const r = detectFromPath("data.bin", BINARY_BLOB);
    expect(r.mimeType).toBe("application/octet-stream");
    expect(r.confidence).toBe("weak");
  });

  test("always returns a result (never null)", () => {
    const r = detectFromPath("mystery", new Uint8Array([0x00, 0x01]));
    expect(r).not.toBeNull();
    expect(typeof r.mimeType).toBe("string");
  });
});
