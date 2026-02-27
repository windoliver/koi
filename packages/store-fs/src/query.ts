/**
 * Re-export matchesBrickQuery from @koi/validation.
 *
 * Previously a local duplicate (missing classification + contentMarkers filters).
 * Consolidated into @koi/validation to fix the divergence bug.
 */

export { matchesBrickQuery } from "@koi/validation";
