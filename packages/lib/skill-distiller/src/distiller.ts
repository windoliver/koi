import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { computeDraftHash, computeSourceHash } from "./hash.js";
import { parseSkillDraft } from "./parse.js";
import { renderDistillationPromptDetailed } from "./prompt.js";
import type {
  DistillationRecord,
  DistillationTrace,
  Distiller,
  DistillerConfig,
  SkillDraft,
} from "./types.js";

function emptyTraceError(): KoiError {
  return {
    code: "VALIDATION",
    message: "trace must contain at least one turn",
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: { errorKind: "TRACE_EMPTY" },
  };
}

// Preserve the upstream retryability signal so callers can distinguish transient
// provider failures (RATE_LIMIT, TIMEOUT) from terminal ones (INTERNAL, AUTH).
function llmExternalError(cause: KoiError): KoiError {
  return {
    code: "EXTERNAL",
    message: `distiller LLM call failed: ${cause.message}`,
    retryable: cause.retryable,
    context: { errorKind: "LLM_FAILED", causeCode: cause.code },
  };
}

// Patterns that indicate a thrown LLM-client exception is transient and worth
// retrying. Anything else (auth, invalid request, schema, config, bad model)
// is treated as terminal so callers don't waste budget on permanent failures.
const TRANSIENT_THROWN_PATTERNS = [
  /timeout/i,
  /timed?[- ]out/i,
  /abort/i,
  /econn(?:reset|refused|aborted)/i,
  /etimedout/i,
  /socket hang up/i,
  /network/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b503\b/,
  /\b504\b/,
  /service unavailable/i,
  /temporar(?:y|ily) unavailable/i,
];

function isTransientThrownMessage(message: string): boolean {
  return TRANSIENT_THROWN_PATTERNS.some((p) => p.test(message));
}

// Normalize a thrown LLM-client exception into an EXTERNAL KoiError so
// distill() always honors its Result contract. Default to non-retryable —
// only known-transient signatures (timeout, abort, transport reset, 429/5xx)
// are marked retryable, so permanent faults like auth or bad-request are not
// silently looped over.
function llmThrownError(thrown: unknown): KoiError {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const retryable = isTransientThrownMessage(message);
  return {
    code: "EXTERNAL",
    message: `distiller LLM call threw: ${message}`,
    retryable,
    context: { errorKind: "LLM_THREW" },
  };
}

function flattenToolCalls(trace: DistillationTrace): readonly string[] {
  const calls: string[] = [];
  for (const turn of trace.turns) {
    if (turn.toolCalls === undefined) continue;
    for (const call of turn.toolCalls) calls.push(call.name);
  }
  return calls;
}

const LITERAL_MIN_LENGTH = 6;
const LEAK_PROBE_FIELDS_DOC =
  "name / description / triggers / expectedInputs / expectedOutputs / parameter fields";

// Common identifier shapes that should never survive verbatim into a reusable
// skill: emails (PII), UUIDs, IPv4 addresses, JWT-shaped tokens.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

// A trace literal is a string value (from tool args or turn text) that looks
// like a resource identifier or PII token — long enough and shaped enough that
// it almost certainly should be parameterized rather than burned into a
// reusable skill description.
function looksLikeResourceLiteral(s: string): boolean {
  if (s.length < LITERAL_MIN_LENGTH) return false;
  if (/^[\s.,!?]+$/.test(s)) return false;
  if (EMAIL_RE.test(s)) return true;
  if (UUID_RE.test(s)) return true;
  if (IPV4_RE.test(s)) return true;
  if (JWT_RE.test(s)) return true;
  if (/[/.:_-]/.test(s)) return true;
  // Bare alphanumeric tokens count as identifiers ONLY if they show entropy
  // beyond a normal English word: letters AND digits mixed (acct77c19ab3,
  // user42abc), or all-uppercase hex-ish (DEADBEEF). Lowercase letter-only
  // tokens like "kubernetes", "formatting", "operations" are common nouns
  // and must not poison the leak set.
  if (/^[A-Za-z0-9]{8,}$/.test(s)) {
    const hasDigit = /\d/.test(s);
    const hasLetter = /[A-Za-z]/.test(s);
    if (hasDigit && hasLetter) return true;
    if (/^[A-Z0-9]{8,}$/.test(s) && hasDigit) return true;
  }
  return false;
}

function collectTraceLiterals(trace: DistillationTrace): readonly string[] {
  const literals = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (looksLikeResourceLiteral(v)) literals.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x);
    }
  };
  // Tokenize turn.text so individual identifier-shaped words count, not the
  // whole sentence. Tool output and user messages routinely surface paths/IDs
  // that the LLM would otherwise be free to copy into the draft.
  const tokenize = (text: string): readonly string[] =>
    text.split(/[\s,;()<>{}[\]"]+/).filter((t) => t.length > 0);
  for (const turn of trace.turns) {
    if (turn.text !== undefined) {
      for (const token of tokenize(turn.text)) visit(token);
    }
    if (turn.toolCalls === undefined) continue;
    for (const call of turn.toolCalls) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.argsJson);
        visit(parsed);
      } catch {
        // Malformed args still get rendered into the prompt verbatim, so
        // tokenize the raw string the same way we do turn.text. Otherwise a
        // truncated tool call could smuggle a tenant ID past the leak gate.
        for (const token of tokenize(call.argsJson)) visit(token);
      }
    }
  }
  return [...literals];
}

// Catch the "burned-in target" failure mode: the LLM took a tenant path / file
// path / ID that appeared in a tool call and pasted it verbatim into ANY
// persisted field of the draft. We probe every user-visible string (description,
// triggers, expectedInputs, expectedOutputs, every parameter name + description)
// because each is stored on the DistillationRecord and surfaced downstream.
function collectDraftProbes(draft: SkillDraft): readonly string[] {
  const probes: string[] = [draft.name, draft.description, ...draft.triggers];
  probes.push(...draft.expectedInputs);
  probes.push(...draft.expectedOutputs);
  for (const p of draft.parameters) {
    probes.push(p.name, p.description);
  }
  return probes;
}

function findLeakedLiteral(draft: SkillDraft, trace: DistillationTrace): string | undefined {
  const literals = collectTraceLiterals(trace);
  if (literals.length === 0) return undefined;
  const probes = collectDraftProbes(draft);
  for (const literal of literals) {
    for (const field of probes) {
      if (field.includes(literal)) return literal;
    }
  }
  return undefined;
}

interface VariableArg {
  readonly tool: string;
  readonly key: string;
}

// Recursively flatten an arg object into dotted-path leaves so a nested
// `{target:{path:"/a"}}` is tracked as `target.path` and survives the
// variability check the same way a top-level `path` would.
function flattenArgKeys(prefix: string, v: unknown, out: Map<string, string>): void {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    out.set(prefix, JSON.stringify(v));
    return;
  }
  for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
    const next = prefix === "" ? k : `${prefix}.${k}`;
    flattenArgKeys(next, vv, out);
  }
}

// Walk a value and report whether any descendant string leaf looks like a
// resource literal (path, ID, URL, …). Used for the "single-use destructive
// target" guard so a literal smuggled inside an array or nested object still
// forces parameter coverage.
function containsResourceLiteral(v: unknown): boolean {
  if (typeof v === "string") return looksLikeResourceLiteral(v);
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some(containsResourceLiteral);
  for (const vv of Object.values(v as Record<string, unknown>)) {
    if (containsResourceLiteral(vv)) return true;
  }
  return false;
}

// Walk every tool call's argsJson and collect the set of values seen for each
// (toolName, argKey) pair, including nested keys via dotted paths. A key whose
// value differs across invocations is a "variable" arg — exactly the kind of
// input that must be exposed as a skill parameter so the next caller can
// supply it. Malformed args are conservatively treated as variable for that
// tool (we cannot prove they're constant), which forces the draft to expose a
// parameter rather than silently passing.
function collectVariableArgKeys(
  trace: DistillationTrace,
  prefixLength: number,
): readonly VariableArg[] {
  const seen = new Map<string, Set<string>>();
  // Track keys whose ANY observed value looks like a resource literal (path,
  // ID, URL, email, …). A single destructive call against `/tenant-a/x` is
  // still a resource selector that the next caller must supply, even if the
  // tool was only invoked once and the value never "varied". Forcing
  // parameter coverage for these keys closes the single-use leak path.
  const resourceKeys = new Set<string>();
  const recordValue = (composite: string, value: string): void => {
    const bag = seen.get(composite) ?? new Set<string>();
    bag.add(value);
    seen.set(composite, bag);
  };
  // Flag a top-level arg key (or `<root>`) whose value tree contains any
  // resource literal at any depth. Recurses arrays/objects so a target
  // smuggled inside `{targets:[{path:"/a"}]}` still forces parameter coverage.
  const noteResource = (composite: string, rawValue: unknown): void => {
    if (containsResourceLiteral(rawValue)) {
      resourceKeys.add(composite);
    }
  };
  // Only inspect the first `prefixLength` tool calls — the same window
  // grounding accepted as the distilled procedure. Variable args in tail
  // calls outside the prefix are someone else's skill and must not force
  // extra parameters into this one.
  let consumed = 0;
  outer: for (const turn of trace.turns) {
    if (turn.toolCalls === undefined) continue;
    for (const call of turn.toolCalls) {
      if (consumed >= prefixLength) break outer;
      consumed += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.argsJson);
      } catch {
        // Fail-closed: an unparsable arg cannot be proved constant. Mark a
        // synthetic key so the draft must expose at least one parameter for
        // this tool's inputs, and use the raw arg string as the value to
        // ensure two different malformed arg strings count as variable.
        recordValue(`${call.name}::<unparsable>`, call.argsJson);
        continue;
      }
      // Variability tracking uses TOP-LEVEL keys only (or `<root>` for arrays
      // and primitives). Resource-literal detection scans the whole value
      // tree but reports back against the same top-level key, so a buried
      // resource selector forces coverage on the outer arg name without
      // exploding the variable-arg list with synthetic dotted paths.
      if (Array.isArray(parsed)) {
        recordValue(`${call.name}::<root>`, JSON.stringify(parsed));
        noteResource(`${call.name}::<root>`, parsed);
      } else if (parsed !== null && typeof parsed === "object") {
        for (const [k, vv] of Object.entries(parsed as Record<string, unknown>)) {
          recordValue(`${call.name}::${k}`, JSON.stringify(vv));
          noteResource(`${call.name}::${k}`, vv);
        }
      } else {
        recordValue(`${call.name}::<root>`, JSON.stringify(parsed));
        noteResource(`${call.name}::<root>`, parsed);
      }
    }
  }
  const variable: VariableArg[] = [];
  // Union: keys that varied across calls + keys that ever held a resource
  // literal (even once). Both classes need a draft parameter to cover them.
  const composites = new Set<string>();
  for (const [composite, values] of seen) if (values.size > 1) composites.add(composite);
  for (const composite of resourceKeys) composites.add(composite);
  for (const composite of composites) {
    const sep = composite.indexOf("::");
    if (sep > 0) variable.push({ tool: composite.slice(0, sep), key: composite.slice(sep + 2) });
  }
  return variable;
}

// Tokenize an identifier into normalized lowercase tokens by splitting on
// non-alphanumerics AND camelCase boundaries. "tenantId" → ["tenant","id"];
// "input_path" → ["input","path"]; "target.path" → ["target","path"].
function tokenizeIdentifier(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// True if `paramName` shares any whole token with `argKey`. Whole-token match
// rejects spurious substring hits like `grid` claiming to satisfy `id` or
// `pathology` claiming to satisfy `path`, while still accepting genuine
// compound names like `input_path` for `path` or `tenantId` for `tenant`.
function paramNameMatches(paramName: string, argKey: string): boolean {
  const pTokens = new Set(tokenizeIdentifier(paramName));
  for (const t of tokenizeIdentifier(argKey)) {
    if (pTokens.has(t)) return true;
  }
  return false;
}

// Bipartite cover: each distinct (tool, key) variable arg must be claimable
// by some draft parameter, and a single parameter cannot be reused to cover
// two different variable args. This prevents one generic `path` parameter
// from silently satisfying both `read_file.path` and `write_file.path`,
// which would let a skill replay against the wrong resource. Returns the
// first variable arg that cannot be assigned, or undefined on success.
function findUncoveredVariableArg(
  parameters: SkillDraft["parameters"],
  variable: readonly VariableArg[],
): VariableArg | undefined {
  const claimed = new Set<string>();
  for (const v of variable) {
    // Synthetic keys (`<root>`, `<unparsable>`) come from non-object tool args
    // for which we cannot infer a meaningful key name. Token matching against
    // a literal "root"/"unparsable" would block sensible parameter names like
    // `paths` or `targets`, so any UNCLAIMED parameter is an acceptable cover.
    const synthetic = v.key.startsWith("<") && v.key.endsWith(">");
    let assigned = false;
    for (const p of parameters) {
      if (claimed.has(p.name)) continue;
      if (synthetic || paramNameMatches(p.name, v.key)) {
        claimed.add(p.name);
        assigned = true;
        break;
      }
    }
    if (!assigned) return v;
  }
  return undefined;
}

function ungroundedError(reason: string, errorKind: string): KoiError {
  return {
    code: "VALIDATION",
    message: reason,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: { errorKind },
  };
}

// Strict prefix match: `needle` must equal the first `needle.length` items of
// `haystack`. Without semantic knowledge of which observed tool calls are
// guards / setup / authorization steps, the conservative rule is to forbid
// distilled skills that begin AFTER the trace did. Suffix or middle windows
// would silently strip whatever leading work the original session relied on
// (auth checks, lock acquisition, validation), producing a replayable skill
// that performs side effects without the original preconditions.
function isContiguousPrefix(needle: readonly string[], haystack: readonly string[]): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (haystack[i] !== needle[i]) return false;
  }
  return true;
}

// Reject hallucinated drafts: the emitted toolSequence must be a contiguous
// PREFIX of the trace's actual tool-call stream. Allowing arbitrary windows
// would let an LLM start the skill after the session's leading guard/setup
// steps and still pass grounding. Triggers and a non-empty toolSequence are
// required so the skill remains discoverable and replayable.
function groundDraftInTrace(
  draft: SkillDraft,
  trace: DistillationTrace,
): Result<SkillDraft, KoiError> {
  if (draft.toolSequence.length === 0) {
    return { ok: false, error: ungroundedError("toolSequence is empty", "DRAFT_TOOLS_EMPTY") };
  }
  if (draft.triggers.length === 0) {
    return { ok: false, error: ungroundedError("triggers is empty", "DRAFT_TRIGGERS_EMPTY") };
  }
  const observed = flattenToolCalls(trace);
  if (!isContiguousPrefix(draft.toolSequence, observed)) {
    return {
      ok: false,
      error: ungroundedError(
        `toolSequence ${JSON.stringify(draft.toolSequence)} is not a contiguous prefix of the trace's tool calls ${JSON.stringify(observed)} — distilled skills may not omit leading prerequisite steps (auth, setup, validation)`,
        "DRAFT_TOOL_NOT_GROUNDED",
      ),
    };
  }
  // Leak check first: if the LLM copied a trace literal verbatim into prose,
  // that's the most explicit failure mode and the most actionable error for
  // the caller. Variable-arg coverage runs after so its message only fires
  // for drafts that didn't already trip the literal gate.
  const leaked = findLeakedLiteral(draft, trace);
  if (leaked !== undefined) {
    const sample = leaked.length > 60 ? `${leaked.slice(0, 60)}…` : leaked;
    return {
      ok: false,
      error: ungroundedError(
        `${LEAK_PROBE_FIELDS_DOC} contains the trace-specific literal "${sample}" — abstract it through a parameter instead of burning it in`,
        "DRAFT_LITERAL_LEAKED",
      ),
    };
  }
  const variable = collectVariableArgKeys(trace, draft.toolSequence.length);
  const uncovered = findUncoveredVariableArg(draft.parameters, variable);
  if (uncovered !== undefined) {
    return {
      ok: false,
      error: ungroundedError(
        `tool argument ${uncovered.tool}.${uncovered.key} is a variable or resource-shaped input but no distinct draft parameter covers it — the skill would replay with a stale value baked in. Add a parameter for "${uncovered.key}".`,
        "DRAFT_VARIABLE_ARG_UNPARAMETERIZED",
      ),
    };
  }
  return { ok: true, value: draft };
}

export function createDistiller(config: DistillerConfig): Distiller {
  if (config.redactor === undefined && config.allowUnredactedTrace !== true) {
    throw new Error(
      "createDistiller: must supply `redactor` (recommended) or set " +
        "`allowUnredactedTrace: true` to acknowledge that raw trace text and " +
        "tool args will be forwarded to the LLM. The unsafe path is never the default.",
    );
  }
  const now = config.now ?? Date.now;
  const redact = config.redactor ?? ((t) => t);
  return {
    distill: async (trace: DistillationTrace): Promise<Result<DistillationRecord, KoiError>> => {
      if (trace.turns.length === 0) {
        return { ok: false, error: emptyTraceError() };
      }
      // Two independent deep clones: one feeds the redactor (whose output
      // crosses the trust boundary to the LLM), the other stays inside this
      // process as the raw evidence that grounding/leak-detection runs on.
      // An in-place redactor would otherwise mutate the same object we use
      // for grounding, which would re-open the round-4 hole where redaction
      // can hide real input variability.
      const rawForGrounding = structuredClone(trace);
      const forRedaction = structuredClone(trace);
      const redacted = redact(forRedaction);
      const { prompt, truncated } = renderDistillationPromptDetailed(redacted);
      if (truncated) {
        // Fail closed: a truncated prompt means the LLM never saw the tail of
        // the trace, but grounding accepts contiguous prefixes. Combining
        // those would let us persist a partial procedure that drops the
        // session's later validation/finalization steps. Reject here so the
        // caller can split, summarize, or shrink the trace before retrying.
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "trace exceeds the distillation prompt budget — refusing to distill a truncated trace, which would persist a partial procedure",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
            context: { errorKind: "TRACE_TOO_LARGE" },
          },
        };
      }
      let llmResult: Result<string, KoiError>;
      try {
        llmResult = await config.llm({ prompt, modelHint: "cheap" });
      } catch (e: unknown) {
        return { ok: false, error: llmThrownError(e) };
      }
      if (!llmResult.ok) {
        return { ok: false, error: llmExternalError(llmResult.error) };
      }
      const draftResult = parseSkillDraft(llmResult.value);
      if (!draftResult.ok) return draftResult;
      const grounded = groundDraftInTrace(draftResult.value, rawForGrounding);
      if (!grounded.ok) return grounded;
      const draft = grounded.value;
      const record: DistillationRecord = {
        draft,
        source: {
          traceId: trace.traceId,
          ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
          timestamp: now(),
          // Hash the redacted trace — that's what actually fed the LLM and
          // what grounding/leak detection ran against. Hashing the raw trace
          // would let two materially different prompt inputs share the same
          // provenance whenever redaction rules changed.
          sourceHash: computeSourceHash(redacted),
        },
        draftHash: computeDraftHash(draft),
      };
      return { ok: true, value: record };
    },
  };
}
