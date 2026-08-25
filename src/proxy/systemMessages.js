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
import { passesTokenGate } from "../compression/compressionHelper.js";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const CF_SENTINEL = "[CF_INJECTED_RULE]";

const CF_NOTICE_PREFIX =
  "[CF_INJECTED_RULE]\n\nYou are operating behind ContextForge. " +
  "File contents may be structurally compressed to save context. ";

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

function buildContextForgeRule({ mcpSession = true, toolPrefix = undefined } = {}) {
  const prefix = toolPrefix ?? (mcpSession ? MCP_PREFIX : BARE_PREFIX);
  const access = String(prefix).startsWith("mcp__")
    ? "You have access to ContextForge's native repository intelligence tools via MCP."
    : "You have access to ContextForge's native repository intelligence tools directly through this proxy.";
  return CF_NOTICE_PREFIX + access + buildToolGuidance(prefix) + buildPatchGuidance(prefix);
}

// Keep exported constants for native egress and existing consumers. The
// ingress injector chooses between them from the actual active session mode.
const CF_RULE = buildContextForgeRule({ mcpSession: true });
export const CF_RULE_BARE = buildContextForgeRule({ mcpSession: false });

export function getContextForgeRule({ mcpSession = false, toolPrefix = undefined } = {}) {
  if (toolPrefix !== undefined) {
    return buildContextForgeRule({ mcpSession, toolPrefix });
  }
  return mcpSession ? CF_RULE : CF_RULE_BARE;
}

// ─────────────────────────────────────────────
// injectContextForgeRule
// ─────────────────────────────────────────────

export function injectContextForgeRule(
  payload,
  { mcpSession = false, toolPrefix = undefined } = {}
) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const rule = getContextForgeRule({ mcpSession, toolPrefix });
  const alternateRules = [CF_RULE, CF_RULE_BARE].filter((candidate) => candidate !== rule);

  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i];

    if (msg.role !== "system") continue;
    if (typeof msg.content !== "string") continue;

    if (msg.content.includes(CF_SENTINEL)) {
      // A conversation can cross a transport boundary (for example, a direct
      // proxy call followed by an MCP-enabled client). Keep the one injected
      // rule but align its tool names with the active tool namespace instead
      // of preserving stale MCP aliases in a bare-tool session.
      const alternateRule = alternateRules.find((candidate) => msg.content.includes(candidate));
      if (alternateRule) {
        const newMessages = [...payload.messages];
        newMessages[i] = {
          ...msg,
          content: msg.content.replace(alternateRule, rule),
        };
        return { ...payload, messages: newMessages };
      }
      return payload;
    }

    const newMessages = [...payload.messages];
    newMessages[i] = {
      ...msg,
      content: msg.content + rule,
    };

    return { ...payload, messages: newMessages };
  }

  return {
    ...payload,
    messages: [{ role: "system", content: rule.trim() }, ...payload.messages],
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
        // A1 (headroom analysis): token-validation gate. The check above is
        // char-based; a SHORT skills list (few items, long skill names) can
        // be replaced by a placeholder that is actually LARGER in tokens.
        // Gate the removed region against the replacement before accepting.
        const removedRegion = content.slice(startIdx, endIdx);
        if (passesTokenGate(removedRegion, replacement)) {
          charsSaved += content.length - cleanContent.length;
          prunedCount++;
          content = cleanContent;
        }
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
