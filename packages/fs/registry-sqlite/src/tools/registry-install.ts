/**
 * Tool factory for `registry_install` — install a brick from the registry.
 *
 * For skills: delegates to SkillRegistryReader.install() which handles download.
 * For other kinds: fetches via BrickRegistryReader.get().
 * If an onInstall callback is provided, invokes it with the artifact.
 * Otherwise returns the artifact data (download-only mode).
 *
 * This tool uses "promoted" trust tier since it modifies agent capabilities.
 */

import type {
  BrickArtifact,
  BrickKind,
  JsonObject,
  KoiError,
  RegistryComponent,
  Result,
  Tool,
  TrustTier,
} from "@koi/core";
import { ALL_BRICK_KINDS, skillId } from "@koi/core";
import { parseEnum, parseOptionalString, parseString } from "../parse-args.js";
import { mapBrickInstallSummary } from "./map-brick.js";

export type OnInstallCallback = (artifact: BrickArtifact) => Promise<Result<void, KoiError>>;

export function createRegistryInstallTool(
  facade: RegistryComponent,
  prefix: string,
  trustTier: TrustTier,
  onInstall?: OnInstallCallback,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_install`,
      description:
        "Install a brick from the registry. For skills, downloads and installs. " +
        "For other kinds, fetches the artifact. Evaluate trust tier before installing.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...ALL_BRICK_KINDS],
            description: "Brick kind (tool, skill, agent, middleware, channel)",
          },
          name: {
            type: "string",
            description: "Brick name",
          },
          version: {
            type: "string",
            description: "Specific version to install. Omit for latest.",
          },
        },
        required: ["kind", "name"],
      } as JsonObject,
    },
    trustTier,

    execute: async (args: JsonObject): Promise<unknown> => {
      const kindResult = parseEnum<BrickKind>(args, "kind", [...ALL_BRICK_KINDS]);
      if (!kindResult.ok) return kindResult.err;

      const nameResult = parseString(args, "name");
      if (!nameResult.ok) return nameResult.err;

      const versionResult = parseOptionalString(args, "version");
      if (!versionResult.ok) return versionResult.err;

      try {
        // let justified: assigned in one of two branches (skill vs non-skill)
        let artifact: BrickArtifact;

        if (kindResult.value === "skill") {
          const installResult = await facade.skills.install(
            skillId(nameResult.value),
            versionResult.value,
          );
          if (!installResult.ok) {
            return { error: installResult.error.message, code: installResult.error.code };
          }
          artifact = installResult.value;
        } else {
          const getResult = await facade.bricks.get(kindResult.value, nameResult.value);
          if (!getResult.ok) {
            return { error: getResult.error.message, code: getResult.error.code };
          }
          artifact = getResult.value;
        }

        // If onInstall callback provided, invoke it
        if (onInstall !== undefined) {
          const installResult = await onInstall(artifact);
          if (!installResult.ok) {
            return { error: installResult.error.message, code: installResult.error.code };
          }
          return {
            installed: true,
            artifact: mapBrickInstallSummary(artifact),
          };
        }

        // No callback — download-only mode
        return {
          installed: false,
          message: "Artifact fetched but no install handler configured",
          artifact: mapBrickInstallSummary(artifact),
        };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
