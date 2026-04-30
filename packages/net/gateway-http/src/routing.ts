export type RouteMatch =
  | { readonly kind: "webhook"; readonly channel: string; readonly account: string | undefined }
  | { readonly kind: "preflight" }
  | { readonly kind: "health" }
  | { readonly kind: "not-found" };

export function matchRoute(method: string, pathname: string): RouteMatch {
  if (method === "OPTIONS" && pathname.startsWith("/webhooks/")) {
    return { kind: "preflight" };
  }
  if (method === "GET" && pathname === "/healthz") return { kind: "health" };
  // /ws is intentionally not advertised: WS frame forwarding into @koi/gateway
  // is not yet implemented (see threat model section 3.3). Until that integration
  // lands, /ws falls through to 404 rather than admitting an inert socket.
  if (method === "POST" && pathname.startsWith("/webhooks/")) {
    const rest = pathname.slice("/webhooks/".length);
    const parts = rest.split("/").filter((s) => s.length > 0);
    const channel = parts[0];
    const account = parts[1];
    if (channel === undefined) return { kind: "not-found" };
    return { kind: "webhook", channel, account };
  }
  return { kind: "not-found" };
}
