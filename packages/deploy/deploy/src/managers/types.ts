/**
 * Service manager interface — abstracts OS service operations.
 */

export type ServiceStatus = "running" | "stopped" | "failed" | "not-installed";

export interface ServiceInfo {
  readonly status: ServiceStatus;
  readonly pid?: number | undefined;
  readonly uptimeMs?: number | undefined;
  readonly memoryBytes?: number | undefined;
}

export interface LogOptions {
  readonly follow: boolean;
  readonly lines: number;
}

export interface ServiceManager {
  readonly install: (serviceName: string, content: string) => Promise<void>;
  readonly uninstall: (serviceName: string) => Promise<void>;
  readonly start: (serviceName: string) => Promise<void>;
  readonly stop: (serviceName: string) => Promise<void>;
  readonly status: (serviceName: string) => Promise<ServiceInfo>;
  readonly logs: (serviceName: string, opts: LogOptions) => AsyncIterable<string>;
}
