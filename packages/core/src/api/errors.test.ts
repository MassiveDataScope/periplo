import { describe, expect, it } from "vitest";
import { ApiError, networkError, normalizeError } from "./errors";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("normalizeError", () => {
  it("reads the Loom envelope for a missing entity", async () => {
    const error = await normalizeError(
      json(404, { detail: { code: "not_found", message: "Table orders not found", trace_id: "t-1", entity: "Table", id: "orders" } }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: "not_found",
      message: "Table orders not found",
      traceId: "t-1",
      entity: "Table",
      entityId: "orders",
      retryable: false,
      violations: [],
    });
  });

  it("reads Loom rule violations", async () => {
    const error = await normalizeError(
      json(422, { detail: { code: "rule_violations", message: "Invalid", trace_id: "t-2", violations: [{ field: "sql", message: "too long" }, { bogus: 1 }] } }),
    );
    expect(error.violations).toEqual([{ field: "sql", message: "too long" }]);
  });

  it("reads the post-commit flag and the authentication status", async () => {
    expect((await normalizeError(json(500, { detail: { code: "post_commit_failure", message: "x", committed: true } }))).committed).toBe(true);
    expect(await normalizeError(json(401, { detail: { code: "unauthenticated", message: "Login required" } }))).toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
  });

  it("turns FastAPI body validation into violations", async () => {
    const error = await normalizeError(
      json(422, { detail: [{ loc: ["body", "max_rows"], msg: "Input should be less than 100001", type: "less_than_equal" }] }),
    );
    expect(error).toMatchObject({ status: 422, code: "validation_error" });
    expect(error.violations).toEqual([{ field: "body.max_rows", message: "Input should be less than 100001" }]);
  });

  it("reads the flat Periplo body, inside or outside the envelope", async () => {
    const flat = await normalizeError(
      json(429, { code: "capacity", message: "Too many queries", query_id: "q-1", retryable: true }, { "retry-after": "1" }),
    );
    expect(flat).toMatchObject({ code: "capacity", queryId: "q-1", retryable: true, retryAfterSeconds: 1 });

    const wrapped = await normalizeError(json(504, { detail: { code: "timeout", message: "Timed out", query_id: "q-2", retryable: false } }));
    expect(wrapped).toMatchObject({ code: "timeout", queryId: "q-2", retryable: false });
  });

  it("falls back to the query id header and to status-based retryability", async () => {
    const error = await normalizeError(json(503, { detail: { code: "storage", message: "S3 unavailable" } }, { "x-query-id": "q-3" }));
    expect(error).toMatchObject({ queryId: "q-3", retryable: true });
  });

  it("never exposes or chokes on non-conforming bodies", async () => {
    const html = await normalizeError(new Response("<html><h1>502 Bad Gateway</h1>secret-internal</html>", { status: 502 }));
    expect(html).toMatchObject({ status: 502, code: "http_502", violations: [] });
    expect(html.message).not.toContain("secret-internal");

    expect(await normalizeError(new Response(null, { status: 500 }))).toMatchObject({ code: "http_500" });
    expect(await normalizeError(new Response("{not json", { status: 400 }))).toMatchObject({ code: "http_400" });
    expect(await normalizeError(json(400, { detail: { code: 7, message: { nested: true } } }))).toMatchObject({ code: "http_400" });
    expect(await normalizeError(json(400, ["unexpected"]))).toMatchObject({ code: "http_400" });
    expect(await normalizeError(json(418, { detail: "I am a teapot" }))).toMatchObject({ code: "http_418", message: "I am a teapot" });
  });

  it("does not throw when the body cannot be read", async () => {
    const response = new Response("x", { status: 500 });
    await response.text();
    expect(await normalizeError(response)).toMatchObject({ status: 500, code: "http_500" });
  });

  it("describes network failures as retryable errors without a status", () => {
    expect(networkError(new TypeError("fetch failed"))).toMatchObject({ status: 0, code: "network_error", retryable: true });
  });
});
