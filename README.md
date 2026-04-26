# stripe-founder-mcp

The Stripe co-pilot for indie SaaS founders. Ask your AI about MRR, churn, failed payments, and at-risk customers in plain English — and get answers shaped around the questions a founder actually asks, not raw API dumps.

## The problem

Stripe's API is exhaustive. The Dashboard answers most questions but requires clicking through ten screens. Existing Stripe MCPs are thin CRUD wrappers — they let an AI list charges or retrieve a customer object, but they don't answer founder questions.

This MCP is opinionated. Each tool maps to a question a founder wakes up asking: "What's my MRR?", "Who's about to churn?", "Is dunning recovering my failed payments?" The math is done for you. The output is structured for an LLM to summarize cleanly — headline number first, supporting context after, raw line items last.

## What it looks like in practice

You're in Claude Code or Cursor. You ask:

```
"What's my MRR right now and how does it compare to last month?"
→ $4,820 MRR, up 12.3% from $4,292 last month. 47 active subscriptions.
  3 trials in progress worth $147/mo if they convert.

"Who's at risk of churning this week?"
→ 4 customers, $680 MRR at risk. Top: acme@example.com ($290/mo, 3 failed
  payment attempts, last retry failed 6 hours ago). Two others are past-due.

"How well is dunning recovering failed payments this month?"
→ 50% recovery rate on 14 failed payments. 2 recovered ($20), 2 final
  failures, 10 still in retry. Top unrecovered: $20 from the same customer.
```

No SQL. No dashboard clicking. No manual Stripe API calls.

## Install

**1. Create a Stripe restricted key** with read-only access at [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys). Scopes needed: Customers, Subscriptions, Charges, Invoices, Disputes, PaymentIntents (all read-only).

**2. Add to your MCP client config:**

### Claude Desktop

Config file: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "stripe-founder": {
      "command": "npx",
      "args": ["-y", "stripe-founder-mcp"],
      "env": {
        "STRIPE_API_KEY": "rk_live_..."
      }
    }
  }
}
```

### Cursor

Config file: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "stripe-founder": {
      "command": "npx",
      "args": ["-y", "stripe-founder-mcp"],
      "env": {
        "STRIPE_API_KEY": "rk_live_..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add stripe-founder -- npx -y stripe-founder-mcp
```

Then set your key: add `STRIPE_API_KEY=rk_live_...` to your shell environment or `.env` file.

### Self-hosted / development

```bash
git clone https://github.com/PrimeEcto/stripe-founder-mcp.git
cd stripe-founder-mcp
npm install
cp .env.example .env   # then fill in your STRIPE_API_KEY
npm run dev
```

## Tools

| Tool | What it answers |
|---|---|
| `get_mrr` | Current MRR with delta vs a comparison period and trial pipeline |
| `get_growth_metrics` | New MRR, churned MRR, expansion, net new MRR, and growth rate for a period |
| `get_churn_summary` | Churn count, voluntary vs involuntary, gross/net churn rate, top cancellation reasons |
| `get_failed_payment_recovery_rate` | How well dunning is working — recovery rate, recovered revenue, top unrecovered failures |
| `list_at_risk_customers` | Customers at risk of churning due to past-due status or repeated payment failures |
| `list_recent_signups` | New customers in a date range, with MRR contribution and payment method status |
| `list_disputes` | Open chargebacks with evidence deadlines; or filter to won/lost |
| `get_customer_profile` | Full picture for one customer: LTV, plan, payment status, and 30-event timeline |
| `get_support_context` | Everything needed to handle a support ticket: risk flags, refund-eligible charges, prioritized timeline |

All tools accept human-readable date ranges: `"last_30_days"`, `"this_month"`, `"2026-Q1"`, `"March 2026"`, or explicit ISO ranges.

## Safety

- **Read-only by design.** This server never creates, modifies, or deletes Stripe resources. A runtime guard blocks any non-GET Stripe request at the HTTP client level.
- **Restricted key recommended.** Use `rk_live_...` scoped to the specific read permissions listed above, not your full secret key.
- **Test mode auto-detected.** If your key starts with `sk_test_` or `rk_test_`, every tool response includes `"stripe_mode": "test"` so you never confuse environments.
- **No telemetry.** No data leaves your machine beyond the calls to Stripe's API. No analytics, no logging to external services.

## Hosted version

Don't want to manage your own install? stripe-founder-mcp is available as a managed hosted MCP at [MCPize](https://mcpize.com/mcp/stripe-founder-mcp). You provide your Stripe key; they handle the infrastructure.

## Contributing

Issues and pull requests are welcome. If you find a bug, open an issue with the tool name, the input you passed, and what you expected vs what you got. If you want to add a tool, read `AGENTS.md` and `SPEC.md` first — the project has strong opinions on what belongs here.

## License

[MIT](./LICENSE)
