/**
 * Scope attenuation checking — re-exports isPermissionSubset from L0 core.
 *
 * The `isAttenuated` alias is preserved for backward compatibility with
 * existing consumers of @koi/capability-verifier.
 */

export { isPermissionSubset as isAttenuated } from "@koi/core";
