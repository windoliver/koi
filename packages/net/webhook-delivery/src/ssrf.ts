/**
 * SSRF prevention — validates webhook URLs at registration time.
 *
 * Rejects private IP ranges, link-local addresses, and non-HTTPS URLs.
 */

/** Private and reserved IPv4 ranges that must be blocked. */
const BLOCKED_IPV4_RANGES = [
  { prefix: "10.", label: "private (10.0.0.0/8)" },
  { prefix: "172.16.", label: "private (172.16.0.0/12)" },
  { prefix: "172.17.", label: "private (172.16.0.0/12)" },
  { prefix: "172.18.", label: "private (172.16.0.0/12)" },
  { prefix: "172.19.", label: "private (172.16.0.0/12)" },
  { prefix: "172.20.", label: "private (172.16.0.0/12)" },
  { prefix: "172.21.", label: "private (172.16.0.0/12)" },
  { prefix: "172.22.", label: "private (172.16.0.0/12)" },
  { prefix: "172.23.", label: "private (172.16.0.0/12)" },
  { prefix: "172.24.", label: "private (172.16.0.0/12)" },
  { prefix: "172.25.", label: "private (172.16.0.0/12)" },
  { prefix: "172.26.", label: "private (172.16.0.0/12)" },
  { prefix: "172.27.", label: "private (172.16.0.0/12)" },
  { prefix: "172.28.", label: "private (172.16.0.0/12)" },
  { prefix: "172.29.", label: "private (172.16.0.0/12)" },
  { prefix: "172.30.", label: "private (172.16.0.0/12)" },
  { prefix: "172.31.", label: "private (172.16.0.0/12)" },
  { prefix: "192.168.", label: "private (192.168.0.0/16)" },
  { prefix: "127.", label: "loopback (127.0.0.0/8)" },
  { prefix: "169.254.", label: "link-local (169.254.0.0/16)" },
  { prefix: "0.", label: "unspecified" },
] as const;

/** Blocked IPv6 patterns. */
const BLOCKED_IPV6 = ["::1", "fe80:", "fc00:", "fd00:"] as const;

export interface WebhookUrlValidationResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
}

/**
 * Validates a webhook URL for SSRF safety.
 *
 * @param url - The webhook URL to validate
 * @param allowInsecureLocalhost - Allow HTTP for localhost (dev mode). Default: false.
 */
export function validateWebhookUrl(
  url: string,
  allowInsecureLocalhost: boolean = false,
): WebhookUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }

  const hostname = parsed.hostname;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  // Require HTTPS (allow HTTP for localhost in dev)
  if (parsed.protocol !== "https:") {
    if (parsed.protocol === "http:") {
      if (!allowInsecureLocalhost || !isLocalhost) {
        return { ok: false, error: "Webhook URL must use HTTPS" };
      }
    } else {
      return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
    }
  }

  // Skip SSRF checks for allowed localhost
  if (allowInsecureLocalhost && isLocalhost) {
    return { ok: true };
  }

  // Check IPv4 blocked ranges
  for (const range of BLOCKED_IPV4_RANGES) {
    if (hostname.startsWith(range.prefix)) {
      return { ok: false, error: `Webhook URL targets ${range.label} address: ${hostname}` };
    }
  }

  // Check IPv6 blocked patterns (hostname may be wrapped in brackets)
  const rawHost = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  for (const pattern of BLOCKED_IPV6) {
    if (rawHost === pattern || rawHost.startsWith(pattern)) {
      return { ok: false, error: `Webhook URL targets blocked IPv6 address: ${rawHost}` };
    }
  }

  return { ok: true };
}

/**
 * Checks whether a resolved IP address falls into a blocked range.
 * Use this at delivery time to prevent DNS-rebinding SSRF attacks.
 */
export function isBlockedAddress(ip: string): boolean {
  for (const range of BLOCKED_IPV4_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }
  const rawIp = ip.startsWith("[") ? ip.slice(1, -1) : ip;
  for (const pattern of BLOCKED_IPV6) {
    if (rawIp === pattern || rawIp.startsWith(pattern)) return true;
  }
  return false;
}
