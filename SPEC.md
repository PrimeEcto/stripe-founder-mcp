# SPEC.md

Product specification for `stripe-founder-mcp` v1.

## Audience

Solo SaaS founders and small teams (1–5 people) who:
- Run their billing through Stripe
- Use Claude Code, Cursor, ChatGPT, or another MCP client daily
- Want to ask questions about their business in natural language without opening the Stripe Dashboard
- Are not data analysts and don't want to write SQL or Sigma queries

## Positioning vs alternatives

| | Stripe Dashboard | Stripe Sigma | `stripe-subscription-whisperer` (existing MCP) | **stripe-founder-mcp** |
|---|---|---|---|---|
| Natural language | No | No | Limited (5 tools) | Yes (13 tools, founder-shaped) |
| Setup time | None | Requires SQL knowledge | Minutes | Minutes |
| Founder workflows baked in | No | No | No | Yes |
| Cohort / churn math | Manual | Yes (you write SQL) | No | Yes |

The wedge is **opinionated tools**. We don't expose Stripe's API; we expose the questions a founder asks, with the math done correctly.

## Tools (v1) — 13 total

Each tool below is defined by:
- **What it answers** (the founder question)
- **Input** (zod schema fields, briefly)
- **Output** (key fields in `summary` / `context` / `items`)

---

### 1. `get_mrr`

**Answers:** "What is my MRR right now?"

**Input:**
- `as_of` (optional ISO date or relative string; default = now)
- `compare_to` (optional, default = "last_month") — controls the delta

**Output:**
- `summary`: `mrr_cents`, `mrr_formatted`, `currency`, `delta_vs_compare_cents`, `delta_pct`, `active_subscriptions_count`
- `context`: `compare_period_label`, `as_of_iso`, `stripe_mode`, `caveats`
- `items`: empty (this is a single-number tool)

---

### 2. `get_revenue_breakdown`

**Answers:** "Show me my revenue for [period], broken down by [dimension]."

**Input:**
- `period` (required): ISO range or relative string
- `group_by` (required, enum): `"plan"` | `"interval"` | `"country"` | `"day"` | `"week"` | `"month"`
- `currency` (optional): if you have multi-currency, filter to one

**Output:**
- `summary`: total recognized revenue (cents + formatted), refund amount, net revenue
- `context`: period label, currency, stripe_mode, number of charges included
- `items`: array of `{ key, label, gross_cents, refund_cents, net_cents, formatted }`

---

### 3. `get_growth_metrics`

**Answers:** "How are we growing this month?"

**Input:**
- `period` (optional, default = "this_month")

**Output:**
- `summary`: `mrr_start_cents`, `mrr_end_cents`, `new_mrr`, `expansion_mrr`, `contraction_mrr`, `churned_mrr`, `net_new_mrr`, `growth_rate_pct`, `gross_churn_rate_pct`, `net_churn_rate_pct`
- `context`: period label, stripe_mode, caveats (e.g. "expansion is computed from subscription item quantity changes")
- `items`: empty

---

### 4. `find_customer`

**Answers:** "Find <person>." Lightweight search across email, name, Stripe customer ID, and metadata.

**Input:**
- `query` (required): string

**Output:**
- `summary`: `match_count`, `exact_match` (bool — true if email or ID exact match)
- `context`: stripe_mode, search fields used, caveats
- `items`: array of `{ id, email, name, created_iso, current_subscription_status, ltv_cents }`. Cap at 10 results.

---

### 5. `get_customer_summary`

**Answers:** "Tell me everything about this customer."

**Input:**
- `customer` (required): email or Stripe customer ID

**Output:**
- `summary`: `customer_id`, `email`, `name`, `ltv_cents`, `ltv_formatted`, `subscription_status`, `current_plan`, `mrr_contribution_cents`, `customer_since_iso`, `tenure_days`
- `context`: stripe_mode, payment_method_status, default_payment_method_last4
- `items`: an array combining recent charges, recent invoices, recent subscription events — chronologically sorted, capped at 30 most recent. Each item has `type`, `occurred_at_iso`, `amount_cents` (if applicable), `status`, `description`.

---

### 6. `list_at_risk_customers`

**Answers:** "Who's about to churn?"

**Input:**
- `risk_signals` (optional, default = `["past_due", "payment_failed", "multiple_failed_attempts"]`) — array of enum
- `limit` (optional, default = 25)

**Output:**
- `summary`: `at_risk_count`, `total_mrr_at_risk_cents`, `total_mrr_at_risk_formatted`
- `context`: signals applied, stripe_mode
- `items`: array of `{ customer_id, email, mrr_cents, risk_signal, signal_detail, last_payment_attempt_iso, retry_remaining }`, sorted by MRR at risk descending

---

### 7. `list_recent_signups`

**Answers:** "Who signed up recently?"

**Input:**
- `period` (optional, default = "last_7_days")
- `limit` (optional, default = 50)
- `min_mrr_cents` (optional): only include subscribed customers above this MRR

**Output:**
- `summary`: `signup_count`, `paid_signup_count`, `total_new_mrr_cents`, `total_new_mrr_formatted`
- `context`: period label, stripe_mode
- `items`: array of `{ customer_id, email, name, signed_up_iso, current_plan, mrr_cents, payment_method_attached }`, newest first

---

### 8. `list_failed_payments`

**Answers:** "What payments failed recently?"

**Input:**
- `period` (optional, default = "last_7_days")
- `recovery_state` (optional, enum): `"any"` | `"unrecovered"` | `"recovered"` | `"final"`
- `limit` (optional, default = 50)

**Output:**
- `summary`: `failed_count`, `unrecovered_count`, `recovered_count`, `total_failed_amount_cents`, `total_recovered_amount_cents`
- `context`: period label, stripe_mode
- `items`: array of `{ payment_intent_id, customer_id, customer_email, amount_cents, failure_code, failure_message, attempted_at_iso, current_state, retry_scheduled_for_iso }`, sorted newest first

---

### 9. `get_failed_payment_recovery_rate`

**Answers:** "How well is dunning working?"

**Input:**
- `period` (optional, default = "last_30_days")

**Output:**
- `summary`: `total_failed_count`, `recovered_count`, `final_failure_count`, `still_in_retry_count`, `recovery_rate_pct`, `recovered_revenue_cents`, `recovered_revenue_formatted`
- `context`: period label, stripe_mode, caveats (e.g. "recovery rate excludes payments still in retry")
- `items`: empty

---

### 10. `list_disputes`

**Answers:** "What disputes are open?"

**Input:**
- `status` (optional, enum, default = `"actionable"`): `"actionable"` | `"all"` | `"won"` | `"lost"`
- `period` (optional, default = "last_90_days")

**Output:**
- `summary`: `open_count`, `total_disputed_amount_cents`, `won_count_in_period`, `lost_count_in_period`
- `context`: status filter, period label, stripe_mode
- `items`: array of `{ dispute_id, customer_id, customer_email, amount_cents, reason, status, evidence_due_by_iso, created_iso }`

---

### 11. `list_subscriptions`

**Answers:** "Show me subscriptions in <state>."

**Input:**
- `status` (optional, enum, default = `"active"`): `"active"` | `"trialing"` | `"past_due"` | `"canceled"` | `"paused"` | `"all"`
- `plan` (optional): filter by Stripe price ID or product nickname
- `period` (optional): if status is `"canceled"`, filter to cancellations within this window
- `limit` (optional, default = 100)

**Output:**
- `summary`: `count`, `total_mrr_cents`, `total_mrr_formatted`, distribution map by plan
- `context`: status filter, stripe_mode
- `items`: array of `{ subscription_id, customer_id, customer_email, plan, status, mrr_cents, current_period_end_iso, cancel_at_period_end }`

---

### 12. `get_churn_summary`

**Answers:** "What's my churn looking like, and why?"

**Input:**
- `period` (optional, default = "this_month")

**Output:**
- `summary`: `total_churned_count`, `voluntary_count`, `involuntary_count`, `churned_mrr_cents`, `gross_churn_rate_pct`, `net_churn_rate_pct`
- `context`: period label, stripe_mode, caveats
- `items`: array of `{ reason, count, mrr_cents }` aggregating Stripe's `cancellation_details.reason` and `cancellation_details.feedback`. Top 10 reasons.

---

### 13. `summarize_customer_for_support`

**Answers:** "Give me everything I need to handle a support ticket from this person."

**Input:**
- `customer` (required): email or Stripe customer ID
- `context_hint` (optional): free text from the support ticket, used to bias which historical events surface in `items`

**Output:**
- `summary`: same headline fields as `get_customer_summary`, plus `flags`: array of strings like `"in_dunning"`, `"recent_dispute"`, `"trial_ending_soon"`, `"high_value"`, `"new_customer"`
- `context`: stripe_mode, payment_method_status, refund_eligibility (last 60d charges)
- `items`: chronologically sorted recent events, with type-aware filtering biased by `context_hint` keywords (e.g. if hint mentions "refund", include all refund-eligible charges first)

---

## Out of scope for v1 (intentional)

These are good v2 candidates, listed so we know what we're saying no to right now:

- Drafting dunning emails (LLM job, not MCP job — but providing the data is in scope)
- Cohort retention analysis (heavy compute; v2)
- Multi-currency consolidation (v1 returns each currency in its own line; v2 normalizes)
- Webhook ingestion (we're poll-only against Stripe API in v1)
- Any write operations (refund, cancel, retry — v2 once read-only is trusted)
- Comparison to industry benchmarks (no data source; not building one)
- Forecasting / projections (model-side job)

## Pricing and distribution (post-build, not for Codex)

- Distribute on **MCPize** for monetization (85% rev share, hosted) and **GitHub** for self-host install
- **Free tier:** 200 calls/month, never expires
- **Pro:** $14/month for 5,000 calls + $5 per 1,000 overage
- The Stripe key is provided by the user, so we have no Stripe-side cost beyond hosting on MCPize
