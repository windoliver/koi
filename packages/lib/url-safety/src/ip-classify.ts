/**
 * IP-literal classification — returns true if the address falls into any
 * blocked range (private, loopback, link-local, CGNAT, multicast, reserved,
 * cloud metadata). Fail-closed: malformed input returns true.
 *
 * Ranges (rationale):
 *   IPv4:
 *     0.0.0.0/8       "this network" (RFC1122)
 *     10.0.0.0/8      private RFC1918
 *     100.64.0.0/10   CGNAT / shared address space (Alibaba uses for metadata)
 *     127.0.0.0/8     loopback
 *     169.254.0.0/16  link-local — includes AWS/GCP/Azure IMDS at 169.254.169.254
 *     172.16.0.0/12   private RFC1918
 *     192.0.2.0/24    TEST-NET-1 (RFC5737)
 *     192.168.0.0/16  private RFC1918
 *     198.18.0.0/15   benchmarking (RFC2544)
 *     198.51.100.0/24 TEST-NET-2
 *     203.0.113.0/24  TEST-NET-3
 *     224.0.0.0/4     multicast
 *     240.0.0.0/4     reserved for future use (incl. 255.255.255.255 broadcast)
 *   IPv6:
 *     ::/128          unspecified
 *     ::1/128         loopback
 *     ::ffff:0:0/96   IPv4-mapped (extract and re-check the v4)
 *     fc00::/7        unique-local (incl. fd00:ec2::254 AWS IMDS)
 *     fe80::/10       link-local
 *     ff00::/8        multicast
 *     2001::/32       Teredo tunnel (can embed arbitrary IPv4)
 *     2001:db8::/32   documentation / not routed
 *     2002::/16       6to4 (embeds IPv4 in groups 2-3)
 */

function parseIpv4ToBigInt(ip: string): bigint | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const num = Number(part);
    if (num < 0 || num > 255) return undefined;
    result = (result << 8n) | BigInt(num);
  }
  return result;
}

const BLOCKED_V4: readonly (readonly [bigint, bigint])[] = [
  [0x00000000n, 0xff000000n], // 0.0.0.0/8
  [0x0a000000n, 0xff000000n], // 10.0.0.0/8
  [0x64400000n, 0xffc00000n], // 100.64.0.0/10
  [0x7f000000n, 0xff000000n], // 127.0.0.0/8
  [0xa9fe0000n, 0xffff0000n], // 169.254.0.0/16
  [0xac100000n, 0xfff00000n], // 172.16.0.0/12
  [0xc0000200n, 0xffffff00n], // 192.0.2.0/24
  [0xc0a80000n, 0xffff0000n], // 192.168.0.0/16
  [0xc6120000n, 0xfffe0000n], // 198.18.0.0/15
  [0xc6336400n, 0xffffff00n], // 198.51.100.0/24
  [0xcb007100n, 0xffffff00n], // 203.0.113.0/24
  [0xe0000000n, 0xf0000000n], // 224.0.0.0/4
  [0xf0000000n, 0xf0000000n], // 240.0.0.0/4 (covers 255.255.255.255)
];

const BLOCKED_V6_FIRST_HEXTET_PREFIXES: readonly string[] = [
  "fc",
  "fd",
  "fe8",
  "fe9",
  "fea",
  "feb",
  "ff",
];

function isBlockedV4(ip: string): boolean {
  const n = parseIpv4ToBigInt(ip);
  if (n === undefined) return true;
  return BLOCKED_V4.some(([net, mask]) => (n & mask) === net);
}

function extractMappedV4(ip: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  const h1 = hex?.[1];
  const h2 = hex?.[2];
  if (h1 !== undefined && h2 !== undefined) {
    const hi = Number.parseInt(h1, 16);
    const lo = Number.parseInt(h2, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return undefined;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;

  const mapped = extractMappedV4(lower);
  if (mapped !== undefined) return isBlockedV4(mapped);

  const firstHextet = lower.split(":")[0] ?? "";
  for (const prefix of BLOCKED_V6_FIRST_HEXTET_PREFIXES) {
    if (firstHextet.startsWith(prefix)) return true;
  }

  // Teredo 2001::/32 and documentation 2001:db8::/32
  if (firstHextet === "2001") {
    const second = lower.split(":")[1] ?? "";
    if (second === "" || second === "0" || second === "0000" || second === "db8") return true;
  }

  // 6to4 2002::/16 — embedded v4 in groups 2 + 3
  if (firstHextet === "2002") {
    const parts = lower.split(":");
    const g1 = parts[1];
    const g2 = parts[2];
    if (g1 !== undefined && g2 !== undefined) {
      const h1 = Number.parseInt(g1.padStart(4, "0"), 16);
      const h2 = Number.parseInt(g2.padStart(4, "0"), 16);
      if (!Number.isNaN(h1) && !Number.isNaN(h2)) {
        const embedded = `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
        if (isBlockedV4(embedded)) return true;
      }
    }
  }

  return false;
}

export function isBlockedIp(ip: string): boolean {
  const stripped = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  if (stripped.includes(":")) return isBlockedV6(stripped);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(stripped)) return isBlockedV4(stripped);
  return true;
}
