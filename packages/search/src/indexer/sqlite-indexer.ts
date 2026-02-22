import { Database } from "bun:sqlite";
import type { Embedder, IndexDocument, Indexer, KoiError, Result } from "@koi/core";
import type { ChunkerConfig } from "./chunker.js";
import { chunk } from "./chunker.js";

export interface SqliteIndexerConfig {
  readonly dbPath: string;
  readonly embedder: Embedder;
  readonly chunkerConfig?: Partial<ChunkerConfig>;
  readonly embeddingBatchSize?: number;
}

const DEFAULT_BATCH_SIZE = 50;

export function createSqliteIndexer(
  config: SqliteIndexerConfig,
): Indexer & { readonly close: () => void } {
  const db = new Database(config.dbPath);
  const batchSize = config.embeddingBatchSize ?? DEFAULT_BATCH_SIZE;

  db.run("PRAGMA journal_mode=WAL");

  // FTS5 table for BM25 search
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      id UNINDEXED,
      doc_id UNINDEXED,
      content,
      tokenize='unicode61'
    )
  `);

  // Vector table (blob storage for embeddings)
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks_vec (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      embedding BLOB NOT NULL
    )
  `);

  // Metadata table
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks_meta (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      content TEXT NOT NULL DEFAULT ''
    )
  `);

  // Index for doc_id lookups
  db.run("CREATE INDEX IF NOT EXISTS idx_vec_doc_id ON chunks_vec(doc_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_meta_doc_id ON chunks_meta(doc_id)");

  const insertFts = db.prepare("INSERT INTO chunks_fts (id, doc_id, content) VALUES (?, ?, ?)");
  const insertVec = db.prepare(
    "INSERT OR REPLACE INTO chunks_vec (id, doc_id, embedding) VALUES (?, ?, ?)",
  );
  const insertMeta = db.prepare(
    "INSERT OR REPLACE INTO chunks_meta (id, doc_id, metadata, content) VALUES (?, ?, ?, ?)",
  );

  const deleteFtsByDocId = db.prepare("DELETE FROM chunks_fts WHERE doc_id = ?");
  const deleteVecByDocId = db.prepare("DELETE FROM chunks_vec WHERE doc_id = ?");
  const deleteMetaByDocId = db.prepare("DELETE FROM chunks_meta WHERE doc_id = ?");

  function serializeEmbedding(embedding: readonly number[]): Uint8Array {
    const floats = new Float32Array(embedding);
    return new Uint8Array(floats.buffer);
  }

  async function indexDocuments(
    documents: readonly IndexDocument[],
  ): Promise<Result<void, KoiError>> {
    try {
      for (const doc of documents) {
        // Chunk the document
        const chunks = chunk(doc.content, config.chunkerConfig);

        // Collect texts for batch embedding
        const texts = chunks.map((c) => c.text);

        // Batch embed
        let embeddings: readonly (readonly number[])[];
        if (doc.embedding && chunks.length === 1) {
          embeddings = [doc.embedding];
        } else {
          embeddings = await batchEmbed(texts, config.embedder, batchSize);
        }

        // Insert into all tables within a transaction
        db.transaction(() => {
          // Remove existing chunks for this doc
          deleteFtsByDocId.run(doc.id);
          deleteVecByDocId.run(doc.id);
          deleteMetaByDocId.run(doc.id);

          for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const emb = embeddings[i];
            if (c === undefined || emb === undefined) continue;
            const chunkId = `${doc.id}:${i}`;

            insertFts.run(chunkId, doc.id, c.text);
            insertVec.run(chunkId, doc.id, serializeEmbedding(emb));
            insertMeta.run(chunkId, doc.id, JSON.stringify(doc.metadata ?? {}), c.text);
          }
        })();
      }

      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "SQLite indexer failed to index documents",
          retryable: true,
          cause: err,
          context: { backend: "sqlite-indexer" },
        },
      };
    }
  }

  async function removeDocuments(ids: readonly string[]): Promise<Result<void, KoiError>> {
    try {
      db.transaction(() => {
        for (const id of ids) {
          deleteFtsByDocId.run(id);
          deleteVecByDocId.run(id);
          deleteMetaByDocId.run(id);
        }
      })();
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "SQLite indexer failed to remove documents",
          retryable: true,
          cause: err,
          context: { backend: "sqlite-indexer" },
        },
      };
    }
  }

  function close(): void {
    db.close();
  }

  return {
    index: indexDocuments,
    remove: removeDocuments,
    close,
  };
}

async function batchEmbed(
  texts: readonly string[],
  embedder: Embedder,
  batchSize: number,
): Promise<readonly (readonly number[])[]> {
  const results: (readonly number[])[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await embedder.embedMany(batch);
    results.push(...embeddings);
  }
  return results;
}
