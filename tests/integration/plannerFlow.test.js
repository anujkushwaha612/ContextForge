import { MockProvider } from "../fixtures/mockProvider.js";
import { ServerManager } from "../helpers/serverManager.js";
import { SIMPLE_CHAT } from "../fixtures/payloads.js";

let mockProvider;
let server;

beforeAll(async () => {
  mockProvider = new MockProvider();
  const mockPort = await mockProvider.start();
  
  server = new ServerManager({
    CF_PROVIDER: "ollama",
    OLLAMA_HOST: "127.0.0.1",
    OLLAMA_PORT: String(mockPort),
    CF_PORT: "13003",
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

describe("Planner Flow", () => {
  test("planner identifies HUMAN_TASK intent correctly", async () => {
    // Send a plain chat message simulating a fresh conversation
    const res = await server.request("/v1/chat/completions", SIMPLE_CHAT);
    expect(res.status).toBe(200);
    
    // Check the server logs (stdout) to see if planner was engaged
    const logs = server.logs.join("\\n");
    expect(logs).toMatch(/Origin: HUMAN_TASK/);
    expect(logs).toMatch(/Intent:/);
  });
});
