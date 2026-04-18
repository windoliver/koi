/**
 * Frozen blocklists consumed by ip-classify.ts (for matching) and exported
 * as public data so governance / tools-browser can extend policy.
 *
 * Two classes of IPv6 coverage exist and the distinction is LOAD-BEARING for
 * downstream policy: some prefixes are blocked wholesale, others are
 * re-checked against their embedded IPv4 address. Use the correct constant.
 *
 * See the header comment in ip-classify.ts for the RFC rationale of each
 * entry.
 */

export const BLOCKED_HOSTS: readonly string[] = Object.freeze([
  "localhost",
  "0.0.0.0",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

/**
 * Ranges blocked wholesale — every address inside the CIDR is rejected.
 */
export const BLOCKED_CIDR_RANGES: readonly string[] = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "100::/64",
  "2001::/32",
  "2001:db8::/32",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
]);

/**
 * IPv6 prefixes that embed an IPv4 address. The classifier decodes the
 * embedded v4 and re-runs the IPv4 blocklist against it — an address in
 * these prefixes pointing at a PUBLIC v4 target is allowed (that's just
 * legitimate translation traffic to a public host), while one pointing at
 * a private v4 is rejected.
 *
 * Separated from `BLOCKED_CIDR_RANGES` so the two policy surfaces are
 * distinguishable: a security auditor reading the constants can see
 * exactly which ranges are full-block vs. embedded-v4-recheck.
 */
export const EMBEDDED_V4_IPV6_PREFIXES: readonly string[] = Object.freeze([
  "::ffff:0:0/96", // IPv4-mapped (RFC4291)
  "::/96", // IPv4-compatible (deprecated RFC4291)
  "64:ff9b::/96", // NAT64 well-known prefix (RFC6052)
  "64:ff9b:1::/48", // NAT64 local-use prefix (RFC8215)
  "2002::/16", // 6to4 (RFC3056)
]);
