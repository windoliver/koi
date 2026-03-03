/**
 * Shared types for @koi/deploy — re-export DeployConfig shape.
 *
 * This mirrors @koi/manifest's DeployConfig but is defined locally to avoid
 * depending on @koi/manifest (L2 packages cannot depend on peer L2).
 */

export interface DeployConfig {
  readonly port: number;
  readonly restart: "on-failure" | "always" | "no";
  readonly restartDelaySec: number;
  readonly envFile?: string | undefined;
  readonly logDir?: string | undefined;
  readonly system: boolean;
}
