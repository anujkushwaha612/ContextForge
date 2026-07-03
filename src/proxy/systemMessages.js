/**
 * systemMessages.js
 *
 * Fixes applied:
 *   SM-1: TOOL_GUIDANCE evaluated once at module load.
 *   SM-2: CF_SENTINEL changed to "[CF_INJECTED_RULE]".
 *   SM-3: hasPatchTool check removed.
 *   SM-4: Skills pruning finds END of list before cutting.
 *   SM-5: charsSaved uses original content length.
 *
 *   SM-6: Removed "You may use native Read for initial file discovery" —
 *         Read is stripped from tools. Telling LLM to use it wastes a turn.
 *
 *   SM-7: Added explicit 3-step workflow so LLM does not improvise
 *         exploration strategy. Eliminates Glob→Shell→Read→patch failure chain.
 *
 *   SM-8: Added Glob guidance — always exclude node_modules, prefer
 *         contextforge_query_graph for project exploration.
 *
 *   SM-9: PATCH_GUIDANCE rewritten to teach correct workflow instead of
 *         only warning. LLM now knows the replacement before it tries Edit.
 *
 *   SM-10: Tool name reference table added so LLM never typos MCP names.
 */

import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const CF_SENTINEL = "[CF_INJECTED_RULE]";

const CF_NOTICE =
  "[CF_INJECTED_RULE]\n\nYou are operating behind ContextForge. " +
  "File contents may be structurally compressed to save context. " +
  "You have access to ContextForge's native repository intelligence tools via MCP.";

const SKILLS_PHRASE = "The following skills are available for use with the Skill tool:";

// SM-6 FIX: Removed "You may use native Read for initial file discovery."
// SM-7 FIX: Added explicit 3-step mandatory workflow.
// SM-8 FIX: Added Glob node_modules exclusion guidance.
// SM-11 FIX (this pass): Guidance no longer claims Write is unavailable —
//          server.js strips only Edit/Read/Update/NotebookEdit. Lying about
//          tool availability teaches the model to distrust the guidance.
// SM-12 FIX (this pass): F5 alignment — patch results carry an authoritative
//          `diff`; the workflow now says NOT to re-read to verify. This is
//          what converts the observed 3-6 verification round-trips per
//          session into zero.
// SM-13 FIX: TOOL_GUIDANCE/PATCH_GUIDANCE were hardcoded to the
//          `mcp__contextforge__` name prefix unconditionally. That's only
//          correct when the client discovers these tools via MCP (mcp/bridge.js).
//          server.js's GRAPH_INJECT stage can ALSO inject the tools directly
//          under their BARE names (contextforge_query_graph, etc.) for
//          non-MCP clients — and when it does, this guidance was still
//          telling the model to call the mcp__-prefixed name, which does not
//          exist in that request's tools array. Reproduced: the model
//          correctly reported "the tools I have access to don't include
//          contextforge_query_graph" because the guidance lied about the
//          actual tool name available to it.
//
// Fix: build BOTH variants once at module load (preserving the original
// SM-1 intent of not recomputing per request — there are only two possible
// shapes, not one per request) and select the correct one per request based
// on which naming convention is actually present in payload.tools.
function buildToolGuidance(prefix) {
  return process.env.CF_NUDGE_TOOLS === "1"
    ? `\n\n## ContextForge Mandatory Workflow

You MUST follow this exact sequence for every file modification task:

**Step 1 — Symbol Discovery (ALWAYS first)**
Call \`${prefix}contextforge_query_graph\` with \`find_symbol\` 
to locate the exact function/class before reading any file.
Never call Glob, Bash, or PowerShell to explore — the graph already 
indexes all source files and excludes node_modules automatically.

**Step 2 — Targeted Read (only if needed)**
Call \`${prefix}read_file_chunk\` with the exact line range 
from Step 1. Never read more than you need.
Do NOT use native Read — it is not available.

**Step 3 — Surgical Edit**
Call \`${prefix}contextforge_patch_ast\` to apply the change.
- For CREATING new files → use operation='create_file' with new_body set to the full file content.
Do NOT use native Edit — it is not available.

**Step 4 — Trust the result (do NOT re-read)**
Every successful patch returns a \`diff\` field showing the exact change 
applied to disk. The diff is authoritative. Do NOT call read_file_chunk 
just to verify a patch — only read again if you need surrounding context 
for a DIFFERENT edit.

## ContextForge Tool Reference

| Task | Tool to use |
|------|-------------|
| Find a function/class | \`${prefix}contextforge_query_graph\` (find_symbol) |
| Find all callers | \`${prefix}contextforge_query_graph\` (analyze_impact) |
| List file exports | \`${prefix}contextforge_query_graph\` (what_does_this_export) |
| Find text/literals/env vars | \`${prefix}contextforge_query_graph\` (find) — results include the matching source line |
| Read specific lines | \`${prefix}read_file_chunk\` |
| Edit any file | \`${prefix}contextforge_patch_ast\` |
| Create a new file | \`${prefix}contextforge_patch_ast\` (create_file) |
| Retrieve compressed content | \`${prefix}contextforge_retrieve\` |

## Glob Rules (when you must use Glob)
- ALWAYS exclude node_modules: use ignore pattern \`**/node_modules/**\`
- Prefer \`${prefix}contextforge_query_graph\` over Glob — 
  it only returns source files and is pre-indexed.
- Never run PowerShell or Bash just to list files.`
    : "";
}

// SM-9 FIX: Rewritten to teach correct workflow, not just warn.
// SM-11: softened — in non-nudge mode native Edit IS available; the advice
// is preference (CF patching survives compressed content), not a ban.
// SM-13 FIX: same prefix parameterization as buildToolGuidance above.
function buildPatchGuidance(prefix) {
  return process.env.CF_NUDGE_TOOLS !== "1"
    ? `\n\n## ContextForge Edit Workflow (recommended)

The native Edit tool uses strict whitespace matching and will fail on 
compressed file content ([CF_COMPRESSED_FILE] or [CF_VAULT:...]). 
Preferred workflow:

1. Find the symbol: \`${prefix}contextforge_query_graph\` (find_symbol)
2. Read exact lines: \`${prefix}read_file_chunk\`  
3. Apply the patch: \`${prefix}contextforge_patch_ast\` — its result 
   includes an authoritative \`diff\`; no re-read needed to verify.

If you see compressed content, retrieve the full source first with 
\`${prefix}contextforge_retrieve\` before using native Edit on it.`
    : "";
}

const MCP_PREFIX = "mcp__contextforge__";
const BARE_PREFIX = "";

// SM-13 FIX: both variants precomputed once at module load (same spirit as
// the original SM-1 fix — avoid rebuilding these strings per request).
const CF_RULE_MCP = CF_NOTICE + buildToolGuidance(MCP_PREFIX) + buildPatchGuidance(MCP_PREFIX);
const CF_RULE_BARE = CF_NOTICE + buildToolGuidance(BARE_PREFIX) + buildPatchGuidance(BARE_PREFIX);

// SM-13 FIX: bare-name tool-name constants used to detect which naming
// convention is actually present in a given request's tools array.
const BARE_TOOL_NAMES = [
  "contextforge_query_graph",
  "contextforge_patch_ast",
  "read_file_chunk",
  "contextforge_retrieve",
];

/**
 * SM-13 FIX: Determine whether payload.tools carries the tools under their
 * mcp__contextforge__-prefixed names (MCP-discovered) or their bare names
 * (server.js's direct GRAPH_INJECT-stage injection for non-MCP clients).
 * Mirrors the isGraphToolCall/isPatchToolCall/isReadFileChunkTool alias
 * checks in graphTools.js/patchTools.js, kept independent here since
 * systemMessages.js should not gain a dependency on the graph/patch modules
 * just to pick a guidance string.
 *
 * Ordering note: server.js runs STAGES.DEDUPLICATE (which calls
 * injectContextForgeRule) BEFORE STAGES.GRAPH_INJECT (where bare-named
 * tools actually get added to payload.tools for non-MCP clients). That
 * means on a non-MCP session's FIRST turn, payload.tools contains no
 * ContextForge tool yet at the point this function runs — the bare names
 * are injected later in the same request. An MCP session, by contrast,
 * ALWAYS arrives with mcp__-prefixed tools already present in payload.tools
 * from turn 1 onward, because Claude Code includes its full MCP-discovered
 * tool list on every request once registered.
 *
 * So the correct default when no ContextForge tool is present yet is BARE
 * naming, not MCP — the absence of mcp__-prefixed tools is itself the
 * signal that this is (or will be, this same request) a non-MCP session.
 */
function usesMcpToolNames(payload) {
  if (!Array.isArray(payload.tools)) return false;
  for (const t of payload.tools) {
    const name = t.name || t.function?.name;
    if (!name) continue;
    if (name.startsWith(MCP_PREFIX)) return true;
    if (BARE_TOOL_NAMES.includes(name)) return false;
  }
  return false; // no ContextForge tool present yet — default to bare naming
}


// ─────────────────────────────────────────────
// injectContextForgeRule
// ─────────────────────────────────────────────

export function injectContextForgeRule(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  // SM-13 FIX: pick the guidance variant matching the tool names actually
  // present (or about to be injected this same request) for this client.
  const cfRule = usesMcpToolNames(payload) ? CF_RULE_MCP : CF_RULE_BARE;

  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i];

    if (msg.role !== "system") continue;
    if (typeof msg.content !== "string") continue;

    if (msg.content.includes(CF_SENTINEL)) return payload;

    const newMessages = [...payload.messages];
    newMessages[i] = {
      ...msg,
      content: msg.content + cfRule,
    };

    return { ...payload, messages: newMessages };
  }

  return {
    ...payload,
    messages: [{ role: "system", content: cfRule.trim() }, ...payload.messages],
  };
}

// ─────────────────────────────────────────────
// deduplicateSystemMessages
// ─────────────────────────────────────────────

export function deduplicateSystemMessages(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const systemMessages = payload.messages.filter((m) => m.role === "system");

  if (systemMessages.length <= 1) return payload;

  const seenSystemPrompts = new Set();
  let prunedCount = 0;
  let charsSaved = 0;

  const newMessages = [];

  for (const msg of payload.messages) {
    if (msg.role !== "system" || typeof msg.content !== "string") {
      newMessages.push(msg);
      continue;
    }

    const originalLength = msg.content.length;
    let content = msg.content;

    if (content.includes(SKILLS_PHRASE)) {
      const startIdx = content.indexOf(SKILLS_PHRASE);
      const searchFrom = startIdx + SKILLS_PHRASE.length;

      const endPattern = /\n\n(?=[A-Z\n])/;
      const relativeEnd = content.slice(searchFrom).search(endPattern);
      const endIdx = relativeEnd === -1 ? content.length : searchFrom + relativeEnd;

      const before = content.slice(0, startIdx).trim();
      const after = content.slice(endIdx).trim();
      const replacement = "[ContextForge: Repetitive skills list removed to save tokens]";

      const cleanContent =
        after.length > 0 ? `${before}\n${replacement}\n${after}` : `${before}\n${replacement}`;

      if (cleanContent.length < content.length) {
        charsSaved += content.length - cleanContent.length;
        prunedCount++;
        content = cleanContent;
      }
    }

    const promptHash = crypto.createHash("sha256").update(content).digest("hex");

    if (seenSystemPrompts.has(promptHash)) {
      charsSaved += originalLength;
      prunedCount++;
      continue;
    }

    seenSystemPrompts.add(promptHash);

    if (content !== msg.content) {
      newMessages.push({ ...msg, content });
    } else {
      newMessages.push(msg);
    }
  }

  if (prunedCount > 0) {
    const tokensSaved = Math.floor(charsSaved / 4);
    payload._cf_sysPromptTokensSaved = tokensSaved;
  }

  return { ...payload, messages: newMessages };
}
