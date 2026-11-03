import type { RequestKind, Throttle } from "./throttle";

/**
 * Thrown when a non-idempotent request (e.g. POST create) failed in a way that
 * leaves its outcome unknown — the object may or may not exist in Notion.
 * Callers must reconcile (look for the object) instead of blindly retrying,
 * because the Notion API has no idempotency keys.
 */
export class UncertainOutcomeError extends Error {
  override readonly name = "UncertainOutcomeError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`${method} ${path}: outcome unknown (${reason})`, options);
  }
}

export interface HttpEvent {
  method: string;
  path: string;
  attempt: number;
  status?: number;
  durationMs: number;
  /** Response body for failed requests (truncated). */
  errorBody?: string;
  error?: string;
  retryInMs?: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpPolicyOptions {
  throttle: Throttle;
  fetchImpl?: FetchLike;
  /** Retries for idempotent requests and for 429/409 on any request. */
  maxRetries?: number;
  /** Per-attempt timeout; the SDK's own timeout must be set higher than retries can take. */
  attemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onEvent?: (event: HttpEvent) => void;
}

export interface RequestClass {
  kind: RequestKind;
  idempotent: boolean;
}

const QUERY_PATHS = [
  /^\/data_sources\/[^/]+\/query$/,
  /^\/databases\/[^/]+\/query$/,
  /^\/views\/[^/]+\/queries$/,
  /^\/search$/,
];

/** Decides which rate bucket a request uses and whether it is safe to replay. */
export function classifyRequest(method: string, url: string, body?: unknown): RequestClass {
  const m = method.toUpperCase();
  const path = apiPath(url);
  const isQuery = m === "POST" && QUERY_PATHS.some((re) => re.test(path));
  if (isQuery) return { kind: "query", idempotent: true };
  if (m === "GET" || m === "DELETE") return { kind: "default", idempotent: true };
  if (m === "PATCH") {
    // Appending children or inserting markdown adds content each time it runs.
    if (/^\/blocks\/[^/]+\/children$/.test(path)) return { kind: "default", idempotent: false };
    if (/\/markdown$/.test(path) && typeof body === "string" && body.includes('"insert_content"')) {
      return { kind: "default", idempotent: false };
    }
    return { kind: "default", idempotent: true };
  }
  return { kind: "default", idempotent: false };
}

function apiPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/v1/, "");
  } catch {
    return url;
  }
}

const RETRYABLE_SERVER = new Set([500, 502, 503, 504, 529]);

/**
 * Builds a `fetch` for the Notion SDK (with SDK retries disabled) that applies
 * the shared throttle and a retry policy that never replays a create whose
 * outcome is unknown.
 */
export function createPolicyFetch(opts: HttpPolicyOptions) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const maxRetries = opts.maxRetries ?? 5;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const emit = opts.onEvent ?? (() => {});

  const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + random() * 0.5);

  return async function policyFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const path = apiPath(url);
    const { kind, idempotent } = classifyRequest(method, url, init.body);

    for (let attempt = 0; ; attempt++) {
      const release = await opts.throttle.acquire(kind);
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, { ...init, signal: controller.signal });
      } catch (err) {
        const reason = controller.signal.aborted ? `timed out after ${attemptTimeoutMs}ms` : errorMessage(err);
        emit({ method, path, attempt, durationMs: Date.now() - started, error: reason });
        if (!idempotent) throw new UncertainOutcomeError(method, path, reason, { cause: err });
        if (attempt >= maxRetries) throw err;
        await sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
        release();
      }

      const durationMs = Date.now() - started;
      if (response.ok) {
        emit({ method, path, attempt, status: response.status, durationMs });
        return response;
      }

      const errorBody = await response
        .clone()
        .text()
        .catch(() => "");
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const event: HttpEvent = { method, path, attempt, status: response.status, durationMs, errorBody: errorBody.slice(0, 4000) };

      if (response.status === 429) {
        // A blocked workspace/connection will not recover by waiting.
        if (rateLimitReason(errorBody) === "public_api_request_blocked" || attempt >= maxRetries) {
          emit(event);
          return response;
        }
        const wait = retryAfterMs ?? backoff(attempt);
        opts.throttle.pauseFor(wait);
        opts.throttle.penalize();
        emit({ ...event, retryInMs: wait });
        continue; // 429 means the request was rejected before processing: safe for any method.
      }

      if (response.status === 409) {
        // conflict_error: the transaction was not applied, so replaying is safe.
        if (attempt >= maxRetries) {
          emit(event);
          return response;
        }
        const wait = retryAfterMs ?? backoff(attempt);
        emit({ ...event, retryInMs: wait });
        await sleep(wait);
        continue;
      }

      if (RETRYABLE_SERVER.has(response.status)) {
        if (!idempotent) {
          emit(event);
          throw new UncertainOutcomeError(method, path, `HTTP ${response.status}`);
        }
        if (attempt >= maxRetries) {
          emit(event);
          return response;
        }
        const wait = retryAfterMs ?? backoff(attempt);
        emit({ ...event, retryInMs: wait });
        await sleep(wait);
        continue;
      }

      emit(event);
      return response; // 4xx: not retryable; the SDK turns it into an APIResponseError.
    }
  };
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function rateLimitReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { additional_data?: { rate_limit_reason?: unknown } };
    const reason = parsed.additional_data?.rate_limit_reason;
    return typeof reason === "string" ? reason : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
