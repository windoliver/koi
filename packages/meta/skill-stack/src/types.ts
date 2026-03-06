/**
 * Configuration and bundle types for @koi/skill-stack.
 */

import type {
  ComponentProvider,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  Result,
  SkillConfig,
  StoreChangeNotifier,
} from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import type { ProgressiveSkillProvider } from "@koi/skills";

export type SkillStackPreset = "restrictive" | "standard" | "permissive";

export interface SkillUserConfig {
  readonly [skillName: string]: {
    readonly enabled?: boolean;
    readonly env?: Readonly<Record<string, string>>;
  };
}

export interface SkillStackConfig {
  readonly skills: readonly SkillConfig[];
  readonly basePath: string;
  readonly store?: ForgeStore;
  readonly preset?: SkillStackPreset;
  readonly overrideDirs?: readonly string[];
  readonly userConfig?: SkillUserConfig;
  readonly watch?: boolean;
  readonly watchDebounceMs?: number;
  readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
  /** Optional forge tools ComponentProvider — bridge via watch() for ComponentEvent. */
  readonly forgeProvider?: ComponentProvider;
  /** Optional store change notifier — bridge via subscribe() for StoreChangeEvent. */
  readonly notifier?: StoreChangeNotifier;
}

export interface SkillStackBundle {
  readonly provider: ProgressiveSkillProvider;
  readonly middleware: readonly KoiMiddleware[];
  readonly mount: (skill: SkillConfig) => Promise<Result<void, KoiError>>;
  readonly unmount: (name: string) => void;
  readonly dispose: () => void;
  readonly config: ResolvedSkillStackMeta;
}

export interface ResolvedSkillStackMeta {
  readonly preset: SkillStackPreset;
  readonly skillCount: number;
  readonly watcherCount: number;
  readonly gatingEnabled: boolean;
}
