# inboundr

TypeScript SDK for [Inboundr](https://inboundr.net) — email addresses for AI agents.

```bash
npm add inboundr
```

Zero dependencies. Runs on Node 18+, Bun, Deno, Cloudflare Workers and Vercel Edge.

## Verifying a webhook

This is the part worth installing a package for. Inbound mail is delivered as a signed POST, and checking that signature by hand means parsing a compound header, rebuilding the exact signed string, comparing a MAC in constant time, and enforcing a replay window. Every one of those fails *silently* when you get it wrong — your endpoint keeps working and starts accepting forgeries.

```ts
// app/api/inbound/route.ts
import { verifyWebhook, InboundrSignatureError } from "inboundr";

export async function POST(req: Request) {
  try {
    const { email } = await verifyWebhook(req, process.env.INBOUNDR_WEBHOOK_SECRET!);

    console.log(`${email.from} → ${email.subject}`);
    await handOffToAgent(email.text ?? email.html ?? "");

    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof InboundrSignatureError) {
      return new Response("bad signature", { status: 400 });
    }
    throw err;
  }
}
```

`email` is fully typed — `from`, `to`, `cc`, `subject`, `text`, `html`, `attachments`, `verdicts`, `receivedAt`.

### Two things that will bite you

**Call `verifyWebhook` before reading the body.** A request body can only be consumed once, so `await req.json()` first leaves nothing to hash. `verifyWebhook` returns the parsed event, so you never need both — and it throws `reason: "body_already_read"` rather than something cryptic if you do.

**Return quickly.** Deliveries have a timeout and failures are retried, so a handler that runs a long agent inline will be retried while it is still working. Enqueue and return 204.

### Not holding a `Request`?

Express, Fastify, a queue consumer replaying a stored payload — use the raw form:

```ts
import { verifyWebhookPayload, SIGNATURE_HEADER } from "inboundr";

app.post("/inbound", express.raw({ type: "application/json" }), async (req, res) => {
  const event = await verifyWebhookPayload(
    req.body.toString("utf8"),
    req.get(SIGNATURE_HEADER),
    process.env.INBOUNDR_WEBHOOK_SECRET,
  );
  res.sendStatus(204);
});
```

`express.raw()`, not `express.json()`. The signature covers the bytes we sent, and `JSON.stringify(JSON.parse(body))` is a different set of bytes.

### Idempotency

Retries reuse the delivery id, so that header is the key to dedupe on:

```ts
import { DELIVERY_ID_HEADER } from "inboundr";

const deliveryId = req.headers.get(DELIVERY_ID_HEADER);
if (await alreadyHandled(deliveryId)) return new Response(null, { status: 204 });
```

The email's own `id` is not a substitute — a message fanned out to several endpoints shares it.

### Failure reasons

`InboundrSignatureError.reason` is a stable string for your logs: `missing_header`, `malformed_header`, `invalid_signature`, `timestamp_out_of_tolerance`, `body_already_read`, `invalid_payload`, `missing_secret`.

Respond 400 to all of them. Do not branch on `reason` to decide whether to trust a request — a forgery picks its own failure mode, so "only `invalid_signature` is suspicious" is not a distinction that survives an attacker.

The replay window defaults to 5 minutes in both directions. Widen it with `{ toleranceSeconds }`, or pass `Infinity` when you are deliberately replaying archived payloads.

## REST client

```ts
import { Inboundr } from "inboundr";

const inboundr = new Inboundr(); // reads INBOUNDR_API_KEY

const { data } = await inboundr.emails.list({ direction: "inbound", limit: 20 });
const email = await inboundr.emails.get(data[0].id);

await inboundr.emails.send({
  from: "agent@mail.yourdomain.com",
  to: ["customer@example.com"],
  subject: "Re: your order",
  text: "Shipped this morning.",
});
```

Resources: `emails`, `threads`, `domains`, `addresses`, `endpoints`, `shieldRules`, `suppressions`, `forwardDestinations`.

Options: `{ apiKey, baseUrl, fetch, timeoutMs }`. Injecting `fetch` is how you test against a stub without touching the network.

### Attachments

Bodies carry metadata only — a base64'd 40 MB PDF in a webhook is a timeout, not a feature. Fetch content with a short-lived signed URL:

```ts
const { url } = await inboundr.emails.attachmentUrl(email.id, 0);
```

`stored: false` on an attachment means nothing was kept to download (the plan does not store attachments, or the message exceeded its size cap).

### Errors

- `InboundrApiError` — any non-2xx. Carries `status`, `body` and `requestId`. The `body` of a 400 is a validation tree naming the offending field; it is kept, not collapsed into "Bad Request".
- `InboundrRateLimitError` — a 429, with `retryAfterSeconds` (null if the server omitted the header). Extends `InboundrApiError`.
- `InboundrError` — transport failures and timeouts.

**There is no automatic retry, deliberately.** A blind retry is wrong for half of these calls: `emails.send` is not idempotent, and the rate limit is per *account* and shared with MCP, so retrying into a 429 spends a budget your other agents are also drawing on. `retryAfterSeconds` is the server's own answer for when you do want to back off.

## Timestamps are strings

Every timestamp in every type is an ISO 8601 `string`, not a `Date` — the server serializes them on the way out. `new Date(email.receivedAt)` is your step. They are typed as `string` because typing them as `Date` would compile and then hand you a string at runtime.

## MCP

If you want an agent to talk to Inboundr directly rather than through your app, you want the MCP endpoint, not this package — `https://inboundr.net/api/mcp` with the same `inb_` bearer token. This SDK is for the app-side glue: receiving mail and managing configuration.

## ESM only

This package ships ESM. `import` works everywhere; `require("inboundr")` does not. If you need CJS, `await import("inboundr")` from CJS works on Node 18+.

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # build + both suites
```

Releases are cut by tagging: `v0.1.0` on `main` runs the test matrix and, if it is green, publishes to npm with provenance. CI checks that the tag matches `version` in `package.json`, because npm publishes whatever the file says and ignores the tag.

## Maintaining the platform contract

This repository holds only the client. The API it talks to and the server that signs its webhooks live elsewhere, which has one consequence worth being blunt about:

**Nothing here can detect a platform-side change.** There is no codegen and no shared types. If an API response gains, loses or renames a field, this package's build stays green and its types quietly become wrong. A green CI run means the client is self-consistent, not that it matches production.

So the contract is maintained by hand, in two places:

- **`src/types.ts`** — the wire types, written against the `/api/v1` routes. Update on any response-shape change.
- **`tests/webhook.test.mjs`** — the signing spec, stated in full in that file's header and implemented independently with `node:crypto` so it cross-checks the SDK's WebCrypto path. A change to the signing scheme is a breaking change to this package.

Treat a platform release that alters either as requiring a release here.
