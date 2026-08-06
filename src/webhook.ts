/**
 * Webhook signature verification.
 *
 * This is the part of the SDK that earns its existence. Calling the REST API is
 * a `fetch` with a bearer token and you do not need a package for it — but
 * proving that a POST to your handler actually came from Inboundr means parsing
 * a compound header, rebuilding the exact signed string, comparing a MAC without
 * leaking timing, and enforcing a replay window. Four steps, each of which fails
 * *silently* when you get it wrong: your endpoint keeps working and accepts
 * forgeries. That is why this exists as one call.
 *
 * Built entirely on WebCrypto (`crypto.subtle`) rather than `node:crypto`, so it
 * runs unchanged on Node, Bun, Deno, Cloudflare Workers and Vercel Edge. Agents
 * get deployed to workers constantly and a `node:crypto` import there is a
 * runtime crash, not a type error.
 */

import { InboundrSignatureError } from "./errors.js";
import type { InboundrEvent } from "./types.js";

/** Carries `t=<unix>,v1=<hmac>`. Verify against this, not the body alone. */
export const SIGNATURE_HEADER = "x-inbound-signature";

/** The event name, mirroring the body's `event` field. */
export const EVENT_HEADER = "x-inbound-event";

/**
 * Unique per delivery attempt — the idempotency key for your handler.
 *
 * Retries of the same message reuse it, so recording the ones you have
 * processed is what stops a retried delivery from being handled twice. The
 * email's own `id` is *not* a substitute: a message fanned out to several
 * endpoints, or retried after your 500, shares it.
 */
export const DELIVERY_ID_HEADER = "x-inbound-delivery-id";

/**
 * How far a timestamp may be from now, in seconds.
 *
 * Five minutes: long enough to absorb a retry queue and ordinary clock drift,
 * short enough that a captured request is not indefinitely replayable.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyWebhookOptions = {
  /**
   * Replay window in seconds, applied in both directions. Default 300.
   *
   * Raising this widens the window in which a captured request can be replayed.
   * `Infinity` disables the check — only reasonable when you are replaying
   * archived payloads deliberately.
   */
  toleranceSeconds?: number;
  /** Clock override, in milliseconds since the epoch. For tests. */
  now?: () => number;
};

const encoder = new TextEncoder();

type ParsedSignature = { timestamp: number; macs: string[] };

/**
 * Splits `t=<unix>,v1=<hex>` into its parts.
 *
 * Tolerates unknown fields and accepts several `v1` values, which is what makes
 * secret rotation possible without dropping deliveries: during a rotation both
 * the old and new signature can ride along and either one verifying is enough.
 * Returns null for anything that isn't parseable — the caller turns that into a
 * `malformed_header` failure.
 */
function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const macs: string[] = [];

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key === "t") {
      // Digits only. `Number("12e5")` and `Number(" 12 ")` both succeed, and
      // neither is a timestamp we ever emit.
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (/^[0-9a-fA-F]+$/.test(value)) macs.push(value.toLowerCase());
    }
  }

  if (timestamp === null || macs.length === 0) return null;
  return { timestamp, macs };
}

/** HMAC-SHA256 of `message` under `secret`, lowercase hex. */
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  let hex = "";
  for (const byte of new Uint8Array(signature)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time comparison of two hex strings.
 *
 * `a === b` on strings short-circuits at the first differing character, which
 * turns "is this MAC right" into a measurable question and lets an attacker
 * recover a valid signature byte by byte. Comparing every character regardless
 * closes that.
 *
 * The length check is not a leak: our MACs are always 64 hex characters, so the
 * length carries no secret.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Narrows decoded JSON to an event we recognise. */
function asEvent(value: unknown): InboundrEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { event?: unknown; email?: unknown };
  if (candidate.event !== "email.received") return null;
  if (typeof candidate.email !== "object" || candidate.email === null) return null;
  return value as InboundrEvent;
}

/**
 * Verifies a raw body against its signature header and returns the typed event.
 *
 * The framework-agnostic form. Reach for it when you don't have a web `Request`
 * — Express, Fastify, Hono's raw mode, a queue consumer replaying a stored
 * payload. If you do have a `Request`, use {@link verifyWebhook}.
 *
 * `body` must be the **exact bytes** we sent, as text. Anything that round-trips
 * through a JSON parser will fail: `JSON.stringify(JSON.parse(body))` reorders
 * nothing but does change whitespace and unicode escapes, and the MAC covers the
 * bytes, not the meaning. In Express that means `express.raw()`, not
 * `express.json()`.
 *
 * @throws {InboundrSignatureError} on any failure. Respond 400 and drop it.
 */
export async function verifyWebhookPayload(
  body: string,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<InboundrEvent> {
  if (!secret) {
    throw new InboundrSignatureError(
      "missing_secret",
      "No signing secret was provided. It is the `whsec_…` value shown once when " +
        "the endpoint was created; store it and pass it here (e.g. from " +
        "process.env.INBOUNDR_WEBHOOK_SECRET).",
    );
  }

  if (!signatureHeader) {
    throw new InboundrSignatureError(
      "missing_header",
      `Request has no ${SIGNATURE_HEADER} header, so it cannot be from Inboundr. ` +
        "If you are behind a proxy, check that it forwards x-* headers.",
    );
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    throw new InboundrSignatureError(
      "malformed_header",
      `Could not parse the ${SIGNATURE_HEADER} header. Expected "t=<unix>,v1=<hex>".`,
    );
  }

  const expected = await hmacHex(secret, `${parsed.timestamp}.${body}`);
  const matched = parsed.macs.some((mac) => timingSafeEqualHex(mac, expected));

  // Signature before freshness, deliberately. Both end in a rejection, but only
  // a verified MAC tells you *which* problem you have: a stale authentic replay
  // is an infrastructure hiccup, a bad MAC on a fresh timestamp is someone
  // POSTing at your endpoint. Checking freshness first would collapse those two
  // into one log line.
  if (!matched) {
    throw new InboundrSignatureError(
      "invalid_signature",
      "Webhook signature did not match. The usual cause is the wrong secret for " +
        "this endpoint, or a body that was re-serialized before verification — " +
        "the signature covers the raw bytes we sent.",
    );
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const age = Math.abs(nowSeconds - parsed.timestamp);
  // Two-sided: a timestamp in the future means clock skew (yours or ours), and
  // silently accepting arbitrarily future-dated requests would let a captured
  // one stay valid forever.
  if (Number.isFinite(tolerance) && age > tolerance) {
    throw new InboundrSignatureError(
      "timestamp_out_of_tolerance",
      `Webhook signature is authentic but its timestamp is ${age}s away from now, ` +
        `outside the ${tolerance}s replay window. Check this machine's clock, or ` +
        "raise toleranceSeconds if you are intentionally replaying old payloads.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (cause) {
    throw new InboundrSignatureError(
      "invalid_payload",
      "Webhook signature verified but the body is not valid JSON. This should not " +
        `happen; please report it. Cause: ${String(cause)}`,
    );
  }

  const event = asEvent(decoded);
  if (!event) {
    throw new InboundrSignatureError(
      "invalid_payload",
      "Webhook signature verified but the body is not an event envelope this " +
        "version understands. Upgrading `inboundr` usually resolves it.",
    );
  }

  return event;
}

/**
 * Verifies an incoming webhook `Request` and returns the typed event.
 *
 * ```ts
 * // app/api/inbound/route.ts
 * import { verifyWebhook, InboundrSignatureError } from "inboundr";
 *
 * export async function POST(req: Request) {
 *   try {
 *     const { email } = await verifyWebhook(req, process.env.INBOUNDR_WEBHOOK_SECRET!);
 *     await handle(email);
 *     return new Response(null, { status: 204 });
 *   } catch (err) {
 *     if (err instanceof InboundrSignatureError) return new Response("bad signature", { status: 400 });
 *     throw err;
 *   }
 * }
 * ```
 *
 * **This reads the request body, so call it first.** A body can only be consumed
 * once; if you `await req.json()` beforehand there is nothing left to hash. This
 * is the single most common way webhook verification gets broken, so it fails
 * loudly rather than mysteriously.
 *
 * @throws {InboundrSignatureError} on any failure. Respond 400 and drop it.
 */
export async function verifyWebhook(
  request: Request,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<InboundrEvent> {
  if (request.bodyUsed) {
    throw new InboundrSignatureError(
      "body_already_read",
      "The request body has already been read, so the signature cannot be " +
        "checked against it. Call verifyWebhook(req, secret) before req.json() " +
        "or req.text() — it returns the parsed event, so you do not need both.",
    );
  }

  const signature = request.headers.get(SIGNATURE_HEADER);
  const body = await request.text();
  return verifyWebhookPayload(body, signature, secret, options);
}
