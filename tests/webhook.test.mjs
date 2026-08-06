/**
 * Tests for webhook verification, run against the built package in dist/ —
 * the artifact that actually ships, not the sources it came from.
 *
 * `signPayload` below is the load-bearing piece: an independent implementation
 * of the signing scheme written against `node:crypto`, while the SDK verifies
 * with WebCrypto. Every "valid signature" case is therefore a real
 * cross-implementation check — if the two disagree about which string gets
 * signed or how bytes become hex, these fail. A test that signed with the SDK's
 * own HMAC would agree with itself and prove nothing.
 *
 * ## This file is the signing spec
 *
 * The server that produces these signatures lives in a different repository, so
 * nothing here can import it and nothing here will notice if it changes. That
 * makes `signPayload` the written contract rather than a mirror of code next
 * door, and it is worth stating in full:
 *
 *     signature = "t=" + <unix seconds> + ",v1=" + hex(hmac_sha256(secret, unix + "." + rawBody))
 *
 * If the platform ever changes that — a new `v2` scheme, a different signed
 * string, base64 instead of hex — this file has to change with it, and a green
 * CI run here is not evidence that it hasn't. Treat a platform-side change to
 * the signing scheme as a breaking change to this package.
 *
 * The rejection cases matter just as much, because every one of them is a
 * failure that a naive verifier accepts silently — a replayed request, a
 * tampered body, a signature from a different endpoint's secret.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  DEFAULT_TOLERANCE_SECONDS,
  InboundrSignatureError,
  SIGNATURE_HEADER,
  verifyWebhook,
  verifyWebhookPayload,
} from "../dist/index.js";

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

/** The signing scheme, per the spec in this file's header. */
function signPayload(secret, body, timestamp) {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

const SECRET = "whsec_HXK9y2sVQ4mZ1pTn8LrJdCwB";
const NOW_MS = 1_770_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

/** A realistic email.received envelope, matching the shape ingest sends. */
const EVENT = {
  event: "email.received",
  email: {
    id: "eml_7Kq2mR",
    threadId: "thr_9Fj4nP",
    messageId: "<CAF=abc123@mail.example.com>",
    from: "customer@example.com",
    to: ["agent@mail.example.com"],
    cc: [],
    subject: "Re: invoice 4471",
    text: "Any update on this?",
    html: null,
    attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", size: 18244 }],
    verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS" },
    receivedAt: "2026-02-02T03:20:00.000Z",
  },
};
const BODY = JSON.stringify(EVENT);

/** Asserts fn() rejects with an InboundrSignatureError carrying `reason`. */
async function assertRejects(reason, fn) {
  try {
    await fn();
  } catch (err) {
    assert.ok(
      err instanceof InboundrSignatureError,
      `expected InboundrSignatureError, got ${err?.constructor?.name}: ${err?.message}`,
    );
    assert.equal(err.reason, reason);
    return;
  }
  assert.fail(`expected rejection with reason "${reason}", but it resolved`);
}

// --- the happy path, cross-checked against the server's signer ---------------

await test("a signature from the server's own signer verifies", async () => {
  const event = await verifyWebhookPayload(
    BODY,
    signPayload(SECRET, BODY, NOW_S),
    SECRET,
    { now },
  );
  assert.equal(event.event, "email.received");
  assert.equal(event.email.id, "eml_7Kq2mR");
  assert.equal(event.email.subject, "Re: invoice 4471");
  assert.deepEqual(event.email.to, ["agent@mail.example.com"]);
  assert.equal(event.email.attachments[0].size, 18244);
});

await test("a body with non-ASCII content verifies (UTF-8 is hashed as bytes)", async () => {
  // A subject line of CJK plus an emoji is 3–4 bytes per character. If either
  // side hashed UTF-16 code units, or measured length in characters, this
  // diverges while the pure-ASCII case above still passes.
  const body = JSON.stringify({
    event: "email.received",
    email: { ...EVENT.email, subject: "請求書 4471 について 📎", text: "確認しました" },
  });
  const event = await verifyWebhookPayload(
    body,
    signPayload(SECRET, body, NOW_S),
    SECRET,
    { now },
  );
  assert.equal(event.email.subject, "請求書 4471 について 📎");
});

await test("verifyWebhook reads a Request and returns the event", async () => {
  const timestamp = NOW_S;
  const request = new Request("https://app.example.com/api/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signPayload(SECRET, BODY, timestamp),
      "x-inbound-event": "email.received",
      "x-inbound-delivery-id": "whd_abc123",
    },
    body: BODY,
  });
  const event = await verifyWebhook(request, SECRET, { now });
  assert.equal(event.email.from, "customer@example.com");
});

// --- forgery and tampering ---------------------------------------------------

await test("a tampered body is rejected even with a valid-looking signature", async () => {
  const signature = signPayload(SECRET, BODY, NOW_S);
  const tampered = BODY.replace("customer@example.com", "attacker@evil.test");
  assert.notEqual(tampered, BODY);
  await assertRejects("invalid_signature", () =>
    verifyWebhookPayload(tampered, signature, SECRET, { now }),
  );
});

await test("a signature made with a different secret is rejected", async () => {
  const signature = signPayload("whsec_someOtherEndpointsSecret", BODY, NOW_S);
  await assertRejects("invalid_signature", () =>
    verifyWebhookPayload(BODY, signature, SECRET, { now }),
  );
});

await test("re-serializing the body breaks verification", async () => {
  // The documented footgun: the MAC covers bytes, not meaning. Parsing and
  // re-stringifying is semantically identical and cryptographically different.
  const signature = signPayload(SECRET, BODY, NOW_S);
  const reserialized = JSON.stringify(JSON.parse(BODY), null, 2);
  await assertRejects("invalid_signature", () =>
    verifyWebhookPayload(reserialized, signature, SECRET, { now }),
  );
});

await test("the timestamp is covered by the signature, not just carried alongside", async () => {
  // Restamping a captured request must not extend its life.
  const signature = signPayload(SECRET, BODY, NOW_S - 10_000);
  const restamped = signature.replace(/^t=\d+/, `t=${NOW_S}`);
  await assertRejects("invalid_signature", () =>
    verifyWebhookPayload(BODY, restamped, SECRET, { now }),
  );
});

// --- replay window -----------------------------------------------------------

await test("an authentic but stale signature is rejected", async () => {
  const old = NOW_S - DEFAULT_TOLERANCE_SECONDS - 1;
  await assertRejects("timestamp_out_of_tolerance", () =>
    verifyWebhookPayload(BODY, signPayload(SECRET, BODY, old), SECRET, { now }),
  );
});

await test("a timestamp just inside the window is accepted", async () => {
  const edge = NOW_S - DEFAULT_TOLERANCE_SECONDS;
  const event = await verifyWebhookPayload(
    BODY,
    signPayload(SECRET, BODY, edge),
    SECRET,
    { now },
  );
  assert.equal(event.event, "email.received");
});

await test("a far-future timestamp is rejected too", async () => {
  // One-sided checks accept these, which makes a captured request valid forever.
  const future = NOW_S + DEFAULT_TOLERANCE_SECONDS + 1;
  await assertRejects("timestamp_out_of_tolerance", () =>
    verifyWebhookPayload(BODY, signPayload(SECRET, BODY, future), SECRET, {
      now,
    }),
  );
});

await test("modest clock skew ahead is tolerated", async () => {
  const skewed = NOW_S + 30;
  const event = await verifyWebhookPayload(
    BODY,
    signPayload(SECRET, BODY, skewed),
    SECRET,
    { now },
  );
  assert.equal(event.event, "email.received");
});

await test("toleranceSeconds: Infinity accepts an ancient payload", async () => {
  const ancient = NOW_S - 60 * 60 * 24 * 365;
  const event = await verifyWebhookPayload(
    BODY,
    signPayload(SECRET, BODY, ancient),
    SECRET,
    { now, toleranceSeconds: Infinity },
  );
  assert.equal(event.email.id, "eml_7Kq2mR");
});

await test("a forgery is rejected before the timestamp is judged", async () => {
  // Both are wrong, but the reason must be the signature: a stale-authentic
  // replay and an outright forgery are different incidents.
  const stale = NOW_S - 10_000;
  const forged = signPayload("wrong-secret", BODY, stale);
  await assertRejects("invalid_signature", () =>
    verifyWebhookPayload(BODY, forged, SECRET, { now }),
  );
});

// --- header parsing ----------------------------------------------------------

await test("a missing header is rejected", async () => {
  await assertRejects("missing_header", () =>
    verifyWebhookPayload(BODY, null, SECRET, { now }),
  );
  await assertRejects("missing_header", () =>
    verifyWebhookPayload(BODY, "", SECRET, { now }),
  );
});

await test("malformed headers are rejected", async () => {
  const bad = [
    "garbage",
    "v1=deadbeef", // no timestamp
    `t=${NOW_S}`, // no mac
    `t=abc,v1=${"a".repeat(64)}`, // non-numeric timestamp
    `t=1.5e9,v1=${"a".repeat(64)}`, // exponent form
    `t=${NOW_S},v1=nothexatall!!`, // non-hex mac
  ];
  for (const signature of bad) {
    await assertRejects("malformed_header", () =>
      verifyWebhookPayload(BODY, signature, SECRET, { now }),
    );
  }
});

await test("unknown fields and whitespace in the header are tolerated", async () => {
  const valid = signPayload(SECRET, BODY, NOW_S);
  const mac = valid.split("v1=")[1];
  const event = await verifyWebhookPayload(
    BODY,
    ` t=${NOW_S} , v0=legacy , v1=${mac} , scheme=whatever `,
    SECRET,
    { now },
  );
  assert.equal(event.event, "email.received");
});

await test("several v1 values pass if any one matches (secret rotation)", async () => {
  const good = signPayload(SECRET, BODY, NOW_S).split("v1=")[1];
  const bogus = "b".repeat(64);
  const event = await verifyWebhookPayload(
    BODY,
    `t=${NOW_S},v1=${bogus},v1=${good}`,
    SECRET,
    { now },
  );
  assert.equal(event.event, "email.received");
});

await test("an uppercase hex mac verifies", async () => {
  const mac = signPayload(SECRET, BODY, NOW_S).split("v1=")[1];
  const event = await verifyWebhookPayload(
    BODY,
    `t=${NOW_S},v1=${mac.toUpperCase()}`,
    SECRET,
    { now },
  );
  assert.equal(event.event, "email.received");
});

await test("a truncated mac is rejected, not treated as a prefix match", async () => {
  const mac = signPayload(SECRET, BODY, NOW_S).split("v1=")[1];
  await assertRejects("invalid_signature", () =>
    verifyWebhookPayload(BODY, `t=${NOW_S},v1=${mac.slice(0, 32)}`, SECRET, {
      now,
    }),
  );
});

// --- caller mistakes ---------------------------------------------------------

await test("an empty secret is a distinct, named failure", async () => {
  // Rather than "invalid signature", which sends people auditing their handler
  // when the real problem is an unset env var.
  await assertRejects("missing_secret", () =>
    verifyWebhookPayload(BODY, signPayload(SECRET, BODY, NOW_S), "", { now }),
  );
});

await test("a Request whose body was already read fails loudly", async () => {
  const request = new Request("https://app.example.com/api/inbound", {
    method: "POST",
    headers: { [SIGNATURE_HEADER]: signPayload(SECRET, BODY, NOW_S) },
    body: BODY,
  });
  await request.json(); // the mistake
  await assertRejects("body_already_read", () =>
    verifyWebhook(request, SECRET, { now }),
  );
});

await test("a signed body that isn't an event envelope is rejected", async () => {
  const body = JSON.stringify({ hello: "world" });
  await assertRejects("invalid_payload", () =>
    verifyWebhookPayload(body, signPayload(SECRET, body, NOW_S), SECRET, {
      now,
    }),
  );
});

await test("a signed body that isn't JSON is rejected", async () => {
  const body = "not json at all";
  await assertRejects("invalid_payload", () =>
    verifyWebhookPayload(body, signPayload(SECRET, body, NOW_S), SECRET, {
      now,
    }),
  );
});

await test("an unknown event type is rejected rather than mistyped", async () => {
  const body = JSON.stringify({ event: "email.bounced", email: {} });
  await assertRejects("invalid_payload", () =>
    verifyWebhookPayload(body, signPayload(SECRET, body, NOW_S), SECRET, {
      now,
    }),
  );
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
