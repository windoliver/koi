import type {
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordInput,
  MemoryRecordPatch,
} from "@koi/core/memory";
import {
  formatMemoryIndexEntry,
  memoryRecordId,
  parseMemoryFrontmatter,
  sanitizeFrontmatterValue,
  serializeMemoryFrontmatter,
  validateMemoryFilePath,
  validateMemoryRecordInput,
} from "@koi/core/memory";
import type { StoreContext } from "./backend-store.js";
import {
  memoryPath,
  rawMemoryFilenames,
  readRecordAt,
  scanRecords,
  toError,
} from "./backend-store-io.js";
import { findDuplicate } from "./dedup.js";
import { deriveFilename } from "./slug.js";
import type {
  DeleteResult,
  MemoryStore,
  MemoryStoreOperation,
  UpdateResult,
  UpsertResult,
} from "./types.js";

const INDEX_FILENAME = "MEMORY.md";

export function buildFileSystemMemoryStore(ctx: StoreContext): MemoryStore {
  return {
    read: (id) => readStore(ctx, id),
    list: (filter) => listStore(ctx, filter),
    write: (input) => writeStore(ctx, input),
    update: (id, patch) => updateStore(ctx, id, patch),
    delete: (id) => deleteStore(ctx, id),
    rebuildIndex: async () => {
      const error = await attemptIndexRebuild(ctx, "rebuild");
      if (error !== undefined) throw error;
    },
    upsert: (input, opts) => upsertStore(ctx, input, opts),
  };
}

function validateInput(input: MemoryRecordInput): void {
  const errors = validateMemoryRecordInput({ ...input });
  if (errors.length > 0) {
    const messages = errors.map((error) => `${error.field}: ${error.message}`).join("; ");
    throw new Error(`Invalid memory record input: ${messages}`);
  }
}

function filenameToId(filename: string): string {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

async function readStore(ctx: StoreContext, id: MemoryRecordId): Promise<MemoryRecord | undefined> {
  const filePath = `${String(id)}.md`;
  if (validateMemoryFilePath(filePath) !== undefined) return undefined;
  return readRecordAt(ctx, filePath);
}

async function listStore(
  ctx: StoreContext,
  filter?: Parameters<MemoryStore["list"]>[0],
): ReturnType<MemoryStore["list"]> {
  const records = (await scanRecords(ctx)).map((entry) => entry.record);
  if (filter?.type !== undefined) return records.filter((record) => record.type === filter.type);
  return records;
}

async function writeStore(ctx: StoreContext, input: MemoryRecordInput) {
  validateInput(input);
  const result = await writeRecord(ctx, input);
  if (result.action !== "created") return result;
  const indexError = await attemptIndexRebuild(ctx, "write");
  return indexError === undefined ? result : { ...result, indexError };
}

async function updateStore(ctx: StoreContext, id: MemoryRecordId, patch: MemoryRecordPatch) {
  const result = await updateRecord(ctx, id, patch);
  const indexError = await attemptIndexRebuild(ctx, "update");
  return indexError === undefined ? result : { ...result, indexError };
}

async function deleteStore(ctx: StoreContext, id: MemoryRecordId) {
  const result = await deleteRecord(ctx, id);
  if (!result.deleted) return result;
  const indexError = await attemptIndexRebuild(ctx, "delete");
  return indexError === undefined ? result : { ...result, indexError };
}

async function upsertStore(
  ctx: StoreContext,
  input: MemoryRecordInput,
  opts: Parameters<MemoryStore["upsert"]>[1],
) {
  validateInput(input);
  if (opts === null || typeof opts !== "object" || typeof opts.force !== "boolean") {
    throw new Error("Invalid upsert options: opts.force must be a boolean");
  }
  const result = await upsertRecord(ctx, input, opts.force);
  if (result.action === "created" || result.action === "updated") {
    const indexError = await attemptIndexRebuild(ctx, "upsert");
    return indexError === undefined ? result : { ...result, indexError };
  }
  return result;
}

async function writeRecord(
  ctx: StoreContext,
  input: MemoryRecordInput,
): Promise<ReturnType<MemoryStore["write"]> extends Promise<infer T> ? T : never> {
  const existing = await scanRecords(ctx);
  const existingRecords = existing.map((entry) => entry.record);
  const canonicalName = sanitizeFrontmatterValue(input.name);
  const canonicalDescription = sanitizeFrontmatterValue(input.description);
  const collision = existingRecords.find(
    (record) => record.name === canonicalName && record.type === input.type,
  );
  if (collision !== undefined) {
    const exactReplay =
      collision.description === canonicalDescription &&
      collision.content === input.content &&
      collision.confidence === input.confidence;
    if (exactReplay) {
      return { action: "skipped", record: collision, duplicateOf: collision.id, similarity: 1 };
    }
    throw new Error(
      `Memory record already exists with name=${JSON.stringify(canonicalName)}, ` +
        `type=${input.type} (id=${collision.id}). Use upsert({ force: true }) ` +
        `to overwrite or pick a different name.`,
    );
  }

  const dup = findDuplicate(input.content, existingRecords, ctx.threshold);
  if (dup !== undefined) {
    return {
      action: "skipped",
      record: dup.record,
      duplicateOf: dup.id,
      similarity: dup.similarity,
    };
  }

  return createRecord(ctx, {
    ...input,
    name: canonicalName,
    description: canonicalDescription,
  });
}

async function createRecord(
  ctx: StoreContext,
  input: MemoryRecordInput,
): Promise<{ readonly action: "created"; readonly record: MemoryRecord }> {
  const serialized = serializeMemoryFrontmatter(
    {
      name: input.name,
      description: input.description,
      type: input.type,
      confidence: input.confidence,
    },
    input.content,
  );
  if (serialized === undefined) {
    throw new Error("Failed to serialize memory record — invalid frontmatter or empty content");
  }

  const filename = deriveFilename(input.name, await rawMemoryFilenames(ctx));
  const fullPath = memoryPath(ctx, filename);
  const written = await ctx.fs.write(fullPath, serialized, {
    createDirectories: true,
    overwrite: false,
  });
  if (!written.ok) throw toError(written, "write memory record");

  const parsed = parseMemoryFrontmatter(serialized);
  const now = Date.now();
  return {
    action: "created",
    record: {
      id: memoryRecordId(filenameToId(filename)),
      name: parsed?.frontmatter.name ?? input.name,
      description: parsed?.frontmatter.description ?? input.description,
      type: parsed?.frontmatter.type ?? input.type,
      content: parsed?.content ?? input.content,
      filePath: filename,
      createdAt: now,
      updatedAt: now,
      ...(parsed?.frontmatter.confidence !== undefined
        ? { confidence: parsed.frontmatter.confidence }
        : {}),
    },
  };
}

async function updateRecord(
  ctx: StoreContext,
  id: MemoryRecordId,
  patch: MemoryRecordPatch,
): Promise<UpdateResult> {
  const records = await scanRecords(ctx);
  const existing = records.find((entry) => entry.record.id === id);
  if (existing === undefined) throw new Error(`Memory record not found: ${id}`);

  const updated: MemoryRecordInput = {
    name: patch.name ?? existing.record.name,
    description: patch.description ?? existing.record.description,
    type: patch.type ?? existing.record.type,
    content: patch.content ?? existing.record.content,
    confidence: "confidence" in patch ? patch.confidence : existing.record.confidence,
  };

  const canonicalName = sanitizeFrontmatterValue(updated.name);
  const keyChanged =
    canonicalName !== existing.record.name || updated.type !== existing.record.type;
  if (keyChanged) {
    const collision = records.find(
      (entry) =>
        entry.record.id !== id &&
        entry.record.name === canonicalName &&
        entry.record.type === updated.type,
    );
    if (collision !== undefined) {
      throw new Error(
        `Cannot rename memory record ${id}: target (name=${JSON.stringify(canonicalName)}, ` +
          `type=${updated.type}) is already owned by ${collision.record.id}.`,
      );
    }
  }

  const serialized = serializeMemoryFrontmatter(
    {
      name: canonicalName,
      description: sanitizeFrontmatterValue(updated.description),
      type: updated.type,
      confidence: updated.confidence,
    },
    updated.content,
  );
  if (serialized === undefined) throw new Error("Failed to serialize updated memory record");

  const written = await ctx.fs.write(existing.fullPath, serialized, {
    createDirectories: true,
    overwrite: true,
  });
  if (!written.ok) throw toError(written, "update memory record");

  const parsed = parseMemoryFrontmatter(serialized);
  return {
    record: {
      id: existing.record.id,
      name: parsed?.frontmatter.name ?? canonicalName,
      description: parsed?.frontmatter.description ?? updated.description,
      type: parsed?.frontmatter.type ?? updated.type,
      content: parsed?.content ?? updated.content,
      filePath: existing.record.filePath,
      createdAt: existing.record.createdAt,
      updatedAt: Date.now(),
      ...(parsed?.frontmatter.confidence !== undefined
        ? { confidence: parsed.frontmatter.confidence }
        : {}),
    },
  };
}

async function deleteRecord(ctx: StoreContext, id: MemoryRecordId): Promise<DeleteResult> {
  const records = await scanRecords(ctx);
  const existing = records.find((entry) => entry.record.id === id);
  if (existing === undefined) return { deleted: false };
  if (ctx.fs.delete === undefined) {
    throw new Error("Memory backend does not support delete()");
  }

  const deleted = await ctx.fs.delete(existing.fullPath);
  if (!deleted.ok) {
    if (deleted.error.code === "NOT_FOUND") return { deleted: false };
    throw toError(deleted, "delete memory record");
  }
  return { deleted: true };
}

async function upsertRecord(
  ctx: StoreContext,
  input: MemoryRecordInput,
  force: boolean,
): Promise<UpsertResult> {
  const records = await scanRecords(ctx);
  const existingRecords = records.map((entry) => entry.record);
  const canonicalName = sanitizeFrontmatterValue(input.name);
  const canonicalDescription = sanitizeFrontmatterValue(input.description);
  const canonicalInput: MemoryRecordInput = {
    ...input,
    name: canonicalName,
    description: canonicalDescription,
  };
  const nameTypeMatches = existingRecords.filter(
    (record) => record.name === canonicalName && record.type === canonicalInput.type,
  );

  if (nameTypeMatches.length > 1) {
    return {
      action: "corrupted",
      canonicalName,
      type: canonicalInput.type,
      conflictingIds: nameTypeMatches.map((record) => record.id),
    };
  }

  const nameTypeMatch = nameTypeMatches[0];
  if (nameTypeMatch !== undefined) {
    if (!force) return { action: "conflict", existing: nameTypeMatch };
    const updated = await updateRecord(ctx, nameTypeMatch.id, {
      description: canonicalDescription,
      content: canonicalInput.content,
      ...(canonicalInput.confidence !== undefined ? { confidence: canonicalInput.confidence } : {}),
    });
    return { action: "updated", record: updated.record };
  }

  const dup = findDuplicate(canonicalInput.content, existingRecords, ctx.threshold);
  if (dup !== undefined) {
    return {
      action: "skipped",
      record: dup.record,
      duplicateOf: dup.id,
      similarity: dup.similarity,
    };
  }

  return createRecord(ctx, canonicalInput);
}

async function attemptIndexRebuild(
  ctx: StoreContext,
  operation: MemoryStoreOperation,
): Promise<unknown> {
  try {
    const records = (await scanRecords(ctx)).map((entry) => entry.record);
    const lines = [...records]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) =>
        formatMemoryIndexEntry({
          title: record.name,
          filePath: record.filePath,
          hook: record.description,
        }),
      )
      .filter((line): line is string => line !== undefined);
    const written = await ctx.fs.write(memoryPath(ctx, INDEX_FILENAME), `${lines.join("\n")}\n`, {
      createDirectories: true,
      overwrite: true,
    });
    if (!written.ok) throw toError(written, "rebuild MEMORY.md");
    return undefined;
  } catch (e: unknown) {
    if (ctx.onIndexError !== undefined) {
      void Promise.resolve()
        .then(() => ctx.onIndexError?.(e, { operation }))
        .catch((): undefined => undefined);
    }
    return e;
  }
}
