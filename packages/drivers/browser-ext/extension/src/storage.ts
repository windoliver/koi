import { z } from "zod";

import { logBrowserExt } from "./logger.js";

export interface AlwaysGrantRecord {
  readonly grant: "always";
  readonly grantedAt: string;
}

export interface LocalStorageState {
  readonly hostBootCounter: number;
  readonly instanceId: string | null;
  readonly installId: string | null;
  readonly alwaysGrants: Record<string, AlwaysGrantRecord>;
  readonly privateOriginAllowlist: readonly string[];
  readonly extensionName: string;
}

/**
 * Per-tab/document one-time consent grant. We track `origin` so
 * origin-scoped admin revocation can target only matching entries, instead
 * of widening to a global wipe that affects unrelated sessions.
 */
export interface AllowOnceGrantRecord {
  readonly origin: string;
}

export interface SessionStorageState {
  readonly browserSessionId: string | null;
  readonly allowOnceGrants: Record<string, AllowOnceGrantRecord>;
  readonly recentlyRetiredSessionIds: readonly string[];
}

export interface ExtensionStorage {
  readonly getLocalState: () => Promise<LocalStorageState>;
  readonly getSessionState: () => Promise<SessionStorageState>;
  readonly getAlwaysGrants: () => Promise<Record<string, AlwaysGrantRecord>>;
  readonly setAlwaysGrant: (origin: string, grantedAt: string) => Promise<void>;
  readonly removeAlwaysGrant: (origin: string) => Promise<void>;
  readonly clearAlwaysGrants: () => Promise<readonly string[]>;
  readonly getPrivateOriginAllowlist: () => Promise<readonly string[]>;
  readonly setPrivateOriginAllowlist: (origins: readonly string[]) => Promise<void>;
  readonly clearPrivateOriginAllowlist: () => Promise<readonly string[]>;
  readonly getAllowOnceGrants: () => Promise<Record<string, AllowOnceGrantRecord>>;
  readonly grantAllowOnce: (tabId: number, documentId: string, origin: string) => Promise<void>;
  readonly hasAllowOnceGrant: (tabId: number, documentId: string) => Promise<boolean>;
  readonly clearAllowOnceGrants: () => Promise<readonly string[]>;
  readonly revokeAllowOnceForTab: (tabId: number) => Promise<void>;
  readonly revokeAllowOnceForOrigin: (origin: string) => Promise<readonly string[]>;
  readonly getInstanceId: () => Promise<string>;
  readonly getBrowserSessionId: () => Promise<string>;
  readonly getInstallId: () => Promise<string | null>;
  readonly setInstallId: (installId: string) => Promise<void>;
  readonly getExtensionName: () => Promise<string>;
  readonly setExtensionName: (name: string) => Promise<void>;
  readonly incrementHostBootCounter: () => Promise<number>;
  readonly retireSessionId: (sessionId: string) => Promise<void>;
}

const AlwaysGrantRecordSchema: z.ZodType<AlwaysGrantRecord> = z.object({
  grant: z.literal("always"),
  grantedAt: z.string(),
});

const AlwaysGrantsSchema: z.ZodType<Record<string, AlwaysGrantRecord>> = z.record(
  z.string(),
  AlwaysGrantRecordSchema,
);

const AllowOnceGrantRecordSchema: z.ZodType<AllowOnceGrantRecord> = z.object({
  origin: z.string(),
});

const AllowOnceGrantsSchema: z.ZodType<Record<string, AllowOnceGrantRecord>> = z.record(
  z.string(),
  AllowOnceGrantRecordSchema,
);

const _LocalStateSchema: z.ZodType<LocalStorageState> = z.object({
  hostBootCounter: z.number().int().nonnegative().default(0),
  instanceId: z.string().uuid().nullable().default(null),
  installId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  alwaysGrants: AlwaysGrantsSchema.default({}),
  privateOriginAllowlist: z.array(z.string()).default([]),
  extensionName: z.string().default("default"),
});

const _SessionStateSchema: z.ZodType<SessionStorageState> = z.object({
  browserSessionId: z.string().uuid().nullable().default(null),
  allowOnceGrants: AllowOnceGrantsSchema.default({}),
  recentlyRetiredSessionIds: z.array(z.string().uuid()).default([]),
});

const LOCAL_KEYS = [
  "koi.hostBootCounter",
  "koi.instanceId",
  "koi.installId",
  "koi.alwaysGrants",
  "koi.privateOriginAllowlist",
  "koi.extensionName",
] as const;

const SESSION_KEYS = [
  "koi.browserSessionId",
  "koi.allowOnceGrants",
  "koi.recentlyRetiredSessionIds",
] as const;

function allowOnceKey(tabId: number, documentId: string): string {
  return `${tabId}:${documentId}`;
}

async function storageGet(
  area: chrome.storage.StorageArea,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  return (await (
    area.get as unknown as (input: readonly string[]) => Promise<Record<string, unknown>>
  )([...keys])) as Record<string, unknown>;
}

async function storageSet(
  area: chrome.storage.StorageArea,
  value: Record<string, unknown>,
): Promise<void> {
  await (area.set as unknown as (input: Record<string, unknown>) => Promise<void>)(value);
}

function parseOrDefault<T>(schema: z.ZodType<T>, input: unknown, fallback: T, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  if (input !== undefined)
    logBrowserExt(`storage value for ${label} had unexpected shape`, result.error);
  return fallback;
}

export function createExtensionStorage(): ExtensionStorage {
  return {
    async getLocalState(): Promise<LocalStorageState> {
      const raw = await storageGet(chrome.storage.local, LOCAL_KEYS);
      return {
        hostBootCounter: parseOrDefault(
          z.number().int().nonnegative(),
          raw["koi.hostBootCounter"],
          0,
          "koi.hostBootCounter",
        ),
        instanceId: parseOrDefault(
          z.string().uuid().nullable(),
          raw["koi.instanceId"],
          null,
          "koi.instanceId",
        ),
        installId: parseOrDefault(
          z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
          raw["koi.installId"],
          null,
          "koi.installId",
        ),
        alwaysGrants: parseOrDefault(
          AlwaysGrantsSchema,
          raw["koi.alwaysGrants"],
          {},
          "koi.alwaysGrants",
        ),
        privateOriginAllowlist: parseOrDefault(
          z.array(z.string()),
          raw["koi.privateOriginAllowlist"],
          [],
          "koi.privateOriginAllowlist",
        ),
        extensionName: parseOrDefault(
          z.string(),
          raw["koi.extensionName"],
          "default",
          "koi.extensionName",
        ),
      };
    },
    async getSessionState(): Promise<SessionStorageState> {
      const raw = await storageGet(chrome.storage.session, SESSION_KEYS);
      return {
        browserSessionId: parseOrDefault(
          z.string().uuid().nullable(),
          raw["koi.browserSessionId"],
          null,
          "koi.browserSessionId",
        ),
        allowOnceGrants: parseOrDefault(
          AllowOnceGrantsSchema,
          raw["koi.allowOnceGrants"],
          {},
          "koi.allowOnceGrants",
        ),
        recentlyRetiredSessionIds: parseOrDefault(
          z.array(z.string().uuid()),
          raw["koi.recentlyRetiredSessionIds"],
          [],
          "koi.recentlyRetiredSessionIds",
        ),
      };
    },
    async getAlwaysGrants(): Promise<Record<string, AlwaysGrantRecord>> {
      return (await this.getLocalState()).alwaysGrants;
    },
    async setAlwaysGrant(origin: string, grantedAt: string): Promise<void> {
      const local = await this.getLocalState();
      await storageSet(chrome.storage.local, {
        "koi.alwaysGrants": {
          ...local.alwaysGrants,
          [origin]: { grant: "always", grantedAt },
        },
      });
    },
    async removeAlwaysGrant(origin: string): Promise<void> {
      const local = await this.getLocalState();
      const next = { ...local.alwaysGrants };
      delete next[origin];
      await storageSet(chrome.storage.local, { "koi.alwaysGrants": next });
    },
    async clearAlwaysGrants(): Promise<readonly string[]> {
      const local = await this.getLocalState();
      await storageSet(chrome.storage.local, { "koi.alwaysGrants": {} });
      return Object.keys(local.alwaysGrants);
    },
    async getPrivateOriginAllowlist(): Promise<readonly string[]> {
      return (await this.getLocalState()).privateOriginAllowlist;
    },
    async setPrivateOriginAllowlist(origins: readonly string[]): Promise<void> {
      await storageSet(chrome.storage.local, {
        "koi.privateOriginAllowlist": [...new Set(origins)].sort(),
      });
    },
    async clearPrivateOriginAllowlist(): Promise<readonly string[]> {
      const local = await this.getLocalState();
      await storageSet(chrome.storage.local, { "koi.privateOriginAllowlist": [] });
      return local.privateOriginAllowlist;
    },
    async getAllowOnceGrants(): Promise<Record<string, AllowOnceGrantRecord>> {
      return (await this.getSessionState()).allowOnceGrants;
    },
    async grantAllowOnce(tabId: number, documentId: string, origin: string): Promise<void> {
      const session = await this.getSessionState();
      await storageSet(chrome.storage.session, {
        "koi.allowOnceGrants": {
          ...session.allowOnceGrants,
          [allowOnceKey(tabId, documentId)]: { origin },
        },
      });
    },
    async hasAllowOnceGrant(tabId: number, documentId: string): Promise<boolean> {
      const grants = await this.getAllowOnceGrants();
      return grants[allowOnceKey(tabId, documentId)] !== undefined;
    },
    async clearAllowOnceGrants(): Promise<readonly string[]> {
      const session = await this.getSessionState();
      await storageSet(chrome.storage.session, { "koi.allowOnceGrants": {} });
      return Object.keys(session.allowOnceGrants);
    },
    async revokeAllowOnceForTab(tabId: number): Promise<void> {
      const session = await this.getSessionState();
      const next: Record<string, AllowOnceGrantRecord> = {};
      for (const [key, value] of Object.entries(session.allowOnceGrants)) {
        if (!key.startsWith(`${tabId}:`)) next[key] = value;
      }
      await storageSet(chrome.storage.session, { "koi.allowOnceGrants": next });
    },
    async revokeAllowOnceForOrigin(origin: string): Promise<readonly string[]> {
      const session = await this.getSessionState();
      const next: Record<string, AllowOnceGrantRecord> = {};
      const removed: string[] = [];
      for (const [key, value] of Object.entries(session.allowOnceGrants)) {
        if (value.origin === origin) {
          removed.push(key);
          continue;
        }
        next[key] = value;
      }
      await storageSet(chrome.storage.session, { "koi.allowOnceGrants": next });
      return removed;
    },
    async getInstanceId(): Promise<string> {
      const local = await this.getLocalState();
      if (local.instanceId) return local.instanceId;
      const instanceId = crypto.randomUUID();
      await storageSet(chrome.storage.local, { "koi.instanceId": instanceId });
      return instanceId;
    },
    async getBrowserSessionId(): Promise<string> {
      const session = await this.getSessionState();
      if (session.browserSessionId) return session.browserSessionId;
      const browserSessionId = crypto.randomUUID();
      await storageSet(chrome.storage.session, { "koi.browserSessionId": browserSessionId });
      return browserSessionId;
    },
    async getInstallId(): Promise<string | null> {
      return (await this.getLocalState()).installId;
    },
    async setInstallId(installId: string): Promise<void> {
      await storageSet(chrome.storage.local, { "koi.installId": installId });
    },
    async getExtensionName(): Promise<string> {
      return (await this.getLocalState()).extensionName;
    },
    async setExtensionName(name: string): Promise<void> {
      await storageSet(chrome.storage.local, { "koi.extensionName": name });
    },
    async incrementHostBootCounter(): Promise<number> {
      const local = await this.getLocalState();
      const nextValue = local.hostBootCounter + 1;
      await storageSet(chrome.storage.local, { "koi.hostBootCounter": nextValue });
      return nextValue;
    },
    async retireSessionId(sessionId: string): Promise<void> {
      const session = await this.getSessionState();
      const next = [
        sessionId,
        ...session.recentlyRetiredSessionIds.filter((value) => value !== sessionId),
      ].slice(0, 1024);
      await storageSet(chrome.storage.session, { "koi.recentlyRetiredSessionIds": next });
    },
  };
}

export function createAllowOnceGrantKey(tabId: number, documentId: string): string {
  return allowOnceKey(tabId, documentId);
}
