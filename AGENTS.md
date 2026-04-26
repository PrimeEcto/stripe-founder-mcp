# AGENTS.md

You are building `stripe-founder-mcp`, a Model Context Protocol server for Stripe analytics aimed at indie SaaS founders. Read `SPEC.md` for full product detail before starting any task. This file describes how to work in this repo.

## Project mission

Each tool answers a founder question, not an API endpoint. "What's my MRR?" is a tool; "list all subscriptions paginated" is not. Outputs are structured for an LLM to summarize cleanly — headline number first, supporting context after, raw line items last.

## Tech stack (firm)

- **Language:** TypeScript, ES modules, Node 20+
- **MCP framework:** `fastmcp` (TypeScript)
- **Stripe SDK:** official `stripe` Node SDK
- **Schema validation:** `zod`
- **Tests:** `vitest`
- **Transport:** stdio for local install, with the same server able to run over Streamable HTTP. Do not use SSE — it is deprecated.

## Repo structure

```
src/
  index.ts              # entrypoint: parse env, build server, start
  server.ts             # FastMCP server construction + tool registration
  stripe/
    client.ts           # Stripe SDK wrapper, key validation, mode detection
    cache.ts            # small LRU keyed by tool+args, TTL from env
    pagination.ts       # safe auto-pagination helpers
  tools/
    <one file per tool> # e.g. get_mrr.ts, get_customer_summary.ts
    index.ts            # exports an array of all tools
  lib/
    dates.ts            # date range parsing, month/period math, UTC normalization
    money.ts            # consistent money formatting + currency handling
    types.ts            # shared types
tests/
  unit/                 # one file per tool: schema validation + pure logic
  integration/          # uses Stripe test mode; gated by STRIPE_API_KEY env
```

One tool per file. Each file exports a single FastMCP tool definition.

## Tool authoring conventions

Every tool follows this shape:

1. A `zod` input schema with a clear `.describe()` on each field — these descriptions are what the LLM sees and uses to call the tool. Make them precise.
2. A handler that fetches from Stripe via the cached client, never directly.
3. A return value that is **typed JSON**, not a string blob. Use this shape:
   ```ts
   {
     summary: { /* headline numbers, 3-7 fields max */ },
     context: { /* supporting metrics, comparisons, caveats */ },
     items: [ /* raw line-level data, capped at a sane default */ ]
   }
   ```
4. Money is always returned in two fields: `amount_cents` (integer) and `formatted` (string with currency symbol). Never return floats for money.
5. Dates are always ISO 8601 strings in UTC. Accept human inputs ("last 30 days", "2026-Q1", "March 2026") and normalize internally.

## Stripe specifics

- Use restricted-key auth. Validate the key prefix on startup; refuse to start on an unrecognized prefix.
- Detect mode (`test` / `live`) from the key prefix and surface it in every tool response under `context.stripe_mode` so users never confuse environments.
- Use `auto_paging_each` from the Stripe SDK for any list operation. Cap auto-paginated results at a reasonable per-tool maximum and indicate truncation in `context.truncated` if hit.
- Use `expand` aggressively to avoid N+1 calls (e.g. expanding `latest_invoice.payment_intent` on subscriptions).
- For MRR / churn / cohort math: use `Subscription` + `Subscription.items` data for active state, and the `customer.subscription.deleted` and `invoice.payment_failed` events for historical churn. Stripe also exposes `BillingMeterEvent` and the Sigma-style summary endpoints — prefer those when accuracy matters more than recency.
- All time-series queries should accept either an explicit `[start, end]` ISO range or a relative range string ("last_30_days", "this_month", "last_month", "ytd", "<N>_months_ago", "<N>_days_ago").

## Safety

- v1 is **read-only**. No tool should call any Stripe method that mutates state. Add a runtime guard in the Stripe client wrapper that throws on any non-`GET` Stripe request and write a test for it.
- Never log full API responses. Log tool name, input shape, duration, and result counts — not raw customer or payment data.

## Caching

Implement a tiny in-memory LRU. Default TTL 60s, configurable via `CACHE_TTL_SECONDS`. Cache key = `<tool_name>:<sorted_json(args)>`. Disable cache when `CACHE_TTL_SECONDS=0`.

## Commands

- `npm run dev` — runs the server via tsx in stdio mode, useful for local testing
- `npm run build` — compile TS to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint over `src/` and `tests/`
- `npm test` — Vitest unit suite (no network)
- `npm run test:integration` — Vitest integration suite, requires `STRIPE_API_KEY` in `.env`

## Testing strategy

- **Unit tests** are mandatory for every tool: schema validation (good and bad inputs), date-range parsing, money formatting, pagination behavior, cache hit/miss. Mock the Stripe SDK; never hit the network in unit tests.
- **Integration tests** run against Stripe test mode. They populate the test account with a small fixture (a few customers, subscriptions, charges, a failed payment, a dispute) using the Stripe SDK, then exercise each tool end-to-end and assert on shape, not exact numbers. Tear down after each run.
- A failing test blocks completion. Do not skip or `.todo` tests to mark a task done.

## Definition of done (per tool)

A tool is done when:
1. Input schema exists with `.describe()` on every field.
2. Handler is implemented and returns the `{summary, context, items}` shape.
3. Unit tests pass: schema validation, happy path with mocked Stripe, at least one error path.
4. Integration test passes against Stripe test mode.
5. The tool is registered in `src/tools/index.ts`.
6. README's tool table reflects the tool.
7. `npm run typecheck && npm run lint && npm test` all pass.

## Definition of done (project v1)

All 13 tools listed in `SPEC.md` complete to the per-tool definition above, plus:

- Server starts cleanly under `npm run dev` with a valid `STRIPE_API_KEY` in `.env`.
- Built `dist/` runs as a CLI: `node dist/index.js` works as the MCP stdio entrypoint.
- `bin` field in `package.json` is wired so `npx stripe-founder-mcp` works after publish.
- A `mcp-config-example.json` snippet in the README that users can paste into Claude Desktop / Cursor / Claude Code config.
- Integration tests pass green against a fresh Stripe test account using only `STRIPE_API_KEY`.

## What not to do

- Do not add a database. State lives in Stripe; we are a stateless adapter.
- Do not add a web dashboard. This is an MCP server, full stop.
- Do not add a custom auth layer. The Stripe key is the auth.
- Do not add OpenAI / Anthropic SDK calls. The LLM lives in the MCP client; this server is pure data.
- Do not invent metrics. If something can't be computed precisely from Stripe data, say so in the tool's `context.caveats` field rather than estimating silently.
