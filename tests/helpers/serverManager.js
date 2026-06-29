/**
 * ServerManager — starts and stops ContextForge programmatically for smoke tests.
 *
 * Uses Node.js child_process to spawn the server as a subprocess,
 * captures its stdout/stderr, and waits for the "ready" signal.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "../../src/server.js");
const READY_SIGNAL = "ContextForge Proxy routing engine active on port";
const STARTUP_TIMEOUT_MS = 20_000;

export class ServerManager {
  constructor(env = {}) {
    this._proc = null;
    this._env = env;
    this._port = env.CF_PORT || 3000;
    this._logs = [];
  }

  get port() { return this._port; }
  get logs() { return [...this._logs]; }

  async start() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Server did not start within ${STARTUP_TIMEOUT_MS}ms.\nLogs:\n${this._logs.join("\n")}`));
      }, STARTUP_TIMEOUT_MS);

      this._proc = spawn("node", [SERVER_ENTRY], {
        env: {
          ...process.env,
          ...this._env,
          // Always use test mode so dashboard adds test header
          CF_IS_TEST_ENV: "true",
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      const onData = (chunk) => {
        const text = chunk.toString();
        this._logs.push(text);

        if (text.includes(READY_SIGNAL)) {
          clearTimeout(timeout);
          // Small delay to ensure the HTTP server is fully bound
          setTimeout(() => resolve(), 200);
        }
      };

      this._proc.stdout.on("data", onData);
      this._proc.stderr.on("data", onData);

      this._proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn server: ${err.message}`));
      });

      this._proc.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}\nLogs:\n${this._logs.join("\n")}`));
        }
      });
    });
  }

  async stop() {
    if (this._proc) {
      this._proc.kill("SIGINT");
      await new Promise((resolve) => {
        this._proc.on("exit", resolve);
        // Force kill after 5 seconds if SIGINT doesn't work
        setTimeout(() => {
          this._proc?.kill("SIGKILL");
          resolve();
        }, 5000);
      });
      this._proc = null;
    }
  }

  /** Make a request to the running ContextForge server. */
  async request(path, body, headers = {}, method = "POST") {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : "";
      const options = {
        hostname: "127.0.0.1",
        port: this._port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          ...headers
        }
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk.toString(); });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
            json: () => {
              try { return JSON.parse(data); }
              catch { return null; }
            }
          });
        });
      });

      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  }

  /** Make a GET request to the running ContextForge server. */
  async get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "127.0.0.1",
        port: this._port,
        path,
        method: "GET",
        headers
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk.toString(); });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
            json: () => {
              try { return JSON.parse(data); }
              catch { return null; }
            }
          });
        });
      });

      req.on("error", reject);
      req.end();
    });
  }
}