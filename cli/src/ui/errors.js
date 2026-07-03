/**
 * ui/errors.js — CFError convention + exit codes.
 * Every user-facing failure carries { code, message, hint }.
 * No raw stack traces unless --verbose.
 */

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  ENV: 10,      // missing native prebuild / model download failed
  PROXY: 11,    // proxy failed to start / health timeout
  PORT: 12,     // port conflict with unmanaged process
  AGENT: 13,    // agent binary not found
};

const CODE_TO_EXIT = {
  CF_ERR_NATIVE_LOAD: EXIT.ENV,
  CF_ERR_MODEL_DOWNLOAD: EXIT.ENV,
  CF_ERR_MODEL_CHECKSUM: EXIT.ENV,
  CF_ERR_MODEL_MISSING: EXIT.ENV,
  CF_ERR_CONFIG_KEY: EXIT.USAGE,
  CF_ERR_CONFIG_VALUE: EXIT.USAGE,
  CF_ERR_CONFIG_PARSE: EXIT.USAGE,
  CF_ERR_PROXY_START: EXIT.PROXY,
  CF_ERR_PROXY_HEALTH: EXIT.PROXY,
  CF_ERR_PORT_CONFLICT: EXIT.PORT,
  CF_ERR_AGENT_NOT_FOUND: EXIT.AGENT,
};

export class CFError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.name = "CFError";
    this.code = code;
    this.hint = hint;
  }
  get exitCode() {
    return CODE_TO_EXIT[this.code] ?? EXIT.ERROR;
  }
}

export function handleFatal(err, { verbose = false, json = false } = {}) {
  if (json) {
    console.error(JSON.stringify({
      error: err.code ?? "CF_ERR_UNKNOWN",
      message: err.message,
      hint: err.hint ?? null,
    }));
  } else if (err instanceof CFError) {
    console.error(`\n  ✖ ${err.message}   [${err.code}]`);
    if (err.hint) console.error(`  → ${err.hint}`);
    if (verbose && err.stack) console.error(`\n${err.stack}`);
  } else {
    console.error(`\n  ✖ Unexpected error: ${err.message}`);
    console.error(`  → Run \`cf doctor\` and file an issue with the output.`);
    if (verbose && err.stack) console.error(`\n${err.stack}`);
  }
  process.exit(err instanceof CFError ? err.exitCode : EXIT.ERROR);
}
