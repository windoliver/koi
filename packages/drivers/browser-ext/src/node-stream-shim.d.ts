declare module "node:stream" {
  interface Duplex {}

  export function duplexPair(): [Duplex, Duplex];
}
