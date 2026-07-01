#pragma once

#include <napi.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <functional>

extern "C" {
#include "tree_sitter/api.h"

    const TSLanguage* tree_sitter_javascript();
    const TSLanguage* tree_sitter_typescript();
    const TSLanguage* tree_sitter_tsx();
    const TSLanguage* tree_sitter_python();
    const TSLanguage* tree_sitter_go();
    const TSLanguage* tree_sitter_rust();
    const TSLanguage* tree_sitter_java();
}

namespace contextforge {

// ─────────────────────────────────────────────
// ASTNode — metadata extracted from one AST node
// ─────────────────────────────────────────────
struct ASTNode {
    std::string type;
    uint32_t    start_line;
    uint32_t    end_line;
    uint32_t    body_start_line;
    uint32_t    body_end_line;
    std::string name;
    bool        is_exported;
    bool        is_async;
    bool        has_error_handler;
    int         complexity;
    int         depth;
    std::string initializer_type;
};

// ─────────────────────────────────────────────
// CompressionResult — returned to JS
// ─────────────────────────────────────────────
struct CompressionResult {
    std::string          compressed_source;
    int                  original_lines;
    int                  compressed_lines;
    int                  nodes_found;
    int                  nodes_compressed;
    bool                 syntax_valid;
    std::string          language_detected;
    std::vector<ASTNode> preserved_nodes;
    std::vector<ASTNode> compressed_nodes;
};

// ─────────────────────────────────────────────
// CompressorConfig
//
// Fields that are actually consumed by the pipeline:
//   extract_complexity       — compute cyclomatic complexity (wired up: UN-2 fix)
//   max_body_lines           — body lines kept before compression marker
//   min_tokens_to_compress   — skip tiny functions
//   preserve_error_handlers  — keep try/catch bodies
//   vault_on_compress        — emit vault marker in compression comment
//
// Removed:
//   docstring_mode           — set in old NAPI constructor but never read in C++
//   target_compression_rate  — defined but never used
// ─────────────────────────────────────────────
struct CompressorConfig {
    bool preserve_imports          = true;
    bool preserve_signatures       = true;
    bool preserve_type_annotations = true;
    bool preserve_error_handlers   = true;
    bool preserve_decorators       = true;
    bool preserve_exports          = true;
    int  max_body_lines            = 4;
    int  min_tokens_to_compress    = 80;
    bool extract_complexity        = true;   // UN-2: wired up in NAPI constructor
    bool vault_on_compress         = true;
    // docstring_mode removed — was set but never read anywhere in C++
};

// ─────────────────────────────────────────────
// ASTCompressor — core C++ class
// ─────────────────────────────────────────────
class ASTCompressor {
public:
    explicit ASTCompressor(const CompressorConfig& config = CompressorConfig{});
    ~ASTCompressor();

    CompressionResult compress(
        const std::string& source,
        const std::string& language_hint = "");

    std::string detectLanguage(
        const std::string& source,
        const std::string& filename_hint = "");

    std::vector<ASTNode> extractNodes(
        TSTree*             tree,
        const std::string&  source,
        const std::string&  language);

    int  computeComplexity(TSNode node, const std::string& source);
    bool isSignatureNode(const std::string& node_type, const std::string& lang);
    bool shouldCompressBody(const ASTNode& node);

    std::string buildCompressedSource(
        const std::string&          source,
        const std::vector<ASTNode>& all_nodes,
        const std::vector<int>&     lines_to_keep,
        const std::string&          language);

private:
    void initGrammars();

    CompressorConfig config_;
    TSParser*        parser_;

    std::unordered_map<std::string, const TSLanguage*> grammars_;

    void walkNode(
        TSNode               node,
        const std::string&   source,
        const std::string&   language,
        int                  depth,
        std::vector<ASTNode>& out_nodes);

    TSNode findBodyNode(TSNode node);

    std::string extractName(TSNode node, const std::string& source);

    // AC-2: depth parameter with default — explicit at call sites in .cpp
    std::string extractInitializerType(TSNode node, int depth = 0);

    std::string getNodeText(TSNode node, const std::string& source);

    // SIGNATURE_TYPES: node type → kept in compressed output
    static const std::unordered_map<std::string, std::vector<std::string>>
        SIGNATURE_TYPES;

    // COMPLEXITY_NODES removed — was defined but never read.
    // computeComplexity uses its own internal BRANCH_TYPES static vector.
};

// ─────────────────────────────────────────────
// N-API wrapper
// ─────────────────────────────────────────────
class ASTCompressorNAPI : public Napi::ObjectWrap<ASTCompressorNAPI> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit ASTCompressorNAPI(const Napi::CallbackInfo& info);

private:
    ASTCompressor compressor_;

    Napi::Value Compress(const Napi::CallbackInfo& info);
    Napi::Value DetectLanguage(const Napi::CallbackInfo& info);
    Napi::Value ExtractNodes(const Napi::CallbackInfo& info);

    static Napi::Object ResultToJS(Napi::Env env, const CompressionResult& result);
    static Napi::Object NodeToJS(Napi::Env env, const ASTNode& node);
};

} // namespace contextforge