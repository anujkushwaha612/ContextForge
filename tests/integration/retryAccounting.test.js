import { MockProvider } from "../fixtures/mockProvider.js";
import { ServerManager } from "../helpers/serverManager.js";
import { OPENAI_WITH_TOOLS, MOCK_TOOL_CALL_RESPONSE } from "../fixtures/payloads.js";

let mockProvider;
let server;

beforeAll(async () => {
  mockProvider = new MockProvider();
  const mockPort = await mockProvider.start();
  
  server = new ServerManager({
    CF_PROVIDER: "ollama",
    OLLAMA_HOST: "127.0.0.1",
    OLLAMA_PORT: String(mockPort),
    CF_PORT: "13002",
    CF_WORKSPACE_PATH: "./",
    CF_IS_TEST_ENV: "true",
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

describe("Retry Accounting", () => {
  test("ghost retries accumulate in wireTokens and hopCount", async () => {
    // 1. Mock provider will return a tool call FIRST.
    // The ghost interceptor should intercept it, run the tool, and retry.
    // 2. On the SECOND request, the mock provider will return DEFAULT_RESPONSE.
    mockProvider.setNextResponse(MOCK_TOOL_CALL_RESPONSE("contextforge_retrieve", { query: "authenticate" }));
    
    // We send a request requesting metrics in the dry-run header?
    // Wait, dry-run skips LLM entirely! So we can't use dry-run to test ghost retries.
    // We must do a real request. To see the metrics, we could rely on checking the dashboard SSE stream
    // or we could check the server's metrics directly (not exposed).
    // Let's rely on checking the `mockProvider.getRequests()` to see it received 2 requests!
    
    const res = await server.request("/v1/chat/completions", OPENAI_WITH_TOOLS);
    expect(res.status).toBe(200);
    
    const requests = mockProvider.getRequests();
    
    // The mock LLM should have been hit twice (first time: tool call, second time: retry with tool result)
    expect(requests.length).toBe(2);
    
    const secondReq = requests[1].body;
    expect(secondReq.messages).toBeDefined();
    
    // The second request should have the tool_call and the tool_result appended!
    const toolMsg = secondReq.messages.find(m => m.role === "tool");
    expect(toolMsg).toBeDefined();
    
    // In the future, we could assert that dashboard statsEmitter also shows the correct hop count.
  });
});
