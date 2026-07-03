// src/mcp/index.js — updated for the trimmed agent set (claude, codex, gemini-cli)
//
// Changes:
//  - cursor/windsurf exports removed (matches your decision to defer them)
//  - formatResults + anySucceeded re-exported (cf mcp install reads them)
//  - NOTE: getAllRegistrars() is now ASYNC (defensive dynamic imports in
//    install.js) — callers must await it.

export { MCPRegistrar, ServerSpec, RegisterResult, RegisterStatus } from "./base.js";
export { ClaudeRegistrar }    from "./registrars/claude.js";
export { CodexRegistrar }     from "./registrars/codex.js";
export { GeminiCLIRegistrar } from "./registrars/gemini-cli.js";
export {
  DEFAULT_PROXY_URL,
  buildContextForgeSpec,
  getAllRegistrars,
  installEverywhere,
  uninstallEverywhere,
  formatResults,
  anySucceeded,
} from "./install.js";
export { recordInstall, clearInstall, contextforgeInstalledMatching, specFingerprint } from "./ledger.js";
