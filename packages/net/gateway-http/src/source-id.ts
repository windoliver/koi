import type { ProxyTrustConfig } from "./types.js";

export function resolveSourceId(req: Request, socketAddr: string, trust: ProxyTrustConfig): string {
  if (trust.mode === "none") return socketAddr;
  if (!isInCidrList(socketAddr, trust.trustedProxies)) return socketAddr;
  const xff = req.headers.get("X-Forwarded-For");
  if (xff === null) return socketAddr;
  const ips = xff
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const ip of ips) {
    if (!isInCidrList(ip, trust.trustedProxies)) return ip;
  }
  return socketAddr;
}

function isInCidrList(ip: string, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    if (matchCidr(ip, cidr)) return true;
  }
  return false;
}

function matchCidr(ip: string, cidr: string): boolean {
  const [base, prefix] = cidr.split("/");
  if (base === undefined) return false;
  if (prefix === undefined) return ip === base;
  const ipBits = ipToInt(ip);
  const baseBits = ipToInt(base);
  if (ipBits === undefined || baseBits === undefined) return false;
  const n = Number(prefix);
  if (!Number.isInteger(n) || n < 0 || n > 32) return false;
  if (n === 0) return true;
  const mask = (~0 << (32 - n)) >>> 0;
  return (ipBits & mask) === (baseBits & mask);
}

function ipToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return undefined;
    n = (n << 8) | x;
  }
  return n >>> 0;
}
