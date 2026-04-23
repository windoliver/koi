export interface EnvVar {
  readonly name: string;
  readonly value: string;
}

export interface UnwrapResult {
  readonly argv: readonly string[];
  readonly envVars: readonly EnvVar[];
}
