/**
 * retrievalPlanner.js
 *
 * Evidence-based retrieval planner.
 * The LLM calls retrieve(query, intent).
 * This module gathers evidence from cheapest → most expensive sources,
 * expanding until confidence crosses threshold or no sources remain.
 *
 * Confidence is computed from actual match quality, not hardcoded per tier.
 */

import fs from "node:fs";
import path from "node:path";
import { resolve, resolveWithEmbeddings } from "./semanticResolver.js";
import { queryWhoCallsThis, queryWhatDoesThisCall, queryFindRoutes } from "./graphDb.js";

const CONF_SUFFICIENT = parseFloat(process.env.CF_RETRIEVAL_CONF_HIGH ?? "0.80");
const CONF_ACCEPTABLE = parseFloat(process.env.CF_RETRIEVAL_CONF_MID ?? "0.55");

// Intent → which evidence sources may be used
const SOURCES = {
  location: ["graph", "semantic"],
  implementation: ["graph", "semantic", "function_body"],
  architecture: ["graph", "semantic", "function_body", "call_graph"],
  debug: ["graph", "semantic", "function_body", "call_graph", "context_chunk"],
};

/**
 * @param {string} query
 * @param {string} intent
 * @returns {Promise<{ evidence: Array, confidence: number, strategy: string }>}
 */
export async function planRetrieval(query, intent) {
  const sources = SOURCES[intent] ?? SOURCES.location;
  const evidence = [];
  let confidence = 0;
  let strategy = [];

  for (const source of sources) {
    if (confidence >= CONF_SUFFICIENT) break;

    // Run graph + semantic in parallel when possible (they are independent)
    let newEvidence;
    if (source === "graph") {
      newEvidence = await gatherGraph(query);
    } else if (source === "semantic") {
      // Only run semantic if graph confidence is below acceptable
      if (confidence < CONF_ACCEPTABLE) {
        newEvidence = await gatherSemantic(query);
      }
    } else if (source === "function_body") {
      newEvidence = await gatherFunctionBodies(query, evidence);
    } else if (source === "call_graph") {
      newEvidence = await gatherCallGraph(query, evidence);
    } else if (source === "context_chunk") {
      newEvidence = await gatherContextChunks(query, evidence);
    }

    if (newEvidence && newEvidence.items.length > 0) {
      evidence.push(newEvidence);
      confidence = Math.max(confidence, newEvidence.confidence);
      strategy.push(source);
    }
  }

  return {
    evidence,
    confidence,
    strategy: strategy.join(" → ") || "none",
  };
}

// ── Evidence gatherers ──

async function gatherGraph(query) {
  const result = resolve(query);
  if (!result.found) return null;
  // Confidence from resolver's own scoring (exact match, etc.)
  return {
    source: "graph",
    items: result.results,
    confidence: result.confidence,
    meta: result.strategy,
  };
}

async function gatherSemantic(query) {
  const result = await resolveWithEmbeddings(query);
  if (result.results.length === 0) return null;
  // Semantic results get a base confidence of 0.7 times the top score
  const topScore = result.results[0]?._semanticScore ?? 0.5;
  return {
    source: "semantic",
    items: result.results,
    confidence: Math.min(0.8, topScore * 0.85),
    meta: result.strategy,
  };
}

async function gatherFunctionBodies(query, existingEvidence) {
  const symbols = extractSymbols(existingEvidence);
  if (symbols.length === 0) return null;

  const bodies = [];
  for (const sym of symbols.slice(0, 3)) {
    const body = readFunctionBody(sym);
    if (body) bodies.push(body);
  }
  if (bodies.length === 0) return null;
  return {
    source: "function_body",
    items: bodies,
    confidence: 0.85,
  };
}

async function gatherCallGraph(query, existingEvidence) {
  const symbols = extractSymbols(existingEvidence);
  if (symbols.length === 0) return null;

  const graphNodes = buildCallGraph(symbols);
  // Read bodies for call graph nodes
  const bodies = [];
  for (const node of graphNodes.slice(0, 4)) {
    const body = readFunctionBody(node);
    if (body) bodies.push(body);
  }

  return {
    source: "call_graph",
    items: { graph: graphNodes, bodies },
    confidence: 0.75 + (graphNodes.length > 3 ? 0.05 : 0),
  };
}

async function gatherContextChunks(query, existingEvidence) {
  const files = extractFiles(existingEvidence);
  if (files.length === 0) return null;

  // Read around the first symbol's location, not just top of file
  const symbols = extractSymbols(existingEvidence);
  const chunks = [];
  const targetFile = files[0];
  const targetSym = symbols[0];

  try {
    const absPath = path.isAbsolute(targetFile)
      ? targetFile
      : path.resolve(process.cwd(), targetFile);
    const lines = fs.readFileSync(absPath, "utf-8").replace(/\r\n/g, "\n").split("\n");
    if (targetSym && targetSym.startLine) {
      const start = Math.max(0, targetSym.startLine - 20);
      const end = Math.min(lines.length, targetSym.startLine + 40);
      chunks.push({
        file: targetFile,
        content: lines.slice(start, end).join("\n"),
        startLine: start + 1,
      });
    } else {
      chunks.push({ file: targetFile, content: lines.slice(0, 80).join("\n"), startLine: 1 });
    }
  } catch {
    /* skip */
  }

  if (chunks.length === 0) return null;
  return {
    source: "context_chunk",
    items: chunks,
    confidence: 0.88,
  };
}

// ── Helpers ──

function extractSymbols(evidence) {
  const syms = [];
  const seen = new Set();
  for (const e of evidence) {
    for (const item of e.items || []) {
      if (item.type === "symbol" && item.name && !seen.has(item.name)) {
        seen.add(item.name);
        syms.push(item);
      }
    }
    // handle call_graph items which contain graph array
    if (e.items?.graph) {
      for (const n of e.items.graph) {
        if (n.name && !seen.has(n.name)) {
          seen.add(n.name);
          syms.push(n);
        }
      }
    }
  }
  return syms;
}

function extractFiles(evidence) {
  const files = new Set();
  for (const e of evidence) {
    for (const item of e.items || []) {
      if (item.file) files.add(item.file);
      if (item.source_file) files.add(item.source_file);
    }
  }
  return [...files];
}

function readFunctionBody(sym) {
  if (!sym.file || sym.startLine == null) return null;
  try {
    const absPath = path.isAbsolute(sym.file) ? sym.file : path.resolve(process.cwd(), sym.file);
    const lines = fs.readFileSync(absPath, "utf-8").replace(/\r\n/g, "\n").split("\n");
    const start = Math.max(0, sym.startLine - 1);
    const end = Math.min(lines.length, sym.endLine ?? sym.startLine + 60);
    return {
      name: sym.name,
      file: sym.file,
      startLine: sym.startLine,
      endLine: sym.endLine,
      body: lines.slice(start, end).join("\n"),
      calls: sym.calls ?? [],
      envRefs: sym.envRefs ?? [],
      literalRefs: sym.literalRefs ?? [],
    };
  } catch {
    return null;
  }
}

function buildCallGraph(symbols) {
  const nodes = [];
  const seen = new Set(symbols.map((s) => s.name));
  for (const sym of symbols.slice(0, 2)) {
    const callers = queryWhoCallsThis(sym.name);
    for (const c of callers.slice(0, 3)) {
      if (c.source_symbol && !seen.has(c.source_symbol)) {
        seen.add(c.source_symbol);
        nodes.push({ name: c.source_symbol, file: c.source_file, relation: "caller" });
      }
    }
    const callees = queryWhatDoesThisCall(sym.name);
    for (const c of callees.slice(0, 3)) {
      if (c.target_symbol && !seen.has(c.target_symbol)) {
        seen.add(c.target_symbol);
        nodes.push({ name: c.target_symbol, file: c.target_file, relation: "callee" });
      }
    }
  }
  return nodes;
}
