import { Database } from "bun:sqlite";

export interface VectorHit {
  readonly id: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface VectorStoreConfig {
  readonly dbPath: string;
  readonly dimensions: number;
}

export interface VectorStore {
  readonly search: (embedding: readonly number[], limit: number) => readonly VectorHit[];
  readonly insert: (
    id: string,
    embedding: readonly number[],
    metadata: Readonly<Record<string, unknown>>,
  ) => void;
  readonly remove: (id: string) => void;
  readonly warmup: () => void;
  readonly close: () => void;
  /** Whether the native sqlite-vec extension is active */
  readonly nativeVec: boolean;
}

/**
 * Try to load the sqlite-vec extension.
 * Returns true if the extension loaded successfully, false otherwise.
 */
function tryLoadSqliteVec(db: Database): boolean {
  try {
    db.run("SELECT vec_version()");
    return true;
  } catch {
    // Extension not available — fall back to brute-force
    return false;
  }
}

export function createVectorStore(config: VectorStoreConfig): VectorStore {
  const db = new Database(config.dbPath);
  db.run("PRAGMA journal_mode=WAL");

  const hasNativeVec = tryLoadSqliteVec(db);

  // Create metadata table
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks_meta (
      id TEXT PRIMARY KEY,
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);

  if (hasNativeVec) {
    // Use native vec0 virtual table for accelerated vector search
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
      USING vec0(id TEXT PRIMARY KEY, embedding float[${config.dimensions}])
    `);
  } else {
    // Fallback: plain table with BLOB storage
    db.run(`
      CREATE TABLE IF NOT EXISTS chunks_vec (
        id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
      )
    `);
  }

  function serializeEmbedding(embedding: readonly number[]): Uint8Array {
    const floats = new Float32Array(embedding);
    return new Uint8Array(floats.buffer);
  }

  function deserializeEmbedding(data: Uint8Array): readonly number[] {
    const floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    return Array.from(floats);
  }

  function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
  }

  const insertMeta = db.prepare("INSERT OR REPLACE INTO chunks_meta (id, metadata) VALUES (?, ?)");
  const insertVec = hasNativeVec
    ? db.prepare("INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)")
    : db.prepare("INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)");
  const deleteMeta = db.prepare("DELETE FROM chunks_meta WHERE id = ?");
  const deleteVec = db.prepare("DELETE FROM chunks_vec WHERE id = ?");
  const selectMeta = db.prepare("SELECT metadata FROM chunks_meta WHERE id = ?");

  function searchNative(embedding: readonly number[], limit: number): readonly VectorHit[] {
    const blob = serializeEmbedding(embedding);
    const rows = db
      .prepare(
        `SELECT id, distance
         FROM chunks_vec
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(blob, limit) as readonly { id: string; distance: number }[];

    return rows.map((row) => {
      const metaRow = selectMeta.get(row.id) as { metadata: string } | undefined;
      const metadata = metaRow ? (JSON.parse(metaRow.metadata) as Record<string, unknown>) : {};
      // Convert distance to similarity score in [0, 1]: smaller distance = higher score
      const score = 1 / (1 + row.distance);
      return { id: row.id, score, metadata };
    });
  }

  function searchBruteForce(embedding: readonly number[], limit: number): readonly VectorHit[] {
    const selectAllVec = db.prepare("SELECT id, embedding FROM chunks_vec");
    const rows = selectAllVec.all() as readonly { id: string; embedding: Uint8Array }[];
    const scored: { id: string; score: number }[] = [];

    for (const row of rows) {
      const stored = deserializeEmbedding(row.embedding);
      const score = (cosineSimilarity(embedding, stored) + 1) / 2; // Normalize to [0, 1]
      scored.push({ id: row.id, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    return top.map((hit) => {
      const metaRow = selectMeta.get(hit.id) as { metadata: string } | undefined;
      const metadata = metaRow ? (JSON.parse(metaRow.metadata) as Record<string, unknown>) : {};
      return { id: hit.id, score: hit.score, metadata };
    });
  }

  const search = hasNativeVec ? searchNative : searchBruteForce;

  function insert(
    id: string,
    embedding: readonly number[],
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    const blob = serializeEmbedding(embedding);
    db.transaction(() => {
      insertVec.run(id, blob);
      insertMeta.run(id, JSON.stringify(metadata));
    })();
  }

  function remove(id: string): void {
    db.transaction(() => {
      deleteVec.run(id);
      deleteMeta.run(id);
    })();
  }

  function warmup(): void {
    const dummy = new Array(config.dimensions).fill(0) as number[];
    search(dummy, 1);
  }

  function close(): void {
    db.close();
  }

  return { search, insert, remove, warmup, close, nativeVec: hasNativeVec };
}
