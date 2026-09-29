import { ApiError } from "@periplo/core/api";

export type Loadable<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "failed"; readonly error: ApiError };

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({ status: 0, code: "unexpected", message: error instanceof Error ? error.message : "Unexpected failure" });
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
