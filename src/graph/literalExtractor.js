/**
 * literalExtractor.js
 *
 * Extracts string literals and env var references from source files.
 * Works alongside symbolExtractor — called during indexing to populate
 * the literals and config_refs tables.
 *
 * Fixes applied:
 *   LE-1: STRING_PATTERN now uses separate same-quote patterns for ' and "
 *         to avoid mismatched-quote captures. Template literals with ${}
 *         are excluded — they are not string constants.
 *
 *   LE-2: REGEX_PATTERN removed — was declared but never used.
 *
 *   LE-3: findContainingFunction now finds the innermost container by
 *         smallest line range instead of relying on node.depth which
 *         symbolExtractor never sets.
 *
 *   LE-4: buildNodeSummaries nodeId now uses filePath:startLine:name
 *         format matching buildRetrievalDocuments — no more SHA-256
 *         hash that must stay in sync with writeFileGraph.
 *
 *   LE-5: Call name extraction extracted to shared extractCallNames()
 *         helper with a single unified exclusion set.
 *
 *   LE-6: buildNodeSummaries now skips __module_ synthetic nodes.
 *
 *   Removed:
 *     - Magic number extraction (noisy, low value)
 *     - String literal kind classification (computed but never queried)
 *     - REGEX_PATTERN (dead code)
 */

// ─────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────

// Single-quoted string literals — same-quote open/close
const SINGLE_QUOTE_PATTERN = /(?<![a-zA-Z])'((?:[^'\\\n]|\\.)*)'/g;

// Double-quoted string literals — same-quote open/close
const DOUBLE_QUOTE_PATTERN = /(?<![a-zA-Z])"((?:[^"\\\n]|\\.)*)"/g;

// process.env.XXX references
const ENV_PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
];
const ENV_DESTRUCT_PATTERN = /const\s*\{\s*([^}]+)\s*\}\s*=\s*process\.env/g;

// LE-7 FIX: keys inside the destructure may carry defaults or renames:
//   const { PORT = 3000, DB_URL = "x", HOST: host } = process.env;
// The old filter required the ENTIRE segment to be a bare KEY — any
// default value or rename made the key silently vanish from config_refs
// (and "PORT = 3000" is the single most common way Node apps read env).
function parseEnvDestructureKeys(inner) {
  const keys = [];
  for (const segRaw of inner.split(",")) {
    // strip default:  PORT = 3000 → PORT ; rename: HOST: host → HOST
    const seg = segRaw.split("=")[0].split(":")[0].trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(seg)) keys.push(seg);
  }
  return keys;
}

// Patterns that indicate a string is "interesting" (not just punctuation/noise)
const INTERESTING_STRING = /[a-z][a-z-]{2,}|[A-Z_]{3,}/;

// Strings to skip — too generic to be useful in semantic search
const SKIP_STRINGS = new Set([
  "utf-8",
  "utf8",
  "hex",
  "base64",
  "ascii",
  "application/json",
  "text/plain",
  "text/html",
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "true",
  "false",
  "null",
  "undefined",
  "localhost",
  "0.0.0.0",
]);

// ─────────────────────────────────────────────
// Shared call name exclusion set
// Used by both buildNodeSummaries and buildRetrievalDocument.
// LE-5: Was duplicated with inconsistent exclusion lists.
// ─────────────────────────────────────────────

const CALL_EXCLUSIONS = new Set([
  "if",
  "for",
  "while",
  "return",
  "const",
  "let",
  "var",
  "async",
  "await",
  "function",
  "class",
  "new",
  "typeof",
  "instanceof",
  "switch",
  "catch",
  "throw",
  "delete",
  "void",
]);

// ─────────────────────────────────────────────
// Shared call name extractor
// LE-5: Extracted from duplicated inline logic in both summary builders.
// ─────────────────────────────────────────────

// LE-8 FIX: the exclusion set only matched EXACT names, but the capture
// pattern allows dots — console.log, Math.max, JSON.stringify sailed
// straight past the filter and polluted every retrieval document's
// "Calls:" line (burning embedding signal on universal noise). Exclude
// by the root segment of dotted names.
const BUILTIN_ROOTS = new Set([
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Error",
  "Date",
  "Map",
  "Set",
  "Symbol",
  "Reflect",
  "Proxy",
  "Intl",
  "Buffer",
  "process",
  "crypto",
  "performance",
  "globalThis",
  "window",
  "document",
]);

function extractCallNames(bodyText, selfName, limit = 8) {
  if (!bodyText) return [];

  const callPattern = /\b([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(/g;
  const seen = new Set([selfName]); // exclude self-reference
  const names = [];
  let m;

  while ((m = callPattern.exec(bodyText)) !== null) {
    const name = m[1];
    const root = name.split(".")[0];
    if (
      !seen.has(name) &&
      name.length > 2 &&
      !CALL_EXCLUSIONS.has(name) &&
      !BUILTIN_ROOTS.has(root)
    ) {
      seen.add(name);
      names.push(name);
      if (names.length >= limit) break;
    }
  }

  return names;
}

// ─────────────────────────────────────────────
// Containing function detection
//
// LE-3: Was using node.depth which symbolExtractor never sets (always 0).
// Now finds the innermost container by smallest line range — a function
// with fewer lines that still contains the target line is more specific.
// ─────────────────────────────────────────────

function findContainingFunction(line, nodes, filePath) {
  let best = null;
  let bestRange = Infinity;

  for (const node of nodes) {
    if (!["function", "method", "arrow_function"].includes(node.kind)) continue;
    if (node.startLine <= line && node.endLine >= line) {
      const range = node.endLine - node.startLine;
      if (range < bestRange) {
        bestRange = range;
        best = `${filePath}:${node.startLine}:${node.name}`;
      }
    }
  }

  return best || null;
}

// ─────────────────────────────────────────────
// Line number helper
// ─────────────────────────────────────────────

function buildLineIndex(source) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  return lineStarts;
}

function offsetToLine(offset, lineStarts) {
  let lo = 0,
    hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ─────────────────────────────────────────────
// String literal extraction helper
// ─────────────────────────────────────────────

function extractStringLiterals(source, lineStarts, nodes, seenLiterals, filePath) {
  const literals = [];

  for (const pattern of [SINGLE_QUOTE_PATTERN, DOUBLE_QUOTE_PATTERN]) {
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(source)) !== null) {
      const value = match[1].trim();

      if (value.length < 3 || value.length > 80) continue;
      if (!INTERESTING_STRING.test(value)) continue;
      if (SKIP_STRINGS.has(value)) continue;
      if (seenLiterals.has(value)) continue;
      if (value.includes("{") || value.includes("}")) continue;
      if (value.startsWith("/*")) continue;

      seenLiterals.add(value);

      const line = offsetToLine(match.index, lineStarts);
      const containingFn = findContainingFunction(line, nodes, filePath);

      literals.push({
        value,
        kind: "string",
        containingFn,
        startLine: line,
      });
    }
  }

  return literals;
}

// ─────────────────────────────────────────────
// Main extractor
// ─────────────────────────────────────────────

/**
 * Extract literals and config refs from source.
 *
 * @param {string} source
 * @param {string} filePath
 * @param {Array}  nodes    - from symbolExtractor (for containingFn lookup)
 * @returns {{ literals: Array, configRefs: Array }}
 */
export function extractLiterals(source, filePath, nodes = []) {
  const lineStarts = buildLineIndex(source);
  const seenLiterals = new Set();
  const seenConfigs = new Set();

  // ── String literals ──
  const literals = extractStringLiterals(source, lineStarts, nodes, seenLiterals, filePath).map(
    (l) => ({
      ...l,
      filePath,
    })
  );

  // ── Environment variable references ──
  const configRefs = [];

  for (const pattern of ENV_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const key = match[1];
      const rawText = match[0];

      if (seenConfigs.has(key)) continue;
      seenConfigs.add(key);

      const line = offsetToLine(match.index, lineStarts);
      const containingFn = findContainingFunction(line, nodes, filePath);

      configRefs.push({
        key,
        rawText,
        containingFn,
        startLine: line,
        filePath,
      });
    }
  }

  ENV_DESTRUCT_PATTERN.lastIndex = 0;
  let match;
  while ((match = ENV_DESTRUCT_PATTERN.exec(source)) !== null) {
    const rawText = match[0];
    const keys = parseEnvDestructureKeys(match[1]); // LE-7

    for (const key of keys) {
      if (seenConfigs.has(key)) continue;
      seenConfigs.add(key);

      const line = offsetToLine(match.index, lineStarts);
      const containingFn = findContainingFunction(line, nodes, filePath);

      configRefs.push({
        key,
        rawText,
        containingFn,
        startLine: line,
        filePath,
      });
    }
  }

  return { literals, configRefs };
}

// ─────────────────────────────────────────────
// Summary builder
// ─────────────────────────────────────────────

/**
 * Build a lightweight summary for each function node.
 * Called after extractLiterals so we can include literal/config refs per function.
 *
 * LE-4: nodeId now uses filePath:startLine:name format — matches
 *       buildRetrievalDocuments stableId and queryNodeByStableId in graphDb.js.
 *       Removed SHA-256 fileId computation that had to stay in sync with writeFileGraph.
 *
 * LE-6: Skips synthetic __module_ nodes.
 */
export function buildNodeSummaries(nodes, literals, configRefs, filePath) {
  const summaries = [];

  for (const node of nodes) {
    if (!["function", "method", "arrow_function", "class"].includes(node.kind)) {
      continue;
    }

    // LE-6: Skip synthetic module sentinel nodes
    if (!node.name || node.name.startsWith("__module_")) {
      continue;
    }

    const nodeId = `${filePath}:${node.startLine}:${node.name}`;

    // Literals used inside this function
    const fnLiterals = literals
      .filter((l) => l.containingFn === nodeId)
      .map((l) => l.value)
      .slice(0, 10);

    // Env vars used inside this function
    const fnEnvRefs = configRefs
      .filter((c) => c.containingFn === nodeId)
      .map((c) => c.key)
      .slice(0, 10);

    // Extract signature from bodyText (first line)
    let signature = null;
    if (node.bodyText) {
      const firstLine = node.bodyText.split("\n")[0].trim();
      signature = firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
    }

    // LE-5: Use shared extractCallNames helper
    const callNames = extractCallNames(node.bodyText, node.name, 8);

    summaries.push({
      // LE-4: stable ID matching buildRetrievalDocuments and queryNodeByStableId
      nodeId,
      filePath,
      name: node.name,
      signature,
      dependencies: JSON.stringify([...fnLiterals, ...fnEnvRefs]),
      envRefs: JSON.stringify(fnEnvRefs),
      literalRefs: JSON.stringify(fnLiterals),
      callSummary: JSON.stringify(callNames),
    });
  }

  return summaries;
}

// ─────────────────────────────────────────────
// Retrieval document builder
//
// Builds the rich text document that gets embedded into HNSW.
// Format mirrors how a developer would describe a function:
//   Function: getS3SignedUrl
//   Kind: async arrow_function
//   File: controllers/s3-upload.controller.js
//   Environment: STORAGE_QUOTA, AWS_BUCKET_NAME
//   Literals: content-length
//   Calls: createPresignedPost, Directory.findById, File.create
// ─────────────────────────────────────────────

/**
 * Build a rich retrieval document for a single node.
 *
 * @param {Object} node
 * @param {Array}  literals
 * @param {Array}  configRefs
 * @param {string} filePath
 * @returns {string}
 */
export function buildRetrievalDocument(node, literals, configRefs, filePath) {
  const lines = [];

  lines.push(`Function: ${node.name}`);
  lines.push(`Kind: ${node.isAsync ? "async " : ""}${node.kind}`);
  lines.push(`File: ${filePath}`);

  // Signature — first line of bodyText
  if (node.bodyText) {
    const sig = node.bodyText.split("\n")[0].trim();
    if (sig) lines.push(`Signature: ${sig.slice(0, 120)}`);
  }

  const nodeId = `${filePath}:${node.startLine}:${node.name}`;

  // Env vars used in this function
  const fnEnvRefs = configRefs.filter((c) => c.containingFn === nodeId).map((c) => c.key);

  if (fnEnvRefs.length > 0) {
    lines.push(`Environment: ${fnEnvRefs.join(", ")}`);
  }

  // String literals used in this function
  const fnLiterals = literals
    .filter((l) => l.containingFn === nodeId && l.kind !== "magic_number")
    .map((l) => l.value)
    .slice(0, 8);

  if (fnLiterals.length > 0) {
    lines.push(`Literals: ${fnLiterals.join(", ")}`);
  }

  // LE-5: Use shared extractCallNames helper
  const callNames = extractCallNames(node.bodyText, node.name, 8);
  if (callNames.length > 0) {
    lines.push(`Calls: ${callNames.join(", ")}`);
  }

  if (node.isExported) {
    lines.push("Exported: yes");
  }

  if (node.complexity > 5) {
    lines.push(`Complexity: ${node.complexity}`);
  }

  return lines.join("\n");
}

/**
 * Build retrieval documents for all embeddable nodes in a file.
 * Returns array of { stableId, document } ready for embedding.
 *
 * Stable ID format: "filePath:startLine:name"
 * This matches queryNodeByStableId in graphDb.js.
 *
 * @param {Array}  nodes
 * @param {Array}  literals
 * @param {Array}  configRefs
 * @param {string} filePath
 * @returns {Array<{ stableId: string, name: string, document: string }>}
 */
export function buildRetrievalDocuments(nodes, literals, configRefs, filePath) {
  const results = [];

  for (const node of nodes) {
    if (!["function", "method", "arrow_function", "class"].includes(node.kind)) {
      continue;
    }

    // Skip synthetic module sentinel nodes
    if (!node.name || node.name.startsWith("__module_")) {
      continue;
    }

    const stableId = `${filePath}:${node.startLine}:${node.name}`;
    const document = buildRetrievalDocument(node, literals, configRefs, filePath);

    results.push({
      stableId,
      name: node.name,
      document,
    });
  }

  return results;
}
