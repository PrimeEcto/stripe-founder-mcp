import type Stripe from "stripe";

import { customerEmailFromExpandable } from "./stripe_records.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

export interface ResolvedCustomerSearch {
  caveats: string[];
  exact_match: boolean;
  items: Stripe.Customer[];
  search_fields: string[];
}

function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseMetadataQuery(query: string): { key: string; value: string } | undefined {
  const match = query.trim().match(/^(?:metadata[.\[])?([a-zA-Z0-9_-]+)[\]\.]?:(.+)$/);
  if (!match) {
    return undefined;
  }

  const key = match[1]?.trim();
  const value = match[2]?.trim();
  if (!key || !value) {
    return undefined;
  }

  return { key, value };
}

function shouldUseLocalFallback(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length >= 2 && !trimmed.includes("@") && !trimmed.includes(":");
}

async function localFuzzyFallback(stripe: Stripe, query: string): Promise<Stripe.Customer[]> {
  const stripeClient = getStripeClientContext();
  const collection = await stripeClient.getCachedToolResult(
    "find_customer:local_fallback",
    { query },
    async () =>
      collectAutoPaged(
        stripe.customers.list({
          expand: ["data.invoice_settings.default_payment_method"],
          limit: 100
        }),
        200
      )
  );

  const fragment = query.trim().toLowerCase();

  return collection.items.filter((customer) => {
    const haystacks = [
      customer.email ?? "",
      customer.name ?? "",
      ...Object.values(customer.metadata ?? {})
    ].map((value) => value.toLowerCase());

    return haystacks.some((value) => value.includes(fragment));
  });
}

function buildSearchQuery(query: string): { searchFields: string[]; searchQuery: string } {
  const trimmed = query.trim();
  const metadataQuery = parseMetadataQuery(trimmed);
  if (metadataQuery) {
    return {
      searchFields: [`metadata["${metadataQuery.key}"]`],
      searchQuery: `metadata["${metadataQuery.key}"]:"${escapeSearchValue(metadataQuery.value)}"`
    };
  }

  const escaped = escapeSearchValue(trimmed);
  return {
    searchFields: ["email", "name"],
    searchQuery: `email:"${escaped}" OR name:"${escaped}"`
  };
}

// Resolver precedence:
// 1. Exact Stripe customer ID
// 2. Exact email match via customers.list({ email })
// 3. Stripe Search API
// 4. Optional local fuzzy fallback when Search returns no results and the input is a bare fragment
export async function resolveCustomersByQuery(
  query: string,
  limit = 10
): Promise<ResolvedCustomerSearch> {
  const stripe = getStripeClientContext().stripe;
  const trimmed = query.trim();

  if (/^cus_[A-Za-z0-9]+$/.test(trimmed)) {
    const customer = await stripe.customers.retrieve(trimmed, {
      expand: ["invoice_settings.default_payment_method"]
    });

    if (!("deleted" in customer)) {
      return {
        caveats: [],
        exact_match: true,
        items: [customer],
        search_fields: ["id"]
      };
    }
  }

  const exactEmailMatches = await stripe.customers.list({
    email: trimmed,
    expand: ["data.invoice_settings.default_payment_method"],
    limit
  });

  if (exactEmailMatches.data.length > 0) {
    return {
      caveats: [],
      exact_match: true,
      items: exactEmailMatches.data.filter((customer) => customer.email === trimmed),
      search_fields: ["email"]
    };
  }

  const search = buildSearchQuery(trimmed);
  const searchResults = await stripe.customers.search({
    expand: ["data.invoice_settings.default_payment_method"],
    limit,
    query: search.searchQuery
  });

  if (searchResults.data.length > 0) {
    return {
      caveats: [
        "Stripe Search API results are usually current within a minute, but can lag during outages."
      ],
      exact_match: false,
      items: searchResults.data,
      search_fields: search.searchFields
    };
  }

  if (shouldUseLocalFallback(trimmed)) {
    const fuzzyMatches = await localFuzzyFallback(stripe, trimmed);
    return {
      caveats: ["Used local fuzzy fallback after Stripe Search returned no results."],
      exact_match: false,
      items: fuzzyMatches.slice(0, limit),
      search_fields: ["email", "name", "metadata"]
    };
  }

  return {
    caveats: [
      "Stripe Search API results are usually current within a minute, but can lag during outages."
    ],
    exact_match: false,
    items: [],
    search_fields: search.searchFields
  };
}

export async function resolveSingleCustomer(query: string): Promise<Stripe.Customer> {
  const result = await resolveCustomersByQuery(query, 5);

  if (result.exact_match && result.items.length > 0) {
    return result.items[0]!;
  }

  if (result.items.length === 1) {
    return result.items[0]!;
  }

  if (result.items.length === 0) {
    throw new Error(`No customer found for query: ${query}`);
  }

  const candidates = result.items
    .map((c) => `${c.id} (${c.email ?? "no email"}) - ${c.name ?? "no name"}`)
    .join(", ");

  throw new Error(
    `Ambiguous customer match for "${query}". Found ${result.items.length} candidates. Please refine your search. Candidates: ${candidates}`
  );
}

export function buildCustomerDisplayName(customer: Stripe.Customer): string {
  return customer.name ?? customer.email ?? customer.id;
}

export function buildCustomerSearchItem(customer: Stripe.Customer): {
  created_iso: string | null;
  email: string | null;
  id: string;
  name: string | null;
} {
  return {
    created_iso: new Date(customer.created * 1000).toISOString(),
    email: customerEmailFromExpandable(customer),
    id: customer.id,
    name: customer.name ?? null
  };
}
