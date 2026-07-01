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
const TOOL_GUIDANCE =
  process.env.CF_NUDGE_TOOLS === "1"
    ? `\n\n## ContextForge Mandatory Workflow

You MUST follow this exact sequence for every file modification task:

**Step 1 — Symbol Discovery (ALWAYS first)**
Call \`mcp__contextforge__contextforge_query_graph\` with \`find_symbol\` 
to locate the exact function/class before reading any file.
Never call Glob, Bash, or PowerShell to explore — the graph already 
indexes all source files and excludes node_modules automatically.

**Step 2 — Targeted Read (only if needed)**
Call \`mcp__contextforge__read_file_chunk\` with the exact line range 
from Step 1. Never read more than you need.
Do NOT use native Read — it is not available.

**Step 3 — Surgical Edit**
Call \`mcp__contextforge__contextforge_patch_ast\` to apply the change.
- For CREATING new files → use \`mcp__contextforge__contextforge_patch_ast\` with operation='create_file' and new_body set to the full file content.
Do NOT use native Edit or Write — they are not available.

## ContextForge Tool Reference

| Task | Tool to use |
|------|-------------|
| Find a function/class | \`mcp__contextforge__contextforge_query_graph\` (find_symbol) |
| Find all callers | \`mcp__contextforge__contextforge_query_graph\` (analyze_impact) |
| List file exports | \`mcp__contextforge__contextforge_query_graph\` (what_does_this_export) |
| Read specific lines | \`mcp__contextforge__read_file_chunk\` |
| Edit any file | \`mcp__contextforge__contextforge_patch_ast\` |
| Retrieve compressed content | \`mcp__contextforge__contextforge_retrieve\` |

## Glob Rules (when you must use Glob)
- ALWAYS exclude node_modules: use ignore pattern \`**/node_modules/**\`
- Prefer \`mcp__contextforge__contextforge_query_graph\` over Glob — 
  it only returns source files and is pre-indexed.
- Never run PowerShell or Bash just to list files.`
    : "";

// SM-9 FIX: Rewritten to teach correct workflow, not just warn.
const PATCH_GUIDANCE =
  process.env.CF_NUDGE_TOOLS !== "1"
    ? `\n\n## ContextForge Edit Workflow (CRITICAL)

The native Edit tool uses strict whitespace matching and will fail on 
compressed file content. Always use this workflow instead:

1. Find the symbol: \`mcp__contextforge__contextforge_query_graph\` (find_symbol)
2. Read exact lines: \`mcp__contextforge__read_file_chunk\`  
3. Apply the patch: \`mcp__contextforge__contextforge_patch_ast\`

Never call the native Edit tool. If you see compressed content 
([CF_COMPRESSED_FILE] or [CF_VAULT:...]), retrieve the full source 
first with \`mcp__contextforge__contextforge_retrieve\` before patching.`
    : "";

const CF_RULE = CF_NOTICE + TOOL_GUIDANCE + PATCH_GUIDANCE;

// ─────────────────────────────────────────────
// injectContextForgeRule
// ─────────────────────────────────────────────

export function injectContextForgeRule(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i];

    if (msg.role !== "system") continue;
    if (typeof msg.content !== "string") continue;

    if (msg.content.includes(CF_SENTINEL)) return payload;

    const newMessages = [...payload.messages];
    newMessages[i] = {
      ...msg,
      content: msg.content + CF_RULE,
    };

    return { ...payload, messages: newMessages };
  }

  return {
    ...payload,
    messages: [{ role: "system", content: CF_RULE.trim() }, ...payload.messages],
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
