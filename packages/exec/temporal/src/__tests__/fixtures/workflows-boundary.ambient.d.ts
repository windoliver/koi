// biome-ignore-all lint/suspicious/noExplicitAny: ambient fixture intentionally uses permissive placeholders
export {};
declare module "@koi/core" {
  export type AgentId = string;
  export type ContentBlock = any;
  export type CronSchedule = any;
  export type EngineInput = any;
  export type KoiError = any;
  export type KoiErrorCode = any;
  export type ScheduledTask = any;
  export type ScheduledTaskStatus = any;
  export type ScheduleId = string;
  export type SchedulerEvent = any;
  export type SchedulerStats = any;
  export type TaskFilter = any;
  export type TaskHistoryFilter = any;
  export type TaskId = string;
  export type TaskOptions = any;
  export type TaskRunRecord = any;
  export type TaskScheduler = any;
  export type SessionId = string;
  export type InboundMessage = any;
  export type SpawnLedger = any;
  export const agentId: any;
  export const scheduleId: any;
  export const taskId: any;
}

declare module "@temporalio/worker" {
  export const Worker: any;
  export const NativeConnection: any;
}

declare module "@temporalio/client" {
  export const Client: any;
  export const Connection: any;
}

declare module "@temporalio/common" {
  export const __temporalCommon: unknown;
}

declare module "@temporalio/workflow" {
  export const __temporalWorkflow: unknown;
  export const sleep: (ms: number) => Promise<void>;
  export const startChild: (workflow: unknown, options?: unknown) => Promise<unknown>;
}

declare module "node:fs" {
  export const closeSync: any;
  export const fsyncSync: any;
  export const linkSync: any;
  export const openSync: any;
  export const readdirSync: any;
  export const readFileSync: any;
  export const renameSync: any;
  export const statSync: any;
  export const unlinkSync: any;
  export const writeFileSync: any;
  export const writeSync: any;
}

declare module "node:path" {
  export const basename: any;
  export const dirname: any;
}

declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly pid: number;
  readonly kill?: (pid: number, signal?: number | string) => boolean;
};

declare namespace NodeJS {
  type ErrnoException = any;
  type Timeout = unknown;
}
