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

const require = createRequire(import.meta.url);

let _native = null;
let _compressor = null;
let _nativeReady = false;

function getNative() {
  if (_native) return _native;
  try {
    _native = require("../../native/build/Release/contextforge_native.node");
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
  /^export\s+default\s+(?:function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/gm;

const EXPORT_NAMED_PATTERN =
  /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

const EXPORT_LIST_PATTERN =
  /^export\s*\{([^}]+)\}/gm;

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

  return exported;
}

// ─────────────────────────────────────────────
// Tree-sitter extraction
// ─────────────────────────────────────────────

function treesitterExtract(source, language, filePath) {
  getNative();
  if (!_nativeReady || !_compressor) return { nodes: [], edges: [] };

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
    if (!raw.name || raw.name.trim() === "") continue;

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
        if ((raw.depth || Infinity) <= 2) {
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
            `Use read_function('${raw.name}') or read_file_chunk to get the full body.`,
        ]
      : [];

    const bodyText = [...signatureLines, ...bodyLines, ...truncationNote]
      .join("\n")
      .trimEnd();

    // SE-5: Correct is_exported — native misses export const arrow functions
    const isExported = raw.is_exported
      ? true
      : (exportedNames?.has(raw.name) ?? false);

    nodes.push({
      name:       raw.name,
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
        targetSymbol: raw.name,
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
      if (newWins) nameMap.set(node.name, node);
    }
  }

  const dedupedNodes = [...nameMap.values()].sort(
    (a, b) => a.startLine - b.startLine
  );

  // Synthesize virtual module-scope node for procedural scripts
  if (dedupedNodes.length === 0 && source.length > 200 && source.includes("(")) {
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
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [/from\s+([\w.]+)\s+import\s+([^#\n]+)/g, /^import\s+([\w.]+)/gm],
  go:     [/import\s+"([^"]+)"/g, /"([\w./]+)"/g],
  rust:   [/use\s+([\w:]+)::(\w+)/g, /use\s+([\w:]+)::\{([^}]+)\}/g],
  cpp:    [/#include\s+"([^"]+)"/g, /#include\s+<([^>]+)>/g],
};

function resolveImportPath(fromDir, importPath, importingFileExt = ".js") {
  try {
    const clean  = importPath.split("?")[0].split("#")[0];
    const hasExt = /\.\w{1,4}$/.test(clean);

    if (hasExt) {
      return path.resolve(fromDir, clean).replace(/\\/g, "/");
    }

    const preferredExt = [".ts", ".tsx", ".jsx"].includes(importingFileExt)
      ? importingFileExt
      : ".js";

    return path.resolve(fromDir, clean + preferredExt).replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function extractImportEdges(source, language, filePath) {
  const edges    = [];
  const lang     = language === "typescript" || language === "tsx" ? "javascript" : language;
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