/**
 * Append-only daily session log.
 *
 * Writes timestamped entries to `sessions/YYYY-MM-DD.md`.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export async function appendSessionLog(
  baseDir: string,
  content: string,
  timestamp: Date,
): Promise<void> {
  const sessionsDir = join(baseDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  const date = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}`;
  const time = `${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}`;
  const filePath = join(sessionsDir, `${date}.md`);

  await appendFile(filePath, `- [${time}] ${content}\n`, "utf-8");
}
