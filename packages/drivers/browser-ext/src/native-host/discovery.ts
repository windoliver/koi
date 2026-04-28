import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DiscoveryRecord {
  readonly instanceId: string;
  readonly pid: number;
  readonly socket: string;
  readonly ready: boolean;
  readonly name: string;
  readonly browserHint: string | null;
  readonly extensionVersion: string | null;
  readonly epoch: number;
  readonly seq: number;
}

function recordPath(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
}

export async function writeDiscoveryFile(dir: string, record: DiscoveryRecord): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const finalPath = recordPath(dir, record.pid);
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(tmpPath, finalPath);
}

export async function unlinkDiscoveryFile(dir: string, pid: number): Promise<void> {
  await rm(recordPath(dir, pid), { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

export async function scanInstances(dir: string): Promise<readonly DiscoveryRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const out: DiscoveryRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    let content: string;
    try {
      content = await readFile(full, "utf-8");
    } catch {
      continue;
    }
    let record: DiscoveryRecord;
    try {
      record = JSON.parse(content) as DiscoveryRecord;
    } catch {
      continue;
    }
    if (!isPidAlive(record.pid)) {
      await rm(full, { force: true });
      continue;
    }
    out.push(record);
  }
  return out;
}

export async function supersedeStale(
  dir: string,
  newRecord: Pick<DiscoveryRecord, "instanceId" | "epoch" | "seq">,
): Promise<void> {
  const existing = await scanInstances(dir);
  for (const rec of existing) {
    if (rec.instanceId !== newRecord.instanceId) continue;
    const isLower =
      rec.epoch < newRecord.epoch || (rec.epoch === newRecord.epoch && rec.seq < newRecord.seq);
    if (isLower && !isPidAlive(rec.pid)) {
      await rm(recordPath(dir, rec.pid), { force: true });
    }
  }
}
