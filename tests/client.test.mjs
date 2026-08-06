/**
 * Tests for the REST client, run against the built package in dist/.
 *
 * `fetch` is injected throughout, so nothing here touches the network. What is
 * being checked is the layer the client actually owns: the URL it builds, the
 * headers it sets, and — mostly — that a failed call raises an error carrying
 * enough to diagnose it. A client that throws away a 400's body is the reason
 * people give up and go back to curl.
 */
import assert from "node:assert/strict";
import {
  API_KEY_ENV_VAR,
  Inboundr,
  InboundrApiError,
  InboundrError,
  InboundrRateLimitError,
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

const KEY = "inb_test_2mR9Kq4nPj";

/**
 * A fetch stub that records every call and replies with whatever it's given.
 * `calls[0]` is the request the client built.
 */
function stub(reply = { status: 200, body: {} }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const status = reply.status ?? 200;
    if (status === 204) {
      return new Response(null, { status, headers: reply.headers });
    }
    const body =
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, {
      status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { calls, fetchImpl };
}

function client(reply, options = {}) {
  const { calls, fetchImpl } = stub(reply);
  return {
    calls,
    inboundr: new Inboundr({ apiKey: KEY, fetch: fetchImpl, ...options }),
  };
}

// --- construction ------------------------------------------------------------

await test("a missing API key throws rather than 401ing later", async () => {
  const previous = process.env[API_KEY_ENV_VAR];
  delete process.env[API_KEY_ENV_VAR];
  try {
    assert.throws(() => new Inboundr(), InboundrError);
  } finally {
    if (previous !== undefined) process.env[API_KEY_ENV_VAR] = previous;
  }
});

await test("the API key falls back to the environment", async () => {
  const previous = process.env[API_KEY_ENV_VAR];
  process.env[API_KEY_ENV_VAR] = KEY;
  try {
    const { calls, fetchImpl } = stub({ body: { data: [] } });
    await new Inboundr({ fetch: fetchImpl }).domains.list();
    assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  } finally {
    if (previous === undefined) delete process.env[API_KEY_ENV_VAR];
    else process.env[API_KEY_ENV_VAR] = previous;
  }
});

await test("a bare string is accepted as the key", async () => {
  // The shorthand takes a key and nothing else, so there is no fetch to inject
  // — this asserts construction only. Deliberately makes no call: a stray real
  // request to inboundr.net from the test suite is how a unit test starts
  // depending on production being up.
  const inboundr = new Inboundr(KEY);
  assert.equal(inboundr.baseUrl, "https://inboundr.net");
});

await test("a trailing slash on baseUrl does not produce a double slash", async () => {
  const { calls, inboundr } = client(
    { body: { data: [] } },
    { baseUrl: "https://api.example.com/" },
  );
  await inboundr.domains.list();
  assert.equal(calls[0].url, "https://api.example.com/api/v1/domains");
});

// --- request building --------------------------------------------------------

await test("a list call sets the bearer token and no content-type", async () => {
  const { calls, inboundr } = client({ body: { data: [], nextCursor: null } });
  await inboundr.emails.list();
  const call = calls[0];
  assert.equal(call.method, "GET");
  assert.equal(call.url, "https://inboundr.net/api/v1/emails");
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.headers.accept, "application/json");
  // A GET with no body must not claim to have one.
  assert.equal(call.headers["content-type"], undefined);
  assert.equal(call.body, undefined);
});

await test("filters become a query string and undefined ones are dropped", async () => {
  const { calls, inboundr } = client({ body: { data: [], nextCursor: null } });
  await inboundr.emails.list({
    direction: "inbound",
    limit: 25,
    to: undefined,
    cursor: undefined,
  });
  assert.equal(
    calls[0].url,
    "https://inboundr.net/api/v1/emails?direction=inbound&limit=25",
  );
});

await test("a query value needing escaping is encoded", async () => {
  const { calls, inboundr } = client({ body: { data: [], nextCursor: null } });
  await inboundr.emails.list({ to: "agent+billing@mail.example.com" });
  assert.ok(
    calls[0].url.endsWith("?to=agent%2Bbilling%40mail.example.com"),
    `unexpected url: ${calls[0].url}`,
  );
});

await test("an address in a path segment is encoded, not interpolated raw", async () => {
  // "+" in a path is literal, but the address may contain "/" or "#", either of
  // which would silently retarget the request.
  const { calls, inboundr } = client({ status: 204 });
  await inboundr.suppressions.delete("bounced+tag@example.com");
  assert.equal(
    calls[0].url,
    "https://inboundr.net/api/v1/suppressions/bounced%2Btag%40example.com",
  );
});

await test("a send serializes the body and sets content-type", async () => {
  const { calls, inboundr } = client({ status: 201, body: { id: "eml_1" } });
  await inboundr.emails.send({
    from: "agent@mail.example.com",
    to: ["customer@example.com"],
    subject: "Done",
    text: "Shipped.",
  });
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.body), {
    from: "agent@mail.example.com",
    to: ["customer@example.com"],
    subject: "Done",
    text: "Shipped.",
  });
});

await test("reorder PUTs the collection, not a single rule", async () => {
  const { calls, inboundr } = client({ body: { order: ["shr_b", "shr_a"] } });
  const result = await inboundr.shieldRules.reorder(["shr_b", "shr_a"]);
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].url, "https://inboundr.net/api/v1/shield-rules");
  assert.deepEqual(JSON.parse(calls[0].body), { order: ["shr_b", "shr_a"] });
  assert.deepEqual(result.order, ["shr_b", "shr_a"]);
});

await test("an attachment index goes into the path", async () => {
  const { calls, inboundr } = client({
    body: { url: "https://signed.example.com/x", expiresAt: "2026-02-02T03:25:00Z" },
  });
  const result = await inboundr.emails.attachmentUrl("eml_7Kq2mR", 2);
  assert.equal(
    calls[0].url,
    "https://inboundr.net/api/v1/emails/eml_7Kq2mR/attachments/2",
  );
  assert.equal(result.url, "https://signed.example.com/x");
});

// --- responses ---------------------------------------------------------------

await test("a 204 resolves to undefined instead of failing to parse ''", async () => {
  const { inboundr } = client({ status: 204 });
  assert.equal(await inboundr.domains.delete("dom_1"), undefined);
});

await test("a successful body is returned as-is", async () => {
  const page = {
    data: [{ id: "eml_1", subject: "hi", attachmentCount: 0 }],
    nextCursor: "Y3Vyc29y",
  };
  const { inboundr } = client({ body: page });
  assert.deepEqual(await inboundr.emails.list(), page);
});

// --- errors ------------------------------------------------------------------

await test("a 404 throws InboundrApiError with status and body intact", async () => {
  const { inboundr } = client({ status: 404, body: { error: "Email not found" } });
  await assert.rejects(() => inboundr.emails.get("eml_missing"), (err) => {
    assert.ok(err instanceof InboundrApiError);
    assert.equal(err.status, 404);
    assert.equal(err.message, "Email not found");
    assert.deepEqual(err.body, { error: "Email not found" });
    return true;
  });
});

await test("a 400's Zod error tree survives into the message", async () => {
  // The tree names the offending field. Collapsing it to "Bad Request" would
  // throw away the only actionable part of the response.
  const tree = { properties: { from: { errors: ["Invalid email address"] } } };
  const { inboundr } = client({ status: 400, body: { error: tree } });
  await assert.rejects(
    () =>
      inboundr.emails.send({ from: "nope", to: ["a@b.co"], subject: "x", text: "y" }),
    (err) => {
      assert.ok(err instanceof InboundrApiError);
      assert.match(err.message, /Invalid email address/);
      assert.deepEqual(err.body, { error: tree });
      return true;
    },
  );
});

await test("a 403 from a read-only key reports what to do", async () => {
  const message =
    "This API key is read-only. Create a key with full access to send email or change configuration.";
  const { inboundr } = client({ status: 403, body: { error: message } });
  await assert.rejects(
    () =>
      inboundr.emails.send({
        from: "a@mail.example.com",
        to: ["b@example.com"],
        subject: "x",
        text: "y",
      }),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.message, message);
      return true;
    },
  );
});

await test("a 429 throws InboundrRateLimitError carrying retry-after", async () => {
  const { inboundr } = client({
    status: 429,
    body: { error: "Rate limit exceeded" },
    headers: { "retry-after": "7" },
  });
  await assert.rejects(() => inboundr.emails.list(), (err) => {
    assert.ok(err instanceof InboundrRateLimitError);
    assert.ok(err instanceof InboundrApiError, "should still be an API error");
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterSeconds, 7);
    return true;
  });
});

await test("a 429 without retry-after reports null rather than NaN", async () => {
  const { inboundr } = client({ status: 429, body: { error: "slow down" } });
  await assert.rejects(() => inboundr.emails.list(), (err) => {
    assert.equal(err.retryAfterSeconds, null);
    return true;
  });
});

await test("a non-JSON error body is preserved as text", async () => {
  const { inboundr } = client({
    status: 502,
    body: "<html>Bad Gateway</html>",
    headers: { "content-type": "text/html" },
  });
  await assert.rejects(() => inboundr.emails.list(), (err) => {
    assert.ok(err instanceof InboundrApiError);
    assert.equal(err.status, 502);
    assert.equal(err.body, "<html>Bad Gateway</html>");
    return true;
  });
});

await test("x-request-id is captured when present", async () => {
  const { inboundr } = client({
    status: 500,
    body: { error: "boom" },
    headers: { "x-request-id": "req_abc123" },
  });
  await assert.rejects(() => inboundr.emails.list(), (err) => {
    assert.equal(err.requestId, "req_abc123");
    return true;
  });
});

await test("a timeout reports the timeout, not a bare AbortError", async () => {
  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new Error("The operation was aborted")),
      );
    });
  const inboundr = new Inboundr({ apiKey: KEY, fetch: hanging, timeoutMs: 20 });
  await assert.rejects(() => inboundr.emails.list(), (err) => {
    assert.ok(err instanceof InboundrError);
    assert.match(err.message, /timed out after 20ms/);
    return true;
  });
});

await test("a transport failure is wrapped with the call that caused it", async () => {
  const failing = async () => {
    throw new TypeError("fetch failed");
  };
  const inboundr = new Inboundr({ apiKey: KEY, fetch: failing });
  await assert.rejects(() => inboundr.emails.get("eml_1"), (err) => {
    assert.ok(err instanceof InboundrError);
    assert.match(err.message, /GET \/emails\/eml_1 failed/);
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
