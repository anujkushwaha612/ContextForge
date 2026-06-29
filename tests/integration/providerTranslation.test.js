import { ServerManager } from "../helpers/serverManager.js";
import { MockProvider } from "../fixtures/mockProvider.js";
import { MOCK_LLM_RESPONSE } from "../fixtures/payloads.js";

const PORT = 13007;
const OLLAMA_PORT = 13008;

describe("Provider Translation", () => {
  let server;
  let mockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const mockPort = await mockProvider.start();

    // Use ollama as the upstream provider which mimics OpenAI format
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

  test("translates complex Anthropic payload to internal OpenAI format", async () => {
    const complexAnthropicPayload = {
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1024,
      temperature: 0.7,
      system: "You are an expert assistant.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this image." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abcd" } }
          ]
        }
      ],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } }
          }
        }
      ]
    };

    mockProvider.setNextResponse(MOCK_LLM_RESPONSE);

    const res = await server.request("/v1/messages", complexAnthropicPayload, {
      "anthropic-version": "2023-06-01",
      "x-api-key": "test"
    });

    expect(res.status).toBe(200);

    const requests = mockProvider.getRequests();
    expect(requests.length).toBe(1);

    const upstreamBody = requests[0].body;

    // Verify system prompt was moved to messages
    expect(upstreamBody.messages[0].role).toBe("system");
    expect(upstreamBody.messages[0].content).toBe("You are an expert assistant.");

    // Verify user message conversion
    const userMsg = upstreamBody.messages[1];
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0].type).toBe("text");
    expect(userMsg.content[0].text).toBe("Look at this image.");
    expect(userMsg.content[1].type).toBe("image_url");
    expect(userMsg.content[1].image_url.url).toBe("data:image/jpeg;base64,abcd");

    // Verify tool schema conversion
    expect(upstreamBody.tools[0].type).toBe("function");
    expect(upstreamBody.tools[0].function.name).toBe("weather");
    expect(upstreamBody.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { location: { type: "string", description: "" } },
      required: []
    });

    // Verify temperature
    expect(upstreamBody.temperature).toBe(0.7);
  });
});
