import { Client } from "@notionhq/client";
import { createPolicyFetch, type HttpEvent } from "./httpPolicy";
import { Throttle } from "./throttle";

/** Pinned API version; see docs/api-findings.md before changing it. */
export const NOTION_VERSION = "2026-03-11";

export interface NotionClientOptions {
  token: string;
  /** Per-connection budget; 180/min on most plans, 600/min on Business/Enterprise. */
  rateLimitPerMinute?: number;
  onHttpEvent?: (event: HttpEvent) => void;
}

/**
 * Creates the SDK client with its built-in retries disabled. All requests go
 * through one throttled policy fetch, so rate limits are shared and creates are
 * never replayed blindly (see httpPolicy.ts).
 */
export function createNotionClient(opts: NotionClientOptions): Client {
  const perMinute = opts.rateLimitPerMinute ?? 180;
  const throttle = new Throttle({ ratePerSec: (perMinute / 60) * 0.9 });
  const policyFetch = createPolicyFetch({ throttle, onEvent: opts.onHttpEvent });
  return new Client({
    auth: opts.token,
    notionVersion: NOTION_VERSION,
    retry: false,
    // Errors surface as exceptions with hints; HTTP detail goes to the --debug log instead.
    logger: () => {},
    // Per-attempt timeouts live in the policy; this only bounds retries + Retry-After waits.
    timeoutMs: 15 * 60_000,
    fetch: policyFetch as unknown as NonNullable<ConstructorParameters<typeof Client>[0]>["fetch"],
  });
}
