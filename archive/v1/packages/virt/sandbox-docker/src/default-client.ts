/**
 * Default Docker client — communicates with Docker Engine API
 * over the Unix socket using Bun's native fetch.
 */

import type { DockerClient, DockerContainer, DockerCreateOpts, DockerExecOpts } from "./types.js";

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";

/** Fetch helper that routes through the Docker Unix socket. */
async function dockerFetch(
  socketPath: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    unix: socketPath,
  });
}

/** Parse a Docker API JSON response, throwing on HTTP errors. */
async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docker API ${String(res.status)}: ${body}`);
  }
  return (await res.json()) as T;
}

/** Create a DockerContainer handle from a container ID. */
function createContainerHandle(socketPath: string, containerId: string): DockerContainer {
  return {
    id: containerId,

    async exec(cmd: string, opts?: DockerExecOpts) {
      // 1. Create exec instance
      const createRes = await dockerFetch(socketPath, `/v1.43/containers/${containerId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Cmd: ["sh", "-c", cmd],
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: opts?.stdin !== undefined,
          Env:
            opts?.env !== undefined
              ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
              : undefined,
        }),
      });
      const { Id: execId } = await parseResponse<{ readonly Id: string }>(createRes);

      // 2. Start exec and capture output
      const startRes = await dockerFetch(socketPath, `/v1.43/exec/${execId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Detach: false, Tty: false }),
      });

      // Docker multiplexed stream: 8-byte header per frame
      // [stream_type(1), 0, 0, 0, size(4 BE)] + payload
      const raw = new Uint8Array(await startRes.arrayBuffer());
      let stdout = "";
      let stderr = "";
      let offset = 0;
      while (offset + 8 <= raw.length) {
        const streamType = raw[offset];
        const size =
          ((raw[offset + 4] ?? 0) << 24) |
          ((raw[offset + 5] ?? 0) << 16) |
          ((raw[offset + 6] ?? 0) << 8) |
          (raw[offset + 7] ?? 0);
        offset += 8;
        const chunk = new TextDecoder().decode(raw.slice(offset, offset + size));
        if (streamType === 1) {
          stdout += chunk;
        } else if (streamType === 2) {
          stderr += chunk;
        }
        offset += size;
      }

      // 3. Inspect exec for exit code
      const inspectRes = await dockerFetch(socketPath, `/v1.43/exec/${execId}/json`);
      const { ExitCode } = await parseResponse<{ readonly ExitCode: number }>(inspectRes);

      return { exitCode: ExitCode, stdout, stderr };
    },

    async readFile(path: string) {
      const res = await dockerFetch(
        socketPath,
        `/v1.43/containers/${containerId}/archive?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        throw new Error(`Failed to read ${path} from container: ${String(res.status)}`);
      }
      // Docker returns a tar archive — extract the single file
      const tar = new Uint8Array(await res.arrayBuffer());
      // Tar header is 512 bytes, file content starts at offset 512
      // File size is at bytes 124-135 (octal string)
      const sizeStr = new TextDecoder().decode(tar.slice(124, 136)).replace(/\0/g, "").trim();
      const fileSize = Number.parseInt(sizeStr, 8);
      return new TextDecoder().decode(tar.slice(512, 512 + fileSize));
    },

    async writeFile(path: string, content: string) {
      // Create a minimal tar archive with the file
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const dir = path.substring(0, path.lastIndexOf("/")) || "/";
      const filename = path.substring(path.lastIndexOf("/") + 1);

      // Tar header (512 bytes)
      const header = new Uint8Array(512);
      const nameBytes = encoder.encode(filename);
      header.set(nameBytes.slice(0, 100), 0);
      // Mode: 0644
      header.set(encoder.encode("0000644\0"), 100);
      // UID/GID: 0
      header.set(encoder.encode("0000000\0"), 108);
      header.set(encoder.encode("0000000\0"), 116);
      // Size (octal, 11 chars + null)
      const sizeOctal = data.length.toString(8).padStart(11, "0");
      header.set(encoder.encode(`${sizeOctal}\0`), 124);
      // Checksum placeholder (spaces)
      header.set(encoder.encode("        "), 148);
      // Type: regular file
      header[156] = 48; // '0'
      // Compute checksum
      let checksum = 0;
      for (let i = 0; i < 512; i++) {
        checksum += header[i] ?? 0;
      }
      header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);

      // Pad data to 512-byte boundary
      const paddedSize = Math.ceil(data.length / 512) * 512;
      const tarData = new Uint8Array(512 + paddedSize + 1024); // header + data + end-of-archive
      tarData.set(header, 0);
      tarData.set(data, 512);

      await dockerFetch(
        socketPath,
        `/v1.43/containers/${containerId}/archive?path=${encodeURIComponent(dir)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/x-tar" },
          body: tarData,
        },
      );
    },

    async stop() {
      await dockerFetch(socketPath, `/v1.43/containers/${containerId}/stop`, {
        method: "POST",
      });
    },

    async remove() {
      await dockerFetch(socketPath, `/v1.43/containers/${containerId}?force=true`, {
        method: "DELETE",
      });
    },
  };
}

/**
 * Create a default DockerClient that communicates with the Docker Engine
 * via the Unix socket at the given path (default: /var/run/docker.sock).
 */
export function createDefaultDockerClient(socketPath?: string): DockerClient {
  const socket = socketPath ?? DEFAULT_SOCKET_PATH;

  return {
    async createContainer(opts: DockerCreateOpts) {
      // Pull image if not available (ignore errors — create will fail if missing)
      try {
        await dockerFetch(
          socket,
          `/v1.43/images/create?fromImage=${encodeURIComponent(opts.image)}`,
          {
            method: "POST",
          },
        );
      } catch {
        // Image pull failed — container create will surface the real error
      }

      const res = await dockerFetch(socket, "/v1.43/containers/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Image: opts.image,
          Cmd: ["sleep", "infinity"],
          Env:
            opts.env !== undefined
              ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
              : undefined,
          Labels: opts.labels,
          HostConfig: {
            NetworkMode: opts.networkMode,
            ...(opts.memory !== undefined ? { Memory: opts.memory } : {}),
            ...(opts.pidsLimit !== undefined ? { PidsLimit: opts.pidsLimit } : {}),
            ...(opts.binds !== undefined ? { Binds: [...opts.binds] } : {}),
            ...(opts.capAdd !== undefined ? { CapAdd: [...opts.capAdd] } : {}),
          },
        }),
      });
      const { Id } = await parseResponse<{ readonly Id: string }>(res);

      // Start the container
      await dockerFetch(socket, `/v1.43/containers/${Id}/start`, { method: "POST" });

      return createContainerHandle(socket, Id);
    },

    async findContainer(labels: Readonly<Record<string, string>>) {
      const filters = JSON.stringify({
        label: Object.entries(labels).map(([k, v]) => `${k}=${v}`),
      });
      const res = await dockerFetch(
        socket,
        `/v1.43/containers/json?filters=${encodeURIComponent(filters)}`,
      );
      const containers = await parseResponse<readonly { readonly Id: string }[]>(res);
      if (containers.length === 0) return undefined;
      const first = containers[0];
      if (first === undefined) return undefined;
      return createContainerHandle(socket, first.Id);
    },

    async inspectState(id: string) {
      const res = await dockerFetch(socket, `/v1.43/containers/${id}/json`);
      const info = await parseResponse<{ readonly State: { readonly Status: string } }>(res);
      return info.State.Status;
    },

    async startContainer(id: string) {
      await dockerFetch(socket, `/v1.43/containers/${id}/start`, { method: "POST" });
    },
  };
}
