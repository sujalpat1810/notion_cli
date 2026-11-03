import { describe, expect, it, vi } from "vitest";
import { classifyRequest, createPolicyFetch, parseRetryAfter, UncertainOutcomeError } from "../../src/notion/httpPolicy";
import { Throttle } from "../../src/notion/throttle";

const API = "https://api.notion.com/v1";

function setup(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const throttle = new Throttle({ ratePerSec: 1000, burst: 1000, maxConcurrent: 10, sleep: async () => {} });
  const pauseFor = vi.spyOn(throttle, "pauseFor");
  const policyFetch = createPolicyFetch({
    throttle,
    fetchImpl,
    maxRetries: 2,
    random: () => 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { policyFetch, calls, sleeps, pauseFor };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("classifyRequest", () => {
  it.each([
    ["GET", "/pages/x", "default", true],
    ["DELETE", "/blocks/x", "default", true],
    ["POST", "/data_sources/x/query", "query", true],
    ["POST", "/views/x/queries", "query", true],
    ["POST", "/search", "query", true],
    ["PATCH", "/pages/x", "default", true],
    ["PATCH", "/data_sources/x", "default", true],
    ["PATCH", "/blocks/x/children", "default", false],
    ["POST", "/pages", "default", false],
    ["POST", "/databases", "default", false],
    ["POST", "/views", "default", false],
    ["POST", "/file_uploads/x/send", "default", false],
  ])("%s %s → %s, idempotent=%s", (method, path, kind, idempotent) => {
    expect(classifyRequest(method, `${API}${path}`)).toEqual({ kind, idempotent });
  });

  it("treats markdown insert_content as non-idempotent but replace_content as safe", () => {
    expect(classifyRequest("PATCH", `${API}/pages/x/markdown`, '{"type":"insert_content"}').idempotent).toBe(false);
    expect(classifyRequest("PATCH", `${API}/pages/x/markdown`, '{"type":"replace_content"}').idempotent).toBe(true);
  });
});

describe("createPolicyFetch", () => {
  it("returns successful responses untouched", async () => {
    const { policyFetch, calls } = setup([json(200, { ok: true })]);
    const res = await policyFetch(`${API}/pages/x`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 on a create, honouring Retry-After as a global pause", async () => {
    const { policyFetch, calls, pauseFor } = setup([
      json(429, { code: "rate_limited", message: "slow down" }, { "retry-after": "2" }),
      json(200, { id: "p" }),
    ]);
    const res = await policyFetch(`${API}/pages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(pauseFor).toHaveBeenCalledWith(2000);
  });

  it("does not retry when the rate-limit reason is public_api_request_blocked", async () => {
    const { policyFetch, calls } = setup([
      json(429, { code: "rate_limited", additional_data: { rate_limit_reason: "public_api_request_blocked" } }),
    ]);
    const res = await policyFetch(`${API}/pages/x`, { method: "GET" });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("retries 5xx for idempotent requests with backoff", async () => {
    const { policyFetch, calls, sleeps } = setup([json(503, {}), json(502, {}), json(200, {})]);
    const res = await policyFetch(`${API}/pages/x`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after maxRetries and returns the last error response", async () => {
    const { policyFetch, calls } = setup([json(500, {}), json(500, {}), json(500, {})]);
    const res = await policyFetch(`${API}/pages/x`, { method: "GET" });
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it("never replays a create after a 5xx: throws UncertainOutcomeError", async () => {
    const { policyFetch, calls } = setup([json(504, {}), json(200, {})]);
    await expect(policyFetch(`${API}/pages`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(UncertainOutcomeError);
    expect(calls).toHaveLength(1);
  });

  it("never replays a create after a network error", async () => {
    const { policyFetch, calls } = setup([new TypeError("fetch failed"), json(200, {})]);
    await expect(policyFetch(`${API}/databases`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(UncertainOutcomeError);
    expect(calls).toHaveLength(1);
  });

  it("retries a network error on a safe request", async () => {
    const { policyFetch, calls } = setup([new TypeError("fetch failed"), json(200, {})]);
    const res = await policyFetch(`${API}/data_sources/x/query`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("retries a 409 conflict even for creates (the write was not applied)", async () => {
    const { policyFetch, calls } = setup([json(409, { code: "conflict_error" }), json(200, {})]);
    const res = await policyFetch(`${API}/pages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("passes 4xx validation errors straight through", async () => {
    const { policyFetch, calls } = setup([json(400, { code: "validation_error" })]);
    const res = await policyFetch(`${API}/pages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and ignores junk", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
