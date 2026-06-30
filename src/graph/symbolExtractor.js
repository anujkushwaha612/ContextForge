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

let _native = null;
let _compressor = null;
let _nativeReady = false;

// Lazy-load native — same binary as astCompressor
function getNative() {
  if (_native) return _native;
  try {
    _native = require("../../native/build/Release/contextforge_native.node");
    // Create a compressor instance for ExtractNodes + DetectLanguage
    _compressor = new _native.ASTCompressor({
      preserveImports: true,
      preserveSignatures: true,
      preserveTypeAnnotations: true,
      preserveDecorators: true,
      vaultOnCompress: false, // graph extraction — no vaulting
      docstringMode: 2, // REMOVE — we don't need docstrings
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

const TREESITTER_EXTENSIONS = new Set(["js", "mjs", "cjs", "ts", "tsx", "py", "go", "rs", "java"]);

const REGEX_EXTENSIONS = new Set(["cpp", "cc", "cxx", "h", "hpp", "hh"]);

export function getLanguageForFile(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();

  if (TREESITTER_EXTENSIONS.has(ext)) {
    const map = {
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
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

  return null;
}

function treesitterExtract(source, language, filePath) {
  getNative();
  if (!_nativeReady || !_compressor) return { nodes: [], edges: [] };

  // Pre-split once — used for body extraction below
  const sourceLines = source.split("\n");

  let rawNodes;
  try {
    rawNodes = _compressor.extractNodes(source, language);
  } catch (err) {
    console.warn(`[GraphExtractor] extractNodes failed on ${filePath}: ${err.message}`);
    return { nodes: [], edges: [] };
  }

  const nodes = [];
  const edges = [];

  const MAX_BODY_LINES = 100;

  for (const raw of rawNodes) {
    let kind = mapNodeTypeToKind(raw.type, language);
    if (!kind) continue;
    if (!raw.name || raw.name.trim() === "") continue;

    // ── Upgrade "const" → "arrow_function" for function-valued declarations ──
    // The C++ extractor now recursively checks the right-hand side and populates initializer_type.
    if (kind === "const") {
      const initType = raw.initializer_type || "";
      const isFunctionInit = [
        "arrow_function",
        "function_expression",
        "generator_function",
        "lambda",
        "func_literal",
        "closure_expression"
      ].includes(initType);

      const isAsyncDecl = raw.is_async === true;

      if (isFunctionInit || isAsyncDecl) {
        kind = (initType === "arrow_function" || initType === "closure_expression" || initType === "lambda") 
               ? "arrow_function" : "function";
      } else {
        // Keep non-function constants ONLY if they are at the module root level.
        // Depth 1 is usually the root of the module (child of 'program').
        // Depth 2 might be if it's wrapped in an export_statement.
        if ((raw.depth || Infinity) <= 2) {
          kind = "const";
        } else {
          // Local variable — not useful in the call graph
          continue;
        }
      }
    }

    const startLine = raw.start_line ?? 0;
    const endLine = raw.end_line ?? startLine;
    const bodyStartLine = raw.body_start_line ?? startLine;
    const bodyEndLine = raw.body_end_line ?? endLine;

    // ── Signature lines: from node start up to body start ──
    const signatureLines = sourceLines.slice(startLine, bodyStartLine);

    // ── Body lines: capped at MAX_BODY_LINES ──
    const bodyLines = sourceLines.slice(
      bodyStartLine,
      Math.min(bodyEndLine + 1, bodyStartLine + MAX_BODY_LINES)
    );

    // ── Truncation marker ──
    const actualBodyLines = bodyEndLine - bodyStartLine + 1;
    const wasTruncated = actualBodyLines > MAX_BODY_LINES;
    const truncationNote = wasTruncated
      ? [
          `// ... ${actualBodyLines - MAX_BODY_LINES} more lines — use contextforge_retrieve for full body`,
        ]
      : [];

    const bodyText = [...signatureLines, ...bodyLines, ...truncationNote].join("\n").trimEnd();

    nodes.push({
      name: raw.name,
      kind,
      startLine,
      endLine,
      isExported: raw.is_exported || false,
      isAsync: raw.is_async || false,
      complexity: raw.complexity || 0,
      bodyText,
    });

    if (raw.is_exported) {
      edges.push({
        targetSymbol: raw.name,
        targetFile: filePath,
        sourceSymbol: null,
        relation: "exports",
      });
    }
  }

  // ── G1 FIX: Synthesize a virtual module-scope node for top-level scripts ──
  //
  // When Tree-Sitter finds 0 named nodes the file is a procedural top-level
  // script (like server.js — everything lives inside an anonymous callback).
  // Without a node to anchor from, extractCallEdges emits nothing and
  // show_callers returns "no callers found" for every function server.js calls.
  //
  // We synthesize one sentinel node:
  //   name:     __module_<basename>   e.g. __module_server
  //   kind:     "function"            so extractCallEdges will scan it
  //   bodyText: null                  ← NEVER store the full file body
  //                                      (would inject thousands of tokens)
  //
  // workspaceMapper.extractCallEdges detects bodyText=null and falls back
  // to scanning the entire source text instead of node.bodyText.
  if (nodes.length === 0 && source.length > 200 && source.includes("(")) {
    const baseName = path.basename(filePath, path.extname(filePath));
    nodes.push({
      name: `__module_${baseName}`,
      kind: "function",
      startLine: 0,
      endLine: sourceLines.length - 1,
      isExported: false,
      isAsync: false,
      complexity: 0,
      bodyText: null,
    });
  }

  const importEdges = extractImportEdges(source, language, filePath);
  edges.push(...importEdges);

  return { nodes, edges };
}

function mapNodeTypeToKind(nodeType, language) {
  const map = {
    // JavaScript/TypeScript
    function_declaration: "function",
    function_expression: "function",
    arrow_function: "arrow_function",
    method_definition: "method",
    generator_function: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    class_expression: "class",
    // ── KEY CHANGE: lexical/variable declarations map to "const" ──
    // but treesitterExtract will upgrade to "arrow_function" when
    // the value is a function. See the upgrade logic below.
    lexical_declaration: "const",
    variable_declaration: "const",
    assignment_expression: "const",
    pair: "const",
    internal_module: "namespace",
    export_statement: null,
    import_statement: "import",

    // Python
    function_definition: "function",
    async_function_definition: "function",
    class_definition: "class",
    decorated_definition: "function",
    assignment: "const",

    // Go
    function_declaration_go: "function",
    method_declaration: "method",
    type_declaration: "class",
    assignment_statement: "const",
    short_var_declaration: "const",
    func_literal: "function",

    // Rust
    function_item: "function",
    impl_item: "class",
    struct_item: "class",
    enum_item: "class",
    trait_item: "class",
    closure_expression: "arrow_function",

    // Java
    method_declaration: "method",
    class_declaration_java: "class",
    interface_declaration: "class",
    enum_declaration: "class",
    record_declaration: "class",
  };

  return map[nodeType] ?? null;
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
  go: [/import\s+"([^"]+)"/g, /"([\w./]+)"/g],
  rust: [/use\s+([\w:]+)::(\w+)/g, /use\s+([\w:]+)::\{([^}]+)\}/g],
  cpp: [/#include\s+"([^"]+)"/g, /#include\s+<([^>]+)>/g],
};

function extractImportEdges(source, language, filePath) {
  const edges = [];
  const lang = language === "typescript" || language === "tsx" ? "javascript" : language;
  const patterns = IMPORT_PATTERNS[lang] || IMPORT_PATTERNS.javascript;
  const fileDir = path.dirname(filePath);

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (lang === "javascript") {
        const symbolsStr = match[1];
        const importPath = match[2];

        const isRelative = importPath.startsWith(".") || importPath.startsWith("/");
        const targetFile = isRelative ? resolveImportPath(fileDir, importPath) : null;

        const symbols = symbolsStr
          .split(",")
          .map((s) => s.trim().split(" as ")[0].trim())
          .filter((s) => s && /^\w+$/.test(s));

        for (const sym of symbols) {
          edges.push({
            targetSymbol: sym,
            targetFile,
            sourceSymbol: null,
            relation: "imports",
          });
        }
      } else if (lang === "python") {
        const symbolsRaw = match[2] || match[1];
        const symbols = symbolsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && /^\w+$/.test(s));

        for (const sym of symbols) {
          edges.push({
            targetSymbol: sym,
            targetFile: null,
            sourceSymbol: null,
            relation: "imports",
          });
        }
      } else if (lang === "rust") {
        const pathStr = match[1];
        const symbols = match[2]
          ? match[2]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [pathStr.split("::").pop()];

        for (const sym of symbols) {
          edges.push({
            targetSymbol: sym,
            targetFile: null,
            sourceSymbol: null,
            relation: "imports",
          });
        }
      } else if (lang === "cpp") {
        const includePath = match[1];
        const targetFile = includePath.startsWith("/")
          ? includePath
          : resolveImportPath(fileDir, "./" + includePath);

        edges.push({
          targetSymbol: includePath,
          targetFile,
          sourceSymbol: null,
          relation: "imports",
        });
      }
    }
  }

  return edges;
}

function resolveImportPath(fromDir, importPath) {
  try {
    const clean = importPath.split("?")[0].split("#")[0];
    const hasExt = /\.\w{1,4}$/.test(clean);
    const withExt = hasExt ? clean : clean + ".js";
    return path.resolve(fromDir, withExt).replace(/\\/g, "/");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Regex extraction for C++/H files
// ─────────────────────────────────────────────

const CPP_PATTERNS = {
  function:
    /^(?!.*(?:if|for|while|switch|catch)\s*\()[\w:*&<>]+\s+(\w+)\s*\([^)]*\)\s*(?:const|override|noexcept)?\s*\{/gm,
  class: /^(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)\s+\w+)?/gm,
  namespace: /^namespace\s+(\w+)\s*\{/gm,
};

function regexExtract(source, filePath) {
  const nodes = [];
  const edges = [];
  const lines = source.split("\n");

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

  const MAX_BODY_LINES = 100;

  CPP_PATTERNS.function.lastIndex = 0;
  let match;
  while ((match = CPP_PATTERNS.function.exec(source)) !== null) {
    const name = match[1];
    const startLine = charToLine(match.index);
    const endLine = Math.min(startLine + 50, lines.length - 1);

    const bodyLines = lines.slice(startLine, Math.min(endLine + 1, startLine + MAX_BODY_LINES));
    const bodyText = bodyLines.join("\n").trimEnd();

    nodes.push({
      name,
      kind: "function",
      startLine,
      endLine,
      isExported: true,
      isAsync: false,
      complexity: 1,
      bodyText,
    });
  }

  CPP_PATTERNS.class.lastIndex = 0;
  while ((match = CPP_PATTERNS.class.exec(source)) !== null) {
    const name = match[1];
    const startLine = charToLine(match.index);
    const endLine = Math.min(startLine + 100, lines.length - 1);

    const bodyLines = lines.slice(startLine, Math.min(endLine + 1, startLine + MAX_BODY_LINES));
    const bodyText = bodyLines.join("\n").trimEnd();

    nodes.push({
      name,
      kind: "class",
      startLine,
      endLine,
      isExported: true,
      isAsync: false,
      complexity: 0,
      bodyText,
    });
  }

  const includeEdges = extractImportEdges(source, "cpp", filePath);
  edges.push(...includeEdges);

  return { nodes, edges };
}

// ─────────────────────────────────────────────
// Main export
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
