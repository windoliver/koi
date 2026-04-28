import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

export interface SocketServer {
  readonly close: () => Promise<void>;
  readonly server: Server;
}

export async function createSocketServer(config: {
  readonly socketPath: string;
  readonly onConnection: (socket: Socket) => void;
}): Promise<SocketServer> {
  await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(config.socketPath), 0o700).catch(() => {});
  await rm(config.socketPath, { force: true });

  const server = createServer((socket) => {
    config.onConnection(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(config.socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });

  await chmod(config.socketPath, 0o600);

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        rm(config.socketPath, { force: true }).catch(() => {});
      }),
  };
}
