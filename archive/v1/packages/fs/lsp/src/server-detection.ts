/**
 * Auto-detection of installed LSP server binaries.
 *
 * Scans PATH for known LSP binaries using Bun.which() and returns
 * DetectedLspServer entries ready to merge with user configuration.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedLspServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly languageIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Known LSP server registry
// ---------------------------------------------------------------------------

interface KnownLspServer {
  readonly name: string;
  readonly binaries: readonly string[];
  readonly args: readonly string[];
  readonly languageIds: readonly string[];
}

const KNOWN_LSP_SERVERS: readonly KnownLspServer[] = [
  {
    name: "typescript",
    binaries: ["typescript-language-server"],
    args: ["--stdio"],
    languageIds: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
  },
  {
    name: "pyright",
    binaries: ["pyright-langserver", "pyright"],
    args: ["--stdio"],
    languageIds: ["python"],
  },
  {
    name: "gopls",
    binaries: ["gopls"],
    args: ["serve"],
    languageIds: ["go"],
  },
  {
    name: "rust-analyzer",
    binaries: ["rust-analyzer"],
    args: [],
    languageIds: ["rust"],
  },
  {
    name: "clangd",
    binaries: ["clangd"],
    args: [],
    languageIds: ["c", "cpp", "objc"],
  },
  {
    name: "jdtls",
    binaries: ["jdtls", "jdt-language-server"],
    args: [],
    languageIds: ["java"],
  },
  {
    name: "lua-language-server",
    binaries: ["lua-language-server"],
    args: [],
    languageIds: ["lua"],
  },
  {
    name: "zls",
    binaries: ["zls"],
    args: [],
    languageIds: ["zig"],
  },
  {
    name: "ruby-lsp",
    binaries: ["ruby-lsp"],
    args: [],
    languageIds: ["ruby"],
  },
] as const;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detects installed LSP servers by scanning PATH for known binaries.
 *
 * Returns one entry per known server, using the first binary found from
 * each server's candidate list. Pure and synchronous.
 */
export function detectLspServers(): readonly DetectedLspServer[] {
  const detected: DetectedLspServer[] = [];

  for (const server of KNOWN_LSP_SERVERS) {
    for (const binary of server.binaries) {
      const resolved = Bun.which(binary);
      if (resolved !== null) {
        detected.push({
          name: server.name,
          command: resolved,
          args: server.args,
          languageIds: server.languageIds,
        });
        break;
      }
    }
  }

  return detected;
}
