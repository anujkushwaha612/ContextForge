/**
 * cf logs [-f] [-n <lines>] — show/tail logs of the managed proxy.
 * Falls back to the newest log file if no proxy is running.
 */

import { readFileSync, readdirSync, statSync, watchFile, unwatchFile } from "node:fs";
import path from "node:path";
import { logsDir } from "../core/paths.js";
import { findRunningProxy } from "../core/daemon.js";
import { warn, info, dim } from "../ui/output.js";

function newestLog() {
  try {
    const files = readdirSync(logsDir())
      .filter((f) => f.endsWith(".log"))
      .map((f) => path.join(logsDir(), f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch { return null; }
}

export async function logs(opts = {}) {
  const running = await findRunningProxy();
  const file = running?.logFile ?? newestLog();
  if (!file) { warn("No log files found. Start a proxy first: `cf start`"); return; }

  const n = Number(opts.lines ?? 50);
  info(dim(file));

  let size = 0;
  try {
    const content = readFileSync(file, "utf8");
    size = Buffer.byteLength(content);
    console.log(content.trim().split(/\r?\n/).slice(-n).join("\n"));
  } catch (err) {
    warn(`Cannot read ${file}: ${err.message}`);
    return;
  }

  if (!opts.follow) return;

  // Simple poll-based follow (portable; no native fs.watch quirks).
  watchFile(file, { interval: 300 }, () => {
    try {
      const buf = readFileSync(file);
      if (buf.length > size) {
        process.stdout.write(buf.subarray(size).toString("utf8"));
        size = buf.length;
      }
    } catch { /* rotated/removed */ }
  });
  process.on("SIGINT", () => { unwatchFile(file); process.exit(0); });
}
