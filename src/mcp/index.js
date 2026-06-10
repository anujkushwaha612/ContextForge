// src/mcp/index.js
export { MCPRegistrar, ServerSpec, RegisterResult, RegisterStatus } from "./base.js";
export { ClaudeRegistrar }   from "./registrars/claude.js";
export { CursorRegistrar }   from "./registrars/cursor.js";
export { WindsurfRegistrar } from "./registrars/windsurf.js";
export { CodexRegistrar } from "./registrars/codex.js";
export { GeminiCLIRegistrar } from "./registrars/gemini-cli.js";
export { formatResult, formatResults, anySucceeded } from "./display.js";
export {
  DEFAULT_PROXY_URL,
  buildContextForgeSpec,
  getAllRegistrars,
  installEverywhere,
  uninstallEverywhere,
} from "./install.js";
export { checkProxyHealth }  from "./health.js";
export { recordInstall, clearInstall, contextforgeInstalledMatching } from "./ledger.js";