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
export const SIGNATURE_HEADER = "x-inboundr-signature";

/** The event name, mirroring the body's `event` field. */
export const EVENT_HEADER = "x-inboundr-event";

/**
 * Unique per delivery attempt — the idempotency key for your handler.
 *
 * Retries of the same message reuse it, so recording the ones you have
 * processed is what stops a retried delivery from being handled twice. The
 * email's own `id` is *not* a substitute: a message fanned out to several
 * endpoints, or retried after your 500, shares it.
 */
export const DELIVERY_ID_HEADER = "x-inboundr-delivery-id";

/** The email a delivery carries, so a handler that lost the body can fetch it. */
export const EMAIL_ID_HEADER = "x-inboundr-email-id";

/**
 * Signs the delivery and email ids without the body — see
 * {@link verifyWebhookIds}. Same `t=<unix>,v1=<hex>` format and secret.
 */
export const ID_SIGNATURE_HEADER = "x-inboundr-id-signature";

/**
 * The original `x-inbound-*` spellings. The platform still sends both, with
 * identical values; these are read only as a fallback, so a handler behind a
 * proxy that allow-lists the old names keeps working.
 */
export const LEGACY_SIGNATURE_HEADER = "x-inbound-signature";
export const LEGACY_DELIVERY_ID_HEADER = "x-inbound-delivery-id";

/**
 * Anything request headers come as: a web `Headers` (or a polyfill's — only
 * `.get` is used, never `instanceof`), or a plain object such as Express's or
 * Node's `req.headers`, matched case-insensitively.
 */
export type HeadersLike =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

/** The platform headers on a delivery, legacy spellings already folded in. */
export type WebhookHeaders = {
  signature: string | null;
  idSignature: string | null;
  deliveryId: string | null;
  emailId: string | null;
  event: string | null;
};

function headerReader(headers: HeadersLike): (name: string) => string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const get = (headers as { get(name: string): string | null | undefined }).get.bind(headers);
    return (name) => get(name) ?? null;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const lower = new Map<string, string | string[] | undefined>();
  for (const [key, value] of Object.entries(record)) lower.set(key.toLowerCase(), value);
  return (name) => {
    const value = lower.get(name);
    return (Array.isArray(value) ? value[0] : value) ?? null;
  };
}

/**
 * Reads the delivery headers, preferring the `x-inboundr-*` names and falling
 * back to the legacy `x-inbound-*` ones. The one place that fallback lives:
 * the verifiers use it, and so should a handler reading the delivery id for
 * deduplication.
 *
 * ```ts
 * const { deliveryId } = readWebhookHeaders(req.headers);
 * ```
 */
export function readWebhookHeaders(headers: HeadersLike): WebhookHeaders {
  const get = headerReader(headers);
  return {
    signature: get(SIGNATURE_HEADER) ?? get(LEGACY_SIGNATURE_HEADER),
    idSignature: get(ID_SIGNATURE_HEADER),
    deliveryId: get(DELIVERY_ID_HEADER) ?? get(LEGACY_DELIVERY_ID_HEADER),
    emailId: get(EMAIL_ID_HEADER),
    event: get(EVENT_HEADER) ?? get("x-inbound-event"),
  };
}

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

/** A missing secret is the caller's bug, so it is reported before anything else. */
function requireSecret(secret: string): void {
  if (!secret) {
    throw new InboundrSignatureError(
      "missing_secret",
      "No signing secret was provided. It is the `whsec_…` value shown once when " +
        "the endpoint was created; store it and pass it here (e.g. from " +
        "process.env.INBOUNDR_WEBHOOK_SECRET).",
    );
  }
}

function requireHeader(
  value: string | null | undefined,
  headerName: string,
): asserts value is string {
  if (!value) {
    throw new InboundrSignatureError(
      "missing_header",
      `Request has no ${headerName} header, so it cannot be from Inboundr. ` +
        "If you are behind a proxy, check that it forwards x-* headers.",
    );
  }
}

/** Raw body bytes as the text that was signed, or why there's nothing to hash. */
function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (body === undefined || body === null) return "";
  // body-parser leaves `{}` when there was no body to read.
  if (typeof body === "object" && Object.keys(body).length === 0) return "";
  throw new InboundrSignatureError(
    "body_already_read",
    "The body was already parsed, so the bytes that were signed are gone. Pass " +
      "the raw body: in Express use express.raw({ type: \"application/json\" }), " +
      "not express.json().",
  );
}

/**
 * Checks a `t=<unix>,v1=<hex>` header against `message(timestamp)`, then the
 * replay window. Shared by the body signature and the id signature, which
 * differ only in the string that was signed.
 */
async function verifySignedMessage(
  signatureHeader: string | null | undefined,
  headerName: string,
  secret: string,
  message: (timestamp: number) => string,
  options: VerifyWebhookOptions,
): Promise<void> {
  requireHeader(signatureHeader, headerName);

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    throw new InboundrSignatureError(
      "malformed_header",
      `Could not parse the ${headerName} header. Expected "t=<unix>,v1=<hex>".`,
    );
  }

  const expected = await hmacHex(secret, message(parsed.timestamp));
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
}

/**
 * Verifies a raw body against its signature header and returns the typed event.
 *
 * The framework-agnostic form. Reach for it when you don't have a web `Request`
 * — Express, Fastify, Hono's raw mode, a queue consumer replaying a stored
 * payload. If you do have a `Request`, use {@link verifyWebhook}.
 *
 * `rawBody` must be the **exact bytes** we sent, as a string or the raw bytes
 * (a `Buffer` is fine). Anything that round-trips through a JSON parser will
 * fail: `JSON.stringify(JSON.parse(body))` changes whitespace and unicode
 * escapes, and the MAC covers the bytes, not the meaning. In Express that means
 * `express.raw()`, not `express.json()`. An empty or absent body is reported as
 * `missing_body`.
 *
 * `signature` is the signature header's value, or the request's headers (any
 * shape — see {@link HeadersLike}), which also applies the legacy fallback.
 *
 * @throws {InboundrSignatureError} on any failure. Respond 400 and drop it.
 */
export async function verifyWebhookPayload(
  rawBody: string | Uint8Array | ArrayBuffer | null | undefined,
  signature: string | null | undefined | HeadersLike,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<InboundrEvent> {
  requireSecret(secret);
  const signatureHeader =
    typeof signature === "string" || signature == null
      ? signature
      : readWebhookHeaders(signature).signature;
  // Header before body: an unsigned empty request is a probe, not a delivery
  // whose body was dropped, and must not be steered toward verifyWebhookIds.
  requireHeader(signatureHeader, SIGNATURE_HEADER);
  const body = bodyText(rawBody);
  if (body === "") {
    throw new InboundrSignatureError(
      "missing_body",
      "The request arrived with an empty body. Some hosts and proxies drop it; " +
        "the headers still carry the email's id, so verify them with " +
        "verifyWebhookIds and fetch the email with inboundr.emails.get(emailId).",
    );
  }

  await verifySignedMessage(
    signatureHeader,
    SIGNATURE_HEADER,
    secret,
    (t) => `${t}.${body}`,
    options,
  );

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

  const body = await request.text();
  return verifyWebhookPayload(body, request.headers, secret, options);
}

/** The three values {@link verifyWebhookIds} checks, passed directly. */
export type WebhookIdValues = {
  signature: string | null | undefined;
  deliveryId: string | null | undefined;
  emailId: string | null | undefined;
};

/** Told apart from a plain header record by its camelCase keys, which no
    HTTP header name has. */
function isIdValues(value: HeadersLike | WebhookIdValues): value is WebhookIdValues {
  if (typeof (value as { get?: unknown }).get === "function") return false;
  return "signature" in value || "deliveryId" in value || "emailId" in value;
}

/**
 * Verifies the id signature on a delivery that arrived without its body.
 *
 * Some hosts and proxies drop request bodies. The headers still arrive, and
 * {@link ID_SIGNATURE_HEADER} signs the delivery and email ids on their own:
 * `HMAC-SHA256(secret, "ids." + t + "." + deliveryId + "." + emailId)`, with the
 * same secret and replay window as the body signature.
 *
 * **All this proves is that Inboundr sent a delivery naming this email.** It
 * does not cover any body, so the only safe thing to do with the result is
 * fetch the email through the API:
 *
 * ```ts
 * const { emailId } = await verifyWebhookIds(req.headers, secret);
 * const email = await inboundr.emails.get(emailId);
 * ```
 *
 * Accepts the request's headers in any shape ({@link HeadersLike}, with the
 * legacy delivery-id fallback), or the three values directly.
 *
 * @throws {InboundrSignatureError} on any failure. Respond 400 and drop it.
 */
export async function verifyWebhookIds(
  headers: HeadersLike | WebhookIdValues,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<{ deliveryId: string; emailId: string }> {
  requireSecret(secret);
  const values = isIdValues(headers)
    ? headers
    : (({ idSignature, deliveryId, emailId }) => ({
        signature: idSignature,
        deliveryId,
        emailId,
      }))(readWebhookHeaders(headers));

  if (!values.deliveryId || !values.emailId) {
    throw new InboundrSignatureError(
      "missing_header",
      `Request is missing ${DELIVERY_ID_HEADER} or ${EMAIL_ID_HEADER}, so there ` +
        "is nothing to verify the id signature against.",
    );
  }
  const { deliveryId, emailId } = values;

  await verifySignedMessage(
    values.signature,
    ID_SIGNATURE_HEADER,
    secret,
    // The `ids.` prefix is what keeps this apart from a body signature under
    // the same key; see the platform's webhook-signature.ts.
    (t) => `ids.${t}.${deliveryId}.${emailId}`,
    options,
  );
  return { deliveryId, emailId };
}

/** A delivery whose body and ids both verified. `deliveryId` is signed. */
export type VerifiedDelivery = { event: InboundrEvent; deliveryId: string };

/**
 * Verifies a delivery's body **and** its id signature, and returns the event
 * with a delivery id that is safe to deduplicate retries on.
 *
 * The body signature covers only the body, so a delivery id read straight
 * from the headers could be changed by someone replaying a captured delivery.
 * This also checks `x-inboundr-id-signature`, and that it names the same email
 * as the body.
 *
 * @throws {InboundrSignatureError} on any failure. Respond 400 and drop it.
 */
export async function verifyWebhookDeliveryPayload(
  rawBody: string | Uint8Array | ArrayBuffer | null | undefined,
  headers: HeadersLike,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<VerifiedDelivery> {
  const event = await verifyWebhookPayload(rawBody, headers, secret, options);
  const ids = await verifyWebhookIds(headers, secret, options);
  if (ids.emailId !== event.email.id) {
    throw new InboundrSignatureError(
      "invalid_signature",
      "The id signature names a different email than the body.",
    );
  }
  return { event, deliveryId: ids.deliveryId };
}

/**
 * {@link verifyWebhookDeliveryPayload} for a web `Request`. Reads the body,
 * so call it before anything else does.
 *
 * ```ts
 * const { event, deliveryId } = await verifyWebhookDelivery(req, secret);
 * if (await alreadyHandled(deliveryId)) return new Response(null, { status: 204 });
 * ```
 *
 * @throws {InboundrSignatureError} on any failure. Respond 400 and drop it.
 */
export async function verifyWebhookDelivery(
  request: Request,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<VerifiedDelivery> {
  if (request.bodyUsed) {
    throw new InboundrSignatureError(
      "body_already_read",
      "The request body has already been read, so the signature cannot be " +
        "checked against it. Call verifyWebhookDelivery(req, secret) first.",
    );
  }
  return verifyWebhookDeliveryPayload(await request.text(), request.headers, secret, options);
}
