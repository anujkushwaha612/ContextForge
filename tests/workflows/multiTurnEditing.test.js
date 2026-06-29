import { ServerManager } from "../helpers/serverManager.js";
import { MockProvider } from "../fixtures/mockProvider.js";
import { MOCK_LLM_RESPONSE } from "../fixtures/payloads.js";

const PORT = 13011;
const OLLAMA_PORT = 13012;

describe("Multi-Turn Editing Workflow", () => {
  let server;
  let mockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const mockPort = await mockProvider.start();
    
    server = new ServerManager({
      CF_PORT: String(PORT),
      CF_PROVIDER: "ollama",
      OLLAMA_HOST: "127.0.0.1",
      OLLAMA_PORT: String(mockPort),
    });
    await server.start();
  }, 30000);

  afterAll(async () => {
    await server.stop();
    await mockProvider.stop();
  });

  beforeEach(() => {
    mockProvider.reset();
  });

  test("simulates a multi-turn conversation with vault retention", async () => {
    // Turn 1: LLM decides to search
    mockProvider.setNextResponse({
      ...MOCK_LLM_RESPONSE,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "contextforge_query_graph",
              arguments: JSON.stringify({ query_type: "find_symbol", target: "authenticate" })
            }
          }]
        },
        finish_reason: "tool_calls"
      }]
    });

    // The interceptor will intercept "find_symbol" because it's a background tool.
    // It runs the tool, then retries the mock provider.
    // Turn 2: LLM patches the file
    mockProvider.setNextResponse({
      ...MOCK_LLM_RESPONSE,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_2",
            type: "function",
            function: {
              name: "contextforge_patch_ast",
              arguments: JSON.stringify({ file_path: "auth.js", changes: [] })
            }
          }]
        },
        finish_reason: "tool_calls"
      }]
    });

    // Turn 3: LLM replies done
    mockProvider.setNextResponse({
      ...MOCK_LLM_RESPONSE,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Patch applied successfully."
        },
        finish_reason: "stop"
      }]
    });

    const payload = {
      model: "test-model",
      messages: [
        { role: "user", content: "Update the authenticate function to return true." }
      ]
    };

    const res = await server.request("/v1/chat/completions", payload);
    expect(res.status).toBe(200);

    const requests = mockProvider.getRequests();
    
    // We should see 3 requests hit the mock LLM
    expect(requests.length).toBe(3);
    
    const finalReq = requests[2].body;
    expect(finalReq.messages.length).toBeGreaterThan(2);
  });
});
