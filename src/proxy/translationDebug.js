// src/proxy/translationDebug.js

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = path.join(__dirname, "../../debug_translation");

let _requestCount = 0;

export function debugTranslation({
  requestId,
  rawAnthropicPayload,
  translatedOpenAIPayload,
  clientAdapterName,
  originResult,
  planResult,
}) {
  if (process.env.CF_DEBUG_TRANSLATION !== "1") return;

  try {
    mkdirSync(DEBUG_DIR, { recursive: true });

    const count    = String(++_requestCount).padStart(3, "0");
    const ts       = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${count}_${ts}.json`;

    const entry = {
      requestId,
      timestamp:  new Date().toISOString(),
      origin:     originResult,
      plan:       planResult ? {
        intent:       planResult.intent,
        method:       planResult.method,
        capabilities: planResult.capabilities ? [...planResult.capabilities] : [],
        bypass:       planResult.bypass,
      } : null,

      // ── What Claude Code sent (Anthropic format) ──
      anthropic: {
        model:    rawAnthropicPayload.model,
        stream:   rawAnthropicPayload.stream,
        system:   rawAnthropicPayload.system,
        messageCount: rawAnthropicPayload.messages?.length,
        toolCount:    rawAnthropicPayload.tools?.length ?? 0,
        messages: rawAnthropicPayload.messages?.map(summariseMessage),
        tools:    rawAnthropicPayload.tools?.map(t => t.name || t.function?.name),
      },

      // ── What we forwarded to Ollama (OpenAI format) ──
      openai: {
        model:    translatedOpenAIPayload.model,
        stream:   translatedOpenAIPayload.stream,
        messageCount: translatedOpenAIPayload.messages?.length,
        toolCount:    translatedOpenAIPayload.tools?.length ?? 0,
        messages: translatedOpenAIPayload.messages?.map(summariseMessage),
        tools:    translatedOpenAIPayload.tools?.map(t => t.name || t.function?.name),
      },
    };

    writeFileSync(
      path.join(DEBUG_DIR, filename),
      JSON.stringify(entry, null, 2),
      "utf-8"
    );
  } catch (err) {
    console.error("[TranslationDebug] Failed to write:", err.message);
  }
}

// ── Summarise a message without dumping full content ──
function summariseMessage(msg) {
  const base = {
    role:          msg.role,
    contentType:   typeof msg.content,
    contentLength: typeof msg.content === "string"
      ? msg.content.length
      : Array.isArray(msg.content)
        ? `${msg.content.length} blocks`
        : "null",
  };

  // Show block types for array content
  if (Array.isArray(msg.content)) {
    base.blocks = msg.content.map(b => ({
      type:    b.type,
      length:  typeof b.text === "string" ? b.text.length
             : typeof b.content === "string" ? b.content.length
             : 0,
    }));
  }

  // Show first 200 chars of string content
  if (typeof msg.content === "string") {
    base.preview = msg.content.slice(0, 200);
  }

  // Tool calls summary
  if (Array.isArray(msg.tool_calls)) {
    base.tool_calls = msg.tool_calls.map(tc => ({
      id:   tc.id,
      name: tc.function?.name,
      argsLength: tc.function?.arguments?.length ?? 0,
    }));
  }

  // Tool result info
  if (msg.tool_call_id) {
    base.tool_call_id = msg.tool_call_id;
    base.name         = msg.name;
  }

  // ContextForge metadata flags
  const cfFlags = {};
  if (msg._cf_type)     cfFlags.cf_type     = msg._cf_type;
  if (msg._cf_editable) cfFlags.cf_editable = msg._cf_editable;
  if (msg._cf_pruned)   cfFlags.cf_pruned   = msg._cf_pruned;
  if (msg._cf_deduped)  cfFlags.cf_deduped  = msg._cf_deduped;
  if (msg._filename)    cfFlags.filename     = msg._filename;
  if (Object.keys(cfFlags).length > 0) base.cfFlags = cfFlags;

  return base;
}