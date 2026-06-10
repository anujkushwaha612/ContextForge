// src/mcp/base.js
// Abstract base — matches headroom's interface exactly

export const RegisterStatus = Object.freeze({
  REGISTERED:   "registered",
  ALREADY:      "already",
  MISMATCH:     "mismatch",
  FAILED:       "failed",
  NOT_DETECTED: "not_detected",
});

export class ServerSpec {
  constructor({ name, command, args = [], env = {} }) {
    this.name    = name;
    this.command = command;
    this.args    = args;
    this.env     = env;
  }
}

export class RegisterResult {
  constructor(status, detail = null) {
    this.status = status;
    this.detail = detail;
  }

  get ok() {
    return (
      this.status === RegisterStatus.REGISTERED ||
      this.status === RegisterStatus.ALREADY
    );
  }
}

export class MCPRegistrar {
  // Subclasses set these as static properties
  static agentName    = "";
  static displayName  = "";

  /** @returns {boolean} */
  detect() { throw new Error("detect() not implemented"); }

  /** @returns {ServerSpec|null} */
  getServer(serverName) { throw new Error("getServer() not implemented"); }

  /** @returns {RegisterResult} */
  registerServer(spec, { force = false } = {}) {
    throw new Error("registerServer() not implemented");
  }

  /** @returns {boolean} */
  unregisterServer(serverName) {
    throw new Error("unregisterServer() not implemented");
  }
}