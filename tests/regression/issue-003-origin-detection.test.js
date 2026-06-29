// tests/regression/issue-003-origin-detection.test.js
//
// Regression suite for origin detection misclassifications.

import {
  detectMessageOrigin,
  requiresRepositoryWork,
  detectRecentToolActivity,
} from "../../src/proxy/messageOrigin.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const humanMsg = (text) => ({ role: "user", content: text });
const assistantText = (text) => ({ role: "assistant", content: text });

const assistantWithTool = (name = "read_file") => ({
  role: "assistant",
  content: [
    { type: "text", text: "Let me check." },
    { type: "tool_use", id: "tu_001", name, input: {} },
  ],
});

const toolResultMsg = (content = "result") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "tu_001", content }],
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #003a — role:"tool" not detected as tool activity
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #003a — Anthropic tool result format detection", () => {
  test("tool result as role:user with tool_result blocks → detected as tool activity", () => {
    const messages = [
      humanMsg("Rename authenticate."),
      assistantWithTool("read_file"),
      toolResultMsg("function authenticate() {}"),
      assistantText("I can see the function. Let me patch it."),
      humanMsg("Continue."),
    ];

    expect(detectRecentToolActivity(messages)).toBe(true);

    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("CONTINUATION");
  });

  test("role:tool (wrong format) is NOT detected — only role:user tool_result is", () => {
    const messages = [
      humanMsg("Do the thing."),
      { role: "tool", content: "some result" },
      humanMsg("Continue."),
    ];

    expect(detectRecentToolActivity(messages)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #003b — "Done." misclassified as HUMAN_TASK
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #003b — AGENT_STATUS detection with Anthropic content blocks", () => {
  test('short "ok" after pure assistant status → AGENT_STATUS', () => {
    const messages = [
      humanMsg("Rename the function."),
      assistantText("The patch was applied successfully."),
      humanMsg("ok"),
    ];
    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("AGENT_STATUS");
    expect(requiresRepositoryWork(result.origin)).toBe(false);
  });

  test("assistant with tool_use blocks is NOT a status message — tools stay active", () => {
    const messages = [
      humanMsg("Rename the function."),
      assistantWithTool("patch_file"),
      humanMsg("ok"),
    ];
    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("CONTINUATION");
    expect(requiresRepositoryWork(result.origin)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #003c — system-reminder harness causing misclassification
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #003c — system-reminder harness stripped before classification", () => {
  test("harness injection does not inflate current message text length", () => {
    const messages = [
      humanMsg("Rename authenticate."),
      assistantText("Done. The function has been renamed."),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>You are Claude Code. Remember to use tools.</system-reminder>\nok",
          },
        ],
      },
    ];
    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("AGENT_STATUS");
  });

  test("harness-only message (no real task text) → treated as empty user turn", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>You are Claude Code.</system-reminder>",
          },
        ],
      },
    ];
    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("HUMAN_TASK");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #003d — TOOL_FOLLOWUP must block tool re-injection
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #003d — TOOL_FOLLOWUP blocks tool re-injection", () => {
  test("current message is tool result → requiresRepositoryWork is false", () => {
    const messages = [
      humanMsg("Rename authenticate."),
      assistantWithTool("read_file"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_001",
            content: "function authenticate() { ... }",
          },
        ],
      },
    ];

    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("TOOL_FOLLOWUP");
    expect(requiresRepositoryWork(result.origin)).toBe(false);
  });

  test("multiple tool results in one message → still TOOL_FOLLOWUP", () => {
    const messages = [
      humanMsg("Do both tasks."),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_001", name: "read_file", input: {} },
          { type: "tool_use", id: "tu_002", name: "read_file", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_001", content: "result a" },
          { type: "tool_result", tool_use_id: "tu_002", content: "result b" },
        ],
      },
    ];

    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("TOOL_FOLLOWUP");
    expect(requiresRepositoryWork(result.origin)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #003e — Long coding task never misclassified as AGENT_STATUS
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #003e — substantive tasks not misclassified as AGENT_STATUS", () => {
  test("long task starting with status word → HUMAN_TASK (text length guard)", () => {
    // FIX: extractText calls .trim() on each content block before measuring
    // length. Space-padding gets stripped before the < 150 check runs,
    // making the padded text appear shorter than 150 chars.
    //
    // Solution: pad with real words (non-whitespace) so trim() cannot
    // remove them. We build a string that is GUARANTEED >= 150 visible chars
    // after trim by measuring the trimmed length explicitly.
    const base =
      "Updated the authentication module. Please now rename the verifyUser " +
      "function to authenticateUser in all files across the repository including tests.";

    // Pad with real words until trimmed length reaches 150
    let longTask = base;
    const extraWords = [
      "and", "also", "update", "the", "corresponding", "unit",
      "integration", "smoke", "regression", "test", "files", "too",
    ];
    let wordIdx = 0;
    while (longTask.trim().length < 150) {
      longTask += " " + extraWords[wordIdx % extraWords.length];
      wordIdx++;
    }

    // Confirm the guard holds AFTER trim — this is what extractText measures
    expect(longTask.trim().length).toBeGreaterThanOrEqual(150);

    // "Updated" matches AGENT_STATUS_PATTERNS — but text length >= 150
    // must prevent AGENT_STATUS from firing
    const messages = [
      humanMsg("Start working on auth."),
      assistantText("Done with initial setup."),
      humanMsg(longTask),
    ];

    const result = detectMessageOrigin(messages);
    expect(result.origin).not.toBe("AGENT_STATUS");
    expect(requiresRepositoryWork(result.origin)).toBe(true);
  });

  test("149-char task starting with status word → AGENT_STATUS (boundary below)", () => {
    // Confirm the boundary works in the other direction too.
    // Build a string whose trimmed length is exactly 149.
    const base = "Updated the code.";
    let shortTask = base;
    const filler = "word ";
    while (shortTask.trim().length < 149) {
      shortTask += filler;
    }
    // Trim to exactly 149 if we overshot
    shortTask = shortTask.trim().slice(0, 149);

    expect(shortTask.trim().length).toBe(149);

    const messages = [
      humanMsg("Do a task."),
      assistantText("Done."),
      humanMsg(shortTask),
    ];

    const result = detectMessageOrigin(messages);
    // 149 chars < 150 → AGENT_STATUS fires
    expect(result.origin).toBe("AGENT_STATUS");
  });

  test("coding task with no prior tool activity → HUMAN_TASK by default", () => {
    const messages = [
      humanMsg("Rename the authenticate function to verifyCredentials in auth.js"),
    ];
    const result = detectMessageOrigin(messages);
    expect(result.origin).toBe("HUMAN_TASK");
    expect(requiresRepositoryWork(result.origin)).toBe(true);
  });
});