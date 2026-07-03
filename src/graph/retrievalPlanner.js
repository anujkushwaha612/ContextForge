/**
 * retrievalPlanner.js
 *
 * Fixes applied:
 *   RP-1: gatherContextChunks used process.cwd() — replaced with getWorkspaceRoot().
 *         CF_WORKSPACE_PATH is the authoritative base for all file resolution.
 *
 *   RP-2: readFunctionBody used process.cwd() — replaced with getWorkspaceRoot().
 *
 *   RP-3: Added confidence check before each tier so function_body and call_graph
 *         tiers are skipped when confidence is already sufficient from earlier tiers.
 *
 *   RP-4: gatherCallGraph now returns a flat array of items instead of
 *         { graph, bodies } object. The for...of in extractSymbols was throwing
 *         TypeError on the plain object. Removed the special-case branch in
 *         extractSymbols that handled the object shape.
 *
 *   RP-5: Hardcoded confidence values replaced with computed values based on
 *         actual match count and quality. function_body no longer auto-triggers
 *         CONF_SUFFICIENT early exit when match quality is unknown.
 *
 *   RP-6: planRetrieval now returns tiersUsed and answer fields that graphTools.js
 *         destructures. Previously both were undefined causing null in LLM response.
 *
 *   RP-7: Removed misleading "parallel" comment — execution is sequential by design.
 *
 * Fixes applied (this pass):
 *   RP-8: buildAnswer picked allItems[0] — INSERTION order (graph tier
 *         first), not best score. A weak fuzzy graph hit (score 0.35)
 *         outranked a strong semantic hit (0.9) purely because the graph
 *         tier ran first. Primary is now selected by per-item score
 *         (_score from resolver / _semanticScore from embeddings),
 *         falling back to tier confidence.
 *   RP-9: context_chunk items had no `type` field — buildAnswer's
 *         next_step produced null and extractSymbols/extractFiles saw
 *         malformed items. Now typed "context_chunk" with a next_step.
 *   RP-10: gatherFunctionBodies read bodies for the first 3 symbols in
 *         INSERTION order — now prefers symbols whose name matches the
 *         query (exact, then prefix/substring) so the body budget goes to
 *         what was actually asked about.
 */

import fs from "node:fs";
import path from "node:path";
import { resolve, resolveWithEmbeddings } from "./semanticResolver.js";
import { queryWhoCallsThis, queryWhatDoesThisCall, getWorkspaceRoot } from "./graphDb.js";

const CONF_SUFFICIENT = parseFloat(process.env.CF_RETRIEVAL_CONF_HIGH ?? "0.80");
const CONF_ACCEPTABLE = parseFloat(process.env.CF_RETRIEVAL_CONF_MID  ?? "0.55");

// Intent → which evidence sources may be used, in priority order
const SOURCES = {
  location:       ["graph", "semantic"],
  implementation: ["graph", "semantic", "function_body"],
  architecture:   ["graph", "semantic", "function_body", "call_graph"],
  debug:          ["graph", "semantic", "function_body", "call_graph", "context_chunk"],
};

/**
 * @param {string} query
 * @param {string} intent
 * @returns {Promise<{
 *   evidence:   Array,
 *   confidence: number,
 *   strategy:   string,
 *   tiersUsed:  string[],
 *   answer:     object|null,
 * }>}
 */
export async function planRetrieval(query, intent) {
  const sources    = SOURCES[intent] ?? SOURCES.location;
  const evidence   = [];
  let confidence   = 0;
  const tiersUsed  = [];

  for (const source of sources) {
    // RP-3: Check before every tier, not just at the top of the loop.
    // Prevents function_body/call_graph from running when an earlier tier
    // already produced sufficient confidence.
    if (confidence >= CONF_SUFFICIENT) break;

    let newEvidence = null;

    if (source === "graph") {
      newEvidence = await gatherGraph(query);

    } else if (source === "semantic") {
      // Only run semantic if graph confidence is below acceptable threshold.
      // Semantic embedding is more expensive than a SQLite index lookup.
      if (confidence < CONF_ACCEPTABLE) {
        newEvidence = await gatherSemantic(query);
      }

    } else if (source === "function_body") {
      // RP-3: Only run if we still need more evidence
      if (confidence < CONF_SUFFICIENT) {
        newEvidence = await gatherFunctionBodies(query, evidence);
      }

    } else if (source === "call_graph") {
      if (confidence < CONF_SUFFICIENT) {
        newEvidence = await gatherCallGraph(query, evidence);
      }

    } else if (source === "context_chunk") {
      if (confidence < CONF_SUFFICIENT) {
        newEvidence = await gatherContextChunks(query, evidence);
      }
    }

    if (newEvidence && newEvidence.items.length > 0) {
      evidence.push(newEvidence);
      confidence = Math.max(confidence, newEvidence.confidence);
      tiersUsed.push(source);
    }
  }

  // RP-6: Build a structured answer from the best evidence for graphTools to use.
  // Previously planRetrieval returned only { evidence, confidence, strategy }
  // but graphTools destructured plan.tiersUsed and plan.answer which were undefined.
  const answer = evidence.length > 0 ? buildAnswer(evidence, confidence) : null;

  return {
    evidence,
    confidence,
    strategy:  tiersUsed.join(" → ") || "none",
    tiersUsed,  // RP-6: was missing
    answer,     // RP-6: was missing
  };
}

// ─────────────────────────────────────────────
// RP-6: Answer builder
// Extracts the most useful information from accumulated evidence
// into a single structured object for the LLM response.
// ─────────────────────────────────────────────

function buildAnswer(evidence, confidence) {
  const allItems = [];
  for (const e of evidence) {
    for (const item of e.items) {
      // RP-8: carry a comparable score — per-item where available
      // (_score from resolver sort survives? no — resolver strips it;
      // _semanticScore survives), else the tier's confidence.
      const itemScore =
        item._semanticScore ?? item._score ?? e.confidence ?? 0;
      allItems.push({ ...item, _source: e.source, _rankScore: itemScore });
    }
  }

  if (allItems.length === 0) return null;

  // RP-8: pick primary by score, not insertion order. Stable for ties
  // (earlier tiers win ties, preserving graph-first preference).
  let primary = allItems[0];
  for (const item of allItems) {
    if (item._rankScore > primary._rankScore) primary = item;
  }

  return {
    primary,
    allItems,
    confidence,
    // Hint for the LLM: what to do next based on what we found
    next_step: primary.type === "symbol"
      ? `Call read_function('${primary.name}') to get the full implementation.`
      : primary.type === "route"
        ? `Use find_route('${primary.route}') for more detail or read_file_chunk on '${primary.file}'.`
        : primary.type === "context_chunk"
          ? `Context from '${primary.file}' starting line ${primary.startLine} is included above.`
          : null,
  };
}

// ─────────────────────────────────────────────
// Evidence gatherers
// ─────────────────────────────────────────────

async function gatherGraph(query) {
  const result = resolve(query);
  if (!result.found) return null;
  return {
    source:     "graph",
    items:      result.results,
    confidence: result.confidence,
    meta:       result.strategy,
  };
}

async function gatherSemantic(query) {
  const result = await resolveWithEmbeddings(query);
  if (result.results.length === 0) return null;
  const topScore = result.results[0]?._semanticScore ?? 0.5;
  return {
    source:     "semantic",
    items:      result.results,
    confidence: Math.min(0.8, topScore * 0.85),
    meta:       result.strategy,
  };
}

async function gatherFunctionBodies(query, existingEvidence) {
  const symbols = extractSymbols(existingEvidence);
  if (symbols.length === 0) return null;

  // RP-10: spend the 3-body budget on symbols matching the QUERY first,
  // not on whichever happened to be inserted earliest. Exact name match
  // ranks above prefix/substring, which ranks above unrelated.
  const q = String(query).toLowerCase();
  const rank = (s) => {
    const n = (s.name || "").toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q) || q.startsWith(n)) return 1;
    if (n.includes(q) || q.includes(n)) return 2;
    return 3;
  };
  const ordered = [...symbols].sort((a, b) => rank(a) - rank(b));

  const bodies = [];
  for (const sym of ordered.slice(0, 3)) {
    const body = readFunctionBody(sym);
    if (body) bodies.push(body);
  }

  if (bodies.length === 0) return null;

  // RP-5: Compute confidence from how many bodies were found vs requested,
  // not hardcoded 0.85. If we found all 3 requested bodies, confidence is
  // higher than if we only found 1.
  const bodyConfidence = 0.65 + (bodies.length / Math.min(symbols.length, 3)) * 0.20;

  return {
    source:     "function_body",
    items:      bodies,
    confidence: bodyConfidence,
  };
}

async function gatherCallGraph(query, existingEvidence) {
  const symbols = extractSymbols(existingEvidence);
  if (symbols.length === 0) return null;

  // RP-4: Return flat array of items, not { graph, bodies } object.
  // The previous object shape caused for...of to throw TypeError in extractSymbols
  // since plain objects are not iterable. Flat array is consistent with all
  // other gatherers.
  const graphNodes = buildCallGraph(symbols);
  if (graphNodes.length === 0) return null;

  const items = [];

  // Include the call graph nodes themselves as symbol-type items
  for (const node of graphNodes) {
    items.push({
      type:     "symbol",
      name:     node.name,
      file:     node.file,
      kind:     node.relation, // "caller" or "callee"
      relation: node.relation,
    });
  }

  // Read bodies for call graph nodes to give the LLM implementation context
  for (const node of graphNodes.slice(0, 4)) {
    const body = readFunctionBody(node);
    if (body) {
      // Merge body into the existing item rather than duplicating
      const existing = items.find((i) => i.name === node.name && i.file === node.file);
      if (existing) {
        existing.body      = body.body;
        existing.startLine = body.startLine;
        existing.endLine   = body.endLine;
      }
    }
  }

  // RP-5: Confidence from call graph size — more nodes = better coverage
  const callGraphConfidence = 0.70 + Math.min(graphNodes.length / 10, 0.10);

  return {
    source:     "call_graph",
    items,
    confidence: callGraphConfidence,
  };
}

async function gatherContextChunks(query, existingEvidence) {
  const files   = extractFiles(existingEvidence);
  if (files.length === 0) return null;

  const symbols    = extractSymbols(existingEvidence);
  const chunks     = [];
  const targetFile = files[0];
  const targetSym  = symbols[0];

  try {
    // RP-1: Use getWorkspaceRoot() not process.cwd().
    // CF_WORKSPACE_PATH is the project being indexed — server may be started
    // from a different directory entirely.
    const wsRoot  = getWorkspaceRoot();
    const absPath = path.isAbsolute(targetFile)
      ? targetFile
      : path.resolve(wsRoot, targetFile);

    const lines = fs
      .readFileSync(absPath, "utf-8")
      .replace(/\r\n/g, "\n")
      .split("\n");

    // RP-12 FIX: `targetSym?.startLine` treats a symbol on line 0 (a fully
    // valid 0-indexed line number — e.g. the very first declaration in a
    // file) as falsy, silently falling through to the "no symbol" branch
    // below. Explicit null/undefined check instead.
    if (targetSym?.startLine != null) {
      const start = Math.max(0, targetSym.startLine - 20);
      const end   = Math.min(lines.length, targetSym.startLine + 40);
      chunks.push({
        type:      "context_chunk", // RP-9: was untyped — broke buildAnswer/next_step
        file:      targetFile,
        content:   lines.slice(start, end).join("\n"),
        startLine: start + 1,
      });
    } else {
      chunks.push({
        type:      "context_chunk", // RP-9
        file:      targetFile,
        content:   lines.slice(0, 80).join("\n"),
        startLine: 1,
      });
    }
  } catch {
    /* file unreadable — skip */
  }

  if (chunks.length === 0) return null;

  // RP-5: Context chunk confidence — useful but not definitive
  return {
    source:     "context_chunk",
    items:      chunks,
    confidence: 0.72,
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function extractSymbols(evidence) {
  const syms = [];
  const seen = new Set();

  for (const e of evidence) {
    // RP-4: items is always a flat array now — no special-case needed
    for (const item of e.items || []) {
      if (item.type === "symbol" && item.name && !seen.has(item.name)) {
        seen.add(item.name);
        syms.push(item);
      }
    }
  }

  return syms;
}

function extractFiles(evidence) {
  const files = new Set();
  for (const e of evidence) {
    for (const item of e.items || []) {
      if (item.file)        files.add(item.file);
      if (item.source_file) files.add(item.source_file);
    }
  }
  return [...files];
}

function readFunctionBody(sym) {
  if (!sym.file || sym.startLine == null) return null;

  try {
    // RP-2: Use getWorkspaceRoot() not process.cwd().
    // CF_WORKSPACE_PATH is the project being indexed.
    const wsRoot  = getWorkspaceRoot();
    const absPath = path.isAbsolute(sym.file)
      ? sym.file
      : path.resolve(wsRoot, sym.file);

    const lines = fs
      .readFileSync(absPath, "utf-8")
      .replace(/\r\n/g, "\n")
      .split("\n");

    // RP-11 FIX: sym.startLine/endLine are 0-indexed, inclusive (the
    // convention symbolExtractor.js writes and graphTools.js's read_function
    // already correctly uses: lines.slice(start_line, end_line + 1)). This
    // function instead treated startLine as 1-indexed (`- 1`) and endLine as
    // an exclusive bound (no `+1`) — same symbol, same DB row, but a body
    // shifted one line early and missing its final line (e.g. a truncated
    // closing brace) compared to what read_function returns for the
    // identical symbol. Corrupted every implementation/architecture/debug
    // intent tier that goes through gatherFunctionBodies/gatherCallGraph.
    const start = Math.max(0, sym.startLine);
    const end   = Math.min(lines.length, (sym.endLine ?? sym.startLine + 60) + 1);

    return {
      type:        "symbol",   // consistent type field for extractSymbols
      name:        sym.name,
      file:        sym.file,
      startLine:   sym.startLine,
      endLine:     sym.endLine,
      body:        lines.slice(start, end).join("\n"),
      calls:       sym.calls       ?? [],
      envRefs:     sym.envRefs     ?? [],
      literalRefs: sym.literalRefs ?? [],
    };
  } catch {
    return null;
  }
}

function buildCallGraph(symbols) {
  const nodes = [];
  const seen  = new Set(symbols.map((s) => s.name));

  for (const sym of symbols.slice(0, 2)) {
    const callers = queryWhoCallsThis(sym.name);
    for (const c of callers.slice(0, 3)) {
      if (c.source_symbol && !seen.has(c.source_symbol)) {
        seen.add(c.source_symbol);
        nodes.push({
          name:     c.source_symbol,
          file:     c.source_file,
          relation: "caller",
        });
      }
    }

    const callees = queryWhatDoesThisCall(sym.name);
    for (const c of callees.slice(0, 3)) {
      if (c.target_symbol && !seen.has(c.target_symbol)) {
        seen.add(c.target_symbol);
        nodes.push({
          name:     c.target_symbol,
          file:     c.target_file,
          relation: "callee",
        });
      }
    }
  }

  return nodes;
}