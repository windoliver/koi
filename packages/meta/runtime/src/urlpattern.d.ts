/**
 * Minimal ambient declaration for the `URLPattern` Web API. Bun provides the
 * runtime implementation but `@types/bun` does not yet ship the type.
 *
 * Only the subset used by `scoped-fetcher.ts` is declared; widen this if more
 * of the API surface is needed later.
 */

declare global {
  interface URLPatternInit {
    readonly protocol?: string;
    readonly username?: string;
    readonly password?: string;
    readonly hostname?: string;
    readonly port?: string;
    readonly pathname?: string;
    readonly search?: string;
    readonly hash?: string;
    readonly baseURL?: string;
  }

  interface URLPatternComponentResult {
    readonly input: string;
    readonly groups: Readonly<Record<string, string | undefined>>;
  }

  interface URLPatternResult {
    readonly inputs: ReadonlyArray<string | URLPatternInit>;
    readonly protocol: URLPatternComponentResult;
    readonly username: URLPatternComponentResult;
    readonly password: URLPatternComponentResult;
    readonly hostname: URLPatternComponentResult;
    readonly port: URLPatternComponentResult;
    readonly pathname: URLPatternComponentResult;
    readonly search: URLPatternComponentResult;
    readonly hash: URLPatternComponentResult;
  }

  class URLPattern {
    constructor(input?: string | URLPatternInit, baseURL?: string);
    test(input?: string | URLPatternInit, baseURL?: string): boolean;
    exec(input?: string | URLPatternInit, baseURL?: string): URLPatternResult | null;
    readonly protocol: string;
    readonly username: string;
    readonly password: string;
    readonly hostname: string;
    readonly port: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
  }
}

export {};
