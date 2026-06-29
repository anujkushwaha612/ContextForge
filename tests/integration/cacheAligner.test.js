import { ServerManager } from "../helpers/serverManager.js";
import { MockProvider } from "../fixtures/mockProvider.js";
import { MOCK_LLM_RESPONSE } from "../fixtures/payloads.js";

const PORT = 13015;
const OLLAMA_PORT = 13016;

describe("Cache Aligner", () => {
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

  test("cache aligner works on complex payloads", async () => {
    mockProvider.setNextResponse(MOCK_LLM_RESPONSE);

    const payload = {
      model: "test-model",
      messages: [
        { role: "user", content: "Long context here..." },
        { role: "assistant", content: "Understood." },
        { role: "user", content: "Short query." }
      ]
    };

    const res = await server.request("/v1/chat/completions", payload, {
      "x-cf-dry-run": "true"
    });
    expect(res.status).toBe(200);

    const body = res.json();
    
    // As long as the request succeeds and the aligner doesn't crash, we're good.
    // Real validation of the exact tokens shifted happens inside unit tests.
    expect(body.tokens_before).toBeGreaterThan(0);
  });
});
