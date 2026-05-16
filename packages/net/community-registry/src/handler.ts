import { isKoiVersionCompatible } from "./compatibility.js";
import type {
  CommunityRegistryConfig,
  CommunityRegistryHandler,
  InstallRequest,
  MarketplaceEntry,
  MarketplaceKind,
  MarketplaceSearchQuery,
} from "./types.js";
import { validateInstallRequest, validatePublishRequest } from "./validation.js";

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
};

const VALID_KINDS: ReadonlySet<string> = new Set(["skill", "plugin"]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function isMarketplaceKind(value: string): value is MarketplaceKind {
  return VALID_KINDS.has(value);
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Bad request body: ${message}`);
  }
}

function checkPublishAuth(request: Request, config: CommunityRegistryConfig): Response | null {
  if (config.authTokens === undefined) return null;
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return errorResponse("Missing or invalid Authorization header", 401);
  }
  const token = header.slice("Bearer ".length);
  return config.authTokens.has(token) ? null : errorResponse("Invalid auth token", 403);
}

function mapSearchQuery(url: URL): MarketplaceSearchQuery | Response {
  const kind = url.searchParams.get("kind");
  if (kind !== null && !isMarketplaceKind(kind)) {
    return errorResponse(`Invalid marketplace kind: ${kind}`, 400);
  }

  const tags = url.searchParams.get("tags");
  const limit = url.searchParams.get("limit");
  const parsedLimit = limit === null ? undefined : Number(limit);
  if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
    return errorResponse("Invalid limit", 400);
  }

  return {
    q: url.searchParams.get("q") ?? undefined,
    kind: kind ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    tags:
      tags === null
        ? undefined
        : tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
    limit: parsedLimit,
    cursor: url.searchParams.get("cursor") ?? undefined,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function downloadArtifact(
  entry: MarketplaceEntry,
  config: CommunityRegistryConfig,
): Promise<Uint8Array | Response> {
  const fetcher = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(entry.artifact.url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "download failed";
    return errorResponse(`Artifact download failed: ${message}`, 502);
  }

  if (!response.ok) {
    return errorResponse(`Artifact download failed with status ${response.status}`, 502);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (entry.artifact.sizeBytes !== undefined && bytes.byteLength !== entry.artifact.sizeBytes) {
    return errorResponse("Artifact size mismatch", 422);
  }

  if (entry.artifact.sha256 !== undefined) {
    const actual = await sha256Hex(bytes);
    if (actual.toLowerCase() !== entry.artifact.sha256.toLowerCase()) {
      return errorResponse("Artifact checksum mismatch", 422);
    }
  }

  return bytes;
}

async function handlePublish(request: Request, config: CommunityRegistryConfig): Promise<Response> {
  const auth = checkPublishAuth(request, config);
  if (auth !== null) return auth;

  let body: unknown;
  try {
    body = await parseJson(request);
    const publish = validatePublishRequest(body);
    const entry = await config.backend.publish(publish, config.now?.() ?? new Date());
    return jsonResponse(entry, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid publish request";
    return errorResponse(message, message.startsWith("Bad request body") ? 400 : 400);
  }
}

async function handleInstall(request: Request, config: CommunityRegistryConfig): Promise<Response> {
  if (config.installer === undefined) {
    return errorResponse("Installer is not configured", 503);
  }

  let installRequest: InstallRequest;
  try {
    installRequest = validateInstallRequest(await parseJson(request));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid install request";
    return errorResponse(message, 400);
  }

  const entry = await config.backend.get(
    installRequest.kind,
    installRequest.name,
    installRequest.version,
  );
  if (entry === null) {
    return errorResponse(`${installRequest.kind} ${installRequest.name} not found`, 404);
  }

  if (!isKoiVersionCompatible(entry.compatibility?.koi, installRequest.koiVersion)) {
    return errorResponse(
      `${entry.kind} ${entry.name}@${entry.version} is incompatible with Koi ${installRequest.koiVersion ?? "unknown"}`,
      409,
    );
  }

  const artifact = await downloadArtifact(entry, config);
  if (artifact instanceof Response) return artifact;

  try {
    const result = await config.installer.install({
      entry,
      artifact: {
        bytes: artifact,
      },
    });
    const updated = await config.backend.recordInstall(entry.kind, entry.name, entry.version);
    return jsonResponse({
      installId: result.installId,
      entry: updated ?? entry,
      trust: (updated ?? entry).trust,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "installer failed";
    return errorResponse(`Install registration failed: ${message}`, 502);
  }
}

async function handleGetPackage(
  kindText: string,
  name: string,
  url: URL,
  config: CommunityRegistryConfig,
): Promise<Response> {
  if (!isMarketplaceKind(kindText)) {
    return errorResponse(`Invalid marketplace kind: ${kindText}`, 400);
  }
  const entry = await config.backend.get(
    kindText,
    decodeURIComponent(name),
    url.searchParams.get("version") ?? undefined,
  );
  if (entry === null) {
    return errorResponse(`${kindText} ${name} not found`, 404);
  }
  return jsonResponse(entry);
}

async function handleVersions(
  kindText: string,
  name: string,
  config: CommunityRegistryConfig,
): Promise<Response> {
  if (!isMarketplaceKind(kindText)) {
    return errorResponse(`Invalid marketplace kind: ${kindText}`, 400);
  }
  const items = await config.backend.versions(kindText, decodeURIComponent(name));
  return jsonResponse({ items });
}

export function createCommunityRegistryHandler(
  config: CommunityRegistryConfig,
): CommunityRegistryHandler {
  let disposed = false;

  async function handler(request: Request): Promise<Response | null> {
    if (disposed) {
      return errorResponse("Service unavailable", 503);
    }

    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    if (method === "GET" && path === "/v1/health") {
      return jsonResponse({ status: "ok" });
    }

    if (method === "POST" && path === "/v1/publish") {
      return handlePublish(request, config);
    }

    if (method === "GET" && path === "/v1/discovery") {
      return jsonResponse(
        await config.backend.discovery({
          category: url.searchParams.get("category") ?? undefined,
        }),
      );
    }

    if (method === "GET" && path === "/v1/search") {
      const query = mapSearchQuery(url);
      if (query instanceof Response) return query;
      return jsonResponse(await config.backend.search(query));
    }

    if (method === "POST" && path === "/v1/install") {
      return handleInstall(request, config);
    }

    const versionsMatch = path.match(/^\/v1\/packages\/([^/]+)\/([^/]+)\/versions$/);
    if (method === "GET" && versionsMatch !== null) {
      const kindText = versionsMatch[1];
      const name = versionsMatch[2];
      if (kindText === undefined || name === undefined) return null;
      return handleVersions(kindText, name, config);
    }

    const packageMatch = path.match(/^\/v1\/packages\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && packageMatch !== null) {
      const kindText = packageMatch[1];
      const name = packageMatch[2];
      if (kindText === undefined || name === undefined) return null;
      return handleGetPackage(kindText, name, url, config);
    }

    return null;
  }

  function dispose(): void {
    disposed = true;
  }

  return {
    handler,
    dispose,
  };
}
