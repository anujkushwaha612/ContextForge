import { ServerManager } from "../helpers/serverManager.js";
import { MockProvider } from "../fixtures/mockProvider.js";
import { MOCK_LLM_RESPONSE } from "../fixtures/payloads.js";

const PORT = 13013;
const OLLAMA_PORT = 13014;

describe("Tool Scrubber and Pruner", () => {
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

  test("scrubs sensitive keys from tool results", async () => {
    mockProvider.setNextResponse(MOCK_LLM_RESPONSE);

    const payload = {
      model: "test-model",
      messages: [
        { role: "user", content: "Run tests." },
        { 
          role: "tool", 
          tool_call_id: "call_456", 
          name: "run_command", 
          content: "A".repeat(1000) + "\n\x1b[32mPASS\x1b[0m tests.js\n[#########........] 45% - downloading\n[##########.......] 50% - downloading\n[###########......] 55% - downloading\n[############.....] 60% - downloading" 
        }
      ]
    };

    const res = await server.request("/v1/chat/completions", payload);
    expect(res.status).toBe(200);

    const requests = mockProvider.getRequests();
    expect(requests.length).toBe(1);
    
    const upstreamBody = requests[0].body;
    const toolMsg = upstreamBody.messages.find(m => m.role === "tool");
    
    // Check if scrubbed (ANSI stripped, progress bar stripped)
    expect(toolMsg.content).not.toContain("\x1b[32m");
    expect(toolMsg.content).not.toContain("[#########........]");
    expect(toolMsg.content).toContain("PASS tests.js");
  });
});
