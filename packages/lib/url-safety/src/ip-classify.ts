import { isIP } from "node:net";

/**
 * IP-literal classification — returns true if the address falls into any
 * blocked range (private, loopback, link-local, CGNAT, multicast, reserved,
 * cloud metadata, translation prefixes). Fail-closed: malformed input returns true.
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
 *     ::/96           IPv4-compatible (deprecated RFC4291 — URL parser
 *                     canonicalises `[::127.0.0.1]` to `[::7f00:1]`, so
 *                     re-check the embedded v4 the same way as IPv4-mapped)
 *     ::ffff:0:0/96   IPv4-mapped (extract and re-check the v4)
 *     64:ff9b::/96    NAT64 well-known prefix (RFC6052 — translates v4 into v6)
 *     64:ff9b:1::/48  NAT64 local-use prefix (RFC8215 — site-local translator)
 *     100::/64        discard-only (RFC6666)
 *     2001::/32       Teredo tunnel (can embed arbitrary IPv4)
 *     2001:db8::/32   documentation / not routed (RFC3849)
 *     2002::/16       6to4 (embeds IPv4 in groups 2-3; re-check the embedded v4)
 *     fc00::/7        unique-local (incl. fd00:ec2::254 AWS IMDS)
 *     fe80::/10       link-local
 *     fec0::/10       site-local (deprecated RFC3879; legacy-routed, block)
 *     ff00::/8        multicast
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

function isBlockedV4(ip: string): boolean {
  const n = parseIpv4ToBigInt(ip);
  if (n === undefined) return true;
  return BLOCKED_V4.some(([net, mask]) => (n & mask) === net);
}

/**
 * Expand an IPv6 literal into exactly 8 16-bit hextet numbers.
 * Handles `::` compression and optional trailing dotted-decimal IPv4.
 * Caller must have pre-validated with `isIP(ip) === 6`.
 */
function expandV6(addr: string): readonly number[] | undefined {
  let work = addr;
  let tail: number[] = [];
  if (work.includes(".")) {
    const lastColon = work.lastIndexOf(":");
    const v4 = work.slice(lastColon + 1);
    work = work.slice(0, lastColon);
    // If the original form had `::` immediately before the v4 (e.g. `::8.8.8.8`
    // or `2001:db8::127.0.0.1`), slicing at lastColon dropped the second colon
    // of the `::` token — re-append it so `::` survives the v4 extraction.
    if (addr[lastColon - 1] === ":") work = `${work}:`;
    const octets = v4.split(".").map(Number);
    if (octets.length !== 4) return undefined;
    const [o0, o1, o2, o3] = octets;
    if (o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined)
      return undefined;
    if ([o0, o1, o2, o3].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    tail = [(o0 << 8) | o1, (o2 << 8) | o3];
  }
  const dbl = work.indexOf("::");
  let head: string[];
  let mid: string[];
  if (dbl === -1) {
    head = work.split(":");
    mid = [];
  } else {
    const headStr = work.slice(0, dbl);
    const midStr = work.slice(dbl + 2);
    head = headStr === "" ? [] : headStr.split(":");
    mid = midStr === "" ? [] : midStr.split(":");
  }
  const target = 8 - tail.length;
  const fill = target - head.length - mid.length;
  if (fill < 0) return undefined;
  const hex = [...head, ...new Array<string>(fill).fill("0"), ...mid];
  const nums = hex.map((h) => Number.parseInt(h, 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return undefined;
  const full = [...nums, ...tail];
  return full.length === 8 ? full : undefined;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Decode an IPv4 address embedded in a NAT64 /48 prefix per RFC6052 §2.2.
 * For /48, the 32 bits of IPv4 straddle the reserved "u" octet:
 *
 *   bits  |  field
 *   48-63 |  v4[0..1]        (g3)
 *   64-71 |  u (must be 0)   (high byte of g4)
 *   72-79 |  v4[2]           (low byte of g4)
 *   80-87 |  v4[3]           (high byte of g5)
 *   88-127|  suffix (ignored)
 *
 * Returns undefined if the u octet is non-zero (not a valid /48 encoding).
 */
function v4FromNAT64_48(g3: number, g4: number, g5: number): string | undefined {
  if (g4 >> 8 !== 0) return undefined; // u octet must be 0
  const b0 = (g3 >> 8) & 0xff;
  const b1 = g3 & 0xff;
  const b2 = g4 & 0xff;
  const b3 = (g5 >> 8) & 0xff;
  return `${b0}.${b1}.${b2}.${b3}`;
}

function isBlockedV6(ip: string): boolean {
  if (isIP(ip) !== 6) return true; // fail-closed on malformed
  const g = expandV6(ip.toLowerCase());
  if (g === undefined) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // ::/128 unspecified
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 0
  ) {
    return true;
  }

  // ::1/128 loopback
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return true;
  }

  // ::ffff:0:0/96 IPv4-mapped — re-check embedded v4
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedV4(v4FromGroups(g6, g7));
  }

  // ::/96 IPv4-compatible (deprecated, RFC4291) — g0-g5 all zero, embedded
  // v4 in g6/g7. Node/Bun's URL parser canonicalises `[::127.0.0.1]` to
  // `[::7f00:1]`, so we must re-check the embedded address the same way we
  // re-check IPv4-mapped. :: (all zero) and ::1 are already handled above.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedV4(v4FromGroups(g6, g7));
  }

  // 64:ff9b::/96 NAT64 well-known prefix — re-check embedded v4.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    if (isBlockedV4(v4FromGroups(g6, g7))) return true;
  }

  // 64:ff9b:1::/48 NAT64 local-use prefix (RFC8215) — per RFC6052 §2.2, /48
  // NAT64 splits the IPv4 bits around the reserved "u" octet. g6/g7 are the
  // suffix (not the v4), so the /96 extraction would be WRONG here. Use the
  // /48-specific decoder; if it returns undefined, the u octet is non-zero
  // and this isn't a valid NAT64 encoding — fall through (still classified
  // below as a public 64:ff9b::/32-adjacent address).
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    const embedded = v4FromNAT64_48(g3, g4, g5);
    if (embedded !== undefined && isBlockedV4(embedded)) return true;
  }

  // 100::/64 RFC6666 discard-only
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;

  // 2001::/32 Teredo (g0=2001, g1=0)
  if (g0 === 0x2001 && g1 === 0) return true;

  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;

  // 2002::/16 6to4 — embedded v4 in groups 1+2
  if (g0 === 0x2002) {
    if (isBlockedV4(v4FromGroups(g1, g2))) return true;
  }

  // fc00::/7 unique-local (covers fd00:ec2::254 IMDS)
  if ((g0 & 0xfe00) === 0xfc00) return true;

  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // fec0::/10 site-local (deprecated RFC3879 but legacy routers may still
  // honour it — block to keep the SSRF boundary aligned with private v4).
  if ((g0 & 0xffc0) === 0xfec0) return true;

  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

export function isBlockedIp(ip: string): boolean {
  const stripped = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  if (stripped.includes(":")) return isBlockedV6(stripped);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(stripped)) return isBlockedV4(stripped);
  return true;
}
