import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { DistillationTrace, SkillDraft } from "./types.js";

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

// Flatten an arg object's nested objects to dotted-path leaves. Arrays and
// primitives are treated as terminal leaves at their parent path so the
// variability key set stays bounded by the schema, not by the array length.
function flattenObjectLeaves(
  prefix: string,
  v: Record<string, unknown>,
  out: Map<string, unknown>,
): void {
  for (const [k, vv] of Object.entries(v)) {
    const next = prefix === "" ? k : `${prefix}.${k}`;
    if (vv !== null && typeof vv === "object" && !Array.isArray(vv)) {
      flattenObjectLeaves(next, vv as Record<string, unknown>, out);
    } else {
      out.set(next, vv);
    }
  }
}

// Key tokens that indicate the leaf value is an identifier even when the
// value itself is just a number (account_id: 12345 etc.). Numeric IDs
// otherwise look like normal scalars and would skip the literal heuristic.
const ID_KEY_TOKENS = new Set([
  "id",
  "uuid",
  "guid",
  "uid",
  "tenant",
  "account",
  "user",
  "customer",
  "org",
  "organization",
  "project",
  "workspace",
  "session",
  "key",
  "token",
  "secret",
  "arn",
  "ref",
]);

function isIdentifierKey(key: string): boolean {
  for (const token of tokenizeIdentifier(key)) {
    if (ID_KEY_TOKENS.has(token)) return true;
  }
  return false;
}

// True if `value` paired with `key` looks like a resource selector: any
// string leaf that matches the resource-shape heuristic, OR a non-trivial
// numeric/string leaf under an identifier-shaped key (so numeric tenant /
// account IDs cannot bypass parameterization).
function leafLooksLikeResource(key: string, value: unknown): boolean {
  if (typeof value === "string") return looksLikeResourceLiteral(value);
  if (typeof value === "number" && Number.isFinite(value) && isIdentifierKey(key)) {
    return Math.abs(value) >= 1000;
  }
  return false;
}

// Walk a value and report whether any descendant leaf looks like a resource
// selector under any path. Used for the "single-use destructive target"
// guard so a literal smuggled inside an array or nested object still forces
// parameter coverage on the outer arg key.
function containsResourceLiteral(key: string, v: unknown): boolean {
  if (v === null || typeof v !== "object") return leafLooksLikeResource(key, v);
  if (Array.isArray(v)) return v.some((item) => containsResourceLiteral(key, item));
  for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
    if (containsResourceLiteral(k, vv)) return true;
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
  // Flag an arg leaf path (e.g. `delete::path` or `delete::copy.src`) whose
  // value tree contains any resource literal at any depth.
  const noteResource = (composite: string, leafKey: string, rawValue: unknown): void => {
    if (containsResourceLiteral(leafKey, rawValue)) {
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
      // Object args: flatten through nested objects to leaf paths
      // (`copy.src`, `copy.dst`) so independently varying selectors are each
      // tracked separately. Arrays stop at the parent key — array indices
      // would otherwise explode the variable-arg list with synthetic
      // `arr.0`/`arr.1` keys that no sensible parameter name covers; the
      // resource scan still recurses into array contents for the leak guard.
      // Top-level arrays and primitives use the synthetic `<root>` key.
      if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") {
        recordValue(`${call.name}::<root>`, JSON.stringify(parsed));
        noteResource(`${call.name}::<root>`, "<root>", parsed);
      } else {
        const flat = new Map<string, unknown>();
        flattenObjectLeaves("", parsed as Record<string, unknown>, flat);
        for (const [path, leafValue] of flat) {
          recordValue(`${call.name}::${path}`, JSON.stringify(leafValue));
          // Use the LAST segment of the dotted path as the key for the
          // resource heuristic — that's the immediate field name (e.g.
          // `src` in `copy.src`), which is what carries the semantic hint.
          const lastDot = path.lastIndexOf(".");
          const leafName = lastDot >= 0 ? path.slice(lastDot + 1) : path;
          noteResource(`${call.name}::${path}`, leafName, leafValue);
        }
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
export function groundDraftInTrace(
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
