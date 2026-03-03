/**
 * Re-export from @koi/validation for backward compatibility.
 *
 * The canonical implementation now lives in @koi/validation (L0u)
 * so all L2 store implementations can reuse it without cross-L2 imports.
 */

export { createMemoryStoreChangeNotifier } from "@koi/validation";
