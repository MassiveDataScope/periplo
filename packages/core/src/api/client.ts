import createClient, { type Client } from "openapi-fetch";
import { networkError, normalizeError } from "./errors";

export interface LoomClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Typed client for APIs built with Loom. `Paths` comes from the contract the
 * API publishes (openapi-typescript); nothing is typed by hand here. Every
 * non-2xx response and every network failure surfaces as a thrown `ApiError`,
 * so callers never inspect raw bodies. Aborts are rethrown untouched.
 */
export function createLoomClient<Paths extends object>(options: LoomClientOptions): Client<Paths> {
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      throw isAbort(error) ? error : networkError(error);
    }
    if (!response.ok) throw await normalizeError(response);
    return response;
  };

  return createClient<Paths>({ baseUrl: options.baseUrl, fetch: guardedFetch });
}
