/**
 * Terminal clipboard utilities.
 *
 * Write: OSC 52 escape sequence (supported by most modern terminals).
 * Read image: platform-native APIs (osascript/wl-paste/xclip/PowerShell).
 *
 * @see https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands
 */

import { platform } from "node:os";

/**
 * Safe upper bound for OSC 52 payload size in bytes.
 * Terminal-dependent; 100 KB is a conservative default that works
 * across iTerm2, Ghostty, WezTerm, and Kitty.
 */
export const MAX_CLIPBOARD_BYTES = 100_000;

/**
 * Copy text to the system clipboard via OSC 52 terminal escape sequence.
 *
 * Returns `true` if the sequence was written, `false` if stdout is not a TTY
 * or the text exceeds the safe OSC 52 payload limit.
 */
export function copyToClipboard(text: string): boolean {
  if (!process.stdout.isTTY) return false;

  const base64 = Buffer.from(text).toString("base64");
  // Enforce limit on the encoded payload (what the terminal actually receives).
  // OSC 52 framing adds ~8 bytes; the base64 string is the dominant cost.
  if (base64.length > MAX_CLIPBOARD_BYTES) return false;

  process.stdout.write(`\x1b]52;c;${base64}\x07`);
  return true;
}

// ---------------------------------------------------------------------------
// Clipboard image reading (#11) — platform-native APIs
// ---------------------------------------------------------------------------

/** Image read from the system clipboard. */
export interface ClipboardImage {
  /** Data URI: `data:image/png;base64,<base64>` */
  readonly url: string;
  /** MIME type (always image/png). */
  readonly mime: "image/png";
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

  return { url: `data:image/png;base64,${base64}`, mime: "image/png" };
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

  return { url: `data:image/png;base64,${output.trim()}`, mime: "image/png" };
}

/** Run a command that outputs raw PNG bytes to stdout, return as data URI. */
async function tryReadPng(cmd: readonly string[]): Promise<ClipboardImage | null> {
  try {
    const proc = Bun.spawn(cmd as string[], { stdout: "pipe", stderr: "ignore" });
    const bytes = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;
    if (exitCode !== 0 || bytes.byteLength === 0) return null;

    const base64 = Buffer.from(bytes).toString("base64");
    return { url: `data:image/png;base64,${base64}`, mime: "image/png" };
  } catch {
    return null;
  }
}
