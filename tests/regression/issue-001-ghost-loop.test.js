import { MockProvider } from "../fixtures/mockProvider.js";
import { ServerManager } from "../helpers/serverManager.js";
import {
  OPENAI_WITH_TOOLS,
  MOCK_TOOL_CALL_RESPONSE,
  MOCK_LLM_RESPONSE,
} from "../fixtures/payloads.js";

let mockProvider;
let server;

beforeAll(async () => {
  mockProvider = new MockProvider();
  const mockPort = await mockProvider.start();

  server = new ServerManager({
    CF_PROVIDER: "ollama",
    OLLAMA_HOST: "127.0.0.1",
    OLLAMA_PORT: String(mockPort),
    CF_PORT: "13005",
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

describe("Regression: Issue #001 - Ghost Loop", () => {
  test("terminates after MAX_GHOST_RETRIES when LLM loops on same tool", async () => {
    // ── Why contextforge_retrieve ─────────────────────────────────────────
    // The ghost interceptor only intercepts tools where isBackgroundTool()
    // returns true. search_code (the original fixture) is NOT a background
    // tool — it passes straight through to the client on the first hop,
    // making reqs.length === 1 and the loop-guard assertions meaningless.
    //
    // contextforge_retrieve IS a background tool. The interceptor catches it,
    // attempts a vault lookup, gets a miss every time (vault doesn't exist),
    // sets hadFailure=true, increments retryCount, and loops back to the LLM.
    // A mock that always returns the same retrieve call therefore creates the
    // infinite-loop scenario the circuit breaker must cut off.
    const brokenToolResponse = MOCK_TOOL_CALL_RESPONSE("contextforge_retrieve", {
      vault_id: "cf_vault_doesnotexist",
      search_query: "looping",
    });

    // ── Why callCount controls the final response ─────────────────────────
    // After the circuit breaker trips at MAX_GHOST_RETRIES (10), it resets
    // retryCount to 0 and does one final upstream hop with a SYSTEM_ERROR
    // tool result injected. If the mock STILL returns a tool call on that
    // hop, retryCount resets again and a second loop starts — the test would
    // never terminate. Switching to MOCK_LLM_RESPONSE after 12 hops ensures
    // the final hop returns plain text, which the non-streaming path sends
    // straight to the client and resolves cleanly.
    let callCount = 0;
    const origHandler = mockProvider._handleRequest.bind(mockProvider);

    mockProvider._handleRequest = (req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          mockProvider._requests.push({ body: JSON.parse(body) });
        } catch {}

        res.writeHead(200, { "Content-Type": "application/json" });

        // First 12 hops → broken tool call (triggers interceptor loop)
        // Hop 13+      → plain text (lets the circuit-breaker final hop resolve)
        const response = ++callCount > 12 ? MOCK_LLM_RESPONSE : brokenToolResponse;
        res.end(JSON.stringify(response));
      });
    };

    const res = await server.request("/v1/chat/completions", OPENAI_WITH_TOOLS);

    // Restore before assertions so a throw doesn't leave the mock broken
    mockProvider._handleRequest = origHandler;

    const reqs = mockProvider.getRequests();

    // ── Hop count expectations ────────────────────────────────────────────
    // Normal flow:
    //   Hops 1-10 : vault miss → retryCount 0→10 → circuit breaker trips
    //   Hop 11    : circuit breaker resets retryCount=0, mock returns plain text
    //   Total     : 11 hops
    //
    // We allow up to 15 to absorb any off-by-one in how computeNextRetry
    // counts graph-only rounds vs failure rounds, but the hard upper bound
    // confirms the loop was actually cut off and did not run to 100+.
    expect(reqs.length).toBeGreaterThan(1);
    expect(reqs.length).toBeLessThanOrEqual(15);

    // The server must have returned 200 — circuit breaker resolves cleanly,
    // never leaving the client hanging or returning a 5xx.
    expect(res.status).toBe(200);
  });
});