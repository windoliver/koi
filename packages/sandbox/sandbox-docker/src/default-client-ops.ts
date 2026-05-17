import { Buffer } from "node:buffer";
import {
  mapInspectStatus,
  quoteShellArg,
  runDocker,
  runDockerExecBounded,
  safeParseLabels,
  wrapCmdWithTimeout,
} from "./default-client-helpers.js";
import {
  DOCKER_NAME_CONFLICT_CODE,
  type DockerContainer,
  type DockerContainerInfo,
  type DockerCreateOpts,
  type DockerExecOpts,
  type DockerExecResult,
} from "./types.js";

export function buildCreateArgs(opts: DockerCreateOpts): readonly string[] {
  const args: string[] = ["create", "--network", opts.networkMode];
  if (opts.pidsLimit !== undefined) args.push("--pids-limit", String(opts.pidsLimit));
  if (opts.memoryMb !== undefined) args.push("--memory", `${opts.memoryMb}m`);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  for (const bind of opts.binds ?? []) args.push("--volume", bind);
  for (const cap of opts.capAdd ?? []) args.push("--cap-add", cap);
  if (opts.readOnlyRoot === true) args.push("--read-only");
  for (const path of opts.tmpfsMounts ?? []) args.push("--tmpfs", path);
  for (const [k, v] of Object.entries(opts.labels ?? {})) args.push("--label", `${k}=${v}`);
  if (opts.name !== undefined) args.push("--name", opts.name);
  args.push("--", opts.image, "sleep", "infinity");
  return args;
}

function buildExecArgs(id: string, cmd: string, execOpts: DockerExecOpts): readonly string[] {
  const args: string[] = ["exec"];
  for (const [k, v] of Object.entries(execOpts.env ?? {})) args.push("--env", `${k}=${v}`);
  if (execOpts.cwd !== undefined) {
    args.push("--workdir", execOpts.cwd);
  }
  // Wrap with in-container `timeout` when timeoutMs is set, so only the exec'd
  // process is killed — NOT PID 1 (sleep infinity) which would destroy the container.
  const wrappedCmd =
    execOpts.timeoutMs !== undefined && execOpts.timeoutMs > 0
      ? wrapCmdWithTimeout(cmd, execOpts.timeoutMs)
      : cmd;
  args.push(id, "sh", "-c", wrappedCmd);
  return args;
}

async function execOp(
  id: string,
  env: Record<string, string>,
  cmd: string,
  execOpts: DockerExecOpts,
): Promise<DockerExecResult> {
  const args = buildExecArgs(id, cmd, execOpts);
  return runDockerExecBounded(id, args, execOpts, env);
}

async function readFileOp(
  id: string,
  env: Record<string, string>,
  path: string,
): Promise<Uint8Array> {
  const r = await runDocker(["exec", id, "base64", path], undefined, env);
  if (r.exitCode !== 0) {
    throw new Error(`readFile failed for container ${id}`, { cause: r });
  }
  const buf = Buffer.from(r.stdout.trim(), "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function writeFileOp(
  id: string,
  env: Record<string, string>,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const b64 = Buffer.from(content).toString("base64");
  const quotedPath = quoteShellArg(path);
  const r = await runDocker(["exec", "-i", id, "sh", "-c", `base64 -d > ${quotedPath}`], b64, env);
  if (r.exitCode !== 0) {
    throw new Error(`writeFile failed for container ${id}`, { cause: r });
  }
}

async function removeOp(id: string, env: Record<string, string>): Promise<void> {
  const r = await runDocker(["rm", "-f", id], undefined, env);
  if (r.exitCode === 0) return;
  // Idempotent on "no such container" — calling remove() twice (or
  // racing with a peer's cleanup) must not error.
  const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
  if (blob.includes("no such container") || blob.includes("no such object")) {
    return;
  }
  throw new Error(`docker rm -f failed for ${id}`, { cause: r });
}

async function stopOp(id: string, env: Record<string, string>): Promise<void> {
  const r = await runDocker(["stop", id], undefined, env);
  if (r.exitCode !== 0) {
    throw new Error(`docker stop failed for ${id}`, { cause: r });
  }
}

export function makeContainer(id: string, env: Record<string, string>): DockerContainer {
  return {
    id,
    exec: (cmd, execOpts = {}) => execOp(id, env, cmd, execOpts),
    readFile: (path) => readFileOp(id, env, path),
    writeFile: (path, content) => writeFileOp(id, env, path, content),
    stop: () => stopOp(id, env),
    remove: () => removeOp(id, env),
    // Persistence: stop without remove so a later findOrCreate(scope) reattaches.
    detach: () => stopOp(id, env),
  };
}

export async function createContainerOp(
  env: Record<string, string>,
  opts: DockerCreateOpts,
): Promise<DockerContainer> {
  const create = await runDocker(buildCreateArgs(opts), undefined, env);
  if (create.exitCode !== 0) {
    // Daemon-level uniqueness: when --name collides with an existing container,
    // surface a typed error so the persistence adapter can recover by reattaching
    // to the winner instead of treating this as a fatal create failure.
    if (opts.name !== undefined && /is already in use by container/i.test(create.stderr)) {
      const conflict = Object.assign(
        new Error(`docker container name "${opts.name}" is already in use`),
        { code: DOCKER_NAME_CONFLICT_CODE } as const,
      );
      throw conflict;
    }
    throw new Error("docker create failed", { cause: create });
  }
  const id = create.stdout.trim();
  try {
    const start = await runDocker(["start", id], undefined, env);
    if (start.exitCode !== 0) {
      throw new Error(`docker start failed for ${id}`, { cause: start });
    }
  } catch (e: unknown) {
    // Best-effort: remove the orphaned container. Don't mask the original error.
    try {
      await runDocker(["rm", "-f", id], undefined, env);
    } catch (_: unknown) {
      // ignore: original error wins
    }
    throw e;
  }
  return makeContainer(id, env);
}

export async function findContainersOp(
  env: Record<string, string>,
  labels: Readonly<Record<string, string>>,
): Promise<readonly DockerContainer[]> {
  const filterArgs: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    filterArgs.push("--filter", `label=${k}=${v}`);
  }
  // `--no-trunc` forces full 64-char hex IDs. Without it docker emits 12-char
  // short IDs which mismatch the full IDs returned by `docker create` and stored
  // in the registry — the trust check would falsely reject our own container as
  // a stranger.
  const r = await runDocker(["ps", "-a", "-q", "--no-trunc", ...filterArgs], undefined, env);
  if (r.exitCode !== 0) {
    // Do NOT collapse a transient `docker ps` failure into "no matches".
    // findOrCreate would then proceed to fresh-create on the deterministic
    // --name (later colliding) or destroyScope would forget the registry
    // entry — both turn a momentary daemon outage into a wedged scope.
    throw new Error(
      `docker ps failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`,
      { cause: r },
    );
  }
  const ids = r.stdout
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return ids.map((id) => makeContainer(id, env));
}

export async function resolveImageIdOp(
  env: Record<string, string>,
  imageRef: string,
): Promise<string | undefined> {
  // `docker image inspect` resolves a tag/digest to its content-addressed ID
  // without contacting a registry. Returns undefined when the image is not
  // pulled locally — the adapter degrades to (image-string, profile) only.
  const r = await runDocker(["image", "inspect", "--format", "{{.Id}}", imageRef], undefined, env);
  if (r.exitCode !== 0) {
    // Differentiate "image not pulled locally" (legitimate degraded path) from
    // "daemon hiccup" (must throw so drift detection is not silently disabled).
    const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
    if (blob.includes("no such image") || blob.includes("no such object")) {
      return undefined;
    }
    throw new Error(
      `docker image inspect failed for ${imageRef}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`,
      { cause: r },
    );
  }
  const id = r.stdout.trim();
  return id.length > 0 ? id : undefined;
}

export async function inspectContainerOp(
  env: Record<string, string>,
  id: string,
): Promise<DockerContainerInfo | undefined> {
  // Tab-separated output: "<status>\t<json-labels>". Using a literal tab keeps
  // both fields parseable even when label values contain commas/spaces.
  const r = await runDocker(
    ["inspect", "--format", "{{.State.Status}}\t{{json .Config.Labels}}", id],
    undefined,
    env,
  );
  if (r.exitCode !== 0) {
    // Distinguish "container truly gone" from "transient daemon hiccup". The
    // adapter forgets the registry entry on undefined, so collapsing every
    // failure into undefined would let a momentary docker outage erase ownership
    // for a container that still exists.
    const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
    if (blob.includes("no such container") || blob.includes("no such object")) {
      return undefined;
    }
    throw new Error(`docker inspect failed for ${id}: ${r.stderr.trim() || r.stdout.trim()}`, {
      cause: r,
    });
  }
  const tab = r.stdout.indexOf("\t");
  if (tab === -1) {
    return { state: mapInspectStatus(r.stdout), labels: {} };
  }
  const statusRaw = r.stdout.slice(0, tab);
  const labelsRaw = r.stdout.slice(tab + 1).trim();
  // Docker emits the literal string "null" for an empty label set.
  const labels: Record<string, string> =
    labelsRaw === "" || labelsRaw === "null" ? {} : safeParseLabels(labelsRaw);
  return { state: mapInspectStatus(statusRaw), labels };
}

export async function startContainerOp(env: Record<string, string>, id: string): Promise<void> {
  const r = await runDocker(["start", id], undefined, env);
  if (r.exitCode !== 0) {
    throw new Error(`docker start failed for ${id}`, { cause: r });
  }
}
