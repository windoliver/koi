/**
 * mDNS/Bonjour service discovery — publish and discover Koi nodes.
 *
 * Publishes this node as a discoverable service on the local network.
 * Discovery of peer nodes is optional for local routing.
 *
 * Uses lazy loading to avoid penalizing startup when disabled.
 */

import type { DiscoveryConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceInfo {
  readonly name: string;
  readonly type: string;
  readonly port: number;
  readonly txt: Readonly<Record<string, string>>;
}

export interface DiscoveryService {
  /** Publish this node as a discoverable service. */
  readonly publish: (info: ServiceInfo) => Promise<void>;
  /** Stop advertising and clean up. */
  readonly unpublish: () => Promise<void>;
  /** Whether the service is currently published. */
  readonly isPublished: () => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDiscoveryService(config: DiscoveryConfig): DiscoveryService {
  let published = false;
  let unpublishFn: (() => void) | undefined;

  return {
    async publish(info) {
      if (!config.enabled || published) return;

      try {
        // Dynamic import to avoid loading bonjour when discovery is disabled.
        // The bonjour package is a peer/optional dependency.
        const { default: Bonjour } = await import("bonjour" as string);
        const instance = Bonjour();

        instance.publish({
          name: info.name,
          type: config.serviceType.replace(/^_/, "").replace(/\._tcp$/, ""),
          port: info.port,
          txt: info.txt,
        });

        published = true;
        unpublishFn = () => {
          instance.unpublishAll();
          instance.destroy();
        };
      } catch {
        // bonjour not available — discovery is optional
        published = false;
      }
    },

    async unpublish() {
      if (!published || unpublishFn === undefined) return;
      unpublishFn();
      unpublishFn = undefined;
      published = false;
    },

    isPublished() {
      return published;
    },
  };
}
