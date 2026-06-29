import { ServerManager } from "../helpers/serverManager.js";
import { MockProvider } from "../fixtures/mockProvider.js";
import { MOCK_LLM_RESPONSE } from "../fixtures/payloads.js";

const PORT = 13009;
const OLLAMA_PORT = 13010;

describe("Vault Lifecycle", () => {
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

  test("vaults massive tool results and retrieves via endpoint", async () => {
    mockProvider.setNextResponse(MOCK_LLM_RESPONSE);

    const massiveText = "A".repeat(16000);
    const massivePayload = {
      model: "test-model",
      messages: [
        { role: "user", content: "Read the file." },
        { 
          role: "tool", 
          tool_call_id: "call_123", 
          name: "read_file", 
          content: massiveText 
        }
      ]
    };

    const res = await server.request("/v1/chat/completions", massivePayload);
    expect(res.status).toBe(200);

    const requests = mockProvider.getRequests();
    expect(requests.length).toBe(1);
    
    const upstreamBody = requests[0].body;
    const toolMsg = upstreamBody.messages.find(m => m.role === "tool");
    
    // Ensure the message was vaulted
    expect(toolMsg.content).toMatch(/\[CF_VAULT:\s*cf_vault_[a-f0-9]+\]/);

    // Extract the vault ID
    const match = toolMsg.content.match(/\[CF_VAULT:\s*(cf_vault_[a-f0-9]+)\]/);
    expect(match).toBeTruthy();
    const vaultId = match[1];

    // Retrieve via /v1/vault/:id
    const vaultRes = await server.request(`/v1/vault/${vaultId}`, null, {}, "GET");
    expect(vaultRes.status).toBe(200);
    
    const vaultBody = vaultRes.json();
    expect(vaultBody.content).toBe(massiveText);
  });
});
