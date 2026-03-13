/**
 * createSkillStack — factory that composes skill providers, gating,
 * middleware, and optional file watchers into a single bundle.
 */

import type { ComponentEvent, KoiError, KoiMiddleware, Result, SkillConfig } from "@koi/core";
import { fsSkill } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import {
  createSkillActivatorMiddleware,
  createSkillComponentProvider,
  createSkillFileWatcher,
  gateSkills,
  gateSkillsWithCredentials,
} from "@koi/skills";
import { severityAtOrAbove } from "@koi/validation";
import { SKILL_STACK_PRESET_SPECS } from "./presets.js";
import type { ResolvedSkillStackMeta, SkillStackBundle, SkillStackConfig } from "./types.js";

/**
 * Creates a skill-stack bundle that composes:
 * - Gating (filter skills by requirements)
 * - Progressive provider (metadata → body → bundled)
 * - Skill activator middleware (auto-promote on reference)
 * - Optional file watcher (hot-plug on fs changes)
 * - Optional forge→mount bridge (via ComponentEvent)
 */
export async function createSkillStack(config: SkillStackConfig): Promise<SkillStackBundle> {
  const {
    skills,
    basePath,
    store,
    preset = "standard",
    overrideDirs,
    watch: watchConfig,
    watchDebounceMs,
    onSecurityFinding,
    forgeProvider,
    notifier,
    credentialComponent,
    requiresMap,
  } = config;

  const presetSpec = SKILL_STACK_PRESET_SPECS[preset];
  const shouldWatch = watchConfig ?? presetSpec.watchDefault;

  // Phase 1: Gate skills by requirements (platform, bins, env, credentials)
  const { eligible } =
    credentialComponent !== undefined
      ? await gateSkillsWithCredentials(skills, requiresMap, credentialComponent)
      : gateSkills(skills, requiresMap);

  // Phase 2: Create provider with eligible skills
  const findingCallback = createSecurityGate(presetSpec.securityThreshold, onSecurityFinding);

  const provider = createSkillComponentProvider({
    skills: eligible,
    basePath,
    loadLevel: "body",
    onSecurityFinding: findingCallback,
    ...(store !== undefined ? { store } : {}),
  });

  // Phase 3: Create activator middleware
  const activator = createSkillActivatorMiddleware({ provider });
  const middleware: readonly KoiMiddleware[] = [activator];

  // Phase 4: File watcher setup
  const disposables: Array<() => void> = [];
  // let: watcherCount determined by whether dirs exist and watching is enabled
  let watcherCount = 0;

  if (shouldWatch && overrideDirs !== undefined && overrideDirs.length > 0) {
    const watcher = createSkillFileWatcher({
      dirs: overrideDirs,
      ...(watchDebounceMs !== undefined ? { debounceMs: watchDebounceMs } : {}),
      onChange: (event) => {
        switch (event.kind) {
          case "added":
          case "changed": {
            const skill = fsSkill(event.name, event.dirPath);
            void provider.mount(skill, basePath, findingCallback);
            break;
          }
          case "removed": {
            provider.unmount(event.name);
            break;
          }
        }
      },
    });
    disposables.push(watcher.dispose);
    watcherCount = overrideDirs.length;
  }

  // Phase 5: Forge→Mount bridge
  // let: unsubscribe function captured for dispose
  let forgeUnsub: (() => void) | undefined;
  if (forgeProvider?.watch !== undefined) {
    forgeUnsub = forgeProvider.watch((event: ComponentEvent) => {
      if (event.kind === "attached" && event.componentKey.startsWith("brick:skill:")) {
        const name = event.componentKey.slice("brick:skill:".length);
        // Create a forged skill config and mount it
        const skill: SkillConfig = {
          name,
          source: { kind: "forged", brickId: name as never },
        };
        void provider.mount(skill, basePath, findingCallback);
      }
    });
    disposables.push(() => forgeUnsub?.());
  }

  // Phase 6: StoreChangeNotifier bridge — listen for "saved" skill bricks
  if (notifier !== undefined) {
    const notifierUnsub = notifier.subscribe((event) => {
      if (event.kind === "saved") {
        // The provider will re-discover on next attach cycle.
        // For immediate hot-mount, the caller can use mount() directly.
        console.debug(`[skill-stack] Store change: ${event.kind} ${event.brickId}`);
      }
    });
    disposables.push(notifierUnsub);
  }

  // mount/unmount proxy
  const mount = (skill: SkillConfig): Promise<Result<void, KoiError>> => {
    return provider.mount(skill, basePath, findingCallback);
  };

  const unmount = (name: string): void => {
    provider.unmount(name);
  };

  const dispose = (): void => {
    for (const fn of disposables) {
      fn();
    }
    disposables.length = 0;
  };

  const meta: ResolvedSkillStackMeta = {
    preset,
    skillCount: eligible.length,
    watcherCount,
    gatingEnabled: true,
  };

  return {
    provider,
    middleware,
    mount,
    unmount,
    dispose,
    config: meta,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Creates a security finding callback that enforces the preset's severity threshold.
 * Findings at or above the threshold are reported via the user callback.
 */
function createSecurityGate(
  threshold: string,
  userCallback?: (name: string, findings: readonly ScanFinding[]) => void,
): (name: string, findings: readonly ScanFinding[]) => void {
  return (name, findings) => {
    // Always forward to user callback
    userCallback?.(name, findings);

    // Check if any finding meets or exceeds the threshold
    const hasBlocking = findings.some((f) =>
      severityAtOrAbove(f.severity, threshold as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"),
    );
    if (hasBlocking) {
      console.warn(
        `[skill-stack] Skill "${name}" has security findings at or above ${threshold} threshold`,
      );
    }
  };
}
