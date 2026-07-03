{
    "targets": [
        {
            "target_name": "contextforge_native",
            "sources": [
                "src/addon.cpp",
                "src/simhash.cpp",
                "src/cache.cpp",
                "src/hybrid_retriever.cpp",
                "src/ast_compressor.cpp",
                "src/persistent_memory.cpp",
                "src/onnx_embedder.cpp",
                "src/embed_cache.cpp",

                "vendor/sqlite3/sqlite3.c",

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
                "vendor/sqlite3",
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
                "NODE_ADDON_API_DISABLE_DEPRECATED",
                "SQLITE_THREADSAFE=1",
                "SQLITE_OMIT_LOAD_EXTENSION"
            ],
            "cflags!":    ["-fno-exceptions"],
            "cflags_cc!": ["-fno-exceptions"],
            "cflags_cc":  ["-std=c++17"],
            "msvs_settings": {
                "VCCLCompilerTool": {"ExceptionHandling": 1}
            },
            "conditions": [
                ["OS=='win'", {
                    "libraries": [
                        "<(module_root_dir)/vendor/onnxruntime/lib/onnxruntime.lib"
                    ]
                }],

                ["OS=='mac'", {
                    "libraries": [
                        "<(module_root_dir)/vendor/onnxruntime/lib/libonnxruntime.dylib"
                    ],
                    "xcode_settings": {
                        "OTHER_LDFLAGS": [
                            "-Wl,-rpath,@loader_path",
                            "-Wl,-rpath,<(module_root_dir)/vendor/onnxruntime/lib"
                        ],
                        "MACOSX_DEPLOYMENT_TARGET": "11.0"
                    }
                }],

                ["OS=='linux'", {
                    "libraries": [
                        "<(module_root_dir)/vendor/onnxruntime/lib/libonnxruntime.so"
                    ],
                    "ldflags": [
                        "-Wl,-rpath,'$$ORIGIN'",
                        "-Wl,-rpath,<(module_root_dir)/vendor/onnxruntime/lib"
                    ]
                }]
            ]
        }
    ]
}
