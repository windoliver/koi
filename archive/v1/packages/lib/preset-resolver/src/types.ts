/**
 * Recursive partial type — makes all nested properties optional.
 */
export type DeepPartial<T> = T extends object ? { readonly [P in keyof T]?: DeepPartial<T[P]> } : T;
