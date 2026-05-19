import type { KoiError, SessionId } from "@koi/core";
import { internal, validateNonEmpty } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { deletePath, listFilePaths, readJson, writeJson } from "./json-io.js";
import { artifactPath } from "./paths.js";
import type { SessionArtifactRecord, SessionArtifactStore } from "./types.js";

function isSessionArtifactRecord(value: unknown): value is SessionArtifactRecord {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.artifactId === "string" &&
    typeof obj.content === "string" &&
    typeof obj.createdAt === "number"
  );
}

function throwKoiError(error: KoiError): never {
  throw new Error(error.message, { cause: error });
}

export function createNexusSessionArtifactStore(
  transport: NexusTransport,
  basePath: string,
): SessionArtifactStore {
  async function saveArtifact(
    sessionId: SessionId,
    artifact: SessionArtifactRecord,
  ): Promise<void> {
    const sessionCheck = validateNonEmpty(sessionId, "Session ID");
    if (!sessionCheck.ok) throwKoiError(sessionCheck.error);
    const artifactCheck = validateNonEmpty(artifact.artifactId, "Artifact ID");
    if (!artifactCheck.ok) throwKoiError(artifactCheck.error);
    const result = await writeJson(
      transport,
      artifactPath(basePath, sessionId, artifact.artifactId),
      artifact,
    );
    if (!result.ok) throwKoiError(result.error);
  }

  async function loadArtifact(
    sessionId: SessionId,
    artifactId: string,
  ): Promise<SessionArtifactRecord | undefined> {
    const sessionCheck = validateNonEmpty(sessionId, "Session ID");
    if (!sessionCheck.ok) throwKoiError(sessionCheck.error);
    const artifactCheck = validateNonEmpty(artifactId, "Artifact ID");
    if (!artifactCheck.ok) throwKoiError(artifactCheck.error);
    const loaded = await readJson<unknown>(
      transport,
      artifactPath(basePath, sessionId, artifactId),
    );
    if (!loaded.ok) throwKoiError(loaded.error);
    if (loaded.value === undefined) return undefined;
    const value = loaded.value;
    if (!isSessionArtifactRecord(value)) {
      throwKoiError(internal(`Invalid session artifact ${artifactId}`));
    }
    return value;
  }

  async function listArtifacts(sessionId: SessionId): Promise<readonly SessionArtifactRecord[]> {
    const sessionCheck = validateNonEmpty(sessionId, "Session ID");
    if (!sessionCheck.ok) throwKoiError(sessionCheck.error);
    const paths = await listFilePaths(
      transport,
      `${basePath}/artifacts/${encodeURIComponent(sessionId)}`,
    );
    if (!paths.ok) throwKoiError(paths.error);
    const artifacts: SessionArtifactRecord[] = [];
    for (const path of paths.value) {
      const loaded = await readJson<unknown>(transport, path);
      if (!loaded.ok) throwKoiError(loaded.error);
      if (isSessionArtifactRecord(loaded.value)) artifacts.push(loaded.value);
    }
    return artifacts.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function removeArtifact(sessionId: SessionId, artifactId: string): Promise<void> {
    const sessionCheck = validateNonEmpty(sessionId, "Session ID");
    if (!sessionCheck.ok) throwKoiError(sessionCheck.error);
    const artifactCheck = validateNonEmpty(artifactId, "Artifact ID");
    if (!artifactCheck.ok) throwKoiError(artifactCheck.error);
    const result = await deletePath(transport, artifactPath(basePath, sessionId, artifactId));
    if (!result.ok) throwKoiError(result.error);
  }

  return {
    saveArtifact,
    loadArtifact,
    listArtifacts,
    removeArtifact,
  };
}
