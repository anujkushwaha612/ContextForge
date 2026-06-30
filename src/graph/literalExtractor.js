/**
 * literalExtractor.js
 *
 * Extracts string literals, env var references, regex patterns,
 * and magic constants from source files.
 *
 * Works alongside symbolExtractor — called during indexing to
 * populate the literals and config_refs tables.
 */

import { createHash } from "node:crypto";
// ─────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────

// String literals — captures content inside quotes
// Excludes very short strings (< 3 chars) and pure whitespace
const STRING_PATTERN = /(?<![a-zA-Z])['"`]([^'"`\n]{3,80})['"`]/g;

// process.env.XXX references
const ENV_PATTERN = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

// Regex literals
const REGEX_PATTERN = /\/([^/\n]{5,60})\/[gimsuy]*/g;

// Magic numbers — meaningful numeric constants
// Excludes 0, 1, -1, small port numbers < 1000 are kept,
// large round numbers like 100 * 1024 * 1024 are interesting
const MAGIC_NUMBER_PATTERN = /\b(\d{4,})\b/g;

// Patterns that indicate a string is "interesting" (not just punctuation/noise)
const INTERESTING_STRING = /[a-z][a-z-]{2,}|[A-Z_]{3,}/;

// Strings to skip — too generic to be useful
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
// Containing function detection
// ─────────────────────────────────────────────

/**
 * Given a line number and a list of nodes (with startLine/endLine),
 * find which function/method contains this line.
 */
function findContainingFunction(line, nodes) {
  // Find the innermost (deepest depth) function that contains this line
  let best = null;
  let bestDepth = -1;

  for (const node of nodes) {
    if (!["function", "method", "arrow_function"].includes(node.kind)) continue;
    if (node.startLine <= line && node.endLine >= line) {
      // Prefer deeper nesting (more specific container)
      const depth = node.depth || 0;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = node.name;
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
  const literals = [];
  const configRefs = [];
  const lineStarts = buildLineIndex(source);

  // Track seen values to avoid duplicates within same file
  const seenLiterals = new Set();
  const seenConfigs = new Set();

  // ── String literals ──
  STRING_PATTERN.lastIndex = 0;
  let match;
  while ((match = STRING_PATTERN.exec(source)) !== null) {
    const value = match[1].trim();

    // Skip noise
    if (!INTERESTING_STRING.test(value)) continue;
    if (SKIP_STRINGS.has(value)) continue;
    if (seenLiterals.has(value)) continue;

    // Skip things that look like code, not data
    if (value.includes("{") || value.includes("}")) continue;
    if (value.startsWith("//") || value.startsWith("/*")) continue;

    seenLiterals.add(value);

    const line = offsetToLine(match.index, lineStarts);
    const containingFn = findContainingFunction(line, nodes);

    // Classify the literal
    let kind = "string";
    if (value.startsWith("/") && value.includes("/")) kind = "path";
    else if (value.includes("-") && /^[a-z][a-z-]+$/.test(value)) kind = "header";
    else if (value.includes("@")) kind = "email_pattern";
    else if (/^\d+\.\d+\.\d+/.test(value)) kind = "version";

    literals.push({
      value,
      kind,
      containingFn,
      startLine: line,
      filePath,
    });
  }

  // ── Environment variable references ──
  ENV_PATTERN.lastIndex = 0;
  while ((match = ENV_PATTERN.exec(source)) !== null) {
    const key = match[1];
    const rawText = match[0]; // process.env.KEY

    if (seenConfigs.has(key)) continue;
    seenConfigs.add(key);

    const line = offsetToLine(match.index, lineStarts);
    const containingFn = findContainingFunction(line, nodes);

    configRefs.push({
      key,
      rawText,
      containingFn,
      startLine: line,
      filePath,
    });
  }

  // ── Magic constants (inline numeric literals) ──
  // Only capture large/meaningful numbers
  MAGIC_NUMBER_PATTERN.lastIndex = 0;
  while ((match = MAGIC_NUMBER_PATTERN.exec(source)) !== null) {
    const value = match[1];
    const num = parseInt(value, 10);

    // Only index "interesting" large numbers
    // (port numbers, byte sizes, timeouts, limits)
    if (num < 1000) continue;

    const dedupeKey = `num:${value}`;
    if (seenLiterals.has(dedupeKey)) continue;
    seenLiterals.add(dedupeKey);

    const line = offsetToLine(match.index, lineStarts);
    const containingFn = findContainingFunction(line, nodes);

    // Only index if near a meaningful assignment
    const lineText = source.slice(lineStarts[line], lineStarts[line + 1] || source.length);

    if (!/const|let|var|=|quota|limit|size|timeout|max|min/i.test(lineText)) {
      continue;
    }

    literals.push({
      value,
      kind: "magic_number",
      containingFn,
      startLine: line,
      filePath,
    });
  }

  return { literals, configRefs };
}

// ─────────────────────────────────────────────
// Summary builder
// ─────────────────────────────────────────────

/**
 * Build a lightweight summary for each function node.
 * This runs after extractLiterals so we can include
 * literal/config refs per function.
 */
export function buildNodeSummaries(nodes, literals, configRefs, filePath) {
  const summaries = [];

  // ── Compute fileId once — must match writeFileGraph's computation ──
  const fileId = createHash("sha256").update(filePath).digest("hex").slice(0, 16);

  for (const node of nodes) {
    if (!["function", "method", "arrow_function", "class"].includes(node.kind)) {
      continue;
    }

    // Literals used inside this function
    const fnLiterals = literals
      .filter((l) => l.containingFn === node.name)
      .map((l) => l.value)
      .slice(0, 10); // cap at 10

    // Env vars used inside this function
    const fnEnvRefs = configRefs
      .filter((c) => c.containingFn === node.name)
      .map((c) => c.key)
      .slice(0, 10);

    // Extract signature from bodyText (first line)
    let signature = null;
    if (node.bodyText) {
      const firstLine = node.bodyText.split("\n")[0].trim();
      signature = firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
    }

    // Extract call names from bodyText using simple pattern
    const callNames = [];
    if (node.bodyText) {
      const callPattern = /\b([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(/g;
      let m;
      const seen = new Set();
      while ((m = callPattern.exec(node.bodyText)) !== null) {
        const name = m[1];
        if (
          !seen.has(name) &&
          name.length > 2 &&
          !/^(if|for|while|return|const|let|var|async|await)$/.test(name)
        ) {
          seen.add(name);
          callNames.push(name);
          if (callNames.length >= 8) break;
        }
      }
    }

    summaries.push({
      nodeId: `${fileId}:${node.name}:${node.startLine}`, // ← now matches graphDb
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
// This is what makes natural-language queries like "upload quota check"
// find getS3SignedUrl — the document contains semantic context, not
// just the raw function name.
//
// Format deliberately mirrors how a developer would describe a function:
//   Function: getS3SignedUrl
//   Kind: async arrow_function
//   File: controllers/s3-upload.controller.js
//   Uses: STORAGE_QUOTA, AWS_BUCKET_NAME, content-length
//   Calls: createPresignedPost, Directory.findById, File.create
// ─────────────────────────────────────────────

/**
 * Build a rich retrieval document for a single node.
 * This text is embedded into HNSW for semantic search.
 *
 * @param {Object} node        - from symbolExtractor (has name, kind, bodyText, etc.)
 * @param {Array}  literals    - from extractLiterals for this file
 * @param {Array}  configRefs  - from extractLiterals for this file
 * @param {string} filePath
 * @returns {string}           - rich text document for embedding
 */
export function buildRetrievalDocument(node, literals, configRefs, filePath) {
  const lines = [];

  // ── Identity ──
  lines.push(`Function: ${node.name}`);
  lines.push(`Kind: ${node.isAsync ? "async " : ""}${node.kind}`);
  lines.push(`File: ${filePath}`);

  // ── Signature ──
  if (node.bodyText) {
    const sig = node.bodyText.split("\n")[0].trim();
    if (sig) lines.push(`Signature: ${sig.slice(0, 120)}`);
  }

  // ── Env vars used in this function ──
  const fnEnvRefs = configRefs.filter((c) => c.containingFn === node.name).map((c) => c.key);

  if (fnEnvRefs.length > 0) {
    lines.push(`Environment: ${fnEnvRefs.join(", ")}`);
  }

  // ── String literals used in this function ──
  const fnLiterals = literals
    .filter((l) => l.containingFn === node.name && l.kind !== "magic_number")
    .map((l) => l.value)
    .slice(0, 8);

  if (fnLiterals.length > 0) {
    lines.push(`Literals: ${fnLiterals.join(", ")}`);
  }

  // ── Functions called ──
  // Extract from bodyText — same pattern as buildNodeSummaries
  const callNames = [];
  if (node.bodyText) {
    const callPattern = /\b([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(/g;
    let m;
    const seen = new Set();
    // Skip the node's own name to avoid self-reference
    seen.add(node.name);
    while ((m = callPattern.exec(node.bodyText)) !== null) {
      const name = m[1];
      if (
        !seen.has(name) &&
        name.length > 2 &&
        !/^(if|for|while|return|const|let|var|async|await|function|class|new|typeof|instanceof)$/.test(
          name
        )
      ) {
        seen.add(name);
        callNames.push(name);
        if (callNames.length >= 8) break;
      }
    }
  }

  if (callNames.length > 0) {
    lines.push(`Calls: ${callNames.join(", ")}`);
  }

  // ── Exported flag ──
  if (node.isExported) {
    lines.push("Exported: yes");
  }

  // ── Complexity hint ──
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
    // Only embed meaningful nodes — skip consts, imports, synthetic modules
    if (!["function", "method", "arrow_function", "class"].includes(node.kind)) {
      continue;
    }
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
