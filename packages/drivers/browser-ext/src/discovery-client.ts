import { rm, stat } from "node:fs/promises";

import type { JsonObject, KoiError } from "@koi/core";
import { createExtensionError } from "./errors.js";
import type { DiscoveryRecord } from "./native-host/discovery.js";
import { scanInstances } from "./native-host/discovery.js";

export interface HostSelector {
  readonly instanceId?: string;
  readonly pid?: number;
  readonly name?: string;
  readonly browserHint?: string;
}

export interface DiscoveryCandidate extends DiscoveryRecord {}

export interface SelectHostOptions {
  readonly instancesDir: string;
  readonly select?: HostSelector | undefined;
}

function usesTcpTestEndpoint(socket: string): boolean {
  return socket.startsWith("tcp://");
}

export async function listDiscoveryCandidates(
  instancesDir: string,
): Promise<readonly DiscoveryCandidate[]> {
  const scanned = await scanInstances(instancesDir);
  const grouped = new Map<string, DiscoveryCandidate>();

  for (const record of scanned) {
    if (record.ready !== true) {
      continue;
    }
    if (!usesTcpTestEndpoint(record.socket)) {
      try {
        await stat(record.socket);
      } catch {
        await rm(`${instancesDir}/${record.pid}.json`, { force: true });
        continue;
      }
    }

    const previous = grouped.get(record.instanceId);
    if (previous === undefined || compareRecordOrder(record, previous) > 0) {
      grouped.set(record.instanceId, record);
    }
  }

  return [...grouped.values()];
}

function compareRecordOrder(left: DiscoveryCandidate, right: DiscoveryCandidate): number {
  if (left.epoch !== right.epoch) {
    return left.epoch - right.epoch;
  }
  return left.seq - right.seq;
}

function matchesSelector(record: DiscoveryCandidate, select: HostSelector): boolean {
  if (select.instanceId !== undefined && record.instanceId !== select.instanceId) {
    return false;
  }
  if (select.pid !== undefined && record.pid !== select.pid) {
    return false;
  }
  if (select.name !== undefined && record.name !== select.name) {
    return false;
  }
  if (select.browserHint !== undefined && record.browserHint !== select.browserHint) {
    return false;
  }
  return true;
}

export async function selectDiscoveryHost(
  options: SelectHostOptions,
): Promise<DiscoveryCandidate | KoiError> {
  const candidates = await listDiscoveryCandidates(options.instancesDir);
  const selector = options.select;
  const narrowed =
    selector === undefined
      ? candidates
      : candidates.filter((record) => matchesSelector(record, selector));

  if (narrowed.length === 0) {
    return createExtensionError(
      "HOST_SPAWN_FAILED",
      "No live browser extension host was found. Make sure Chrome is open and the Koi Browser Extension is enabled.",
      { reason: "no_extension_running" },
    );
  }

  if (narrowed.length > 1) {
    return createExtensionError(
      "HOST_AMBIGUOUS",
      "Multiple Koi browser extension hosts are active. Narrow selection with createExtensionBrowserDriver({ select }).",
      {
        alternatives: narrowed.map((record) => ({
          instanceId: record.instanceId,
          pid: record.pid,
          name: record.name,
          browserHint: record.browserHint,
          extensionVersion: record.extensionVersion,
        })) as unknown as JsonObject,
      } as JsonObject,
    );
  }

  const match = narrowed[0];
  if (match === undefined) {
    return createExtensionError(
      "HOST_SPAWN_FAILED",
      "No matching browser extension host was found.",
    );
  }
  return match;
}
