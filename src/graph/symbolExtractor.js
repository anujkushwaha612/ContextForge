/**
 * symbolExtractor.js
 *
 * Extracts symbols (functions, classes, imports, exports) from source files.
 *
 * Two extraction paths:
 *   A. Tree-sitter (JS/TS/TSX/Python/Go/Rust/Java) — via native ExtractNodes
 *   B. Regex (C++/H) — tree-sitter C++ grammar not compiled, regex sufficient
 *
 * Output shape per file:
 * {
 *   nodes: [{ name, kind, startLine, endLine, isExported, isAsync, complexity, bodyText }]
 *   edges: [{ targetSymbol, targetFile, relation, sourceSymbol }]
 * }
 *
 * Fixes applied:
 *   SE-1: Truncation note now references read_file_chunk/read_function —
 *         not contextforge_retrieve (graph node bodies are not vaulted).
 *
 *   SE-2: resolveImportPath now tries the importing file's extension
 *         (.ts/.tsx) before falling back to .js — fixes TypeScript projects
 *         where import edges pointed to non-existent .js files.
 *
 *   SE-3: Duplicate method_declaration key removed — single canonical entry.
 *
 *   SE-4: import_statement removed from mapNodeTypeToKind — dead code,
 *         import nodes have no name and are always filtered out immediately.
 *
 *   SE-5: buildExportedNames regex pass added — corrects is_exported for
 *         `export const fn = () => {}` pattern missed by native C++ extractor.
 *         Native ExtractNodes only sets is_exported=true when the node type
 *         string contains "export" — lexical_declaration nodes wrapping
 *         exported arrow functions never match this check.
 *
 *   SE-6: Duplicate node deduplication added after native extraction.
 *         C++ produces both export_statement and lexical_declaration nodes
 *         for the same symbol. Without dedup, graphDb INSERT OR IGNORE keeps
 *         whichever arrives first — which may be the non-exported duplicate,
 *         causing is_exported=0 in the DB even after SE-5 correction.
 *         Dedup keeps the exported version, falling back to higher complexity.
 */

import { createRequire } from "module";
import path from "node:path";
import { getWorkspaceRoot } from "./graphDb.js";

const require = createRequire(import.meta.url);

let _native = null;
let _compressor = null;
let _nativeReady = false;

function getNative() {
  if (_native) return _native;
  // SX-1 FIX: resolution order must match server.js CF-P1 — the npm-shipped
  // package has ONLY prebuilds/<platform>-<arch>/, no native/build/Release.
  // The old single path meant the graph extractor silently degraded to
  // "Native unavailable" on every installed (non-dev) machine.
  const candidates = [
    `../../prebuilds/${process.platform}-${process.arch}/contextforge_native.node`,
    "../../native/build/Release/contextforge_native.node",
  ];
  try {
    let lastErr = null;
    for (const cand of candidates) {
      try {
        _native = require(cand);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!_native) throw lastErr ?? new Error("no native addon found");
    _compressor = new _native.ASTCompressor({
      preserveImports: true,
      preserveSignatures: true,
      preserveTypeAnnotations: true,
      preserveDecorators: true,
      vaultOnCompress: false,
      docstringMode: 2,
      maxBodyLines: 0,
      minTokensToCompress: 0,
    });
    _nativeReady = true;
  } catch (err) {
    console.warn(`[GraphExtractor] Native unavailable: ${err.message}`);
  }
  return _native;
}

// ─────────────────────────────────────────────
// Language routing
// ─────────────────────────────────────────────

const TREESITTER_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "go", "rs", "java",
]);

const REGEX_EXTENSIONS = new Set(["cpp", "cc", "cxx", "h", "hpp", "hh"]);

export function getLanguageForFile(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();

  if (TREESITTER_EXTENSIONS.has(ext)) {
    const map = {
      js:   "javascript",
      mjs:  "javascript",
      cjs:  "javascript",
      jsx:  "javascript",
      ts:   "typescript",
      tsx:  "tsx",
      py:   "python",
      go:   "go",
      rs:   "rust",
      java: "java",
    };
    return { method: "treesitter", language: map[ext] || ext };
  }

  if (REGEX_EXTENSIONS.has(ext)) {
    return { method: "regex", language: "cpp" };
  }

  return null;
}

// ─────────────────────────────────────────────
// Node type → kind mapping
// ─────────────────────────────────────────────

function mapNodeTypeToKind(nodeType) {
  const map = {
    // JavaScript / TypeScript
    function_declaration:           "function",
    function_expression:            "function",
    arrow_function:                 "arrow_function",
    method_definition:              "method",
    generator_function:             "function",
    generator_function_declaration: "function",
    class_declaration:              "class",
    class_expression:               "class",
    lexical_declaration:            "const",
    variable_declaration:           "const",
    assignment_expression:          "const",
    pair:                           "const",
    internal_module:                "namespace",
    export_statement:               null,

    // Python
    function_definition:            "function",
    async_function_definition:      "function",
    class_definition:               "class",
    decorated_definition:           "function",
    assignment:                     "const",

    // Go
    function_declaration_go:        "function",
    method_declaration:             "method",
    type_declaration:               "class",
    assignment_statement:           "const",
    short_var_declaration:          "const",
    func_literal:                   "function",

    // Rust
    function_item:                  "function",
    impl_item:                      "class",
    struct_item:                    "class",
    enum_item:                      "class",
    trait_item:                     "class",
    closure_expression:             "arrow_function",

    // Java
    class_declaration_java:         "class",
    interface_declaration:          "class",
    enum_declaration:               "class",
    record_declaration:             "class",
    // SX-5 FIX: constructor_declaration is in the C++ SIGNATURE_TYPES for
    // java (ast_compressor.cpp) so the native extractor EMITS it — but the
    // kind map dropped it, so every Java constructor vanished from the graph.
    constructor_declaration:        "method",

    // TypeScript — same gap: native emits these, map dropped them.
    type_alias_declaration:         "class",
    abstract_class_declaration:     "class",
  };

  return map[nodeType] ?? null;
}

// ─────────────────────────────────────────────
// Export detection — JavaScript/TypeScript supplement
//
// SE-5: Native C++ ExtractNodes misses `export const fn = () => {}`
// because it checks if the node type string contains "export" —
// lexical_declaration nodes never match this. We run a regex pass
// over the source to build a Set of exported names and correct
// is_exported after the native pass.
// ─────────────────────────────────────────────

const EXPORT_CONST_PATTERN =
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

const EXPORT_DEFAULT_PATTERN =
  // SX-8 FIX: `(?:function\s+)?` had no allowance for `async` appearing
  // between `default` and `function` — `export default async function
  // checkAuth(...)` (a very common Express middleware pattern) matched
  // successfully but captured the literal word "async" as group 1 instead
  // of "checkAuth". The regex never errors or fails to match, so this was
  // a silent corruption: buildExportedNames() registered a phantom
  // "async" entry instead of the real exported name. Any node whose
  // is_exported flag depends on this Set (native extractor misses this
  // export-wrapping shape too, per SE-5) is then incorrectly marked
  // not-exported — vanishing from what_does_this_export() results even
  // though find_symbol() may still surface it by name.
  /^export\s+default\s+(?:async\s+)?(?:function\s*\*?\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/gm;

const EXPORT_NAMED_PATTERN =
  /^export\s+(?:async\s+)?(?:function\s*\*?\s+|class\s+)([A-Za-z_$][A-Za-z0-9_$]*)/gm;

const EXPORT_LIST_PATTERN =
  /^export\s*\{([^}]+)\}/gm;

// SX-2 FIX: CommonJS export patterns. Express/Node projects (including the
// benchmark repo used for Run 1-3) are CJS — module.exports.X / exports.X
// were completely invisible, so EVERY symbol in a CJS project had
// is_exported=0. whatDoesThisExport() returned nothing for entire codebases.
const CJS_MEMBER_EXPORT_PATTERN =
  /^(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm;
const CJS_OBJECT_EXPORT_PATTERN =
  /^module\.exports\s*=\s*\{([^}]*)\}/m;
const CJS_DIRECT_EXPORT_PATTERN =
  /^module\.exports\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?\s*$/m;

function buildExportedNames(source, language) {
  if (!["javascript", "typescript", "tsx"].includes(language)) {
    return null;
  }

  const exported = new Set();

  EXPORT_CONST_PATTERN.lastIndex = 0;
  let m;
  while ((m = EXPORT_CONST_PATTERN.exec(source)) !== null) {
    exported.add(m[1]);
  }

  EXPORT_NAMED_PATTERN.lastIndex = 0;
  while ((m = EXPORT_NAMED_PATTERN.exec(source)) !== null) {
    exported.add(m[1]);
  }

  EXPORT_DEFAULT_PATTERN.lastIndex = 0;
  while ((m = EXPORT_DEFAULT_PATTERN.exec(source)) !== null) {
    exported.add(m[1]);
  }

  EXPORT_LIST_PATTERN.lastIndex = 0;
  while ((m = EXPORT_LIST_PATTERN.exec(source)) !== null) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => /^[A-Za-z_$]/.test(s));
    for (const name of names) exported.add(name);
  }

  // SX-2: CommonJS forms
  CJS_MEMBER_EXPORT_PATTERN.lastIndex = 0;
  while ((m = CJS_MEMBER_EXPORT_PATTERN.exec(source)) !== null) {
    exported.add(m[1]);
  }
  const objMatch = CJS_OBJECT_EXPORT_PATTERN.exec(source);
  if (objMatch) {
    for (const part of objMatch[1].split(",")) {
      // { listFiles, renameFile: rf } → export the LOCAL name (value side
      // for shorthand, key side is the public name — both are useful;
      // the local name is what matches node.name)
      const seg = part.trim();
      if (!seg) continue;
      const [key, val] = seg.split(":").map((x) => x.trim());
      const local = val || key;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) exported.add(local);
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) exported.add(key);
    }
  }
  const directMatch = CJS_DIRECT_EXPORT_PATTERN.exec(source);
  if (directMatch) exported.add(directMatch[1]);

  return exported;
}

// ─────────────────────────────────────────────
// Tree-sitter extraction
// ─────────────────────────────────────────────

// SX-6 FIX: when the native addon is unavailable the old code returned
// { nodes: [], edges: [] } — the graph went COMPLETELY empty even though
// import edges and basic symbols are derivable with regex. Now degrades
// to a regex extraction so cf still has a usable (if shallower) graph.
let _fallbackWarned = false;

const JS_FALLBACK_PATTERNS = [
  { re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: "function", exported: true },
  { re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,             kind: "function", exported: false },
  { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm, kind: "arrow_function", exported: true },
  { re: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm,            kind: "arrow_function", exported: false },
  { re: /^export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm,   kind: "class",    exported: true },
  { re: /^class\s+([A-Za-z_$][\w$]*)/gm,                              kind: "class",    exported: false },
];

const NONJS_FALLBACK_PATTERNS = {
  python: [
    { re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm, kind: "function", exported: true },
    { re: /^class\s+([A-Za-z_][\w]*)/gm,              kind: "class",    exported: true },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm, kind: "function", exported: true },
  ],
  rust: [
    { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/gm,       kind: "function", exported: true },
    { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/gm,   kind: "class",    exported: true },
  ],
  java: [
    { re: /^\s*(?:public|protected|private)?\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: "class", exported: true },
  ],
};

function regexFallbackExtract(source, language, filePath) {
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    console.warn(
      "[GraphExtractor] ⚠️  Running in REGEX FALLBACK mode (native addon " +
        "unavailable). Graph will have shallower symbol data — run " +
        "`cf doctor` to diagnose the native addon."
    );
  }
  const sourceLines = source.split("\n");
  const lineOf = (offset) => source.slice(0, offset).split("\n").length - 1;
  const isJs = ["javascript", "typescript", "tsx"].includes(language);
  const patterns = isJs ? JS_FALLBACK_PATTERNS : (NONJS_FALLBACK_PATTERNS[language] || []);
  const exportedNames = isJs ? buildExportedNames(source, language) : null;

  const nodes = [];
  const seen = new Set();
  for (const { re, kind, exported } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const startLine = lineOf(m.index);
      const endLine = Math.min(startLine + 50, sourceLines.length - 1);
      nodes.push({
        name,
        kind,
        startLine,
        endLine,
        isExported: exported || (exportedNames?.has(name) ?? false),
        isAsync: /\basync\b/.test(m[0]),
        complexity: 0,
        bodyText: sourceLines.slice(startLine, Math.min(endLine + 1, startLine + 100)).join("\n").trimEnd(),
      });
    }
  }

  const edges = [];
  for (const node of nodes) {
    if (node.isExported) {
      edges.push({ targetSymbol: node.name, targetFile: filePath, sourceSymbol: null, relation: "exports" });
    }
  }
  edges.push(...extractImportEdges(source, language, filePath));
  return { nodes, edges };
}

function treesitterExtract(source, language, filePath) {
  getNative();
  if (!_nativeReady || !_compressor) {
    return regexFallbackExtract(source, language, filePath);
  }

  const sourceLines = source.split("\n");

  let rawNodes;
  try {
    rawNodes = _compressor.extractNodes(source, language);
  } catch (err) {
    console.warn(`[GraphExtractor] extractNodes failed on ${filePath}: ${err.message}`);
    return { nodes: [], edges: [] };
  }

  // SE-5: Build export name set for is_exported correction
  const exportedNames = buildExportedNames(source, language);

  const nodes = [];
  const edges = [];
  const MAX_BODY_LINES = 100;

  for (const raw of rawNodes) {
    let kind = mapNodeTypeToKind(raw.type, language);
    if (!kind) continue;

    // SX-9 FIX: Anonymous default exports — `export default function (req,
    // res, next) {}`, `export default (req, res) => {}`, `export default
    // class {}` — have NO identifier for tree-sitter to report, so raw.name
    // arrives empty. The old code silently `continue`d, dropping the node
    // entirely. This pattern is exactly Express's router.param(name, cb)
    // callback convention and extremely common in small single-purpose
    // middleware files. Losing it means BOTH find_symbol AND
    // what_does_this_export (the documented LLM fallback when find_symbol
    // misses) return not-found — there is no node in the graph to report
    // either way, forcing a raw file read the graph should have prevented.
    //
    // Fix: synthesize a discoverable name from the file's basename
    // (mirroring the existing __module_<basename> convention used when a
    // whole file has zero nodes) instead of dropping the node.
    let symbolName = raw.name;
    if (!symbolName || symbolName.trim() === "") {
      const isAnonymousExportable = ["function", "arrow_function", "class"].includes(kind);
      if (!isAnonymousExportable) continue;

      const baseName = path.basename(filePath, path.extname(filePath)).replace(/[^A-Za-z0-9_$]/g, "_");
      symbolName = `default_export_${baseName}`;
    }

    if (kind === "const") {
      const initType = raw.initializer_type || "";
      const isFunctionInit = [
        "arrow_function",
        "function_expression",
        "generator_function",
        "lambda",
        "func_literal",
        "closure_expression",
      ].includes(initType);
      const isAsyncDecl = raw.is_async === true;

      if (isFunctionInit || isAsyncDecl) {
        kind =
          initType === "arrow_function" ||
          initType === "closure_expression" ||
          initType === "lambda"
            ? "arrow_function"
            : "function";
      } else {
        if ((raw.depth ?? Infinity) <= 2) {
          kind = "const";
        } else {
          continue;
        }
      }
    }

    const startLine     = raw.start_line      ?? 0;
    const endLine       = raw.end_line        ?? startLine;
    const bodyStartLine = raw.body_start_line ?? startLine;
    const bodyEndLine   = raw.body_end_line   ?? endLine;

    const signatureLines = sourceLines.slice(startLine, bodyStartLine);
    const bodyLines      = sourceLines.slice(
      bodyStartLine,
      Math.min(bodyEndLine + 1, bodyStartLine + MAX_BODY_LINES)
    );

    const actualBodyLines = bodyEndLine - bodyStartLine + 1;
    const wasTruncated    = actualBodyLines > MAX_BODY_LINES;

    const truncationNote = wasTruncated
      ? [
          `// ... ${actualBodyLines - MAX_BODY_LINES} more lines. ` +
            `Use read_function('${symbolName}') or read_file_chunk to get the full body.`,
        ]
      : [];

    const bodyText = [...signatureLines, ...bodyLines, ...truncationNote]
      .join("\n")
      .trimEnd();

    // SE-5: Correct is_exported — native misses export const arrow functions
    // SX-9: also check exportedNames under the ORIGINAL raw.name (if any)
    // before falling back — a synthesized symbolName never appears in the
    // regex-built exportedNames set, but anonymous `export default ...`
    // nodes are *always* exported by definition (there is no other reason
    // an anonymous function would be the direct target of `export default`).
    const isAnonymousDefaultExport = symbolName !== raw.name;
    const isExported = raw.is_exported
      ? true
      : isAnonymousDefaultExport
        ? true
        : (exportedNames?.has(raw.name) ?? false);

    nodes.push({
      name:       symbolName,
      kind,
      startLine,
      endLine,
      isExported,
      isAsync:    raw.is_async    || false,
      complexity: raw.complexity  || 0,
      bodyText,
    });

    if (isExported) {
      edges.push({
        targetSymbol: symbolName,
        targetFile:   filePath,
        sourceSymbol: null,
        relation:     "exports",
      });
    }
  }

  // ── SE-6: Deduplicate nodes by name ───────────────────────────────────
  // C++ produces both export_statement and lexical_declaration nodes for
  // `export const fn = () => {}` — same name, different types.
  // graphDb uses INSERT OR IGNORE so whichever arrives first wins.
  // Without dedup, the non-exported duplicate can arrive first and persist
  // as is_exported=0 even after the SE-5 correction above sets isExported=true
  // on both — because INSERT OR IGNORE silently discards the second insert.
  //
  // Resolution priority:
  //   1. Exported beats non-exported
  //   2. Higher complexity beats lower (more informative body)
  //   3. First seen wins on tie
  const nameMap = new Map();
  for (const node of nodes) {
    const existing = nameMap.get(node.name);
    if (!existing) {
      nameMap.set(node.name, node);
    } else {
      const newWins =
        (node.isExported && !existing.isExported) ||
        (node.isExported === existing.isExported &&
          node.complexity > existing.complexity);
      if (newWins) {
        if (process.env.CF_DEBUG_GRAPH === "1") {
          console.warn(`[SymbolExtractor] Discarding previous duplicate symbol '${node.name}' in ${filePath}`);
        }
        nameMap.set(node.name, node);
      } else {
        if (process.env.CF_DEBUG_GRAPH === "1") {
          console.warn(`[SymbolExtractor] Discarding new duplicate symbol '${node.name}' in ${filePath}`);
        }
      }
    }
  }

  const dedupedNodes = [...nameMap.values()].sort(
    (a, b) => a.startLine - b.startLine
  );

  // Synthesize virtual module-scope node for procedural scripts
  //
  // SX-9 FIX: threshold lowered 200 -> 20 chars. The 200-char gate meant
  // any small file that genuinely produced zero real nodes (a short
  // side-effect script, a tiny re-export shim) got ZERO graph
  // representation at all — no real node, no synthetic node — leaving it
  // completely invisible to find_symbol AND what_does_this_export alike.
  // Small single-purpose files (exactly the kind most likely to slip under
  // an arbitrary length gate) are common in real codebases; 20 chars still
  // excludes genuinely empty/whitespace-only files while covering them.
  if (dedupedNodes.length === 0 && source.trim().length > 20 && source.includes("(")) {
    const baseName = path.basename(filePath, path.extname(filePath));
    dedupedNodes.push({
      name:       `__module_${baseName}`,
      kind:       "function",
      startLine:  0,
      endLine:    sourceLines.length - 1,
      isExported: false,
      isAsync:    false,
      complexity: 0,
      bodyText:   null,
    });
  }

  const importEdges = extractImportEdges(source, language, filePath);
  edges.push(...importEdges);

  return { nodes: dedupedNodes, edges };
}

// ─────────────────────────────────────────────
// Import edge extraction
// ─────────────────────────────────────────────

const IMPORT_PATTERNS = {
  javascript: [
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    // SX-3 FIX: mixed default+named — `import express, { Router } from "express"`
    // matched NEITHER pattern above (first requires { immediately, second
    // requires bare \w+ before from). Express-style imports lost BOTH edges.
    /import\s+(\w+)\s*,\s*\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+\w+\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
    // SX-3 FIX: namespace import — `import * as utils from "./utils.js"`
    /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [/from\s+([\w.]+)\s+import\s+([^#\n]+)/g, /^import\s+([\w.]+)/gm],
  // SX-4 FIX: old go entry had TWO bugs — (1) /"([\w./]+)"/g matched EVERY
  // string literal in the file as an "import" and (2) extractImportEdges had
  // no go branch at all, so even real imports produced ZERO edges. Go is now
  // handled explicitly in extractImportEdges (single + parenthesized block).
  go:     [],
  rust:   [/use\s+([\w:]+)::(\w+)/g, /use\s+([\w:]+)::\{([^}]+)\}/g],
  cpp:    [/#include\s+"([^"]+)"/g, /#include\s+<([^>]+)>/g],
};

// SX-7 FIX: fromDir is a WORKSPACE-RELATIVE directory (path.dirname of the
// relPath extractSymbols is called with — e.g. "controllers", not an
// absolute path). path.resolve(fromDir, ...) with a relative fromDir
// silently anchors against process.cwd() — the PROXY's own install
// directory, not the indexed project's workspace root. server.js exists
// specifically because cwd != workspace in real deployments (CF_WORKSPACE_PATH).
//
// Consequence before this fix: every relative import edge's targetFile was
// written as an absolute path resolved from the wrong root (e.g.
// "/home/user/contextforge-install/../foo.js" instead of "foo.js"). Every
// downstream query that compares target_file against a workspace-relative
// path — queryWhoDependsOnFile, analyze_impact's transitive lookups — could
// never match, silently returning "no_dependents"/empty results for every
// file with relative imports, regardless of the indexed project's contents.
//
// Fix: resolve against getWorkspaceRoot(), then convert back to a
// workspace-relative path so it matches the format of every other
// file_path/target_file value already written to the graph DB.
function resolveImportPath(fromDir, importPath, importingFileExt = ".js") {
  try {
    const clean  = importPath.split("?")[0].split("#")[0];
    const hasExt = /\.\w{1,4}$/.test(clean);

    const workspaceRoot = getWorkspaceRoot();
    const absFromDir = path.resolve(workspaceRoot, fromDir);

    const absTarget = hasExt
      ? path.resolve(absFromDir, clean)
      : path.resolve(
          absFromDir,
          clean + ([".ts", ".tsx", ".jsx"].includes(importingFileExt) ? importingFileExt : ".js")
        );

    return path.relative(workspaceRoot, absTarget).replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function extractImportEdges(source, language, filePath) {
  const edges    = [];
  const lang     = language === "typescript" || language === "tsx" ? "javascript" : language;

  // SX-4: Go handled explicitly — single imports (optionally aliased) and
  // parenthesized import blocks. No generic-string noise.
  if (lang === "go") {
    const single = /import\s+(?:(\w+)\s+)?"([^"]+)"/g;
    let gm;
    while ((gm = single.exec(source)) !== null) {
      const alias = gm[1];
      const pkg = gm[2];
      edges.push({
        targetSymbol: alias || pkg.split("/").pop(),
        targetFile:   null,
        sourceSymbol: null,
        relation:     "imports",
      });
    }
    const block = /import\s*\(([\s\S]*?)\)/g;
    while ((gm = block.exec(source)) !== null) {
      const inner = /(?:(\w+)\s+)?"([^"]+)"/g;
      let im;
      while ((im = inner.exec(gm[1])) !== null) {
        edges.push({
          targetSymbol: im[1] || im[2].split("/").pop(),
          targetFile:   null,
          sourceSymbol: null,
          relation:     "imports",
        });
      }
    }
    return edges;
  }

  const patterns = IMPORT_PATTERNS[lang] || IMPORT_PATTERNS.javascript;
  const fileDir  = path.dirname(filePath);
  const fileExt  = path.extname(filePath).toLowerCase();

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(source)) !== null) {
      if (lang === "javascript") {
        const symbolsStr = match[1];
        const importPath = match[2];
        const isRelative = importPath.startsWith(".") || importPath.startsWith("/");
        const targetFile = isRelative
          ? resolveImportPath(fileDir, importPath, fileExt)
          : null;

        const symbols = symbolsStr
          .split(",")
          .map((s) => s.trim().split(" as ")[0].trim())
          .filter((s) => s && /^\w+$/.test(s));

        for (const sym of symbols) {
          edges.push({
            targetSymbol: sym,
            targetFile,
            sourceSymbol: null,
            relation:     "imports",
          });
        }
      } else if (lang === "python") {
        const symbolsRaw = match[2] || match[1];
        const symbols    = symbolsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && /^\w+$/.test(s));

        for (const sym of symbols) {
          edges.push({
            targetSymbol: sym,
            targetFile:   null,
            sourceSymbol: null,
            relation:     "imports",
          });
        }
      } else if (lang === "rust") {
        const pathStr = match[1];
        const symbols = match[2]
          ? match[2].split(",").map((s) => s.trim()).filter(Boolean)
          : [pathStr.split("::").pop()];

        for (const sym of symbols) {
          edges.push({
            targetSymbol: sym,
            targetFile:   null,
            sourceSymbol: null,
            relation:     "imports",
          });
        }
      } else if (lang === "cpp") {
        const includePath = match[1];
        const targetFile  = includePath.startsWith("/")
          ? includePath
          : resolveImportPath(fileDir, "./" + includePath, ".cpp");

        edges.push({
          targetSymbol: includePath,
          targetFile,
          sourceSymbol: null,
          relation:     "imports",
        });
      }
    }
  }

  return edges;
}

// ─────────────────────────────────────────────
// Regex extraction for C++/H files
// ─────────────────────────────────────────────

const CPP_PATTERNS = {
  function:
    /^(?!.*(?:if|for|while|switch|catch)\s*\()[\w:*&<>]+\s+(\w+)\s*\([^)]*\)\s*(?:const|override|noexcept)?\s*\{/gm,
  class:
    /^(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)\s+\w+)?/gm,
  namespace:
    /^namespace\s+(\w+)\s*\{/gm,
};

function regexExtract(source, filePath) {
  const nodes  = [];
  const edges  = [];
  const lines  = source.split("\n");

  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }

  function charToLine(charOffset) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= charOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  const MAX_BODY_LINES = 100;

  CPP_PATTERNS.function.lastIndex = 0;
  let match;
  while ((match = CPP_PATTERNS.function.exec(source)) !== null) {
    const name      = match[1];
    const startLine = charToLine(match.index);
    const endLine   = Math.min(startLine + 50, lines.length - 1);
    const bodyLines = lines.slice(
      startLine,
      Math.min(endLine + 1, startLine + MAX_BODY_LINES)
    );

    nodes.push({
      name,
      kind:       "function",
      startLine,
      endLine,
      isExported: true,
      isAsync:    false,
      complexity: 1,
      bodyText:   bodyLines.join("\n").trimEnd(),
    });
  }

  CPP_PATTERNS.class.lastIndex = 0;
  while ((match = CPP_PATTERNS.class.exec(source)) !== null) {
    const name      = match[1];
    const startLine = charToLine(match.index);
    const endLine   = Math.min(startLine + 100, lines.length - 1);
    const bodyLines = lines.slice(
      startLine,
      Math.min(endLine + 1, startLine + MAX_BODY_LINES)
    );

    nodes.push({
      name,
      kind:       "class",
      startLine,
      endLine,
      isExported: true,
      isAsync:    false,
      complexity: 0,
      bodyText:   bodyLines.join("\n").trimEnd(),
    });
  }

  const includeEdges = extractImportEdges(source, "cpp", filePath);
  edges.push(...includeEdges);

  return { nodes, edges };
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export function extractSymbols(source, filePath) {
  if (!source || source.length === 0) return { nodes: [], edges: [] };

  const langInfo = getLanguageForFile(filePath);
  if (!langInfo) return { nodes: [], edges: [] };

  if (langInfo.method === "treesitter") {
    return treesitterExtract(source, langInfo.language, filePath);
  }

  if (langInfo.method === "regex") {
    return regexExtract(source, filePath);
  }

  return { nodes: [], edges: [] };
}