/**
 * Terminal clipboard utilities.
 *
 * Write: use CliRenderer.copyToClipboardOSC52() — routes OSC 52 through the
 * renderer's output path to avoid out-of-band stdout writes that corrupt TUI
 * frame composition. Direct process.stdout.write is prohibited in active TUI
 * contexts (issue #1940).
 *
 * Read image: platform-native APIs (osascript/wl-paste/xclip/PowerShell).
 *
 * @see https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands
 */

import { platform } from "node:os";
import { detectFromBytes } from "@koi/file-type";

// ---------------------------------------------------------------------------
// OSC 52 payload guard
// ---------------------------------------------------------------------------

/**
 * Safe upper bound for OSC 52 base64 payload size in bytes.
 * Terminal-dependent; 100 KB is a conservative default that works across
 * iTerm2, Ghostty, WezTerm, and Kitty. Callers must check before invoking
 * renderer.copyToClipboardOSC52() — the renderer does not cap size internally.
 */
export const MAX_CLIPBOARD_BYTES = 100_000;

/**
 * Returns true if `text` encodes to a base64 payload within the safe OSC 52
 * limit. Call this before renderer.copyToClipboardOSC52() to avoid emitting
 * arbitrarily large sequences that degrade or hang terminals.
 */
export function isBelowOsc52Limit(text: string): boolean {
  return Buffer.from(text).toString("base64").length <= MAX_CLIPBOARD_BYTES;
}

// ---------------------------------------------------------------------------
// Clipboard image reading (#11) — platform-native APIs
// ---------------------------------------------------------------------------

/** Image read from the system clipboard. */
export interface ClipboardImage {
  /** Data URI: `data:<mime>;base64,<base64>` */
  readonly url: string;
  /** Detected MIME type (e.g. "image/png", "image/jpeg", "image/webp"). */
  readonly mime: string;
}

/**
 * Read an image from the system clipboard using platform-native APIs.
 *
 * - macOS: `osascript` with `clipboard as «class PNGf»`
 * - Linux: `wl-paste` (Wayland) or `xclip` (X11) with image/png
 * - Windows: PowerShell System.Windows.Forms.Clipboard
 *
 * Returns null if no image is in the clipboard or the platform is unsupported.
 * Modeled after OpenCode's clipboard.ts approach.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const os = platform();
  try {
    if (os === "darwin") return await readImageMacOS();
    if (os === "linux") return await readImageLinux();
    if (os === "win32") return await readImageWindows();
    return null;
  } catch {
    return null;
  }
}

async function readImageMacOS(): Promise<ClipboardImage | null> {
  // osascript returns hex-encoded PNG data like «data PNGf4142...»
  const proc = Bun.spawn(["osascript", "-e", "the clipboard as «class PNGf»"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0 || output.trim().length === 0) return null;

  const hexMatch = /«data PNGf([0-9A-Fa-f]+)»/.exec(output);
  if (!hexMatch?.[1]) return null;

  const hexStr = hexMatch[1];
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < hexStr.length; i += 2) {
    bytes[i / 2] = parseInt(hexStr.slice(i, i + 2), 16);
  }

  const base64 = Buffer.from(bytes).toString("base64");
  if (base64.length === 0) return null;

  const mime = detectFromBytes(bytes)?.mimeType ?? "image/png";
  return { url: `data:${mime};base64,${base64}`, mime };
}

async function readImageLinux(): Promise<ClipboardImage | null> {
  // Try Wayland first, then X11
  const wayland = await tryReadPng(["wl-paste", "--type", "image/png"]);
  if (wayland) return wayland;
  return tryReadPng(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]);
}

async function readImageWindows(): Promise<ClipboardImage | null> {
  const script = [
    "Add-Type -Assembly System.Windows.Forms",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img -eq $null) { exit 1 }",
    "$ms = New-Object System.IO.MemoryStream",
    "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "[Convert]::ToBase64String($ms.ToArray())",
  ].join("; ");
  const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0 || output.trim().length === 0) return null;

  const winBytes = new Uint8Array(Buffer.from(output.trim(), "base64"));
  const winMime = detectFromBytes(winBytes)?.mimeType ?? "image/png";
  return { url: `data:${winMime};base64,${output.trim()}`, mime: winMime };
}

/** Run a command that outputs raw PNG bytes to stdout, return as data URI. */
async function tryReadPng(cmd: readonly string[]): Promise<ClipboardImage | null> {
  try {
    const proc = Bun.spawn(cmd as string[], { stdout: "pipe", stderr: "ignore" });
    const bytes = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;
    if (exitCode !== 0 || bytes.byteLength === 0) return null;

    const buf = new Uint8Array(bytes);
    const mime = detectFromBytes(buf)?.mimeType ?? "image/png";
    const base64 = Buffer.from(bytes).toString("base64");
    return { url: `data:${mime};base64,${base64}`, mime };
  } catch {
    return null;
  }
}
