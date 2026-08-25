import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeFilePathForDedup,
  applySemanticDedup,
} from "../../src/compression/semanticDedup.js";
import { applyCCRPipeline } from "../../src/ccr/index.js";
import { scanForMarkers } from "../../src/ccr/toolInjection.js";
import { payloadHasVaultMarker } from "../../src/proxy/stableTools.js";
import { countTokens } from "../../src/compression/compressionHelper.js";
import {
  cachedResultIsAlreadyVisible,
  compactAgedGhostGraphResults,
} from "../../src/proxy/upstreamRequest.js";

const WINDOWS_WORKSPACE =
  "D:/NODE JS/Building RESTful CRUD APIs with Express.js/02_making-file-storage-app-in-express/server";

function graphCall(id, queryType, target) {
  return {
    id,
    type: "function",
    function: {
      name: "contextforge_query_graph",
      arguments: JSON.stringify({ query_type: queryType, target }),
    },
  };
}

test("semantic dedup canonicalizes target-workspace absolute and relative paths together", () => {
  const previous = process.env.CF_WORKSPACE_PATH;
  process.env.CF_WORKSPACE_PATH = WINDOWS_WORKSPACE;
  try {
    assert.equal(
      normalizeFilePathForDedup(`${WINDOWS_WORKSPACE}/controllers/file.controller.js`),
      "controllers/file.controller.js"
    );
    assert.equal(
      normalizeFilePathForDedup("controllers/file.controller.js"),
      "controllers/file.controller.js"
    );
    assert.equal(
      normalizeFilePathForDedup(
        "D:\\NODE JS\\Building RESTful CRUD APIs with Express.js\\02_making-file-storage-app-in-express\\server\\controllers\\file.controller.js"
      ),
      "controllers/file.controller.js"
    );
  } finally {
    if (previous === undefined) delete process.env.CF_WORKSPACE_PATH;
    else process.env.CF_WORKSPACE_PATH = previous;
  }
});

test("dedup placeholders do not create retrievable-vault work", () => {
  const legacyDedup =
    "[CF_VAULT:cf_vault_abc123] (identical to the current copy of this file shown later)";
  const realCompressed =
    '[CF_COMPRESSED_FILE vault_id:"cf_vault_real123"]\nUse contextforge_retrieve if needed.';

  assert.deepEqual(scanForMarkers([{ role: "tool", content: legacyDedup }]), []);
  assert.deepEqual(
    scanForMarkers([
      {
        role: "tool",
        content: "[CF_VAULT:cf_vault_oldnear] (outdated copy — 95% similar to the current version)",
      },
    ]),
    []
  );
  assert.deepEqual(scanForMarkers([{ role: "tool", content: "[CF_SUPERSEDED] stale copy" }]), []);
  assert.deepEqual(scanForMarkers([{ role: "tool", content: realCompressed }]), [
    "cf_vault_real123",
  ]);

  assert.equal(
    payloadHasVaultMarker({ messages: [{ role: "tool", content: legacyDedup }] }),
    false
  );
  assert.equal(
    payloadHasVaultMarker({ messages: [{ role: "tool", content: realCompressed }] }),
    true
  );
  assert.equal(
    payloadHasVaultMarker({
      messages: [{ role: "user", content: `Please explain ${realCompressed}` }],
    }),
    false
  );
  assert.deepEqual(
    scanForMarkers([{ role: "user", content: `Please explain ${realCompressed}` }]),
    []
  );
});

test("CCR does not inject retrieve for a dedup-only history", () => {
  const payload = {
    messages: [
      { role: "user", content: "dedup-only CCR test" },
      {
        role: "tool",
        tool_call_id: "old_copy",
        name: "read_file_chunk",
        content:
          "[CF_VAULT:cf_vault_abc123] (identical to the current copy of this file shown later)",
      },
    ],
    tools: [],
  };

  const result = applyCCRPipeline(payload, Infinity);
  assert.equal(result.tools.length, 0);
  assert.equal(result._sessionId, undefined);
});

test("semantic dedup replaces old duplicates with non-retrievable visible-copy stubs", async () => {
  const previous = process.env.CF_WORKSPACE_PATH;
  process.env.CF_WORKSPACE_PATH = WINDOWS_WORKSPACE;
  try {
    const source = "export const shared = { enabled: true };\n".repeat(40);
    const payload = {
      __policy: { dedupEnabled: true, recentTurnExemption: 0 },
      messages: [
        {
          role: "tool",
          tool_call_id: "old_relative",
          name: "read_file_chunk",
          content: source,
          _cf_type: "code",
          _args: { file_path: "controllers/file.controller.js" },
        },
        {
          role: "tool",
          tool_call_id: "new_absolute",
          name: "read_file_chunk",
          content: source,
          _cf_type: "code",
          _args: { file_path: `${WINDOWS_WORKSPACE}/controllers/file.controller.js` },
        },
      ],
    };

    await applySemanticDedup(payload);
    assert.match(payload.messages[0].content, /^\[CF_DEDUPLICATED\]/);
    assert.equal(payload.messages[1].content, source);
    assert.deepEqual(scanForMarkers(payload.messages), []);
  } finally {
    if (previous === undefined) delete process.env.CF_WORKSPACE_PATH;
    else process.env.CF_WORKSPACE_PATH = previous;
  }
});

test("a cache hit is recognized as already visible before another full result is appended", () => {
  const args = JSON.stringify({ query_type: "find_symbol", target: "inviteWithEmail" });
  const result = JSON.stringify({ symbol: "inviteWithEmail", definitions: [] });
  const payload = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "prior_call",
            type: "function",
            function: { name: "contextforge_query_graph", arguments: args },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "prior_call",
        name: "contextforge_query_graph",
        content: result,
      },
    ],
  };

  assert.equal(
    cachedResultIsAlreadyVisible(payload, "contextforge_query_graph", args, result),
    true
  );
  assert.equal(
    cachedResultIsAlreadyVisible(payload, "contextforge_query_graph", args, result + " changed"),
    false
  );
});

test("ghost history retains recent graph rounds while compacting aged locator output", () => {
  const long = JSON.stringify({ results: "locator result ".repeat(80) });
  const payload = {
    messages: [
      {
        role: "assistant",
        tool_calls: [graphCall("round_1", "find", "sharedWith")],
      },
      { role: "tool", tool_call_id: "round_1", name: "contextforge_query_graph", content: long },
      {
        role: "assistant",
        tool_calls: [graphCall("round_2", "find_symbol", "inviteWithEmail")],
      },
      { role: "tool", tool_call_id: "round_2", name: "contextforge_query_graph", content: long },
      {
        role: "assistant",
        tool_calls: [graphCall("round_3", "read_function", "inviteWithEmail")],
      },
      { role: "tool", tool_call_id: "round_3", name: "contextforge_query_graph", content: long },
      {
        role: "assistant",
        tool_calls: [graphCall("round_4", "find", "inviteValidator")],
      },
      { role: "tool", tool_call_id: "round_4", name: "contextforge_query_graph", content: long },
    ],
  };

  const tokensBefore = countTokens(payload);
  compactAgedGhostGraphResults(payload);
  const tokensAfter = countTokens(payload);
  assert.ok(tokensAfter < tokensBefore);
  assert.match(payload.messages[1].content, /^\[CF_GRAPH_HISTORY\]/);
  assert.equal(payload.messages[3].content, long);
  // read_function bodies are deliberately never compacted by locator history cleanup.
  assert.equal(payload.messages[5].content, long);
  assert.equal(payload.messages[7].content, long);
});
