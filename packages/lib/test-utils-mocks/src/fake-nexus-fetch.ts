/**
 * In-memory fake Nexus JSON-RPC server for testing.
 *
 * Implements the Nexus filesystem methods (read, write, exists, delete, glob),
 * scratchpad RPC methods (scratchpad.write, scratchpad.read, etc.),
 * and scheduler RPC methods (scheduler.task.*, scheduler.schedule.*, scheduler.claim, etc.)
 * with glob matching that supports single-segment wildcard patterns.
 *
 * Extracted from @koi/events-nexus for reuse across store and event backends.
 */

// ---------------------------------------------------------------------------
// JSON-RPC types (local to fake — no shared dependency needed)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scratchpad store entry (local to fake)
// ---------------------------------------------------------------------------

interface ScratchpadStoreEntry {
  readonly path: string;
  readonly content: string;
  readonly groupId: string;
  readonly authorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sizeBytes: number;
  readonly generation: number;
  readonly ttlSeconds?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Scheduler store types (local to fake)
// ---------------------------------------------------------------------------

interface SchedulerTaskEntry {
  readonly id: string;
  readonly agent_id: string;
  readonly input: unknown;
  readonly mode: string;
  readonly priority: number;
  readonly status: string;
  readonly created_at: number;
  readonly scheduled_at?: number | undefined;
  readonly started_at?: number | undefined;
  readonly completed_at?: number | undefined;
  readonly retries: number;
  readonly max_retries: number;
  readonly timeout_ms?: number | undefined;
  readonly last_error?: unknown | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  /** Node that currently holds the claim, if any. */
  readonly claimed_by?: string | undefined;
  /** Timestamp when the claim was acquired. */
  readonly claimed_at?: number | undefined;
  /** How long the claim is valid. */
  readonly visibility_timeout_ms?: number | undefined;
}

interface SchedulerScheduleEntry {
  readonly id: string;
  readonly expression: string;
  readonly agent_id: string;
  readonly input: unknown;
  readonly mode: string;
  readonly task_options?: unknown | undefined;
  readonly timezone?: string | undefined;
  readonly paused: boolean;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Match a file path against a glob pattern.
 * Supports `*` (single segment) within a known directory structure.
 *
 * Pattern: /forge/bricks/*.json
 * matches: /forge/bricks/brick_abc.json
 */
function matchGlob(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");

  if (patternParts.length !== pathParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const sp = pathParts[i];
    if (pp === undefined || sp === undefined) return false;
    if (pp === "*") continue;
    if (pp.includes("*")) {
      const regex = new RegExp(`^${pp.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      if (!regex.test(sp)) return false;
    } else if (pp !== sp) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// JSON-RPC response helpers
// ---------------------------------------------------------------------------

function jsonRpcOk(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Scratchpad key helper
// ---------------------------------------------------------------------------

function scratchpadKey(groupId: string, path: string): string {
  return `${groupId}:${path}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a fake fetch that mimics a Nexus JSON-RPC server with in-memory storage. */
export function createFakeNexusFetch(): typeof globalThis.fetch {
  const files = new Map<string, string>();
  const scratchpad = new Map<string, ScratchpadStoreEntry>();
  const tasks = new Map<string, SchedulerTaskEntry>();
  const schedules = new Map<string, SchedulerScheduleEntry>();
  const tickClaims = new Set<string>(); // key: `${scheduleId}:${nodeId}:${Math.floor(now/60000)}`

  return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as JsonRpcRequest;
    const { method, params, id } = body;

    // let justified: result assigned in switch branches
    let result: unknown;

    switch (method) {
      case "write": {
        const path = params.path as string;
        const content = params.content as string;
        files.set(path, content);
        result = null;
        break;
      }
      case "read": {
        const path = params.path as string;
        const content = files.get(path);
        if (content === undefined) {
          return jsonRpcError(id, -32000, "Not found");
        }
        result = content;
        break;
      }
      case "exists": {
        const path = params.path as string;
        result = files.has(path);
        break;
      }
      case "delete": {
        const path = params.path as string;
        files.delete(path);
        result = null;
        break;
      }
      case "glob": {
        const pattern = params.pattern as string;
        const matched: string[] = [];
        for (const key of files.keys()) {
          if (matchGlob(pattern, key)) {
            matched.push(key);
          }
        }
        matched.sort();
        result = matched;
        break;
      }

      // -------------------------------------------------------------------
      // Filesystem extended methods (for FileSystemBackend contract)
      // -------------------------------------------------------------------

      case "list": {
        const basePath = params.path as string;
        const glob = params.glob as string | undefined;
        const recursive = params.recursive as boolean | undefined;

        const baseWithSlash = basePath.endsWith("/") ? basePath : `${basePath}/`;
        const entries = [...files.entries()]
          .filter(([key]) => key.startsWith(baseWithSlash))
          .filter(([key]) => recursive === true || !key.slice(baseWithSlash.length).includes("/"))
          .filter(([key]) => {
            if (glob === undefined) return true;
            const filename = key.split("/").pop() ?? "";
            return matchGlob(glob, filename) || matchGlob(`${basePath}/${glob}`, key);
          })
          .map(([key, content]) => ({
            path: key,
            kind: "file" as const,
            size: new TextEncoder().encode(content).byteLength,
          }))
          .toSorted((a, b) => a.path.localeCompare(b.path));
        result = { entries, truncated: false };
        break;
      }

      case "search": {
        const pattern = params.pattern as string;
        const searchBasePath = params.basePath as string | undefined;
        const maxResults = params.maxResults as number | undefined;
        const caseSensitive = params.caseSensitive as boolean | undefined;

        const flags = caseSensitive === false ? "i" : "";
        const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

        const allMatches = [...files.entries()]
          .filter(([key]) => searchBasePath === undefined || key.startsWith(searchBasePath))
          .flatMap(([key, content]) =>
            content
              .split("\n")
              .map((lineText, idx) => ({ path: key, line: idx + 1, text: lineText }))
              .filter((entry) => regex.test(entry.text)),
          );

        const limited = maxResults !== undefined ? allMatches.slice(0, maxResults) : allMatches;
        result = {
          matches: limited,
          truncated: maxResults !== undefined && allMatches.length > maxResults,
        };
        break;
      }

      case "edit": {
        const editPath = params.path as string;
        const edits = params.edits as ReadonlyArray<{ oldText: string; newText: string }>;
        const dryRun = params.dryRun as boolean | undefined;

        const existing = files.get(editPath);
        if (existing === undefined) {
          return jsonRpcError(id, -32000, "Not found");
        }

        // let justified: content is mutated through edit replacements
        let updated = existing;
        // let justified: counter incremented per successful hunk
        let hunksApplied = 0;
        for (const edit of edits) {
          if (updated.includes(edit.oldText)) {
            updated = updated.replace(edit.oldText, edit.newText);
            hunksApplied += 1;
          }
        }

        if (dryRun !== true) {
          files.set(editPath, updated);
        }

        result = { path: editPath, hunksApplied };
        break;
      }

      case "rename": {
        const from = params.from as string;
        const to = params.to as string;
        const content = files.get(from);
        if (content === undefined) {
          return jsonRpcError(id, -32000, "Not found");
        }
        files.set(to, content);
        files.delete(from);
        result = { from, to };
        break;
      }

      // -------------------------------------------------------------------
      // Scratchpad RPC methods
      // -------------------------------------------------------------------

      case "scratchpad.write": {
        const groupId = params.groupId as string;
        const authorId = params.authorId as string;
        const path = params.path as string;
        const content = params.content as string;
        const expectedGeneration = params.expectedGeneration as number | undefined;
        const ttlSeconds = params.ttlSeconds as number | undefined;
        const metadata = params.metadata as Record<string, unknown> | undefined;

        const key = scratchpadKey(groupId, path);
        const existing = scratchpad.get(key);
        const currentGeneration = existing?.generation ?? 0;

        // CAS logic
        if (expectedGeneration === 0 && existing !== undefined) {
          return jsonRpcError(id, -32000, "CONFLICT: path already exists");
        }
        if (
          expectedGeneration !== undefined &&
          expectedGeneration > 0 &&
          expectedGeneration !== currentGeneration
        ) {
          return jsonRpcError(
            id,
            -32000,
            `CONFLICT: expected generation ${String(expectedGeneration)} but current is ${String(currentGeneration)}`,
          );
        }

        const now = new Date().toISOString();
        const nextGeneration = currentGeneration + 1;
        const sizeBytes = new TextEncoder().encode(content).byteLength;

        const entry: ScratchpadStoreEntry = {
          path,
          content,
          groupId,
          authorId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          sizeBytes,
          generation: nextGeneration,
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        };
        scratchpad.set(key, entry);

        result = { path, generation: nextGeneration, sizeBytes };
        break;
      }

      case "scratchpad.read": {
        const groupId = params.groupId as string;
        const path = params.path as string;
        const key = scratchpadKey(groupId, path);
        const entry = scratchpad.get(key);
        if (entry === undefined) {
          return jsonRpcError(id, -32000, "NOT_FOUND");
        }
        result = entry;
        break;
      }

      case "scratchpad.generation": {
        const groupId = params.groupId as string;
        const path = params.path as string;
        const key = scratchpadKey(groupId, path);
        const entry = scratchpad.get(key);
        if (entry === undefined) {
          return jsonRpcError(id, -32000, "NOT_FOUND");
        }
        result = { generation: entry.generation };
        break;
      }

      case "scratchpad.list": {
        const groupId = params.groupId as string;
        const glob = params.glob as string | undefined;
        const authorId = params.authorId as string | undefined;
        const limit = params.limit as number | undefined;

        const entries: ScratchpadStoreEntry[] = [];
        for (const [key, entry] of scratchpad) {
          // Filter by groupId prefix
          if (!key.startsWith(`${groupId}:`)) continue;

          // Filter by glob pattern against the path
          if (glob !== undefined && !matchGlob(glob, entry.path)) continue;

          // Filter by authorId
          if (authorId !== undefined && entry.authorId !== authorId) continue;

          entries.push(entry);

          // Apply limit
          if (limit !== undefined && entries.length >= limit) break;
        }

        result = { entries };
        break;
      }

      case "scratchpad.delete": {
        const groupId = params.groupId as string;
        const path = params.path as string;
        const key = scratchpadKey(groupId, path);
        if (!scratchpad.has(key)) {
          return jsonRpcError(id, -32000, "NOT_FOUND");
        }
        scratchpad.delete(key);
        result = null;
        break;
      }

      case "scratchpad.provision": {
        // No-op success — provisioning is a no-op in the fake
        result = null;
        break;
      }

      // -------------------------------------------------------------------
      // Scheduler task RPC methods
      // -------------------------------------------------------------------

      case "scheduler.task.save": {
        const entry: SchedulerTaskEntry = {
          id: params.id as string,
          agent_id: params.agent_id as string,
          input: params.input,
          mode: params.mode as string,
          priority: params.priority as number,
          status: params.status as string,
          created_at: params.created_at as number,
          scheduled_at: params.scheduled_at as number | undefined,
          started_at: params.started_at as number | undefined,
          completed_at: params.completed_at as number | undefined,
          retries: params.retries as number,
          max_retries: params.max_retries as number,
          timeout_ms: params.timeout_ms as number | undefined,
          last_error: params.last_error,
          metadata: params.metadata as Record<string, unknown> | undefined,
        };
        tasks.set(entry.id, entry);
        result = null;
        break;
      }

      case "scheduler.task.load": {
        const taskId = params.id as string;
        const task = tasks.get(taskId);
        result = { task: task ?? null };
        break;
      }

      case "scheduler.task.remove": {
        const taskId = params.id as string;
        tasks.delete(taskId);
        result = null;
        break;
      }

      case "scheduler.task.updateStatus": {
        const taskId = params.id as string;
        const existing = tasks.get(taskId);
        if (existing === undefined) {
          return jsonRpcError(id, -32000, "NOT_FOUND");
        }
        const updated: SchedulerTaskEntry = {
          ...existing,
          status: params.status as string,
          ...(params.started_at !== undefined ? { started_at: params.started_at as number } : {}),
          ...(params.completed_at !== undefined
            ? { completed_at: params.completed_at as number }
            : {}),
          ...(params.last_error !== undefined ? { last_error: params.last_error } : {}),
          ...(params.retries !== undefined ? { retries: params.retries as number } : {}),
        };
        tasks.set(taskId, updated);
        result = null;
        break;
      }

      case "scheduler.task.query": {
        const status = params.status as string | undefined;
        const agentId = params.agent_id as string | undefined;
        const priority = params.priority as number | undefined;
        const limit = params.limit as number | undefined;

        const matched: SchedulerTaskEntry[] = [];
        for (const task of tasks.values()) {
          if (status !== undefined && task.status !== status) continue;
          if (agentId !== undefined && task.agent_id !== agentId) continue;
          if (priority !== undefined && task.priority !== priority) continue;
          matched.push(task);
          if (limit !== undefined && matched.length >= limit) break;
        }

        // Sort by priority ASC, then created_at ASC
        matched.sort((a, b) => {
          const pd = a.priority - b.priority;
          if (pd !== 0) return pd;
          return a.created_at - b.created_at;
        });

        result = { tasks: matched };
        break;
      }

      // -------------------------------------------------------------------
      // Scheduler distributed claim/ack/nack/tick
      // -------------------------------------------------------------------

      case "scheduler.claim": {
        const nodeId = params.node_id as string;
        const claimLimit = (params.limit as number | undefined) ?? 10;
        const visibilityMs = (params.visibility_timeout_ms as number | undefined) ?? 30_000;
        const now = Date.now();

        const claimed: SchedulerTaskEntry[] = [];
        for (const [taskId, task] of tasks) {
          if (claimed.length >= claimLimit) break;
          if (task.status !== "pending") continue;

          // Check if already claimed and not expired
          if (
            task.claimed_by !== undefined &&
            task.claimed_at !== undefined &&
            task.visibility_timeout_ms !== undefined &&
            now - task.claimed_at < task.visibility_timeout_ms
          ) {
            continue;
          }

          // Claim the task
          const claimedTask: SchedulerTaskEntry = {
            ...task,
            claimed_by: nodeId,
            claimed_at: now,
            visibility_timeout_ms: visibilityMs,
          };
          tasks.set(taskId, claimedTask);
          claimed.push(claimedTask);
        }

        result = { tasks: claimed };
        break;
      }

      case "scheduler.ack": {
        const taskId = params.task_id as string;
        const task = tasks.get(taskId);
        if (task === undefined) {
          result = { ok: false };
          break;
        }
        // Mark as completed and remove claim
        tasks.set(taskId, {
          ...task,
          status: "completed",
          completed_at: Date.now(),
          claimed_by: undefined,
          claimed_at: undefined,
          visibility_timeout_ms: undefined,
        });
        result = { ok: true };
        break;
      }

      case "scheduler.nack": {
        const taskId = params.task_id as string;
        const task = tasks.get(taskId);
        if (task === undefined) {
          result = { ok: false };
          break;
        }
        // Remove claim — task returns to claimable state
        tasks.set(taskId, {
          ...task,
          claimed_by: undefined,
          claimed_at: undefined,
          visibility_timeout_ms: undefined,
        });
        result = { ok: true };
        break;
      }

      case "scheduler.tick": {
        const schedId = params.schedule_id as string;
        const nodeId = params.node_id as string;
        // Dedup key: scheduleId + nodeId-agnostic tick window (1-minute buckets)
        const tickKey = `${schedId}:${String(Math.floor(Date.now() / 60_000))}`;
        if (tickClaims.has(tickKey)) {
          result = { claimed: false };
        } else {
          tickClaims.add(tickKey);
          // Store which node won (for test assertions)
          void nodeId;
          result = { claimed: true };
        }
        break;
      }

      // -------------------------------------------------------------------
      // Scheduler schedule RPC methods
      // -------------------------------------------------------------------

      case "scheduler.schedule.save": {
        const entry: SchedulerScheduleEntry = {
          id: params.id as string,
          expression: params.expression as string,
          agent_id: params.agent_id as string,
          input: params.input,
          mode: params.mode as string,
          task_options: params.task_options,
          timezone: params.timezone as string | undefined,
          paused: params.paused as boolean,
        };
        schedules.set(entry.id, entry);
        result = null;
        break;
      }

      case "scheduler.schedule.remove": {
        const schedId = params.id as string;
        schedules.delete(schedId);
        result = null;
        break;
      }

      case "scheduler.schedule.list": {
        result = { schedules: [...schedules.values()] };
        break;
      }

      default: {
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
      }
    }

    return jsonRpcOk(id, result);
  }) as typeof globalThis.fetch;
}
