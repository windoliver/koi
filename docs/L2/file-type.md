# @koi/file-type

**Layer:** L2 utility  
**Package:** `packages/lib/file-type/`  
**Purpose:** Magic-byte MIME detection for user-originated file content (clipboard, @-reference, upload).

## Why

Three ingest boundaries in Koi hardcoded or skipped MIME detection:

- `clipboard.ts` locked `ClipboardImage.mime` to `"image/png"` literal — wrong for JPEG/WebP clipboard content
- `at-reference.ts` read every file as UTF-8 — binary files (images, PDFs) became mojibake in model context
- `tool-browser/parse-args.ts` propagated caller-supplied mime with no validation

This package provides the single detection primitive all three call sites share.

## API

```typescript
export interface DetectedType {
  readonly mimeType: string;
  readonly extension: string;
  /** "strong" = magic bytes matched; "weak" = extension-only fallback. */
  readonly confidence: "strong" | "weak";
}

/**
 * Detect MIME type from raw bytes.
 * Returns null when nothing matches and no path hint is available.
 */
export function detectFromBytes(bytes: Uint8Array): DetectedType | null;

/**
 * Detect MIME type using bytes first, path extension as fallback.
 * Always returns a result (falls back to "application/octet-stream").
 */
export function detectFromPath(path: string, bytes: Uint8Array): DetectedType;
```

## Supported Formats

| Format | Signature | MIME | Confidence |
|--------|-----------|------|------------|
| PNG | `89 50 4E 47 0D 0A 1A 0A` | image/png | strong |
| JPEG | `FF D8 FF` | image/jpeg | strong |
| GIF87a/89a | `47 49 46 38 [37\|39] 61` | image/gif | strong |
| WebP | `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` | image/webp | strong |
| PDF | `25 50 44 46 2D` (`%PDF-`) | application/pdf | strong |
| ZIP | `50 4B 03 04` | application/zip | strong |
| HEIC/AVIF | ISO BMFF `ftyp` box with heic/heix/mif1/avif brand | image/heic or image/avif | strong |
| SVG | Leading `<?xml` or `<svg` after whitespace/BOM strip | image/svg+xml | strong |
| Plain text | All bytes printable UTF-8 | text/plain | weak |
| Unknown | Extension lookup | varies | weak |
| Fallback | — | application/octet-stream | weak |

## Design Notes

- No external dependencies — detection table is ~80 lines of pure code
- No re-encoding or decoding — only reads the first 64 bytes for magic matching
- Extension fallback covers common cases (`.ts`, `.json`, `.md` etc.) without false positives from byte sniffing
- `detectFromBytes` returns `null` on no match so callers can decide to reject or fall back to extension
- `detectFromPath` never returns null — always produces at least `application/octet-stream`

## Call Sites

| File | Change |
|------|--------|
| `packages/ui/tui/src/utils/clipboard.ts` | Widen `ClipboardImage.mime` to `string`; call `detectFromBytes` on decoded buffer |
| `packages/meta/cli/src/at-reference.ts` | Before UTF-8 read: sniff head bytes; if non-text, produce `BinaryInjection` with base64 + detected mime |
| `packages/meta/cli/src/tui-command.ts` | Convert `BinaryInjection[]` to `FileBlock`/`ImageBlock` content blocks in `runtime.run` |
| `packages/lib/tool-browser/src/parse-args.ts` | When `mimeType` absent, sniff from decoded base64 bytes |

## Constraints

- HEIC/AVIF re-encoding is out of scope — detection only
- ZIP-based Office formats (xlsx, docx) detected as `application/zip` — caller must handle disambiguation
- Line-range `@-reference` (`@file.png#L10-20`) is ignored for binary files (binary has no meaningful line ranges)
