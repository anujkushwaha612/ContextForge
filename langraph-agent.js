// terminal-agent.js
// Run with: node --env-file=.env terminal-agent.js

import { execSync, exec } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import readline from "node:readline";

const execAsync = promisify(exec);

// ==========================================
// CONFIGURATION
// ==========================================
const PROXY_ENDPOINT = "http://localhost:3000/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b"; // Using Groq via ContextForge proxy
const MAX_TOOL_ITERATIONS = 10; // Prevent infinite loops

// ==========================================
// SAFETY LAYER
// ==========================================
const DANGEROUS_PATTERNS = [
  "rm -rf",
  "sudo",
  "chmod 777",
  "dd if=",
  "> /dev/",
  "mkfs",
  "fdisk",
  "format",
  "del /f",
  "rmdir /s",
  "shutdown",
  "reboot",
  "halt",
  ":(){:|:&};:", // Fork bomb
];

function isSafeCommand(command) {
  return !DANGEROUS_PATTERNS.some((pattern) =>
    command.toLowerCase().includes(pattern.toLowerCase()),
  );
}

// ==========================================
// TOOL IMPLEMENTATIONS
// ==========================================

async function executeTerminalCommand(command, workingDirectory = null) {
  if (!isSafeCommand(command)) {
    return `🚫 BLOCKED: Command '${command}' is potentially dangerous and not allowed.`;
  }

  try {
    const options = {
      timeout: 30000,
      cwd:
        workingDirectory && existsSync(workingDirectory)
          ? workingDirectory
          : process.cwd(),
    };

    const { stdout, stderr } = await execAsync(command, options);

    if (stdout.trim()) {
      return `✅ Command executed successfully:\n${stdout.trim()}`;
    } else if (stderr.trim()) {
      return `❌ Command failed with error:\n${stderr.trim()}`;
    } else {
      return `✅ Command executed successfully (no output)`;
    }
  } catch (err) {
    if (err.killed) return `⏰ Command timed out after 30 seconds`;
    return `💥 Error executing command: ${err.message}`;
  }
}

function fileOperations(operation, filename, content = "") {
  try {
    if (operation === "create") {
      writeFileSync(filename, content, "utf-8");
      return `✅ File '${filename}' created successfully`;
    } else if (operation === "read") {
      if (existsSync(filename)) {
        const data = readFileSync(filename, "utf-8");
        return `📄 Content of '${filename}':\n${data}`;
      } else {
        return `❌ File '${filename}' not found`;
      }
    } else if (operation === "append") {
      appendFileSync(filename, content, "utf-8");
      return `✅ Content appended to '${filename}'`;
    } else {
      return `❌ Unknown operation: ${operation}`;
    }
  } catch (err) {
    return `💥 File operation failed: ${err.message}`;
  }
}

function systemMonitor(infoType) {
  try {
    if (infoType === "memory") {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      return `💾 Memory Usage:
Total     : ${(total / 1024 ** 3).toFixed(2)} GB
Available : ${(free / 1024 ** 3).toFixed(2)} GB
Used      : ${(used / 1024 ** 3).toFixed(2)} GB
Percentage: ${((used / total) * 100).toFixed(2)}%`;
    } else if (infoType === "disk") {
      // Use df for Unix-like systems
      try {
        const result = execSync("df -h /", { encoding: "utf-8" });
        return `💽 Disk Usage:\n${result.trim()}`;
      } catch {
        return `💥 Disk info not available on this platform`;
      }
    } else if (infoType === "processes") {
      try {
        const isWin = process.platform === "win32";
        const cmd = isWin
          ? "tasklist /fo csv /nh"
          : "ps aux --sort=-%mem | head -11";
        const result = execSync(cmd, { encoding: "utf-8" });
        return `🔍 Top Processes by Memory Usage:\n${result.trim()}`;
      } catch {
        return `💥 Process info not available on this platform`;
      }
    } else {
      return `❌ Unknown info type: ${infoType}. Use 'memory', 'disk', or 'processes'.`;
    }
  } catch (err) {
    return `💥 Error getting system info: ${err.message}`;
  }
}

// ==========================================
// TOOL REGISTRY (OpenAI Function Schema)
// ==========================================
const TOOLS = [
  {
    type: "function",
    function: {
      name: "execute_terminal_command",
      description:
        "Execute terminal commands safely. Can run ls, pwd, mkdir, find, grep, wc, head, tail, ps, df, du. Dangerous commands like rm -rf or sudo are automatically blocked.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The terminal command to execute",
          },
          working_directory: {
            type: "string",
            description: "Optional directory to run the command in",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_operations",
      description:
        "Perform file operations: create a new file with content, read an existing file, or append content to a file.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["create", "read", "append"],
            description: "Type of file operation to perform",
          },
          filename: {
            type: "string",
            description: "Name or path of the file to operate on",
          },
          content: {
            type: "string",
            description: "Content to write (required for create and append)",
          },
        },
        required: ["operation", "filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_monitor",
      description:
        "Get system information: running processes, memory usage, or disk space.",
      parameters: {
        type: "object",
        properties: {
          info_type: {
            type: "string",
            enum: ["processes", "memory", "disk"],
            description: "Type of system information to retrieve",
          },
        },
        required: ["info_type"],
      },
    },
  },
];

// ==========================================
// TOOL DISPATCHER
// ==========================================
async function dispatchTool(toolName, args) {
  console.log(`\n[Tool Call] ${toolName}(${JSON.stringify(args)})`);

  try {
    switch (toolName) {
      case "execute_terminal_command":
        return await executeTerminalCommand(
          args.command,
          args.working_directory,
        );
      case "file_operations":
        return fileOperations(
          args.operation,
          args.filename,
          args.content || "",
        );
      case "system_monitor":
        return systemMonitor(args.info_type);
      default:
        return `❌ Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `💥 Tool dispatch error: ${err.message}`;
  }
}

// ==========================================
// CONTEXTFORGE PROXY CLIENT
// This is the core that lets you measure
// token savings vs a direct Groq call
// ==========================================
async function callProxy(messages, useTools = true) {
  const payload = {
    model: MODEL,
    messages,
    stream: false, // Keep false for agentic loops — easier to parse tool calls
    ...(useTools && { tools: TOOLS }),
    ...(useTools && { tool_choice: "auto" }),
  };

  const response = await fetch(PROXY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY || "dummy-key"}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Proxy returned HTTP ${response.status}: ${errText}`);
  }

  return response.json();
}

// ==========================================
// SYSTEM PROMPT
// ==========================================
const SYSTEM_PROMPT = `You are an advanced terminal assistant. You help users with:

🔧 TERMINAL COMMANDS:
- File/directory operations (ls, mkdir, pwd, cat, echo, touch)
- Text processing (grep, wc, head, tail)
- System monitoring (ps, df, du)

🛡️ SAFETY:
- Commands are executed in a sandbox
- Dangerous operations are automatically blocked
- All operations are logged

💡 CAPABILITIES:
- Execute terminal commands safely via execute_terminal_command
- Create, read, and modify files via file_operations  
- Monitor system resources via system_monitor

Always explain what you are doing. Be concise and educational.`;

// ==========================================
// AGENTIC LOOP (The LangGraph ReAct equivalent)
// ==========================================
async function runAgentLoop(userInput, conversationHistory = []) {
  // Build the full message history for this turn
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: userInput },
  ];

  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    let response;
    try {
      response = await callProxy(messages, true);
    } catch (err) {
      console.error(`[Agent] Proxy call failed: ${err.message}`);
      throw err;
    }

    const assistantMessage = response.choices?.[0]?.message;
    if (!assistantMessage) {
      throw new Error("No message in proxy response");
    }

    // Always push the assistant message into history
    messages.push(assistantMessage);

    // If the LLM wants to call tools, dispatch them
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      console.log(
        `\n[Agent] LLM requested ${assistantMessage.tool_calls.length} tool call(s)...`,
      );

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        assistantMessage.tool_calls.map(async (toolCall) => {
          const toolName = toolCall.function.name;
          let args;

          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          const result = await dispatchTool(toolName, args);
          console.log(`[Tool Result] ${result.substring(0, 120)}...`);

          return {
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolName,
            content: result,
          };
        }),
      );

      // Append all tool results to message history
      messages.push(...toolResults);
      // Loop again — the LLM will now reason over the tool results
      continue;
    }

    // No tool calls — this is the final text response
    return {
      content: assistantMessage.content || "(No response)",
      messages: messages, // Return full history for multi-turn conversations
      iterations,
    };
  }

  return {
    content: "⚠️ Agent reached maximum iterations without a final answer.",
    messages,
    iterations,
  };
}

// ==========================================
// DEMO MODE
// ==========================================
async function runDemoMode() {
  console.log("\n🤖 ContextForge Terminal Agent — Demo Mode");
  console.log("==========================================\n");
  console.log("Routing all LLM calls through ContextForge proxy at:");
  console.log(`→ ${PROXY_ENDPOINT}\n`);

  // These tasks are specifically chosen to generate large contexts
  // that will exercise the ContextForge compression pipeline
  const tasks = [
    "Show me all files in the current directory and tell me which ones are JavaScript files",
    "What directory am I currently in? Also show me memory usage.",
    "Create a file called agent_report.txt with a summary of what you can do",
    "Read the file agent_report.txt and tell me how many words are in it",
    "Show me the top processes using the most memory on this system",
    "Create a JavaScript file called hello.js with a hello world program that uses ES modules",
  ];

  // Persistent conversation history across tasks to build up context
  // and really stress-test the ContextForge compression
  let conversationHistory = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.log(`\n${"=".repeat(55)}`);
    console.log(`Task ${i + 1}/${tasks.length}: ${task}`);
    console.log("=".repeat(55));

    const startTime = performance.now();

    try {
      const result = await runAgentLoop(task, conversationHistory);
      const latency = performance.now() - startTime;

      console.log(`\n🤖 Agent Response:\n${result.content}`);
      console.log(`\n⏱️  Task Latency    : ${latency.toFixed(0)}ms`);
      console.log(`🔄 Agent Iterations: ${result.iterations}`);

      // Carry the full message history forward for next task
      // This builds up a large conversation context that ContextForge will compress
      conversationHistory = result.messages.slice(1); // Strip system prompt
    } catch (err) {
      console.error(`\n❌ Task ${i + 1} failed: ${err.message}`);
    }
  }

  console.log("\n\n✅ Demo Complete. Check proxy logs for token savings.");
  console.log(
    "Run the same tasks a second time to verify cache hits are served instantly.\n",
  );
}

// ==========================================
// INTERACTIVE MODE
// ==========================================
async function runInteractiveMode() {
  console.log("\n🚀 Welcome to ContextForge Terminal Agent!");
  console.log("All LLM calls are routed through your proxy at:");
  console.log(`→ ${PROXY_ENDPOINT}`);
  console.log(
    '\nType "exit" to quit, "history" to see message count, "clear" to reset context.',
  );
  console.log("=".repeat(55));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) =>
    new Promise((resolve) => rl.question(prompt, resolve));

  let conversationHistory = [];
  let totalIterations = 0;

  while (true) {
    const userInput = (await question("\n💬 You: ")).trim();

    if (!userInput) continue;

    if (["exit", "quit", "bye"].includes(userInput.toLowerCase())) {
      console.log(
        `\n👋 Goodbye! Total agent iterations this session: ${totalIterations}`,
      );
      rl.close();
      break;
    }

    if (userInput.toLowerCase() === "clear") {
      conversationHistory = [];
      console.log("🧹 Conversation history cleared.");
      continue;
    }

    if (userInput.toLowerCase() === "history") {
      console.log(
        `📜 Current conversation has ${conversationHistory.length} messages in context.`,
      );
      console.log("   (ContextForge is compressing this on every request)");
      continue;
    }

    if (userInput.toLowerCase() === "help") {
      console.log(`
🔧 Available Capabilities:
  File ops  : "list files", "create a file called X", "read file X"
  System    : "show processes", "memory usage", "disk space"
  Terminal  : Any safe terminal command
  Multi-step: "create a file, write 3 bullet points to it, then read it back"

📊 ContextForge Metrics (check proxy terminal):
  - Tokens Saved: How many tokens were compressed away
  - Cache Hit   : If this query was answered from memory (0ms LLM cost)
  - Vault ID    : Pruned context stored for LLM self-retrieval
      `);
      continue;
    }

    const startTime = performance.now();
    process.stdout.write("\n🤖 Agent: ");

    try {
      const result = await runAgentLoop(userInput, conversationHistory);
      const latency = performance.now() - startTime;

      console.log(result.content);
      console.log(
        `\n[Meta] Latency: ${latency.toFixed(0)}ms | Iterations: ${result.iterations} | Context messages: ${conversationHistory.length}`,
      );

      // Persist the conversation
      conversationHistory = result.messages.slice(1); // Strip system prompt
      totalIterations += result.iterations;
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}`);
      console.error(
        "Check that your ContextForge proxy is running on port 3000.",
      );
    }
  }
}

// ==========================================
// ENTRY POINT
// ==========================================
async function main() {
  // Verify the proxy is reachable before starting
  try {
    const testRes = await fetch("http://localhost:3000/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY || "dummy-key"}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
    });
    console.log(`\n✅ ContextForge Proxy reachable (HTTP ${testRes.status})`);
  } catch {
    console.error(
      "\n❌ Cannot reach ContextForge Proxy at http://localhost:3000",
    );
    console.error("   Start it with: node src/server.js");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question(
    "\nChoose mode:\n  1. Demo mode (automated tasks)\n  2. Interactive mode (chat)\n\nEnter choice (1 or 2): ",
    async (choice) => {
      rl.close();
      if (choice.trim() === "1") {
        await runDemoMode();
      } else {
        await runInteractiveMode();
      }
    },
  );
}

main().catch(console.error);
