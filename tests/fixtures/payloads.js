/**
 * Reusable request payloads for all test scenarios.
 * All payloads are in OpenAI internal format (post-normalization).
 */

export const SIMPLE_CHAT = {
  model: "test-model",
  stream: false,
  messages: [
    { role: "user", content: "Hello! What is 2 + 2?" }
  ]
};

export const COMPRESSION_ELIGIBLE = {
  model: "test-model",
  stream: false,
  messages: [
    { role: "user", content: "Summarize this code." },
    {
      role: "tool",
      content: `
        function authenticate(user, password) {
          // MASSIVE tool result that should be compressed
          const hash = crypto.createHash('sha256').update(password).digest('hex');
          const stored = db.query('SELECT hash FROM users WHERE id = ?', [user.id]);
          if (stored.hash !== hash) throw new Error('Invalid credentials');
          const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
          db.query('UPDATE users SET last_login = ? WHERE id = ?', [new Date(), user.id]);
          auditLog.write({ event: 'login', userId: user.id, ip: req.ip, timestamp: new Date().toISOString() });
          return { token, expiresAt: Date.now() + 86400000, userId: user.id };
        }
        ${"// padding to make this compressible\n".repeat(100)}
      `.trim()
    }
  ]
};

export const ANTHROPIC_CHAT = {
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Hello!" }
  ]
};

export const ANTHROPIC_WITH_SYSTEM = {
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  system: "You are a helpful coding assistant.",
  messages: [
    { role: "user", content: "What is TypeScript?" }
  ]
};

export const OPENAI_WITH_TOOLS = {
  model: "gpt-4o",
  stream: false,
  messages: [
    { role: "user", content: "Search the codebase for the authenticate function." }
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "search_code",
        description: "Search the codebase for a symbol or pattern.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query." }
          },
          required: ["query"]
        }
      }
    }
  ]
};

export const PATCH_REQUEST = {
  model: "test-model",
  stream: false,
  messages: [
    {
      role: "user",
      content: "Add a comment // TEST_MARKER to the top of tests/fixtures/target.js"
    }
  ]
};

// Mock LLM response — plain text
export const MOCK_LLM_RESPONSE = {
  id: "chatcmpl-test123",
  object: "chat.completion",
  created: 1700000000,
  model: "test-model",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "4"
    },
    finish_reason: "stop"
  }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 1,
    total_tokens: 11
  }
};

// Mock LLM response — tool call
export const MOCK_TOOL_CALL_RESPONSE = (toolName, args) => ({
  id: "chatcmpl-tool123",
  object: "chat.completion",
  created: 1700000000,
  model: "test-model",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_test_001",
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(args)
        }
      }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
});

// Mock streaming response chunks
export const MOCK_STREAM_CHUNKS = [
  `data: {"id":"chatcmpl-s1","object":"chat.completion.chunk","created":1700000000,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n`,
  `data: {"id":"chatcmpl-s1","object":"chat.completion.chunk","created":1700000000,"model":"test-model","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\n\n`,
  `data: {"id":"chatcmpl-s1","object":"chat.completion.chunk","created":1700000000,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  `data: [DONE]\n\n`
];