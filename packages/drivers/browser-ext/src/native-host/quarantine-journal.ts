import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface QuarantineEntry {
  readonly tabId: number;
  readonly sessionId: string;
  readonly reason: string;
  readonly writerEpoch: number;
  readonly writerSeq: number;
}

interface JournalFile {
  readonly browserSessionId: string;
  readonly entries: readonly QuarantineEntry[];
}

export interface QuarantineJournal {
  readonly addEntry: (entry: QuarantineEntry) => Promise<void>;
  readonly readEntries: () => Promise<readonly QuarantineEntry[]>;
  readonly removeEntry: (key: {
    readonly tabId: number;
    readonly writerEpoch: number;
    readonly writerSeq: number;
  }) => Promise<void>;
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        return await fn();
      } finally {
        await handle.close();
        await (await import("node:fs/promises")).rm(lockPath, { force: true });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      await new Promise<void>((r) => setTimeout(r, 10 + attempt * 5));
    }
  }
  throw new Error(`Quarantine journal: could not acquire lock at ${lockPath}`);
}

async function readJournalFile(path: string): Promise<JournalFile | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as JournalFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function createQuarantineJournal(config: {
  readonly dir: string;
  readonly instanceId: string;
  readonly browserSessionId: string;
}): Promise<QuarantineJournal> {
  await mkdir(config.dir, { recursive: true, mode: 0o700 });
  const filePath = join(config.dir, `${config.instanceId}.quarantine.json`);
  const lockPath = `${filePath}.lock`;

  async function merge(mutate: (cur: QuarantineEntry[]) => QuarantineEntry[]): Promise<void> {
    await withLock(lockPath, async () => {
      const existing = await readJournalFile(filePath);
      const baseEntries =
        existing && existing.browserSessionId === config.browserSessionId ? existing.entries : [];
      const next = mutate([...baseEntries]);
      const record: JournalFile = {
        browserSessionId: config.browserSessionId,
        entries: next,
      };
      await writeFile(filePath, JSON.stringify(record), { mode: 0o600 });
    });
  }

  return {
    addEntry: (entry) =>
      merge((cur) => {
        const existingIdx = cur.findIndex(
          (e) =>
            e.tabId === entry.tabId &&
            e.writerEpoch === entry.writerEpoch &&
            e.writerSeq === entry.writerSeq,
        );
        if (existingIdx >= 0) return cur;
        return [...cur, entry];
      }),
    removeEntry: ({ tabId, writerEpoch, writerSeq }) =>
      merge((cur) =>
        cur.filter(
          (e) => !(e.tabId === tabId && e.writerEpoch === writerEpoch && e.writerSeq === writerSeq),
        ),
      ),
    readEntries: async () => {
      const existing = await readJournalFile(filePath);
      if (!existing) return [];
      if (existing.browserSessionId !== config.browserSessionId) return [];
      return existing.entries;
    },
  };
}
