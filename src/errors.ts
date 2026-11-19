/**
 * Every error this package throws.
 *
 * Two families, because callers handle them in completely different places: an
 * `InboundrApiError` is something that went wrong in a call *you* made and
 * usually belongs in your logs, while an `InboundrSignatureError` is a request
 * that arrived at your webhook and failed to prove it came from us — that one
 * is a 400 you return, not an incident.
 */

/** Base class, so `catch (e) { if (e instanceof InboundrError) ... }` works. */
export class InboundrError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InboundrError";
  }
}

/**
 * A non-2xx response from the API.
 *
 * `body` is the decoded response body when it was JSON and the raw text
 * otherwise — never dropped, because the API's 400s carry a `zod` error tree
 * that says exactly which field was wrong and re-reading the docs is a poor
 * substitute for looking at it.
 */
export class InboundrApiError extends InboundrError {
  readonly status: number;
  readonly body: unknown;
  /** The `x-request-id` of the failed call, when the response carried one. */
  readonly requestId: string | null;

  constructor(
    message: string,
    init: { status: number; body: unknown; requestId?: string | null },
  ) {
    super(message);
    this.name = "InboundrApiError";
    this.status = init.status;
    this.body = init.body;
    this.requestId = init.requestId ?? null;
  }
}

/**
 * A 429. Separate from the general API error only because it is the one status
 * a caller can do something useful about automatically.
 *
 * The API's budget is per *account* and shared between REST and MCP, so backing
 * off here does not help if an agent elsewhere is spending the same bucket —
 * `retryAfterSeconds` is the server's own answer and is worth preferring over a
 * locally guessed backoff.
 */
export class InboundrRateLimitError extends InboundrApiError {
  /** From the `retry-after` header; null if the server omitted it. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    init: {
      status: number;
      body: unknown;
      requestId?: string | null;
      retryAfterSeconds: number | null;
    },
  ) {
    super(message, init);
    this.name = "InboundrRateLimitError";
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** Why a webhook failed verification. Stable strings — safe to switch on. */
export type SignatureFailureReason =
  /** A required header is absent. Not one of ours, or a proxy ate it. */
  | "missing_header"
  /** The body is empty — the host dropped it. Use `verifyWebhookIds` instead. */
  | "missing_body"
  /** Header present but not `t=<unix>,v1=<hex>`. */
  | "malformed_header"
  /** Signature is valid but the timestamp is outside the replay window. */
  | "timestamp_out_of_tolerance"
  /** The HMAC did not match. Wrong secret, or a forgery. */
  | "invalid_signature"
  /** The request body was already consumed, so there was nothing left to hash. */
  | "body_already_read"
  /** Signature verified, but the body was not the JSON envelope we send. */
  | "invalid_payload"
  /** No secret was passed in. A programming error on the caller's side. */
  | "missing_secret";

/**
 * A webhook that could not be proven to come from Inboundr.
 *
 * Treat every one of these the same way — respond 400 and drop the request.
 * `reason` exists for your logs, not for branching on whether to trust it: a
 * forged request can pick its own failure mode, so "only `invalid_signature`
 * is suspicious" is not a distinction that survives an attacker.
 */
export class InboundrSignatureError extends InboundrError {
  readonly reason: SignatureFailureReason;

  constructor(reason: SignatureFailureReason, message: string) {
    super(message);
    this.name = "InboundrSignatureError";
    this.reason = reason;
  }
}
