import type { AdvertisedTool, CapacityReport, ComponentProvider } from "@koi/core";

export interface DeviceGatewayClient {
  readonly connect: () => void;
  readonly disconnect: () => void;
  readonly updateProviders: (providers: readonly ComponentProvider[]) => void;
}

export interface DeviceGatewaySocket {
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  readonly send: (data: string) => void;
  readonly close: () => void;
}

export interface DeviceGatewayClientConfig {
  readonly gatewayUrl: string;
  readonly nodeId: string;
  readonly providers: readonly ComponentProvider[];
  readonly version?: string | undefined;
  readonly capacity?: CapacityReport | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly reconnectDelayMs?: number | undefined;
  readonly webSocketFactory?: ((url: string) => DeviceGatewaySocket) | undefined;
}

const DEVICE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  device: [
    "device.location",
    "device.motion",
    "device.sms",
    "device.push",
    "device.camera",
    "device.contacts",
  ],
  "device:location": ["device.location"],
  "device:motion": ["device.motion"],
  "device:sms": ["device.sms"],
  "device:push": ["device.push"],
  "device:camera": ["device.camera"],
  "device:contacts": ["device.contacts"],
} as const;

function providerTools(provider: ComponentProvider): readonly AdvertisedTool[] {
  const names = DEVICE_TOOL_NAMES[provider.name] ?? [provider.name.replace(":", ".")];
  return names.map((name) => ({
    name,
    description: `Device provider: ${provider.name}`,
  }));
}

function advertiseProviders(providers: readonly ComponentProvider[]): readonly AdvertisedTool[] {
  const allTools = providers.flatMap((provider) => providerTools(provider));
  const names = new Set<string>();
  return allTools.filter((tool) => {
    if (names.has(tool.name)) return false;
    names.add(tool.name);
    return true;
  });
}

function frame(kind: string, nodeId: string, payload: unknown, correlationId?: string): string {
  return JSON.stringify({
    kind,
    nodeId,
    agentId: "",
    correlationId: correlationId ?? crypto.randomUUID(),
    payload,
  });
}

function parseCapabilitiesQuery(data: string, nodeId: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const msg = parsed as Record<string, unknown>;
  if (msg.kind !== "node:capabilities_query") return undefined;
  if (msg.nodeId !== nodeId) return undefined;
  return typeof msg.correlationId === "string" ? msg.correlationId : undefined;
}

function diffTools(
  before: readonly AdvertisedTool[],
  after: readonly AdvertisedTool[],
): { readonly added: readonly AdvertisedTool[]; readonly removed: readonly string[] } {
  const beforeNames = new Set(before.map((tool) => tool.name));
  const afterNames = new Set(after.map((tool) => tool.name));
  return {
    added: after.filter((tool) => !beforeNames.has(tool.name)),
    removed: before.filter((tool) => !afterNames.has(tool.name)).map((tool) => tool.name),
  };
}

class DefaultDeviceGatewayClient implements DeviceGatewayClient {
  private readonly config: DeviceGatewayClientConfig;
  private providers: readonly ComponentProvider[];
  private socket: DeviceGatewaySocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private shouldReconnect = true;

  private readonly capacity: CapacityReport;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly webSocketFactory: (url: string) => DeviceGatewaySocket;

  constructor(config: DeviceGatewayClientConfig) {
    this.config = config;
    this.providers = config.providers;
    this.capacity = config.capacity ?? { current: 0, max: 1, available: 1 };
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 10_000;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 1_000;
    this.webSocketFactory =
      config.webSocketFactory ?? ((url: string): DeviceGatewaySocket => new WebSocket(url));
  }

  connect(): void {
    this.shouldReconnect = true;
    this.open();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearTimers();
    this.socket?.close();
    this.socket = undefined;
  }

  updateProviders(nextProviders: readonly ComponentProvider[]): void {
    const before = advertiseProviders(this.providers);
    const after = advertiseProviders(nextProviders);
    this.providers = nextProviders;
    this.send("node:tools_updated", diffTools(before, after));
  }

  private send(kind: string, payload: unknown): void {
    this.socket?.send(frame(kind, this.config.nodeId, payload));
  }

  private sendCapabilities(correlationId?: string): void {
    this.socket?.send(
      frame(
        "node:capabilities",
        this.config.nodeId,
        {
          nodeType: "thin",
          tools: advertiseProviders(this.providers),
        },
        correlationId,
      ),
    );
  }

  private clearTimers(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (this.reconnect !== undefined) clearTimeout(this.reconnect);
    this.heartbeat = undefined;
    this.reconnect = undefined;
  }

  private open(): void {
    this.clearTimers();
    this.socket = this.webSocketFactory(this.config.gatewayUrl);
    this.socket.onopen = () => {
      this.send("node:handshake", {
        nodeId: this.config.nodeId,
        version: this.config.version ?? "0.0.0",
        capacity: this.capacity,
      });
      this.sendCapabilities();
      this.heartbeat = setInterval(
        () => this.send("node:heartbeat", null),
        this.heartbeatIntervalMs,
      );
    };
    this.socket.onmessage = (event) => {
      const correlationId = parseCapabilitiesQuery(event.data, this.config.nodeId);
      if (correlationId !== undefined) this.sendCapabilities(correlationId);
    };
    this.socket.onclose = () => {
      this.clearTimers();
      this.socket = undefined;
      if (this.shouldReconnect) {
        this.reconnect = setTimeout(() => this.open(), this.reconnectDelayMs);
      }
    };
  }
}

export function createDeviceGatewayClient(config: DeviceGatewayClientConfig): DeviceGatewayClient {
  return new DefaultDeviceGatewayClient(config);
}
