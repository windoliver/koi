/**
 * @koi/url-safety — SSRF / private-IP / metadata-endpoint blocklist (L0-utility).
 *
 * Used by every outbound HTTP in Koi to fail-closed on private ranges and
 * cloud metadata endpoints. Exports frozen data constants so downstream
 * packages (governance-security, tools-browser) can extend.
 */
export {};
