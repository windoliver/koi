/**
 * Re-export URL security from @koi/scope.
 *
 * The canonical implementation now lives in @koi/scope so that both
 * browser scoping and standalone browser providers share the same code.
 */

export {
  type CompiledNavigationSecurity,
  compileNavigationSecurity,
  type NavigationSecurityConfig,
  parseSecureOptionalUrl,
  parseSecureUrl,
} from "@koi/scope";
