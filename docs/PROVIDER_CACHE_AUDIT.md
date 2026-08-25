# Provider Prompt-Cache Audit & Design (PC-1 … PC-4)

Audit of how ContextForge interacts with the **provider-side** prompt caches
(Anthropic `cache_control`, OpenAI automatic caching), and the design that
ensures ContextForge **adds cache value instead of destroying it**.

## Provider semantics (per provider docs)

| | Anthropic | OpenAI |
|---|---|---|
| Mechanism | Explicit `cache_control: {type:"ephemeral"}` breakpoints (max 4) | Automatic for stable prefixes ≥1024 tokens |
| Pricing | write 1.25× (5-min TTL) / 2× (1h TTL); **read 0.1×** | no write premium; **cached 0.1×** |
| Routing hint | `metadata.user_id` keys part of the routing | `prompt_cache_key` (optional routing hint), `prompt_cache_retention` ("24h" for long gaps) |
| Hit signal | `usage.cache_read_input_tokens` / `cache_creation_input_tokens` | `usage.prompt_tokens_details.cached_tokens` |
| Bust cause | ANY byte change inside the marked prefix (timestamps, reordering, tool-array churn) | Any prefix byte change; the new prefix re-caches from the change point |

Both caches are **prefix caches**: everything up to the breakpoint (Anthropic)
or up to the first changed byte (OpenAI) must be byte-identical across
requests for a hit.

## What was wrong before (PC-1/PC-2 findings)

1. **Anthropic sessions got zero cache hits.** The anthropic provider sent
   our OpenAI-format body to Anthropic's OpenAI-compat endpoint, which does
   **not** support prompt caching — while Claude Code (the client) was
   paying full input price every turn and setting `cache_control` markers
   that we silently dropped during `toInternal` translation. We were
   destroying the provider's caching for no benefit.
2. **Tool-array churn busted the prefix.** `contextforge_retrieve` appeared
   in the tools array only while the CCR session had *unretrieved* vaults,
   so it disappeared from the array after retrieval — a tools-array change
   inside the cached prefix busts the Anthropic cache for the next turn.
3. **OpenAI routing hint missing.** No `prompt_cache_key` (A2 added a
   per-session key; this audit added `prompt_cache_retention` opt-in and
   client-key preservation).

## What was done

### PC-1 — native Anthropic egress (`CF_ANTHROPIC_NATIVE=1`, `src/proxy/anthropicNative.js`)
- The client's **original** system blocks and tools — including every
  `cache_control` breakpoint and tool-level marker — are forwarded
  **byte-verbatim** (the raw client body is captured pre-translation in
  `server.js` and passed to the egress builder).
- ContextForge's additions are **appended AFTER** the client's marked
  prefix: the CF rule as a trailing system block (no marker — outside the
  client's up-to-4 breakpoints, so it costs 1.0× input and never busts
  the client's cache), and the CF tools after the client's tools (stable
  order, no markers).
- `metadata`, `thinking`, `max_tokens`, `temperature`, `top_p`,
  `stop_sequences`, `service_tier`, `anthropic-beta` (1h-TTL beta header)
  pass through untouched — `metadata.user_id` matters for Anthropic cache
  routing.
- Responses (streaming SSE and JSON) pass through **event-verbatim** — no
  re-serialization, no reformatting — including native usage, so
  `cache_read_input_tokens` lands in ContextForge metrics and dashboard.
- The Ghost Interceptor works over the native wire: background `tool_use`
  blocks are detected from the stream, executed locally, and the re-hop is
  re-serialized natively with the same verbatim-prefix guarantee.
- Off by default: existing gateway/compat users are unaffected
  (compat stays the default egress for `CF_PROVIDER=anthropic`).

### PC-2 — `prompt_cache_retention` (OpenAI-wire)
`CF_PROMPT_CACHE_RETENTION=5m|24h` opts in to OpenAI's long cache
retention for workloads with long gaps between turns; a client-sent
`prompt_cache_retention` is always preserved; a client-sent
`prompt_cache_key` is always preserved (the proxy only fills in when
absent). Never sent on the native Anthropic wire (markers key the cache
there, not a routing key).

### PC-3 — monotonic retrieve-tool stickiness (`src/ccr/sessionRegistry.js`)
Once a conversation has ever produced a compressed/vaulted payload,
`contextforge_retrieve` stays in the tools array for the rest of the
session (per-session flag, never leaks across conversations). Tool
availability is now **append-only** — no more mid-session array shrink
busting the provider's cached prefix.

### PC-4 — message-conversion byte fidelity (`anthropicNative.js`)
- Standalone user text messages stay **strings** on the wire (byte-identical
  to the client's form); block arrays only appear where merging forces
  them (consecutive same-role messages, tool results).
- Known limitation (documented, v2 candidate): message-**level**
  `cache_control` markers (breakpoints on individual messages) do not
  survive the internal OpenAI-format round-trip. System + tools markers —
  where Claude Code actually places its breakpoints and where ~all of the
  cached prefix lives — are preserved verbatim.

## Economics note (why history compression is still right)

Compression rewrites history → a one-time prefix change per content
change, after which the wire is byte-stable and the provider re-caches.
At Anthropic's 1.25× write premium, the bust pays back after ~1–2 turns
of a live session (each subsequent turn bills the compressed tokens at
0.1× instead of the original tokens at 0.1×). The invariant this design
guarantees: **ContextForge never adds churn the content change didn't
already cause** — every byte it adds (CF rule, CF tools, prompt_cache_key)
is byte-stable for the life of the session, and every byte it rewrites is
deterministic (same content in → same bytes out), so the prefix re-caches
on the next turn.

## Tests

- `tests/cache-audit/test_native_cache.mjs` — 21 checks: verbatim
  system/tools across turns+hops, marker preservation, append-only CF
  additions, native ghost interception, usage→metrics, header hygiene,
  env gate.
- `tests/cache-audit/test_compat_mode.mjs` — 9 checks: compat default
  unchanged (OpenAI path/body shape), `prompt_cache_key` stable across
  turns, retention opt-in, prefix byte-stability on the OpenAI wire.
- `tests/cache-audit/mock_native_upstream.mjs` / `mock_capture_upstream.mjs`
  — recording upstream mocks (native SSE + OpenAI-compat).
- `tests/cache-audit/provision.sh` — idempotent environment provisioner.
