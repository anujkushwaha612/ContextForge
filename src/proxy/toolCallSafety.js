/**
 * toolCallSafety.js
 *
 * Shared safety primitives for ContextForge's ghost-tool boundary.
 *
 * The upstream can stream OpenAI-compatible tool deltas that omit IDs,
 * reuse indexes, repeat full names, or interleave parallel calls.  This
 * module deliberately fails closed whenever identity is ambiguous: a bad
 * tool call must never be added to assistant history and sent upstream on
 * the next ghost hop.
 */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsesJsonObject(value) {
  if (typeof value !== "string") return false;
  try {
    return isPlainObject(JSON.parse(value));
  } catch {
    return false;
  }
}

/**
 * Split a string into complete, top-level JSON object values. Strings and
 * escaped quotes are handled so braces inside argument strings are safe.
 */
export function splitTopLevelJsonObjects(str) {
  if (typeof str !== "string") return [];

  const parts = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        parts.push(str.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return parts;
}

/**
 * Return true only for known, exact bare or namespaced aliases. A trailing
 * valid tool-name suffix alone is intentionally NOT enough: it would accept
 * corrupted names such as `contextforge_query_graphcontextforge_query_graph`.
 */
export function isExactToolAlias(name, bareName) {
  if (typeof name !== "string" || typeof bareName !== "string") return false;
  if (name === bareName || name === `contextforge__${bareName}`) return true;

  // Claude/Codex-style MCP aliases. Allow server names containing underscores,
  // but require both the `mcp__` prefix and the delimiter immediately before
  // the bare tool name.
  return (
    name.startsWith("mcp__") && name.endsWith(`__${bareName}`) && name.length > bareName.length + 7
  );
}

/** Return the matching bare name from a supplied allowlist, or null. */
export function canonicalKnownToolName(name, knownBareNames) {
  for (const bareName of knownBareNames || []) {
    if (isExactToolAlias(name, bareName)) return bareName;
  }
  return null;
}

function isNamePrefix(candidate, knownNames) {
  return (
    typeof candidate === "string" && [...knownNames].some((name) => name.startsWith(candidate))
  );
}

function nameDeltaCanExtend(existing, incoming, knownNames) {
  if (!existing || !incoming) return false;
  const appended = existing + incoming;
  return isNamePrefix(appended, knownNames);
}

/**
 * Stateful OpenAI-wire tool-call assembler.
 *
 * Identity order is deliberately id → index → safe anonymous association.
 * A repeated index is never allowed to silently merge a second complete call,
 * and multiple anonymous calls awaiting arguments are marked ambiguous rather
 * than guessed at.
 */
export class StreamToolCallAssembler {
  constructor({ knownToolNames = [], idPrefix = "call_cf_stream" } = {}) {
    this._knownToolNames = new Set(knownToolNames);
    this._idPrefix = idPrefix;
    this._sequence = 0;
    this._calls = [];
    this._byId = new Map();
    this._byIndex = new Map();
    this._ambiguousIndexes = new Set();
    this._issues = [];
  }

  get calls() {
    return this._calls.filter(Boolean).map((call) => ({ ...call }));
  }

  get issues() {
    return [...this._issues];
  }

  get isAmbiguous() {
    return this._issues.length > 0;
  }

  _newCall({ id = null, index = null } = {}) {
    const call = {
      id: id || `${this._idPrefix}_${++this._sequence}`,
      name: "",
      arguments: "",
      extra_content: null,
      _cf_streamIndex: typeof index === "number" ? index : null,
      _cf_streamHasExplicitId: Boolean(id),
      _cf_streamAnonymous: !id && typeof index !== "number",
    };
    this._calls.push(call);
    if (id) this._byId.set(id, call);
    if (typeof index === "number" && !this._byIndex.has(index)) this._byIndex.set(index, call);
    return call;
  }

  _recordIssue(code, detail) {
    this._issues.push({ code, detail });
  }

  _resolveByIdentity(delta) {
    const id = typeof delta?.id === "string" && delta.id ? delta.id : null;
    const index = typeof delta?.index === "number" ? delta.index : null;
    const byId = id ? this._byId.get(id) : null;
    const byIndex = index !== null ? this._byIndex.get(index) : null;

    if (!id && index !== null && this._ambiguousIndexes.has(index)) {
      this._recordIssue(
        "ambiguous_index_fragment",
        `index ${index} was reused by multiple calls and this fragment has no id`
      );
      return null;
    }

    // IDs are the primary identity. If an upstream reuses an index with a new
    // ID, preserve both calls instead of merging them into one array slot.
    if (byId) {
      if (index !== null && byIndex && byIndex !== byId) {
        this._ambiguousIndexes.add(index);
        this._recordIssue(
          "identity_conflict",
          `id '${id}' and index ${index} identify different calls`
        );
      } else if (index !== null && !byIndex) {
        this._byIndex.set(index, byId);
      }
      return byId;
    }

    if (id) {
      const call = this._newCall({ id, index: byIndex ? null : index });
      if (index !== null && byIndex && byIndex !== call) {
        // Keep the ID-distinct call, but do not overwrite the old index map.
        // A later fragment with only that index is now ambiguous and must not
        // be attached to either call.
        this._ambiguousIndexes.add(index);
        this._recordIssue("reused_index", `index ${index} was reused by new id '${id}'`);
      }
      return call;
    }

    if (byIndex) return byIndex;
    if (index !== null) return this._newCall({ index });
    return null;
  }

  _resolveAnonymousWithName(name) {
    const unfinished = this._calls.filter(
      (call) =>
        call._cf_streamAnonymous &&
        !parsesJsonObject(call.arguments) &&
        nameDeltaCanExtend(call.name, name, this._knownToolNames)
    );

    if (unfinished.length === 1) return unfinished[0];
    if (unfinished.length > 1) {
      this._recordIssue(
        "ambiguous_name_fragment",
        "multiple anonymous calls could accept a name fragment"
      );
      return null;
    }

    return this._newCall();
  }

  _resolveAnonymousArguments() {
    // With no id/index, there is no safe way to route a fragment when two
    // anonymous calls are open. Refuse to guess; this is the exact condition
    // that previously concatenated two JSON objects into one call.
    const candidates = this._calls.filter(
      (call) => call._cf_streamAnonymous && !parsesJsonObject(call.arguments)
    );

    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      this._recordIssue(
        "orphan_arguments",
        "arguments arrived without a matching tool-call identity"
      );
    } else {
      this._recordIssue(
        "ambiguous_arguments",
        "arguments arrived for multiple anonymous tool calls"
      );
    }
    return null;
  }

  _applyName(call, incomingName, { hasArguments = false } = {}) {
    if (!incomingName) return;

    if (!call.name) {
      call.name = incomingName;
      return;
    }

    // Some OpenAI-compatible servers repeat the complete name on later
    // deltas. It is idempotent while arguments are still in progress. Once
    // an argument object is complete, however, the same name with a reused
    // index may be a second parallel call; mark it ambiguous rather than
    // appending its arguments to the finished call.
    if (call.name === incomingName) {
      if (hasArguments && parsesJsonObject(call.arguments)) {
        this._recordIssue(
          "reused_identity_after_complete_call",
          `received '${incomingName}' after a complete call`
        );
      }
      return;
    }

    if (nameDeltaCanExtend(call.name, incomingName, this._knownToolNames)) {
      call.name += incomingName;
      return;
    }

    // A new full name after a complete argument object means the server reused
    // an index for a second call. Do not concatenate it into the first call.
    if (parsesJsonObject(call.arguments) && this._knownToolNames.has(incomingName)) {
      this._recordIssue(
        "reused_identity_after_complete_call",
        `received '${incomingName}' after a complete call`
      );
      return;
    }

    this._recordIssue(
      "name_conflict",
      `cannot safely combine '${call.name}' and '${incomingName}'`
    );
  }

  add(delta) {
    if (!delta || typeof delta !== "object") return;

    const functionDelta = delta.function || {};
    const incomingName = typeof functionDelta.name === "string" ? functionDelta.name : "";
    const incomingArgs = typeof functionDelta.arguments === "string" ? functionDelta.arguments : "";

    let call = this._resolveByIdentity(delta);
    if (!call && incomingName) call = this._resolveAnonymousWithName(incomingName);
    if (!call && incomingArgs) call = this._resolveAnonymousArguments();
    if (!call) return;

    this._applyName(call, incomingName, { hasArguments: Boolean(incomingArgs) });
    if (incomingArgs) call.arguments += incomingArgs;
    if (delta.extra_content !== undefined) call.extra_content = delta.extra_content;
  }

  addAll(deltas) {
    for (const delta of deltas || []) this.add(delta);
  }
}

/**
 * Repair the known failure shape: N complete JSON objects concatenated into
 * one tool call. Repair is permitted only when the name is an exact repeated
 * known active-tool name. Anything else remains rejected instead of guessed.
 */
export function repairMergedToolCalls(calls, { isKnownToolName = () => false } = {}) {
  const repaired = [];
  const issues = [];

  for (const call of calls || []) {
    const name = call?.function?.name || call?.name || "";
    const argumentsText = call?.function?.arguments ?? call?.arguments ?? "";

    if (parsesJsonObject(argumentsText)) {
      repaired.push(call);
      continue;
    }

    const segments = splitTopLevelJsonObjects(argumentsText);
    const allSegmentsValid =
      segments.length >= 2 && segments.every((segment) => parsesJsonObject(segment));

    if (!allSegmentsValid) {
      repaired.push(call);
      continue;
    }

    const count = segments.length;
    if (typeof name !== "string" || name.length % count !== 0) {
      issues.push({ code: "unrepairable_merged_name", detail: `cannot split tool name '${name}'` });
      repaired.push(call);
      continue;
    }

    const baseName = name.slice(0, name.length / count);
    if (baseName.repeat(count) !== name || !isKnownToolName(baseName)) {
      issues.push({
        code: "unrepairable_merged_name",
        detail: `name '${name}' is not a repeated active tool name`,
      });
      repaired.push(call);
      continue;
    }

    for (let i = 0; i < count; i++) {
      const id = call.id ? `${call.id}_${i + 1}` : `call_cf_split_${i + 1}`;
      const fixed = {
        ...call,
        id,
        function: {
          ...(call.function || {}),
          name: baseName,
          arguments: segments[i],
        },
      };
      repaired.push(fixed);
    }
  }

  return { calls: repaired, issues };
}

function validateSchemaValue(value, schema, path = "arguments") {
  if (!schema || typeof schema !== "object") return null;

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} must be one of: ${schema.enum.join(", ")}`;
  }

  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) return `${path} must be an object`;
      for (const required of schema.required || []) {
        if (!(required in value)) return `${path}.${required} is required`;
      }
      const properties = schema.properties || {};
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) return `${path}.${key} is not allowed`;
        }
      }
      for (const [key, childSchema] of Object.entries(properties)) {
        if (!(key in value)) continue;
        const error = validateSchemaValue(value[key], childSchema, `${path}.${key}`);
        if (error) return error;
      }
      return null;
    }
    case "array":
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const error = validateSchemaValue(value[i], schema.items, `${path}[${i}]`);
          if (error) return error;
        }
      }
      return null;
    case "string":
      return typeof value === "string" ? null : `${path} must be a string`;
    case "integer":
      return Number.isInteger(value) ? null : `${path} must be an integer`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${path} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    default:
      return null;
  }
}

/** Build exact active tool-name → parameter-schema lookup from a payload. */
export function activeToolSchemas(payload) {
  const schemas = new Map();
  for (const tool of payload?.tools || []) {
    const fn = tool?.function || tool;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    if (fn.parameters && typeof fn.parameters === "object") schemas.set(fn.name, fn.parameters);
  }
  return schemas;
}

/**
 * Parse and validate a tool call against the schema that was actually sent on
 * this request. This is intentionally exact-name based; aliases not present
 * in the active tools array are not silently accepted.
 */
export function validateActiveToolCall(call, schemas) {
  const name = call?.function?.name;
  const id = call?.id;

  if (typeof id !== "string" || !id) {
    return { ok: false, error: "tool call is missing a stable id" };
  }
  if (typeof name !== "string" || !name) {
    return { ok: false, error: "tool call is missing a function name" };
  }
  if (!schemas?.has(name)) {
    return { ok: false, error: `tool '${name}' was not present in the active tool schema` };
  }

  const rawArguments = call.function?.arguments;
  if (typeof rawArguments !== "string") {
    return { ok: false, error: `tool '${name}' arguments must be a JSON string` };
  }
  // A few OpenAI-compatible servers emit an empty argument delta for a
  // no-argument call. Normalize that wire quirk to the canonical object form
  // before applying the schema; non-empty malformed JSON is still rejected.
  const argumentsText = rawArguments.trim() ? rawArguments : "{}";

  let args;
  try {
    args = JSON.parse(argumentsText);
  } catch (error) {
    return { ok: false, error: `tool '${name}' has malformed JSON arguments: ${error.message}` };
  }

  if (!isPlainObject(args)) {
    return { ok: false, error: `tool '${name}' arguments must decode to an object` };
  }

  const schemaError = validateSchemaValue(args, schemas.get(name));
  if (schemaError)
    return { ok: false, error: `tool '${name}' schema validation failed: ${schemaError}` };

  return { ok: true, args, normalizedArguments: argumentsText };
}

// An explicit ID resolves a reused provider index safely. The remaining issue
// classes mean fragments could not be attributed without guessing and must
// stop ghost interception.
export function hasFatalAssemblyIssues(issues) {
  const informational = new Set(["reused_index", "identity_conflict"]);
  return (issues || []).some((issue) => !informational.has(issue?.code));
}

export function toolCallArgumentsAreParseable(calls) {
  return (
    (calls || []).length > 0 &&
    (calls || []).every((call) => parsesJsonObject(call?.function?.arguments))
  );
}
