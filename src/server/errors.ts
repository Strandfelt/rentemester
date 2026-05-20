// Safe error mapping for the cockpit backend (#170, cf. #158).
//
// Internal errors carry filesystem paths, SQL fragments and other detail that
// must never reach an HTTP client. Handlers throw `ApiError` for *expected*
// failures (bad input, not found, ...); anything else is caught at the edge
// and mapped to a generic 500 with NO leaked detail.

export type ApiErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "method_not_allowed"
  | "internal";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  internal: 500,
};

/**
 * An error that is safe to surface to an HTTP client. The `message` is
 * deliberately curated by the thrower — keep it free of paths/secrets.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }

  static badRequest(message: string): ApiError {
    return new ApiError("bad_request", message);
  }
  static notFound(message: string): ApiError {
    return new ApiError("not_found", message);
  }
  static conflict(message: string): ApiError {
    return new ApiError("conflict", message);
  }
  static unauthorized(message: string): ApiError {
    return new ApiError("unauthorized", message);
  }
  static methodNotAllowed(message: string): ApiError {
    return new ApiError("method_not_allowed", message);
  }
}

export type ApiErrorBody = {
  ok: false;
  error: { code: ApiErrorCode; message: string };
};

/**
 * Maps any thrown value to a safe `{ status, body }` pair.
 *
 * `ApiError` instances pass their curated message through. Every other error
 * is collapsed to a generic 500 — its real message (which may contain a
 * filesystem path or SQL fragment) is dropped, never serialised.
 */
export function toErrorResponse(err: unknown): {
  status: number;
  body: ApiErrorBody;
} {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: { ok: false, error: { code: err.code, message: err.message } },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: { code: "internal", message: "internal server error" },
    },
  };
}
