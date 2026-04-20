export function logBrowserExt(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.error(`[koi:browser-ext] ${message}`);
    return;
  }
  console.error(`[koi:browser-ext] ${message}`, extra);
}
