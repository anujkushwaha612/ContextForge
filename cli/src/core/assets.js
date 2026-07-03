/**
 * core/assets.js
 *
 * Model asset management: download, sha256 verification, manifest.
 * Node port of scripts/setup-onnx.sh so `npx contextforge` works with
 * zero shell dependencies (no bash/curl/wget needed on Windows).
 *
 * Guarantees:
 *   - atomic: .tmp → verify → rename; a corrupt file never gets the final name
 *   - idempotent: verified files are skipped
 *   - manifest: .manifest.json records versions+hashes for `cf doctor`
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { modelsDir } from "./paths.js";
import { CFError } from "../ui/errors.js";

export const MODEL_MANIFEST_VERSION = 1;

// Pinned assets. sha256 values verified against Hugging Face LFS metadata.
// NOTE: Xenova model_quantized.onnx is the true int8 export (23 MB).
//       optimum/.../model.onnx is fp32 (91 MB) — do not use.
export const ASSETS = [
  {
    name: "all-MiniLM-L6-v2-int8.onnx",
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx",
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    size: 22972370,
    label: "ONNX embedding model (int8, ~23 MB)",
  },
  {
    name: "tokenizer.json",
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    size: 711661,
    label: "Tokenizer (~700 KB)",
  },
];

async function sha256File(file) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  await pipeline(createReadStream(file), new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); cb(); },
  }));
  return hash.digest("hex");
}

/** Verify a single asset on disk. Returns { ok, reason }. */
export async function verifyAsset(asset, dir = modelsDir()) {
  const file = path.join(dir, asset.name);
  if (!existsSync(file)) return { ok: false, reason: "missing" };
  const st = await stat(file);
  if (st.size !== asset.size) return { ok: false, reason: `size mismatch (${st.size} ≠ ${asset.size})` };
  const got = await sha256File(file);
  if (got !== asset.sha256) return { ok: false, reason: "sha256 mismatch" };
  return { ok: true };
}

async function downloadAsset(asset, dir, onProgress) {
  const dest = path.join(dir, asset.name);
  const tmp = `${dest}.tmp`;

  const res = await fetch(asset.url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new CFError("CF_ERR_MODEL_DOWNLOAD",
      `Download failed for ${asset.name}: HTTP ${res.status}`,
      "Check your network/proxy settings and retry. Corporate proxies may block huggingface.co.");
  }

  const total = Number(res.headers.get("content-length")) || asset.size;
  let received = 0;
  const hash = createHash("sha256");

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      onProgress?.(received, total);
      cb(null, chunk);
    },
  });

  try {
    const { Readable } = await import("node:stream");
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp));

    const got = hash.digest("hex");
    if (got !== asset.sha256) {
      await unlink(tmp).catch(() => {});
      throw new CFError("CF_ERR_MODEL_CHECKSUM",
        `Checksum mismatch for ${asset.name}\n  expected: ${asset.sha256}\n  got:      ${got}`,
        "The download may be corrupted or intercepted. Run `cf doctor --fix` to retry.");
    }
    await rename(tmp, dest); // atomic
  } catch (err) {
    await unlink(tmp).catch(() => {});
    if (err instanceof CFError) throw err;
    throw new CFError("CF_ERR_MODEL_DOWNLOAD",
      `Download failed for ${asset.name}: ${err.message}`,
      "Check your network and retry with `cf setup`.");
  }
}

async function writeManifest(dir) {
  const manifest = {
    manifestVersion: MODEL_MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    assets: ASSETS.map(({ name, sha256, size, url }) => ({ name, sha256, size, url })),
  };
  await writeFile(path.join(dir, ".manifest.json"), JSON.stringify(manifest, null, 2));
}

/**
 * Ensure all model assets exist and are valid.
 * @returns {Promise<{downloaded: string[], skipped: string[]}>}
 */
export async function ensureModels({ dir = modelsDir(), force = false, onEvent } = {}) {
  await mkdir(dir, { recursive: true });
  const downloaded = [], skipped = [];

  for (const asset of ASSETS) {
    if (!force) {
      const v = await verifyAsset(asset, dir);
      if (v.ok) {
        skipped.push(asset.name);
        onEvent?.({ type: "skip", asset });
        continue;
      }
      if (v.reason !== "missing") onEvent?.({ type: "invalid", asset, reason: v.reason });
    }
    onEvent?.({ type: "start", asset });
    await downloadAsset(asset, dir, (received, total) =>
      onEvent?.({ type: "progress", asset, received, total }));
    onEvent?.({ type: "done", asset });
    downloaded.push(asset.name);
  }

  await writeManifest(dir);
  return { downloaded, skipped };
}

/** Full status for doctor: per-asset verification results. */
export async function modelStatus(dir = modelsDir()) {
  const results = [];
  for (const asset of ASSETS) {
    results.push({ asset, ...(await verifyAsset(asset, dir)) });
  }
  return results;
}
