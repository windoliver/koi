declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { Server as HttpServer, IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  namespace WebSocket {
    type RawData = string | Buffer | ArrayBuffer | Buffer[];
  }

  class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly readyState: number;
    constructor(
      address: string,
      options?: {
        readonly headers?: Readonly<Record<string, string>> | undefined;
      },
    );
    send(data: string): void;
    close(): void;
    once(event: "open", listener: () => void): this;
    once(event: "close", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(
      event: "unexpected-response",
      listener: (request: IncomingMessage, response: IncomingMessage) => void,
    ): this;
    once(event: "message", listener: (data: WebSocket.RawData) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "message", listener: (data: WebSocket.RawData) => void): this;
  }

  export interface WebSocketServerOptions {
    readonly noServer?: boolean | undefined;
    readonly server?: HttpServer | undefined;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: WebSocketServerOptions);
    close(callback?: (error?: Error) => void): void;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket, request: IncomingMessage) => void,
    ): void;
  }

  export { WebSocket };
  export default WebSocket;
}
