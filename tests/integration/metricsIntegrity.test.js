import { MockProvider } from "../fixtures/mockProvider.js";
import { ServerManager } from "../helpers/serverManager.js";
import { COMPRESSION_ELIGIBLE } from "../fixtures/payloads.js";

let mockProvider;
let server;

beforeAll(async () => {
  mockProvider = new MockProvider();
  const mockPort = await mockProvider.start();
  
  server = new ServerManager({
    CF_PROVIDER: "ollama",
    OLLAMA_HOST: "127.0.0.1",
    OLLAMA_PORT: String(mockPort),
    CF_PORT: "13001",
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

describe("Metrics Integrity", () => {
  test("total saved equals true baseline minus final wire tokens", async () => {
    const res = await server.request(
      "/v1/chat/completions",
      COMPRESSION_ELIGIBLE,
      { "x-cf-dry-run": "true" }
    );
    
    expect(res.status).toBe(200);
    const body = res.json();
    
    const expectedSaved = body.tokens_before - body.tokens_after;
    expect(body.tokens_saved).toBe(expectedSaved);
  });

  test("compression ratio is correctly calculated", async () => {
    const res = await server.request(
      "/v1/chat/completions",
      COMPRESSION_ELIGIBLE,
      { "x-cf-dry-run": "true" }
    );
    
    const body = res.json();
    const expectedRatio = (body.tokens_saved / body.tokens_before) * 100;
    
    expect(body.compression_ratio).toBeCloseTo(expectedRatio, 1);
  });

  test("negative savings are not artificially clipped to zero in pipeline report", async () => {
    const TINY_PROMPT = {
      model: "test-model",
      stream: false,
      messages: [{ role: "user", content: "Hi" }]
    };
    
    const res = await server.request(
      "/v1/chat/completions",
      TINY_PROMPT,
      { "x-cf-dry-run": "true" }
    );
    
    const body = res.json();
    expect(res.status).toBe(200);
    
    expect(body.tokens_after).toBeGreaterThan(body.tokens_before);
    expect(body.tokens_saved).toBeLessThan(0);
    expect(body.compression_ratio).toBeLessThan(0);
  });
});
