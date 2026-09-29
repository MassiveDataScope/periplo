export interface Violation {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorInit {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly traceId?: string;
  readonly entity?: string;
  readonly entityId?: string | number;
  readonly violations?: readonly Violation[];
  readonly queryId?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly committed?: boolean;
  readonly cause?: unknown;
}

const RETRYABLE_STATUSES = new Set([429, 503]);

/** The single error shape screens deal with, whatever the server or the network produced. */
export class ApiError extends Error {
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;
  readonly code: string;
  readonly traceId?: string;
  readonly entity?: string;
  readonly entityId?: string | number;
  readonly violations: readonly Violation[];
  readonly queryId?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly committed?: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.traceId = init.traceId;
    this.entity = init.entity;
    this.entityId = init.entityId;
    this.violations = init.violations ?? [];
    this.queryId = init.queryId;
    this.retryable = init.retryable ?? RETRYABLE_STATUSES.has(init.status);
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.committed = init.committed;
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function loomViolations(value: unknown): Violation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const field = text(item.field);
    const message = text(item.message);
    return field && message ? [{ field, message }] : [];
  });
}

function fastApiViolations(items: unknown[]): Violation[] {
  return items.flatMap((item) => {
    if (!isObject(item) || !Array.isArray(item.loc)) return [];
    const message = text(item.msg);
    return message ? [{ field: item.loc.map(String).join("."), message }] : [];
  });
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

/**
 * Maps any non-2xx response to an `ApiError`. Understands the Loom envelope
 * (`{detail: {...}}`), FastAPI body validation (`{detail: [...]}`) and the flat
 * Periplo body; anything else becomes a generic error. Never throws, and only
 * ever shows text the server put in a recognised message field.
 */
export async function normalizeError(response: Response): Promise<ApiError> {
  const status = response.status;
  const body = await readJson(response);
  const root = isObject(body) ? body : {};
  const detail = root.detail;
  const source = isObject(detail) ? detail : root;

  const generic = { code: `http_${status}`, message: `Request failed with status ${status}` };
  let code = text(source.code);
  let message = text(source.message);
  let violations = loomViolations(source.violations);

  if (Array.isArray(detail)) {
    code = "validation_error";
    message = "Request validation failed";
    violations = fastApiViolations(detail);
  } else if (typeof detail === "string") {
    message = text(detail);
  }
  code ??= generic.code;
  message ??= generic.message;

  const retryable = source.retryable ?? root.retryable;
  const entityId = source.id;
  return new ApiError({
    status,
    code,
    message,
    traceId: text(source.trace_id),
    entity: text(source.entity),
    entityId: typeof entityId === "string" || typeof entityId === "number" ? entityId : undefined,
    violations,
    queryId: text(source.query_id) ?? text(root.query_id) ?? response.headers.get("x-query-id") ?? undefined,
    retryable: typeof retryable === "boolean" ? retryable : undefined,
    retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
    committed: typeof source.committed === "boolean" ? source.committed : undefined,
  });
}

export function networkError(cause: unknown): ApiError {
  return new ApiError({ status: 0, code: "network_error", message: "The server could not be reached", retryable: true, cause });
}
