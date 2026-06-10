// src/mcp/health.js
// Post-registration health check — verifies the server actually starts
// Headroom has no equivalent — this is a ContextForge advantage

import { spawn }   from "node:child_process";
import http        from "node:http";

const HEALTH_TIMEOUT_MS = 5000;

/**
 * Verify the proxy is reachable after MCP registration.
 * Returns { ok: boolean, latencyMs: number, error?: string }
 */
export async function checkProxyHealth(proxyUrl = "http://127.0.0.1:3000") {
  const start = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok:        false,
        latencyMs: Date.now() - start,
        error:     `Timeout after ${HEALTH_TIMEOUT_MS}ms`,
      });
    }, HEALTH_TIMEOUT_MS);

    const req = http.request(
      `${proxyUrl}/v1/cache/reset`,
      { method: "POST", headers: { "Content-Length": "0" } },
      (res) => {
        clearTimeout(timer);
        resolve({
          ok:        res.statusCode < 500,
          latencyMs: Date.now() - start,
          statusCode: res.statusCode,
        });
      },
    );

    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok:        false,
        latencyMs: Date.now() - start,
        error:     err.message,
      });
    });

    req.end();
  });
}

/**
 * Check that the registered command actually resolves to a binary.
 */
export async function checkCommandExists(command) {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`which "${command}" 2>/dev/null || where "${command}" 2>nul`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}