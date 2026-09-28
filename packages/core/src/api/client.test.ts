import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createLoomClient } from "./client";

interface Paths {
  "/tables": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: {
      parameters: { query?: never; header?: never; path?: never; cookie?: never };
      requestBody?: never;
      responses: { 200: { headers: Record<string, unknown>; content: { "application/json": { tables: string[] } } } };
    };
    put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
  "/queries": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    post: {
      parameters: { query?: never; header?: never; path?: never; cookie?: never };
      requestBody: { content: { "application/json": { sql: string } } };
      responses: { 200: { headers: Record<string, unknown>; content: { "application/vnd.apache.arrow.stream": unknown } } };
    };
    get?: never; put?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
}

describe("createLoomClient", () => {
  it("returns typed data and sends requests under the base URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ tables: ["orders"] }));
    const client = createLoomClient<Paths>({ baseUrl: "http://api.test/api/v1", fetch: fetchMock });

    const { data } = await client.GET("/tables");

    expect(data?.tables).toEqual(["orders"]);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("http://api.test/api/v1/tables");
  });

  it("throws a normalised ApiError for any non-2xx response", async () => {
    const client = createLoomClient<Paths>({
      baseUrl: "http://api.test",
      fetch: async () => Response.json({ detail: { code: "not_found", message: "Nope", trace_id: "t-9" } }, { status: 404 }),
    });

    const failure = await client.GET("/tables").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, code: "not_found", traceId: "t-9" });
  });

  it("turns network failures into ApiError but lets aborts through untouched", async () => {
    const offline = createLoomClient<Paths>({
      baseUrl: "http://api.test",
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(offline.GET("/tables")).rejects.toMatchObject({ name: "ApiError", code: "network_error", status: 0 });

    const aborted = createLoomClient<Paths>({
      baseUrl: "http://api.test",
      fetch: async () => Promise.reject(new DOMException("The operation was aborted", "AbortError")),
    });
    await expect(aborted.GET("/tables")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("hands back the untouched response for streamed bodies", async () => {
    const client = createLoomClient<Paths>({
      baseUrl: "http://api.test",
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "x-query-id": "q-7" } }),
    });

    const { response } = await client.POST("/queries", { body: { sql: "select 1" }, parseAs: "stream" });

    expect(response.headers.get("x-query-id")).toBe("q-7");
    expect(response.bodyUsed).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
