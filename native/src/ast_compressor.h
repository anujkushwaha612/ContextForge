#pragma once

#include <napi.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <functional>

// Forward declare tree-sitter types
// (tree-sitter is a C library — include its header directly)
extern "C"
{
#include "tree_sitter/api.h"

  // Language grammar entry points (one per vendored grammar)
  const TSLanguage *tree_sitter_javascript();
  const TSLanguage *tree_sitter_typescript();
  const TSLanguage *tree_sitter_tsx();
  const TSLanguage *tree_sitter_python();
  const TSLanguage *tree_sitter_go();
  const TSLanguage *tree_sitter_rust();
  const TSLanguage *tree_sitter_java();
}

namespace contextforge
{

  // ─────────────────────────────────────────────
  // Node metadata extracted from AST walk
  // ─────────────────────────────────────────────
  struct ASTNode
  {
    std::string type; // "function_declaration", "class_body", etc.
    uint32_t start_line;
    uint32_t end_line;
    uint32_t body_start_line; // first line of the BODY (after signature)
    uint32_t body_end_line;
    std::string name; // identifier name if extractable
    bool is_exported;
    bool is_async;
    bool has_error_handler; // contains try/catch
    int complexity;         // cyclomatic complexity estimate
    int depth;              // nesting depth in the tree
  };

  // ─────────────────────────────────────────────
  // Compression result returned to JS
  // ─────────────────────────────────────────────
  struct CompressionResult
  {
    std::string compressed_source;
    int original_lines;
    int compressed_lines;
    int nodes_found;
    int nodes_compressed;
    bool syntax_valid;
    std::string language_detected;
    std::vector<ASTNode> preserved_nodes;
    std::vector<ASTNode> compressed_nodes;
  };

  // ─────────────────────────────────────────────
  // Compression config (mirrors JS-side options)
  // ─────────────────────────────────────────────
  struct CompressorConfig
  {
    bool preserve_imports = true;
    bool preserve_signatures = true;
    bool preserve_type_annotations = true;
    bool preserve_error_handlers = true;
    bool preserve_decorators = true;
    bool preserve_exports = true;
    int max_body_lines = 4;           // lines to keep inside body
    int min_tokens_to_compress = 80;  // skip tiny functions
    int target_compression_rate = 20; // keep 20% of body lines
    bool extract_complexity = true;   // compute cyclomatic complexity
    bool vault_on_compress = true;    // emit vault markers
    // Docstring handling: 0=FULL, 1=FIRST_LINE, 2=REMOVE
    int docstring_mode = 1;
  };

  // ─────────────────────────────────────────────
  // Core compressor class
  // ─────────────────────────────────────────────
  class ASTCompressor
  {
  public:
    explicit ASTCompressor(const CompressorConfig &config = CompressorConfig{});
    ~ASTCompressor();

    // Main entry point
    CompressionResult compress(
        const std::string &source,
        const std::string &language_hint = "");

    // Detect language from source content + optional filename hint
    std::string detectLanguage(
        const std::string &source,
        const std::string &filename_hint = "");

    // Walk tree and extract all structural nodes
    std::vector<ASTNode> extractNodes(
        TSTree *tree,
        const std::string &source,
        const std::string &language);

    // Compute cyclomatic complexity for a subtree
    int computeComplexity(TSNode node, const std::string &source);

    // Check if a node is a signature-level construct
    bool isSignatureNode(const std::string &node_type, const std::string &lang);

    // Check if a node's body should be compressed
    bool shouldCompressBody(const ASTNode &node);

    // Build the compressed output string
    std::string buildCompressedSource(
        const std::string &source,
        const std::vector<ASTNode> &all_nodes,
        const std::vector<int> &lines_to_keep, // line indices (0-based)
        const std::string &language);

  private:
    void initGrammars();
    CompressorConfig config_;

    // Tree-sitter parser instance (one per compressor, reused)
    TSParser *parser_;

    // Grammar cache: language name → TSLanguage*
    std::unordered_map<std::string, const TSLanguage *> grammars_;

    // Recursively walk TSNode tree
    void walkNode(
        TSNode node,
        const std::string &source,
        const std::string &language,
        int depth,
        std::vector<ASTNode> &out_nodes);

    // Extract identifier name from a node
    std::string extractName(TSNode node, const std::string &source);

    // Get source slice for a node
    std::string getNodeText(TSNode node, const std::string &source);

    // Language-specific signature node types
    static const std::unordered_map<
        std::string,
        std::vector<std::string>>
        SIGNATURE_TYPES;

    // Complexity-contributing node types (branch points)
    static const std::unordered_map<
        std::string,
        std::vector<std::string>>
        COMPLEXITY_NODES;
  };

  // ─────────────────────────────────────────────
  // N-API wrapper — exposes ASTCompressor to JS
  // ─────────────────────────────────────────────
  class ASTCompressorNAPI : public Napi::ObjectWrap<ASTCompressorNAPI>
  {
  public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit ASTCompressorNAPI(const Napi::CallbackInfo &info);

  private:
    ASTCompressor compressor_;

    Napi::Value Compress(const Napi::CallbackInfo &info);
    Napi::Value DetectLanguage(const Napi::CallbackInfo &info);
    Napi::Value ExtractNodes(const Napi::CallbackInfo &info);

    // Convert CompressionResult → JS object
    static Napi::Object ResultToJS(
        Napi::Env env,
        const CompressionResult &result);

    // Convert ASTNode → JS object
    static Napi::Object NodeToJS(
        Napi::Env env,
        const ASTNode &node);
  };

} // namespace contextforge