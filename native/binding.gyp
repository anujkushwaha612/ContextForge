{
    "targets": [
        {
            "target_name": "contextforge_native",
            "sources": [
                "src/addon.cpp",
                "src/simhash.cpp",
                "src/sliding_window.cpp",
                "src/tfidf.cpp",
                "src/attention.cpp",
                "src/positional.cpp",
                "src/fidelity.cpp",
                "src/token_counter.cpp",
                "src/static_embed.cpp",
                "src/cache.cpp",
                "src/hybrid_retriever.cpp",
                "src/ast_compressor.cpp",
                "src/persistent_memory.cpp",
                "src/onnx_embedder.cpp",
                "src/embed_cache.cpp",
                "src/anomaly_scorer.cpp",

                "tree-sitter-src/tree-sitter/lib/src/lib.c",

                "tree-sitter-src/tree-sitter-javascript/src/parser.c",
                "tree-sitter-src/tree-sitter-javascript/src/scanner.c",

                "tree-sitter-src/tree-sitter-typescript/typescript/src/parser.c",
                "tree-sitter-src/tree-sitter-typescript/typescript/src/scanner.c",

                "tree-sitter-src/tree-sitter-typescript/tsx/src/parser.c",
                "tree-sitter-src/tree-sitter-typescript/tsx/src/scanner.c",

                "tree-sitter-src/tree-sitter-python/src/parser.c",
                "tree-sitter-src/tree-sitter-python/src/scanner.c",

                "tree-sitter-src/tree-sitter-go/src/parser.c",

                "tree-sitter-src/tree-sitter-rust/src/parser.c",
                "tree-sitter-src/tree-sitter-rust/src/scanner.c",

                "tree-sitter-src/tree-sitter-java/src/parser.c"
            ],
            "include_dirs": [
                "<!@(node -p \"require('node-addon-api').include\")",
                "src",
                "vendor/onnxruntime/include",
                "vendor/nlohmann",
                "tree-sitter-src/tree-sitter/lib/include",
                "tree-sitter-src/tree-sitter-javascript/src",
                "tree-sitter-src/tree-sitter-typescript/typescript/src",
                "tree-sitter-src/tree-sitter-typescript/tsx/src",
                "tree-sitter-src/tree-sitter-python/src",
                "tree-sitter-src/tree-sitter-go/src",
                "tree-sitter-src/tree-sitter-rust/src",
                "tree-sitter-src/tree-sitter-java/src"
            ],
            "dependencies": [
                "<!(node -p \"require('node-addon-api').gyp\")"
            ],
            "defines": [
                "NAPI_DISABLE_CPP_EXCEPTIONS",
                "NODE_ADDON_API_DISABLE_DEPRECATED"
            ],
            "cflags!":    ["-fno-exceptions"],
            "cflags_cc!": ["-fno-exceptions"],
            "cflags_cc":  ["-std=c++17"],
            "msvs_settings": {
                "VCCLCompilerTool": {"ExceptionHandling": 1}
            },
            "conditions": [
                ["OS=='linux' or OS=='mac'", {
                    "libraries": [
                        "-lsqlite3"
                    ]
                }],

                ["OS=='win'", {
                    "sources": [
                        "vendor/sqlite3/sqlite3.c"
                    ],
                    "include_dirs": [
                        "vendor/sqlite3"
                    ],
                    "libraries": [
                        "<(module_root_dir)/vendor/onnxruntime/lib/onnxruntime.lib"
                    ]
                }],

                ["OS=='mac'", {
                    "libraries": [
                        "<(module_root_dir)/vendor/onnxruntime/lib/libonnxruntime.dylib"
                    ]
                }],

                ["OS=='linux'", {
                    "libraries": [
                        "<(module_root_dir)/vendor/onnxruntime/lib/libonnxruntime.so"
                    ]
                }]
            ]
        }
    ]
}
