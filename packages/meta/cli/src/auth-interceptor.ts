/**
 * OAuth redirect URL interceptor for TUI chat input.
 *
 * Detects when a user pastes an OAuth callback URL (localhost redirect)
 * and routes it to the nexus bridge transport's submitAuthCode method.
 */

/** Pattern: http://localhost:<port>/callback or http://127.0.0.1:<port>/callback with query params */
const OAUTH_CALLBACK_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/callback\b/i;

export function isOAuthRedirectUrl(message: string): boolean {
  return OAUTH_CALLBACK_PATTERN.test(message.trim());
}

interface AuthTransport {
  readonly submitAuthCode: (redirectUrl: string, correlationId?: string) => void;
}

interface InterceptResult {
  readonly intercepted: boolean;
}

export function createAuthInterceptor(
  transport: AuthTransport,
): (message: string, correlationId: string | undefined) => InterceptResult {
  return (message: string, correlationId: string | undefined): InterceptResult => {
    const trimmed = message.trim();
    if (!isOAuthRedirectUrl(trimmed)) {
      return { intercepted: false };
    }
    transport.submitAuthCode(trimmed, correlationId);
    return { intercepted: true };
  };
}
