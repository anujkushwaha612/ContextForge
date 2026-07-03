/**
 * core/native.js
 *
 * Native addon resolution + diagnostics.
 * v1 target: prebuilds via node-gyp-build (prebuilds/<platform>-<arch>/).
 * Current dev reality: node-gyp local build at native/build/Release/.
 * This module checks both and reports which one would load.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root relative to cli/src/core/ — adjust if CLI moves to its own package. */
export function repoRoot() {
  return process.env.CF_REPO_ROOT || path.resolve(__dirname, "../../..");
}

export function platformTriple() {
  return `${process.platform}-${process.arch}`;
}

export function candidatePaths() {
  const root = repoRoot();
  return [
    // CI prebuilds: .node + libonnxruntime side by side (rpath $ORIGIN/@loader_path)
    { kind: "prebuild", p: path.join(root, "prebuilds", platformTriple(), "contextforge_native.node") },
    { kind: "local-gyp", p: path.join(root, "native", "build", "Release", "contextforge_native.node") },
  ];
}

/**
 * Diagnose the native addon without crashing the CLI.
 * @returns {{ ok: boolean, kind?: string, path?: string, error?: string, hint?: string }}
 */
export function diagnoseNative({ smokeTest = false } = {}) {
  const candidates = candidatePaths();
  const found = candidates.find((c) => existsSync(c.p));

  if (!found) {
    return {
      ok: false,
      error: `No native addon found for ${platformTriple()}`,
      searched: candidates.map((c) => c.p),
      hint:
        "Run `npm run build:native` (requires C++ toolchain: node-gyp, python3, make/g++ " +
        "or MSVC Build Tools on Windows). v1 will ship prebuilds so users never see this.",
    };
  }

  try {
    const mod = require(found.p);
    const exported = Object.keys(mod);
    const expected = ["OnnxEmbedder", "PersistentMemoryStore", "SemanticCache", "HybridRetriever"];
    const missing = expected.filter((e) => !exported.includes(e));
    if (missing.length) {
      return {
        ok: false, kind: found.kind, path: found.p,
        error: `Addon loaded but missing exports: ${missing.join(", ")}`,
        hint: "The binary is stale — rebuild with `npm run build:native`.",
      };
    }
    return { ok: true, kind: found.kind, path: found.p, exports: exported, smokeTested: false };
  } catch (err) {
    return {
      ok: false, kind: found.kind, path: found.p,
      error: `Addon exists but failed to load: ${err.message}`,
      hint:
        "Usually an ABI mismatch (built against a different Node version) or missing shared " +
        "libs (onnxruntime). Rebuild with `npm run build:native` on this Node version.",
    };
  }
}

/**
 * Full smoke test: load addon, construct embedder, embed one string.
 * Only call when models are verified present (doctor step 4).
 */
export async function smokeTestEmbedder(modelDir) {
  const diag = diagnoseNative();
  if (!diag.ok) return { ok: false, error: diag.error };
  try {
    const native = require(diag.path);
    const embedder = new native.OnnxEmbedder(
      path.join(modelDir, "all-MiniLM-L6-v2-int8.onnx"),
      path.join(modelDir, "tokenizer.json"),
      { dim: 384, cacheSize: 8, batchWaitMs: 1 }
    );
    const vec = await embedder.embed("warmup");
    const len = vec?.length ?? vec?.byteLength ?? 0;
    if (len !== 384 && len !== 384 * 4) {
      return { ok: false, error: `Embedder returned ${len} dims, expected 384` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Embedder smoke test failed: ${err.message}` };
  }
}
