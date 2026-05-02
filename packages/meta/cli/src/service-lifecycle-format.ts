export function parseKeyValueLines(output: string): ReadonlyMap<string, string> {
  const props = new Map<string, string>();
  for (const line of output.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    props.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  return props;
}

export function parsePsOutput(output: string): {
  readonly uptimeMs: number | undefined;
  readonly memoryBytes: number | undefined;
} {
  const parts = output.trim().split(/\s+/);
  const rssKb = Number.parseInt(parts[0] ?? "", 10);
  return {
    memoryBytes: Number.isNaN(rssKb) ? undefined : rssKb * 1024,
    uptimeMs: parseElapsed(parts[1] ?? ""),
  };
}

function parseElapsed(value: string): number | undefined {
  let days = 0;
  let rest = value;
  const dayMatch = /^(\d+)-(.+)$/.exec(value);
  if (dayMatch !== null) {
    days = Number.parseInt(dayMatch[1] ?? "0", 10);
    rest = dayMatch[2] ?? "";
  }
  const parts = rest.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some(Number.isNaN)) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts as [number, number];
    return ((days * 24 * 60 + minutes) * 60 + seconds) * 1000;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts as [number, number, number];
    return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  }
  return undefined;
}

export function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value.replace(/%/g, "%%");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
