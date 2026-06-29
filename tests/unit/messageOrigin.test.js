// tests/unit/messageOrigin.test.js

import {
  detectMessageOrigin,
  requiresRepositoryWork,
  detectRecentToolActivity,
} from "../../src/proxy/messageOrigin.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Plain user message — human typed this */
const humanMsg = (text) => ({ role: "user", content: text });

/** Assistant message with plain text — status report */
const assistantText = (text) => ({ role: "assistant", content: text });

/** Assistant message that called a tool — mid-task reasoning */
const assistantWithTool = (toolName = "read_file") => ({
  role: "assistant",
  content: [
    { type: "text", text: "Let me check the file." },
    { type: "tool_use", id: "tu_001", name: toolName, input: {} },
  ],
});

/**
 * Tool result user message — Anthropic wire format.
 * Role is "user", content blocks are type:"tool_result".
 * There is NO role:"tool" in the Anthropic format.
 */
const toolResultMsg = (toolUseId = "tu_001", content = "file contents here") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
});

/** Mixed user message — has both text and tool_result blocks */
const mixedUserMsg = (text) => ({
  role: "user",
  content: [
    { type: "text", text },
    { type: "tool_result", tool_use_id: "tu_002", content: "result" },
  ],
});

/** System-reminder harness injection Claude Code prepends */
const harnessInjectedMsg = (realTask) => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<system-reminder>You are Claude Code.</system-reminder>\n${realTask}`,
    },
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// detectMessageOrigin
// ─────────────────────────────────────────────────────────────────────────────

describe("detectMessageOrigin", () => {
  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("empty messages array → HUMAN_TASK / no_history", () => {
      const result = detectMessageOrigin([]);
      expect(result.origin).toBe("HUMAN_TASK");
      expect(result.reason).toBe("no_history");
    });

    test("null messages → HUMAN_TASK / no_history", () => {
      const result = detectMessageOrigin(null);
      expect(result.origin).toBe("HUMAN_TASK");
      expect(result.reason).toBe("no_history");
    });

    test("single user message → HUMAN_TASK / fresh_conversation", () => {
      const result = detectMessageOrigin([humanMsg("Hello!")]);
      expect(result.origin).toBe("HUMAN_TASK");
      expect(result.reason).toBe("fresh_conversation");
    });

    test("single assistant message → HUMAN_TASK (no current user turn)", () => {
      // Unusual payload but should not crash
      const result = detectMessageOrigin([assistantText("Hello!")]);
      expect(result.origin).toBe("HUMAN_TASK");
    });
  });

  // ── Rule 1: TOOL_FOLLOWUP ─────────────────────────────────────────────────

  describe("Rule 1 — TOOL_FOLLOWUP", () => {
    test("current message is pure tool_result → TOOL_FOLLOWUP", () => {
      const messages = [
        humanMsg("Rename the authenticate function."),
        assistantWithTool("read_file"),
        toolResultMsg("tu_001", "function authenticate() {}"),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).toBe("TOOL_FOLLOWUP");
      expect(result.reason).toBe("current_message_is_tool_result");
    });

    test("multiple tool_result blocks in current message → TOOL_FOLLOWUP", () => {
      const messages = [
        humanMsg("Do the thing."),
        assistantWithTool(),
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
    });

    test("mixed user message (text + tool_result) is NOT TOOL_FOLLOWUP", () => {
      // isToolResultMessage requires ALL blocks to be tool_result
      const messages = [
        humanMsg("Do the thing."),
        assistantWithTool(),
        mixedUserMsg("Here is some context too."),
      ];
      const result = detectMessageOrigin(messages);
      // Mixed content — not a pure tool result, should not be TOOL_FOLLOWUP
      expect(result.origin).not.toBe("TOOL_FOLLOWUP");
    });
  });

  // ── Rule 2: CONTINUATION ──────────────────────────────────────────────────

  describe("Rule 2 — CONTINUATION", () => {
    test("assistant called a tool recently → CONTINUATION", () => {
      const messages = [
        humanMsg("Rename the authenticate function."),
        assistantWithTool("read_file"),
        toolResultMsg("tu_001", "file contents"),
        assistantText("Done, the file is updated."),
        humanMsg("Now add a comment at the top."),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).toBe("CONTINUATION");
      expect(result.reason).toBe("recent_tool_activity");
    });

    test("tool result in last 4 messages triggers CONTINUATION", () => {
      const messages = [
        humanMsg("Do task A."),
        assistantWithTool(),
        toolResultMsg(),
        assistantText("Task A complete."),
        humanMsg("Do task B."),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).toBe("CONTINUATION");
    });

    test("tool activity beyond 4 messages ago does NOT trigger CONTINUATION", () => {
      // 6 messages deep — tool activity is outside the 4-message window
      const messages = [
        humanMsg("Start."),
        assistantWithTool(),
        toolResultMsg(),
        assistantText("Done with first task."),
        humanMsg("Another thing."),
        assistantText("Got it."),
        humanMsg("Understood."),
        assistantText("Great."),
        // Current turn — no recent tool activity in last 4
        humanMsg("Now do something completely new."),
      ];
      const result = detectMessageOrigin(messages);
      // Tool activity is 5+ messages back — should NOT be CONTINUATION
      expect(result.origin).not.toBe("CONTINUATION");
    });
  });

  // ── Rule 3: AGENT_STATUS ──────────────────────────────────────────────────

  describe("Rule 3 — AGENT_STATUS", () => {
    const statusPhrases = [
      "Done.",
      "The patch was applied.",
      "The patch has been applied successfully.",
      "Updated the function.",
      "Added the import.",
      "Removed the log statement.",
      "Successfully applied the changes.",
      "The file has been modified.",
      "No further changes needed.",
      "Verified the implementation.",
      "The graph has been re-indexed.",
    ];

    test.each(statusPhrases)(
      'last assistant text "%s" + short ack → AGENT_STATUS',
      (phrase) => {
        const messages = [
          humanMsg("Rename the function."),
          assistantText(phrase),
          humanMsg("ok"),
        ];
        const result = detectMessageOrigin(messages);
        expect(result.origin).toBe("AGENT_STATUS");
      }
    );

    test("status phrase + long user response is NOT AGENT_STATUS", () => {
      // User text >= 150 chars — this is a new substantive task
      const longTask = "a".repeat(150);
      const messages = [
        humanMsg("Do the thing."),
        assistantText("Done."),
        humanMsg(longTask),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).not.toBe("AGENT_STATUS");
    });

    test("status phrase + 149 chars → AGENT_STATUS (boundary)", () => {
      const borderlineTask = "a".repeat(149);
      const messages = [
        humanMsg("Do the thing."),
        assistantText("Done."),
        humanMsg(borderlineTask),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).toBe("AGENT_STATUS");
    });

    test("status phrase + 150 chars → NOT AGENT_STATUS (boundary)", () => {
      const borderlineTask = "a".repeat(150);
      const messages = [
        humanMsg("Do the thing."),
        assistantText("Done."),
        humanMsg(borderlineTask),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).not.toBe("AGENT_STATUS");
    });

    test("assistant had tool_use blocks — NOT an agent status message", () => {
      // Even if the text looks like a status, tool_use presence means mid-task
      const messages = [
        humanMsg("Rename the function."),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Done." },
            { type: "tool_use", id: "tu_001", name: "read_file", input: {} },
          ],
        },
        humanMsg("ok"),
      ];
      const result = detectMessageOrigin(messages);
      // assistantCalledTools returns true — Rule 3 should NOT fire
      expect(result.origin).not.toBe("AGENT_STATUS");
    });

    test("system-reminder harness injection stripped before status check", () => {
      // The real task text is after the harness injection
      const messages = [
        harnessInjectedMsg("Rename authenticate."),
        assistantText("Done."),
        humanMsg("thanks"),
      ];
      const result = detectMessageOrigin(messages);
      // Should still detect AGENT_STATUS after stripping the harness
      expect(result.origin).toBe("AGENT_STATUS");
    });
  });

  // ── Rule 4 / Rule 5: HUMAN_TASK ───────────────────────────────────────────

  describe("Rule 4/5 — HUMAN_TASK", () => {
    test("fresh two-message conversation → HUMAN_TASK", () => {
      const messages = [
        humanMsg("Hello!"),
        humanMsg("What is 2 + 2?"),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).toBe("HUMAN_TASK");
    });

    test("long substantive task after non-status assistant → HUMAN_TASK", () => {
      const messages = [
        humanMsg("Explain TypeScript."),
        assistantText("TypeScript is a strongly typed language."),
        humanMsg("Now rename the authenticate function in auth.js to verifyUser."),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).toBe("HUMAN_TASK");
    });

    test("multi-turn conversation with no tool activity → HUMAN_TASK", () => {
      const messages = [
        humanMsg("Question 1"),
        assistantText("Answer 1"),
        humanMsg("Question 2"),
        assistantText("Answer 2"),
        humanMsg("Question 3"),
      ];
      const result = detectMessageOrigin(messages);
      expect(result.origin).toBe("HUMAN_TASK");
    });
  });

  // ── Return shape ──────────────────────────────────────────────────────────

  describe("return shape", () => {
    test("always returns { origin, reason } strings", () => {
      const result = detectMessageOrigin([humanMsg("Hello")]);
      expect(typeof result.origin).toBe("string");
      expect(typeof result.reason).toBe("string");
      expect(result.origin.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requiresRepositoryWork
// ─────────────────────────────────────────────────────────────────────────────

describe("requiresRepositoryWork", () => {
  test("HUMAN_TASK → true", () => {
    expect(requiresRepositoryWork("HUMAN_TASK")).toBe(true);
  });

  test("CONTINUATION → true", () => {
    expect(requiresRepositoryWork("CONTINUATION")).toBe(true);
  });

  test("AGENT_STATUS → false", () => {
    expect(requiresRepositoryWork("AGENT_STATUS")).toBe(false);
  });

  test("TOOL_FOLLOWUP → false", () => {
    expect(requiresRepositoryWork("TOOL_FOLLOWUP")).toBe(false);
  });

  test("unknown origin → true (safe default)", () => {
    // Unknown origins should not accidentally suppress tool injection
    expect(requiresRepositoryWork("UNKNOWN_FUTURE_ORIGIN")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectRecentToolActivity
// ─────────────────────────────────────────────────────────────────────────────

describe("detectRecentToolActivity", () => {
  test("empty messages → false", () => {
    expect(detectRecentToolActivity([])).toBe(false);
  });

  test("null messages → false", () => {
    expect(detectRecentToolActivity(null)).toBe(false);
  });

  test("tool_result in last 4 → true", () => {
    const messages = [
      humanMsg("task"),
      assistantWithTool(),
      toolResultMsg(),
      assistantText("done"),
    ];
    expect(detectRecentToolActivity(messages)).toBe(true);
  });

  test("tool_use in last 4 → true", () => {
    const messages = [
      humanMsg("task"),
      assistantWithTool("patch_file"),
    ];
    expect(detectRecentToolActivity(messages)).toBe(true);
  });

  test("tool activity exactly 4 messages back → true (boundary)", () => {
    // slice(-4) includes index at length-4
    const messages = [
      humanMsg("intro"),
      assistantWithTool(),  // ← this is the 4th from the end
      assistantText("step 2"),
      assistantText("step 3"),
      humanMsg("current"),
    ];
    expect(detectRecentToolActivity(messages)).toBe(true);
  });

  test("tool activity 5 messages back → false (outside window)", () => {
    const messages = [
      assistantWithTool(), // 5th from end — outside window
      assistantText("a"),
      assistantText("b"),
      assistantText("c"),
      assistantText("d"),
      humanMsg("current"),
    ];
    expect(detectRecentToolActivity(messages)).toBe(false);
  });

  test("plain conversation with no tools → false", () => {
    const messages = [
      humanMsg("Hi"),
      assistantText("Hello"),
      humanMsg("How are you?"),
    ];
    expect(detectRecentToolActivity(messages)).toBe(false);
  });
});