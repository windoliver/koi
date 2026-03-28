/**
 * Extracted probe helpers from status.ts — testable with injectable fetch.
 */

type FetchFn = typeof globalThis.fetch;

/** Probe a single HTTP endpoint, returning true for 200. */
export async function probeEndpoint(
  url: string,
  timeout: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeout) });
    return res.status === 200;
  } catch {
    return false;
  }
}

interface AdminDetectResult {
  readonly port: number;
  readonly ok: boolean;
}

/** Scan ports 3100-3109 in parallel to find the running admin API. */
export async function detectAdminPort(
  timeout: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<AdminDetectResult> {
  const controller = new AbortController();
  const ports = Array.from({ length: 10 }, (_, i) => 3100 + i);

  try {
    const result = await Promise.any(
      ports.map(async (port) => {
        const res = await fetchFn(`http://localhost:${String(port)}/admin/api/health`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
        });
        if (res.status !== 200) throw new Error("not healthy");
        return { port, ok: true as const };
      }),
    );
    controller.abort();
    return result;
  } catch {
    return { port: 3100, ok: false };
  }
}

/** Fetch JSON from an admin API endpoint, returning undefined on any failure. */
export async function fetchAdminJson<T>(
  adminUrl: string,
  path: string,
  timeout: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<T | undefined> {
  try {
    const res = await fetchFn(`${adminUrl}/${path}`, { signal: AbortSignal.timeout(timeout) });
    if (res.status !== 200) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Determines Nexus mode label from the manifest preset field. */
export function resolveNexusMode(preset: string | undefined): string | undefined {
  if (preset === "demo" || preset === "mesh") return "embed-auth";
  if (preset === "local") return "embed-lite";
  return undefined;
}
