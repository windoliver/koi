/**
 * Filesystem error mapper — re-exports from @koi/errors.
 *
 * The canonical implementation now lives in @koi/errors so all L2
 * packages can use filesystem error mapping without peer-import violations.
 */

export { mapFsError, mapParseError } from "@koi/errors";
