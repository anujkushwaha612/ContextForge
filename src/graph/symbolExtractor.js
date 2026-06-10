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
 *   nodes: [{ name, kind, startLine, endLine, isExported, isAsync, complexity }]
 *   edges: [{ targetSymbol, targetFile, relation, sourceSymbol }]
 * }
 */

import { createRequire } from "module";
import path from "node:path";

const require = createRequire(import.meta.url);

let _native       = null;
let _compressor   = null;
let _nativeReady  = false;

// Lazy-load native — same binary as astCompressor
function getNative() {
  if (_native) return _native;
  try {
    _native = require("../../native/build/Release/contextforge_native.node");
    // Create a compressor instance for ExtractNodes + DetectLanguage
    _compressor  = new _native.ASTCompressor({
      preserveImports:         true,
      preserveSignatures:      true,
      preserveTypeAnnotations: true,
      preserveDecorators:      true,
      vaultOnCompress:         false,  // graph extraction — no vaulting
      docstringMode:           2,      // REMOVE — we don't need docstrings
      maxBodyLines:            0,
      minTokensToCompress:     0,
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
  "js", "mjs", "cjs",
  "ts",
  "tsx",
  "py",
  "go",
  "rs",
  "java",
]);

const REGEX_EXTENSIONS = new Set([
  "cpp", "cc", "cxx",
  "h", "hpp", "hh",
]);

export function getLanguageForFile(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();

  if (TREESITTER_EXTENSIONS.has(ext)) {
    // Map extension → tree-sitter language hint
    const map = {
      js: "javascript", mjs: "javascript", cjs: "javascript",
      ts: "typescript",
      tsx: "tsx",
      py: "python",
      go: "go",
      rs: "rust",
      java: "java",
    };
    return { method: "treesitter", language: map[ext] || ext };
  }

  if (REGEX_EXTENSIONS.has(ext)) {
    return { method: "regex", language: "cpp" };
  }

  return null; // unsupported
}

// ─────────────────────────────────────────────
// Tree-sitter extraction
// Uses native.ASTCompressor.ExtractNodes()
// ─────────────────────────────────────────────

/**
 * Convert raw ASTNode from C++ into our graph node/edge format.
 * ASTNode shape (from ast_compressor.h):
 *   { type, start_line, end_line, name, is_exported, is_async, complexity, depth }
 */
function treesitterExtract(source, language, filePath) {
  getNative();
  if (!_nativeReady || !_compressor) return { nodes: [], edges: [] };

  let rawNodes;
  try {
    rawNodes = _compressor.extractNodes(source, language);
  } catch (err) {
    console.warn(`[GraphExtractor] extractNodes failed on ${filePath}: ${err.message}`);
    return { nodes: [], edges: [] };
  }

  const nodes = [];
  const edges = [];

  for (const raw of rawNodes) {
    // Map tree-sitter node types → our kinds
    const kind = mapNodeTypeToKind(raw.type, language);
    if (!kind) continue;

    // Skip anonymous/unnamed nodes
    if (!raw.name || raw.name.trim() === "") continue;

    nodes.push({
      name:       raw.name,
      kind,
      startLine:  raw.start_line,
      endLine:    raw.end_line,
      isExported: raw.is_exported || false,
      isAsync:    raw.is_async    || false,
      complexity: raw.complexity  || 0,
    });

    // If exported — create an export edge
    if (raw.is_exported) {
      edges.push({
        targetSymbol: raw.name,
        targetFile:   filePath,
        sourceSymbol: null,
        relation:     "exports",
      });
    }
  }

  // Extract import edges from source text
  // Tree-sitter gives us the nodes but import resolution
  // is cleaner from regex on the source directly
  const importEdges = extractImportEdges(source, language, filePath);
  edges.push(...importEdges);

  return { nodes, edges };
}

function mapNodeTypeToKind(nodeType, language) {
  const map = {
    // JavaScript/TypeScript
    function_declaration:       "function",
    function_expression:        "function",
    arrow_function:             "function",
    method_definition:          "function",
    generator_function:         "function",
    generator_function_declaration: "function",
    class_declaration:          "class",
    class_expression:           "class",
    lexical_declaration:        "const",
    variable_declaration:       "const",
    export_statement:           null,   // handled via is_exported flag
    import_statement:           "import",

    // Python
    function_definition:        "function",
    async_function_definition:  "function",
    class_definition:           "class",
    decorated_definition:       "function",

    // Go
    function_declaration_go:    "function",
    method_declaration:         "function",
    type_declaration:           "class",

    // Rust
    function_item:              "function",
    impl_item:                  "class",
    struct_item:                "class",
    enum_item:                  "class",
    trait_item:                 "class",

    // Java
    method_declaration:         "function",
    class_declaration_java:     "class",
    interface_declaration:      "class",
    enum_declaration:           "class",
  };

  return map[nodeType] ?? null;
}

// ─────────────────────────────────────────────
// Import edge extraction (regex — works for all languages)
// Tree-sitter gives us nodes but not resolved import paths
// ─────────────────────────────────────────────

// Precompiled — paid once at module load
const IMPORT_PATTERNS = {
  javascript: [
    // ES6: import { foo, bar } from './path'
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
    // ES6: import defaultExport from './path'
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    // CommonJS: const { foo } = require('./path')
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // CommonJS: const foo = require('./path')
    /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [
    // from module import foo, bar
    /from\s+([\w.]+)\s+import\s+([^#\n]+)/g,
    // import module
    /^import\s+([\w.]+)/gm,
  ],
  go: [
    // import "path/to/package"
    /import\s+"([^"]+)"/g,
    // import ( "path1" "path2" )
    /"([\w./]+)"/g,
  ],
  rust: [
    // use crate::module::Symbol;
    /use\s+([\w:]+)::(\w+)/g,
    // use crate::module::{A, B}
    /use\s+([\w:]+)::\{([^}]+)\}/g,
  ],
  cpp: [
    // #include "local.h"
    /#include\s+"([^"]+)"/g,
    // #include <system.h>
    /#include\s+<([^>]+)>/g,
  ],
};

function extractImportEdges(source, language, filePath) {
  const edges    = [];
  const lang     = language === "typescript" || language === "tsx"
    ? "javascript"
    : language;
  const patterns = IMPORT_PATTERNS[lang] || IMPORT_PATTERNS.javascript;
  const fileDir  = path.dirname(filePath);

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (lang === "javascript") {
        // Group 1: symbols or default name, Group 2: path
        const symbolsStr = match[1];
        const importPath = match[2];

        // Skip external packages (no . prefix)
        const isRelative = importPath.startsWith(".") ||
                           importPath.startsWith("/");
        const targetFile = isRelative
          ? resolveImportPath(fileDir, importPath)
          : null;

        // Parse individual symbols
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
        const fromModule = match[1];
        const symbolsRaw = match[2] || match[1];
        const symbols    = symbolsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && /^\w+$/.test(s));

        for (const sym of symbols) {
          edges.push({
            targetSymbol: sym,
            targetFile:   null, // Python module resolution is complex
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
          : resolveImportPath(fileDir, "./" + includePath);

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

function resolveImportPath(fromDir, importPath) {
  try {
    // Strip query params and hash
    const clean = importPath.split("?")[0].split("#")[0];

    // Add .js extension if no extension present
    const hasExt = /\.\w{1,4}$/.test(clean);
    const withExt = hasExt ? clean : clean + ".js";

    return path.resolve(fromDir, withExt).replace(/\\/g, "/");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Regex extraction for C++/H files
// Tree-sitter C++ grammar not compiled — regex is sufficient
// for the patterns we care about (function sigs, class decls)
// ─────────────────────────────────────────────

const CPP_PATTERNS = {
  // Function definition: ReturnType functionName(
  // Excludes: if/for/while/switch (control flow)
  function: /^(?!.*(?:if|for|while|switch|catch)\s*\()[\w:*&<>]+\s+(\w+)\s*\([^)]*\)\s*(?:const|override|noexcept)?\s*\{/gm,

  // Class declaration
  class: /^(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)\s+\w+)?/gm,

  // Namespace
  namespace: /^namespace\s+(\w+)\s*\{/gm,
};

function regexExtract(source, filePath) {
  const nodes = [];
  const edges = [];
  const lines = source.split("\n");

  // Build a char-offset → line-number index for position lookup
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }

  function charToLine(charOffset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= charOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Extract functions
  CPP_PATTERNS.function.lastIndex = 0;
  let match;
  while ((match = CPP_PATTERNS.function.exec(source)) !== null) {
    const name      = match[1];
    const startLine = charToLine(match.index);

    // Estimate end line: find matching closing brace
    let endLine = Math.min(startLine + 50, lines.length - 1);

    nodes.push({
      name,
      kind:       "function",
      startLine,
      endLine,
      isExported: true,  // C++ functions in headers are exported by convention
      isAsync:    false,
      complexity: 1,
    });
  }

  // Extract classes
  CPP_PATTERNS.class.lastIndex = 0;
  while ((match = CPP_PATTERNS.class.exec(source)) !== null) {
    const name      = match[1];
    const startLine = charToLine(match.index);

    nodes.push({
      name,
      kind:       "class",
      startLine,
      endLine:    Math.min(startLine + 100, lines.length - 1),
      isExported: true,
      isAsync:    false,
      complexity: 0,
    });
  }

  // Extract includes as import edges
  const includeEdges = extractImportEdges(source, "cpp", filePath);
  edges.push(...includeEdges);

  return { nodes, edges };
}

// ─────────────────────────────────────────────
// Main export: extractSymbols
// ─────────────────────────────────────────────

/**
 * Extract all symbols from a source file.
 *
 * @param {string} source     - File contents
 * @param {string} filePath   - Absolute path (for edge resolution)
 * @returns {{ nodes: Node[], edges: Edge[] }}
 */
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