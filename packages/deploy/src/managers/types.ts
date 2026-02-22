/**
 * Service manager interface — abstracts OS service operations.
 */

export type ServiceStatus = "running" | "stopped" | "failed" | "not-installed";

export interface LogOptions {
  readonly follow: boolean;
  readonly lines: number;
}

export interface ServiceManager {
  readonly install: (serviceName: string, content: string) => Promise<void>;
  readonly uninstall: (serviceName: string) => Promise<void>;
  readonly start: (serviceName: string) => Promise<void>;
  readonly stop: (serviceName: string) => Promise<void>;
  readonly status: (serviceName: string) => Promise<ServiceStatus>;
  readonly logs: (serviceName: string, opts: LogOptions) => AsyncIterable<string>;
}
