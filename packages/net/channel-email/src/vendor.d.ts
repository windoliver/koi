/**
 * Ambient module declarations for vendor packages lacking TypeScript types.
 * These packages are lazy-loaded via dynamic import() in email-channel.ts.
 */

declare module "imapflow" {
  const ImapFlow: unknown;
  export { ImapFlow };
}

declare module "mailparser" {
  const simpleParser: unknown;
  export { simpleParser };
}
