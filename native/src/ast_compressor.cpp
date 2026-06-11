#include "ast_compressor.h"
#include <sstream>
#include <algorithm>
#include <regex>
#include <set>
#include <cstring>
#include <stdexcept>

namespace contextforge {

// ─────────────────────────────────────────────
// Static lookup tables
// ─────────────────────────────────────────────

// Node types that represent "signature-level" constructs per language.
// These are ALWAYS preserved in the compressed output.
const std::unordered_map<std::string, std::vector<std::string>>
ASTCompressor::SIGNATURE_TYPES = {
  {"javascript", {
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "class_expression",
    "generator_function_declaration",
    "async_function_declaration",
    "export_statement",
    "import_declaration",
    "import_statement",
    "lexical_declaration",      // const/let at module level
    "variable_declaration",     // var at module level
    "expression_statement",     // module.exports = ...
  }},
  {"typescript", {
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "method_signature",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "ambient_declaration",
    "export_statement",
    "import_declaration",
    "decorator",
    "abstract_class_declaration",
    "lexical_declaration",
    "variable_declaration",
  }},
  {"python", {
    "function_definition",
    "async_function_definition",
    "class_definition",
    "decorated_definition",
    "import_statement",
    "import_from_statement",
    "assignment",               // module-level constants
    "expression_statement",
  }},
  {"go", {
    "function_declaration",
    "method_declaration",
    "type_declaration",
    "import_declaration",
    "const_declaration",
    "var_declaration",
    "short_var_declaration",
  }},
  {"rust", {
    "function_item",
    "impl_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "use_declaration",
    "mod_item",
    "const_item",
    "type_item",
    "macro_definition",
  }},
  {"java", {
    "method_declaration",
    "class_declaration",
    "interface_declaration",
    "import_declaration",
    "field_declaration",
    "constructor_declaration",
    "annotation_type_declaration",
    "enum_declaration",
  }},
};

// Node types that add +1 to cyclomatic complexity
const std::unordered_map<std::string, std::vector<std::string>>
ASTCompressor::COMPLEXITY_NODES = {
  {"javascript", {
    "if_statement", "else_clause", "for_statement", "for_in_statement",
    "for_of_statement", "while_statement", "do_statement",
    "switch_case", "catch_clause", "ternary_expression",
    "logical_expression",  // && and || each add a branch
    "optional_chain",      // ?. is a conditional
  }},
  {"typescript", {
    "if_statement", "else_clause", "for_statement", "for_in_statement",
    "for_of_statement", "while_statement", "do_statement",
    "switch_case", "catch_clause", "ternary_expression",
    "logical_expression", "optional_chain",
  }},
  {"python", {
    "if_statement", "elif_clause", "for_statement", "while_statement",
    "try_statement", "except_clause", "with_statement",
    "conditional_expression", "boolean_operator",
  }},
  {"go", {
    "if_statement", "for_statement", "range_clause", "type_switch_statement",
    "select_statement", "case_clause", "communication_case",
  }},
  {"rust", {
    "if_expression", "if_let_expression", "while_expression",
    "while_let_expression", "for_expression", "loop_expression",
    "match_arm", "closure_expression",
  }},
};

// ─────────────────────────────────────────────
// Constructor / Destructor
// ─────────────────────────────────────────────

ASTCompressor::ASTCompressor(const CompressorConfig& config)
  : config_(config), parser_(nullptr) {
  parser_ = ts_parser_new();
  if (!parser_) {
    throw std::runtime_error("[ASTCompressor] Failed to create tree-sitter parser");
  }
  initGrammars();
}

ASTCompressor::~ASTCompressor() {
  if (parser_) {
    ts_parser_delete(parser_);
    parser_ = nullptr;
  }
}

void ASTCompressor::initGrammars() {
  grammars_["javascript"]  = tree_sitter_javascript();
  grammars_["typescript"]  = tree_sitter_typescript();
  grammars_["tsx"]         = tree_sitter_tsx();
  grammars_["python"]      = tree_sitter_python();
  grammars_["go"]          = tree_sitter_go();
  grammars_["rust"]        = tree_sitter_rust();
  grammars_["java"]        = tree_sitter_java();
}

// ─────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────

std::string ASTCompressor::detectLanguage(
  const std::string& source,
  const std::string& filename_hint
) {
  // 1. Filename extension wins
  if (!filename_hint.empty()) {
    auto ext_pos = filename_hint.rfind('.');
    if (ext_pos != std::string::npos) {
      std::string ext = filename_hint.substr(ext_pos + 1);
      std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
      if (ext == "js" || ext == "mjs" || ext == "cjs") return "javascript";
      if (ext == "ts")  return "typescript";
      if (ext == "tsx") return "tsx";
      if (ext == "jsx") return "javascript";
      if (ext == "py")  return "python";
      if (ext == "go")  return "go";
      if (ext == "rs")  return "rust";
      if (ext == "java") return "java";
      if (ext == "cpp" || ext == "cc" || ext == "cxx") return "cpp";
    }
  }

  // 2. Content heuristics — scored voting system
  std::unordered_map<std::string, int> scores;

  // Python signals
  if (source.find("def ") != std::string::npos) scores["python"] += 3;
  if (source.find("import ") != std::string::npos &&
      source.find("from ") != std::string::npos) scores["python"] += 2;
  if (source.find("self.") != std::string::npos) scores["python"] += 2;
  if (source.find("__init__") != std::string::npos) scores["python"] += 3;
  if (source.find("print(") != std::string::npos) scores["python"] += 1;
  if (source.find("elif ") != std::string::npos) scores["python"] += 3;
  if (source.find("    ") != std::string::npos &&
      source.find("{") == std::string::npos) scores["python"] += 1;

  // TypeScript signals (check before JS)
  if (source.find(": string") != std::string::npos) scores["typescript"] += 3;
  if (source.find(": number") != std::string::npos) scores["typescript"] += 3;
  if (source.find("interface ") != std::string::npos) scores["typescript"] += 4;
  if (source.find("type ") != std::string::npos &&
      source.find("=") != std::string::npos) scores["typescript"] += 2;
  if (source.find("<T>") != std::string::npos ||
      source.find("<T,") != std::string::npos) scores["typescript"] += 3;
  if (source.find("enum ") != std::string::npos) scores["typescript"] += 2;

  // JavaScript signals
  if (source.find("const ") != std::string::npos) scores["javascript"] += 1;
  if (source.find("=>") != std::string::npos) scores["javascript"] += 2;
  if (source.find("require(") != std::string::npos) scores["javascript"] += 3;
  if (source.find("module.exports") != std::string::npos) scores["javascript"] += 4;
  if (source.find("async function") != std::string::npos) scores["javascript"] += 2;

  // Go signals
  if (source.find("func ") != std::string::npos) scores["go"] += 3;
  if (source.find("package ") != std::string::npos) scores["go"] += 4;
  if (source.find(":=") != std::string::npos) scores["go"] += 3;
  if (source.find("goroutine") != std::string::npos) scores["go"] += 4;

  // Rust signals
  if (source.find("fn ") != std::string::npos) scores["rust"] += 3;
  if (source.find("let mut ") != std::string::npos) scores["rust"] += 4;
  if (source.find("impl ") != std::string::npos) scores["rust"] += 3;
  if (source.find("use std::") != std::string::npos) scores["rust"] += 4;
  if (source.find("->") != std::string::npos &&
      source.find("=>") == std::string::npos) scores["rust"] += 1;

  // Java signals
  if (source.find("public class") != std::string::npos) scores["java"] += 5;
  if (source.find("System.out") != std::string::npos) scores["java"] += 4;
  if (source.find("@Override") != std::string::npos) scores["java"] += 4;
  if (source.find("extends ") != std::string::npos &&
      source.find("class ") != std::string::npos) scores["java"] += 3;

  // Find highest score
  std::string best = "javascript"; // default
  int best_score = 0;
  for (const auto& [lang, score] : scores) {
    if (score > best_score) {
      best_score = score;
      best = lang;
    }
  }

  // TypeScript > JavaScript if scores are close
  if (best == "javascript" && scores.count("typescript") &&
      scores["typescript"] >= scores["javascript"] - 1) {
    best = "typescript";
  }

  return best;
}

// ─────────────────────────────────────────────
// Helper: get source text for a node
// ─────────────────────────────────────────────

std::string ASTCompressor::getNodeText(TSNode node, const std::string& source) {
  uint32_t start = ts_node_start_byte(node);
  uint32_t end   = ts_node_end_byte(node);
  if (start >= source.size() || end > source.size() || start >= end) {
    return "";
  }
  return source.substr(start, end - start);
}

// ─────────────────────────────────────────────
// Helper: extract identifier name from node
// ─────────────────────────────────────────────

std::string ASTCompressor::extractName(TSNode node, const std::string& source) {
  // Try to find a child named "name" or "identifier"
  uint32_t child_count = ts_node_named_child_count(node);
  for (uint32_t i = 0; i < child_count; i++) {
    TSNode child = ts_node_named_child(node, i);
    std::string child_type = ts_node_type(child);
    if (child_type == "identifier" || child_type == "property_identifier" ||
        child_type == "name") {
      return getNodeText(child, source);
    }
  }
  // Try field "name"
  TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
  if (!ts_node_is_null(name_node)) {
    return getNodeText(name_node, source);
  }
  return "";
}

// ─────────────────────────────────────────────
// Cyclomatic Complexity
// ─────────────────────────────────────────────

int ASTCompressor::computeComplexity(TSNode node, const std::string& source) {
  // Get language from parser (stored implicitly via grammar)
  // We pass language externally — here we check all known branch node types
  static const std::vector<std::string> BRANCH_TYPES = {
    "if_statement", "if_expression", "if_let_expression",
    "else_clause", "elif_clause",
    "for_statement", "for_in_statement", "for_of_statement",
    "for_expression", "range_clause",
    "while_statement", "while_expression", "while_let_expression",
    "do_statement", "loop_expression",
    "switch_case", "match_arm", "case_clause",
    "catch_clause", "except_clause",
    "ternary_expression", "conditional_expression",
    "logical_expression", "boolean_operator",
    "optional_chain",
    "with_statement",
    "select_statement", "communication_case",
  };

  int complexity = 1; // base complexity

  std::function<void(TSNode)> walk = [&](TSNode n) {
    std::string ntype = ts_node_type(n);
    for (const auto& bt : BRANCH_TYPES) {
      if (ntype == bt) {
        complexity++;
        break;
      }
    }
    // Special: && and || each add a branch
    if (ntype == "binary_expression" || ntype == "logical_expression") {
      std::string text = getNodeText(n, source);
      for (char c : text) {
        // rough: count && and ||
        if (text.find("&&") != std::string::npos ||
            text.find("||") != std::string::npos) {
          complexity++;
          break;
        }
      }
    }
    uint32_t count = ts_node_named_child_count(n);
    for (uint32_t i = 0; i < count; i++) {
      walk(ts_node_named_child(n, i));
    }
  };

  walk(node);
  return complexity;
}

// ─────────────────────────────────────────────
// isSignatureNode
// ─────────────────────────────────────────────

bool ASTCompressor::isSignatureNode(
  const std::string& node_type,
  const std::string& lang
) {
  auto it = SIGNATURE_TYPES.find(lang);
  if (it == SIGNATURE_TYPES.end()) {
    // Unknown language — be conservative, preserve everything
    return true;
  }
  const auto& types = it->second;
  return std::find(types.begin(), types.end(), node_type) != types.end();
}

// ─────────────────────────────────────────────
// shouldCompressBody
// ─────────────────────────────────────────────

bool ASTCompressor::shouldCompressBody(const ASTNode& node) {
  // Never compress tiny bodies
  int body_lines = (int)node.body_end_line - (int)node.body_start_line;
  if (body_lines <= config_.max_body_lines) return false;

  // Never compress error handlers if configured to preserve
  if (config_.preserve_error_handlers && node.has_error_handler) return false;

  // Compress if body is large enough to be worth it
  int token_estimate = body_lines * 8; // rough: 8 tokens per line
  return token_estimate >= config_.min_tokens_to_compress;
}

// ─────────────────────────────────────────────
// findBodyNode
//
// Recursively searches immediate children (and
// one level deeper for wrapped declarations) for
// a node that represents a function/class body.
//
// Handles:
//   function_declaration        → direct "body" field
//   arrow_function              → direct "body" field
//   lexical_declaration         → variable_declarator → arrow_function → body
//   export_statement            → class_declaration / function_declaration → body
//   method_definition           → direct "body" field
// ─────────────────────────────────────────────

TSNode ASTCompressor::findBodyNode(TSNode node) {
  // ── Try direct "body" field first (fastest path) ──
  TSNode direct = ts_node_child_by_field_name(node, "body", 4);
  if (!ts_node_is_null(direct)) return direct;

  // ── Walk immediate named children ──
  // Covers: lexical_declaration → variable_declarator → arrow_function
  //         export_statement → function_declaration / class_declaration
  uint32_t child_count = ts_node_named_child_count(node);
  for (uint32_t i = 0; i < child_count; i++) {
    TSNode child = ts_node_named_child(node, i);
    std::string child_type = ts_node_type(child);

    // If child itself has a body field — recurse one level
    TSNode child_body = ts_node_child_by_field_name(child, "body", 4);
    if (!ts_node_is_null(child_body)) return child_body;

    // variable_declarator → value field (the arrow_function / function_expression)
    TSNode value = ts_node_child_by_field_name(child, "value", 5);
    if (!ts_node_is_null(value)) {
      TSNode value_body = ts_node_child_by_field_name(value, "body", 4);
      if (!ts_node_is_null(value_body)) return value_body;
    }

    // export_statement wraps: check the declaration child
    if (child_type == "export_statement") {
      TSNode decl = ts_node_child_by_field_name(child, "declaration", 11);
      if (!ts_node_is_null(decl)) {
        TSNode decl_body = ts_node_child_by_field_name(decl, "body", 4);
        if (!ts_node_is_null(decl_body)) return decl_body;
      }
    }
  }

  // Nothing found
  return {}; // returns null node
}

// ─────────────────────────────────────────────
// walkNode — recursive AST traversal
// ─────────────────────────────────────────────

void ASTCompressor::walkNode(
  TSNode node,
  const std::string& source,
  const std::string& language,
  int depth,
  std::vector<ASTNode>& out_nodes
) {
  if (ts_node_is_null(node)) return;

  // Safety net against pathological inputs — raised from 4 to 12
  if (depth > 12) return;

  std::string ntype = ts_node_type(node);

  if (isSignatureNode(ntype, language)) {
    ASTNode anode;
    anode.type            = ntype;
    anode.depth           = depth;
    anode.is_exported     = false;
    anode.is_async        = false;
    anode.has_error_handler = false;
    anode.complexity      = 1;

    anode.start_line = ts_node_start_point(node).row;
    anode.end_line   = ts_node_end_point(node).row;

    // ── Only record nodes with meaningful size ──
    // Filters out single-line const declarations, tiny expressions, etc.
    // that would never qualify for body compression anyway.
    int node_lines = (int)(anode.end_line - anode.start_line);
    if (node_lines >= 2) {

      anode.name = extractName(node, source);

      TSNode body = findBodyNode(node);
        if (!ts_node_is_null(body)) {
          anode.body_start_line = ts_node_start_point(body).row;
          anode.body_end_line   = ts_node_end_point(body).row;
        } else {
          anode.body_start_line = anode.start_line;
          anode.body_end_line   = anode.end_line;
        }

      if (ntype.find("export") != std::string::npos) {
        anode.is_exported = true;
      }

      std::string node_text = getNodeText(node, source);
      if (node_text.find("async ") != std::string::npos) {
        anode.is_async = true;
      }

      std::function<bool(TSNode)> hasErrorHandler = [&](TSNode n) -> bool {
        std::string t = ts_node_type(n);
        if (t == "try_statement" || t == "catch_clause" ||
            t == "try_expression") return true;
        uint32_t c = ts_node_named_child_count(n);
        for (uint32_t i = 0; i < c; i++) {
          if (hasErrorHandler(ts_node_named_child(n, i))) return true;
        }
        return false;
      };

      if (!ts_node_is_null(body)) {
        anode.has_error_handler = hasErrorHandler(body);
      }

      if (config_.extract_complexity && !ts_node_is_null(body)) {
        anode.complexity = computeComplexity(body, source);
      }

      out_nodes.push_back(anode);
    }
    // ── Even if this node is too small to record, still recurse ──
    // A tiny arrow function wrapper may contain a large inner function
  }

  // Always recurse — depth gate above handles termination
  uint32_t child_count = ts_node_named_child_count(node);
  for (uint32_t i = 0; i < child_count; i++) {
    walkNode(ts_node_named_child(node, i), source, language, depth + 1, out_nodes);
  }
}

// ─────────────────────────────────────────────
// extractNodes — parse + walk
// ─────────────────────────────────────────────

std::vector<ASTNode> ASTCompressor::extractNodes(
  TSTree* tree,
  const std::string& source,
  const std::string& language
) {
  std::vector<ASTNode> nodes;
  TSNode root = ts_tree_root_node(tree);
  walkNode(root, source, language, 0, nodes);
  return nodes;
}

// ─────────────────────────────────────────────
// buildCompressedSource
// ─────────────────────────────────────────────

std::string ASTCompressor::buildCompressedSource(
  const std::string& source,
  const std::vector<ASTNode>& all_nodes,
  const std::vector<int>& lines_to_keep,
  const std::string& language
) {
  // Split source into lines
  std::vector<std::string> lines;
  std::istringstream ss(source);
  std::string line;
  while (std::getline(ss, line)) {
    lines.push_back(line);
  }

  // Build a set for O(1) lookup
  std::set<int> keep_set(lines_to_keep.begin(), lines_to_keep.end());

  // For each compressed body range, record [start, end] → compressed line count
  // Maps: body_start_line → (body_end_line, lines_kept_count)
  struct BodyRange {
    int end_line;
    int lines_removed;
    int complexity;
    std::string node_name;
  };
  std::unordered_map<int, BodyRange> compressed_bodies;

  for (const auto& node : all_nodes) {
    if (shouldCompressBody(node)) {
      int body_lines = (int)node.body_end_line - (int)node.body_start_line;
      int kept = std::min(config_.max_body_lines, body_lines);
      compressed_bodies[node.body_start_line] = {
        (int)node.body_end_line,
        body_lines - kept,
        node.complexity,
        node.name
      };
    }
  }

  // Build output
  std::ostringstream out;
  int i = 0;
  int total = (int)lines.size();

  while (i < total) {
    // Check if we're at the start of a compressed body
    auto it = compressed_bodies.find(i);
    if (it != compressed_bodies.end()) {
      const BodyRange& range = it->second;

      // Keep first max_body_lines lines of the body
      int keep_count = std::min(config_.max_body_lines, (int)(range.end_line - i));
      for (int k = 0; k < keep_count && i + k < total; k++) {
        out << lines[i + k] << "\n";
      }

      // Emit compression marker
      int removed = range.lines_removed;
      if (removed > 0) {
        // Compute indentation from first body line
        std::string indent = "";
        if (!lines[i].empty()) {
          for (char c : lines[i]) {
            if (c == ' ' || c == '\t') indent += c;
            else break;
          }
          // Add one extra indent level for the comment
          indent += "  ";
        }

        // Complexity hint in the marker (research feature)
        std::string complexity_hint = "";
        if (range.complexity > 5) {
          complexity_hint = " [complexity:" + std::to_string(range.complexity) + "]";
        }

        out << indent << "// ↓ " << removed << " lines compressed";
        if (!range.node_name.empty()) {
          out << " (" << range.node_name << ")";
        }
        out << complexity_hint;
        if (config_.vault_on_compress) {
          out << " · vault_retrieve to expand";
        }
        out << "\n";
      }

      // Skip to end of body
      i = range.end_line + 1;
      continue;
    }

    // Normal line — check if it should be kept
    if (keep_set.count(i) || compressed_bodies.empty()) {
      out << lines[i] << "\n";
    } else {
      // Check if this line is in any node range we decided to keep
      bool in_kept_range = false;
      for (const auto& node : all_nodes) {
        if (!shouldCompressBody(node) &&
            i >= (int)node.start_line && i <= (int)node.end_line) {
          in_kept_range = true;
          break;
        }
      }
      if (in_kept_range) {
        out << lines[i] << "\n";
      }
      // else: silently drop (compressed)
    }

    i++;
  }

  return out.str();
}

// ─────────────────────────────────────────────
// compress — main entry point
// ─────────────────────────────────────────────

CompressionResult ASTCompressor::compress(
  const std::string& source,
  const std::string& language_hint
) {
  CompressionResult result;
  result.original_lines    = 0;
  result.compressed_lines  = 0;
  result.nodes_found       = 0;
  result.nodes_compressed  = 0;
  result.syntax_valid      = false;

  if (source.empty()) return result;

  // Count original lines
  result.original_lines = (int)std::count(source.begin(), source.end(), '\n') + 1;

  // Detect language
  result.language_detected = language_hint.empty()
    ? detectLanguage(source)
    : language_hint;

  // Find grammar
  auto grammar_it = grammars_.find(result.language_detected);
  if (grammar_it == grammars_.end()) {
    // Unsupported language — return as-is
    result.compressed_source = source;
    result.compressed_lines  = result.original_lines;
    result.syntax_valid      = true;
    return result;
  }

  // Set language on parser
  if (!ts_parser_set_language(parser_, grammar_it->second)) {
    result.compressed_source = source;
    result.compressed_lines  = result.original_lines;
    return result;
  }

  // Parse
  TSTree* tree = ts_parser_parse_string(
    parser_, nullptr,
    source.c_str(), (uint32_t)source.size()
  );

  if (!tree) {
    result.compressed_source = source;
    return result;
  }

  // Check for parse errors
  TSNode root = ts_tree_root_node(tree);
  result.syntax_valid = !ts_node_has_error(root);

  // Extract structural nodes
  std::vector<ASTNode> nodes = extractNodes(tree, source, result.language_detected);
  result.nodes_found = (int)nodes.size();

  if (nodes.empty()) {
    ts_tree_delete(tree);
    result.compressed_source = source;
    result.compressed_lines  = result.original_lines;
    return result;
  }

  // Determine which lines to keep
  // Strategy: keep ALL signature lines, compress large bodies
  std::set<int> keep_lines_set;

  for (const auto& node : nodes) {
    if (!shouldCompressBody(node)) {
      // Keep the entire node
      result.preserved_nodes.push_back(node);
      for (int ln = (int)node.start_line; ln <= (int)node.end_line; ln++) {
        keep_lines_set.insert(ln);
      }
    } else {
      // Keep only signature (start to body_start) + first max_body_lines
      result.compressed_nodes.push_back(node);
      result.nodes_compressed++;

      // Signature lines
      for (int ln = (int)node.start_line; ln < (int)node.body_start_line; ln++) {
        keep_lines_set.insert(ln);
      }
      // First N body lines
      for (int ln = (int)node.body_start_line;
           ln < (int)node.body_start_line + config_.max_body_lines &&
           ln <= (int)node.end_line; ln++) {
        keep_lines_set.insert(ln);
      }
    }
  }

  std::vector<int> keep_lines(keep_lines_set.begin(), keep_lines_set.end());

  // Build compressed output
  result.compressed_source = buildCompressedSource(
    source, nodes, keep_lines, result.language_detected
  );

  result.compressed_lines = (int)std::count(
    result.compressed_source.begin(),
    result.compressed_source.end(), '\n'
  ) + 1;

  ts_tree_delete(tree);
  return result;
}

// ─────────────────────────────────────────────
// N-API WRAPPER
// ─────────────────────────────────────────────

Napi::Object ASTCompressorNAPI::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "ASTCompressor", {
    InstanceMethod("compress",       &ASTCompressorNAPI::Compress),
    InstanceMethod("detectLanguage", &ASTCompressorNAPI::DetectLanguage),
    InstanceMethod("extractNodes",   &ASTCompressorNAPI::ExtractNodes),
  });

  Napi::FunctionReference* constructor = new Napi::FunctionReference();
  *constructor = Napi::Persistent(func);
  env.SetInstanceData(constructor);

  exports.Set("ASTCompressor", func);
  return exports;
}

ASTCompressorNAPI::ASTCompressorNAPI(const Napi::CallbackInfo& info)
  : Napi::ObjectWrap<ASTCompressorNAPI>(info) {

  CompressorConfig cfg;

  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();

    auto getBool = [&](const char* key, bool def) -> bool {
      return opts.Has(key) ? opts.Get(key).ToBoolean().Value() : def;
    };
    auto getInt = [&](const char* key, int def) -> int {
      return opts.Has(key) ? opts.Get(key).ToNumber().Int32Value() : def;
    };

    cfg.preserve_imports          = getBool("preserveImports", true);
    cfg.preserve_signatures       = getBool("preserveSignatures", true);
    cfg.preserve_type_annotations = getBool("preserveTypeAnnotations", true);
    cfg.preserve_error_handlers   = getBool("preserveErrorHandlers", true);
    cfg.preserve_decorators       = getBool("preserveDecorators", true);
    cfg.max_body_lines            = getInt("maxBodyLines", 4);
    cfg.min_tokens_to_compress    = getInt("minTokensToCompress", 80);
    cfg.docstring_mode            = getInt("docstringMode", 1);
    cfg.vault_on_compress         = getBool("vaultOnCompress", true);
  }

  try {
    new (&compressor_) ASTCompressor(cfg);
  } catch (const std::exception& e) {
    Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
  }
}

// ─────────────────────────────────────────────
// JS-facing methods
// ─────────────────────────────────────────────

Napi::Value ASTCompressorNAPI::Compress(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "compress(source: string, languageHint?: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string source      = info[0].As<Napi::String>().Utf8Value();
  std::string lang_hint   = (info.Length() > 1 && info[1].IsString())
                            ? info[1].As<Napi::String>().Utf8Value()
                            : "";

  try {
    CompressionResult result = compressor_.compress(source, lang_hint);
    return ResultToJS(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value ASTCompressorNAPI::DetectLanguage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return Napi::String::New(env, "javascript");
  }
  std::string source = info[0].As<Napi::String>().Utf8Value();
  std::string hint   = (info.Length() > 1 && info[1].IsString())
                       ? info[1].As<Napi::String>().Utf8Value() : "";
  return Napi::String::New(env, compressor_.detectLanguage(source, hint));
}

Napi::Object ASTCompressorNAPI::NodeToJS(Napi::Env env, const ASTNode& node) {
  Napi::Object obj = Napi::Object::New(env);

  obj.Set("type",           Napi::String::New(env, node.type));
  obj.Set("name",           Napi::String::New(env, node.name));
  obj.Set("start_line",     Napi::Number::New(env, node.start_line));
  obj.Set("end_line",       Napi::Number::New(env, node.end_line));
  obj.Set("body_start_line",Napi::Number::New(env, node.body_start_line));
  obj.Set("body_end_line",  Napi::Number::New(env, node.body_end_line));
  obj.Set("is_exported",    Napi::Boolean::New(env, node.is_exported));
  obj.Set("is_async",       Napi::Boolean::New(env, node.is_async));
  obj.Set("complexity",     Napi::Number::New(env, node.complexity));
  obj.Set("depth",          Napi::Number::New(env, node.depth));
  obj.Set("has_error_handler", Napi::Boolean::New(env, node.has_error_handler));

  return obj;
}

Napi::Value ASTCompressorNAPI::ExtractNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "extractNodes(source: string, languageHint?: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string source    = info[0].As<Napi::String>().Utf8Value();
  std::string lang_hint = (info.Length() > 1 && info[1].IsString())
                          ? info[1].As<Napi::String>().Utf8Value()
                          : "";

  if (source.empty()) {
    return Napi::Array::New(env, 0);
  }

  try {
    // ── Detect language ──
    std::string language = lang_hint.empty()
      ? compressor_.detectLanguage(source)
      : lang_hint;

    // ── Find grammar ──
    // We need to parse — reuse the internal parser via compress()
    // but we only want the node list, not the compressed output.
    // Simplest approach: call compress() and return all nodes
    // (preserved + compressed) from the result.
    CompressionResult result = compressor_.compress(source, language);

    // ── Merge preserved + compressed nodes ──
    std::vector<ASTNode> all_nodes;
    all_nodes.reserve(
      result.preserved_nodes.size() + result.compressed_nodes.size()
    );
    for (const auto& n : result.preserved_nodes) {
      all_nodes.push_back(n);
    }
    for (const auto& n : result.compressed_nodes) {
      all_nodes.push_back(n);
    }

    // ── Sort by start_line so JS receives them in source order ──
    std::sort(all_nodes.begin(), all_nodes.end(),
      [](const ASTNode& a, const ASTNode& b) {
        return a.start_line < b.start_line;
      }
    );

    // ── Build JS array ──
    Napi::Array arr = Napi::Array::New(env, all_nodes.size());
    for (size_t i = 0; i < all_nodes.size(); i++) {
      arr.Set((uint32_t)i, NodeToJS(env, all_nodes[i]));
    }

    return arr;

  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─────────────────────────────────────────────
// Result → JS object conversion
// ─────────────────────────────────────────────

Napi::Object ASTCompressorNAPI::ResultToJS(
  Napi::Env env,
  const CompressionResult& r
) {
  Napi::Object obj = Napi::Object::New(env);

  obj.Set("compressedSource",   Napi::String::New(env, r.compressed_source));
  obj.Set("originalLines",      Napi::Number::New(env, r.original_lines));
  obj.Set("compressedLines",    Napi::Number::New(env, r.compressed_lines));
  obj.Set("nodesFound",         Napi::Number::New(env, r.nodes_found));
  obj.Set("nodesCompressed",    Napi::Number::New(env, r.nodes_compressed));
  obj.Set("syntaxValid",        Napi::Boolean::New(env, r.syntax_valid));
  obj.Set("languageDetected",   Napi::String::New(env, r.language_detected));

  // Compression ratio
  double ratio = r.original_lines > 0
    ? 1.0 - ((double)r.compressed_lines / r.original_lines)
    : 0.0;
  obj.Set("compressionRatio",   Napi::Number::New(env, ratio));

  // Preserved node names array
  Napi::Array preserved = Napi::Array::New(env, r.preserved_nodes.size());
  for (size_t i = 0; i < r.preserved_nodes.size(); i++) {
    preserved.Set(i, Napi::String::New(env, r.preserved_nodes[i].name));
  }
  obj.Set("preservedNodes", preserved);

  // Compressed node names array
  Napi::Array compressed = Napi::Array::New(env, r.compressed_nodes.size());
  for (size_t i = 0; i < r.compressed_nodes.size(); i++) {
    compressed.Set(i, Napi::String::New(env, r.compressed_nodes[i].name));
  }
  obj.Set("compressedNodes", compressed);

  // High-complexity nodes (research feature — surfaces to JS)
  Napi::Array highComplexity = Napi::Array::New(env);
  uint32_t hc_idx = 0;
  for (const auto& node : r.compressed_nodes) {
    if (node.complexity > 7) {
      Napi::Object n = Napi::Object::New(env);
      n.Set("name",       Napi::String::New(env, node.name));
      n.Set("complexity", Napi::Number::New(env, node.complexity));
      n.Set("startLine",  Napi::Number::New(env, node.start_line));
      n.Set("endLine",    Napi::Number::New(env, node.end_line));
      highComplexity.Set(hc_idx++, n);
    }
  }
  obj.Set("highComplexityNodes", highComplexity);

  return obj;
}

} // namespace contextforge