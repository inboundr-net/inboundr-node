![Inboundr TypeScript SDK — signed webhooks, verified in one call](https://raw.githubusercontent.com/inboundr-net/inboundr-node/refs/heads/main/assets/banner.png)

[![npm](https://img.shields.io/npm/v/inboundr?color=0f766e&label=npm)](https://www.npmjs.com/package/inboundr)
[![dependencies](https://img.shields.io/badge/dependencies-0-0f766e)](./package.json)
[![types](https://img.shields.io/badge/types-included-0f766e)](./src/types.ts)
[![license](https://img.shields.io/badge/license-MIT-0f766e)](./LICENSE)

The TypeScript client for [Inboundr](https://inboundr.net) — email addresses your AI agents can actually read.

Two things live in this package, used at opposite ends of an integration:

| | |
|---|---|
| **`verifyWebhook`** | Proves an incoming POST came from Inboundr, and hands you a typed email. |
| **`Inboundr`** | A typed REST client for domains, addresses, endpoints, rules, and sending. |

```bash
npm add inboundr
```

---

## Why this package exists

Calling the REST API is a `fetch` with a bearer token. You do not need a dependency for that.

Verifying a webhook is different. Every inbound email arrives as a signed POST, and checking that signature by hand means four separate steps:

1. Parse a compound header — `t=<unix>,v1=<hex>`
2. Rebuild the exact string that was signed — `timestamp + "." + rawBody`
3. Compare the MAC in **constant time**
4. Reject timestamps outside a replay window

Get any of them wrong and nothing tells you. No error, no failed request — your endpoint keeps working and quietly starts accepting forged mail. That is the failure mode this package exists to remove.

## Verify a webhook

```ts
// app/api/inbound/route.ts
import { verifyWebhook, InboundrSignatureError } from "inboundr";

export async function POST(req: Request) {
  try {
    const { email } = await verifyWebhook(req, process.env.INBOUNDR_WEBHOOK_SECRET!);

    await queue.add("handle-email", {
      from: email.from,
      subject: email.subject,
      body: email.text ?? email.html,
    });

    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof InboundrSignatureError) {
      return new Response("bad signature", { status: 400 });
    }
    throw err;
  }
}
```

`email` is fully typed: `from`, `to`, `cc`, `subject`, `text`, `html`, `attachments`, `verdicts`, `receivedAt`.

> [!WARNING]
> **Call `verifyWebhook` before reading the body.** A request body can only be consumed once, so `await req.json()` first leaves nothing to hash. It returns the parsed event, so you never need both — and it throws `reason: "body_already_read"` with the fix in the message rather than failing cryptically.

> [!IMPORTANT]
> **Return quickly.** Deliveries time out and failures are retried, so a handler that runs a long agent inline gets retried while it is still working. Enqueue, then return `204`.

### Outside a `Request`

Express, Fastify, a queue consumer replaying a stored payload:

```ts
import { verifyWebhookPayload } from "inboundr";

app.post("/inbound", express.raw({ type: "application/json" }), async (req, res) => {
  const { email } = await verifyWebhookPayload(
    req.body,     // the raw Buffer
    req.headers,  // reads the signature header, legacy name included
    process.env.INBOUNDR_WEBHOOK_SECRET,
  );
  res.sendStatus(204);
});
```

`express.raw()`, not `express.json()`. The signature covers the bytes we sent, and `JSON.stringify(JSON.parse(body))` is a different set of bytes; an already-parsed body fails with `body_already_read`. The body can be a string or the raw bytes, and the second argument can be the header value or the request's headers in any shape — a web `Headers`, a polyfill, or Node's plain `req.headers`.

### Handling retries safely

Retries reuse the delivery id, so that is the key to dedupe on:

```ts
import { readWebhookHeaders } from "inboundr";

const { deliveryId } = readWebhookHeaders(req.headers);
if (await alreadyHandled(deliveryId)) return new Response(null, { status: 204 });
```

`readWebhookHeaders` prefers the `x-inboundr-*` names and falls back to the legacy `x-inbound-*` ones, so read headers through it rather than by name.

The email's own `id` is **not** a substitute — a message fanned out to several endpoints shares it.

### When the body is missing

Some hosts and proxies drop request bodies. The headers still arrive, carrying a second signature over just the delivery and email ids. A signed request with an empty or absent body fails with `reason: "missing_body"` (an unsigned one is `missing_header`); verify the ids and fetch the email instead:

```ts
import { verifyWebhook, verifyWebhookIds, InboundrSignatureError } from "inboundr";

try {
  const { email } = await verifyWebhook(req, secret);
  await handle(email);
} catch (err) {
  if (err instanceof InboundrSignatureError && err.reason === "missing_body") {
    const { emailId } = await verifyWebhookIds(req.headers, secret);
    await handle(await inboundr.emails.get(emailId));
  } else throw err;
}
```

The id signature proves only that Inboundr sent a delivery naming that email, so fetching it through the API is the one safe use of it.

### Why a verification failed

`InboundrSignatureError.reason` is a stable string, safe to log and switch on:

| `reason` | What happened |
|---|---|
| `missing_header` | No signature header. Not ours, or a proxy stripped it. |
| `missing_body` | Signed, but the body is empty — the host dropped it. Use `verifyWebhookIds`. |
| `malformed_header` | Header present but not `t=…,v1=…`. |
| `invalid_signature` | MAC did not match. Wrong secret, or a forgery. |
| `timestamp_out_of_tolerance` | Authentic, but outside the replay window. |
| `body_already_read` | Something consumed or parsed the body first. |
| `invalid_payload` | Verified, but not an envelope this version knows. |
| `missing_secret` | No secret passed in. Usually an unset env var. |

> [!NOTE]
> Respond `400` to all of them. Do **not** branch on `reason` to decide whether to trust a request — a forgery picks its own failure mode, so "only `invalid_signature` is suspicious" is not a distinction that survives an attacker.

The replay window is 5 minutes in both directions. Override with `{ toleranceSeconds }`, or `Infinity` when deliberately replaying archived payloads.

## Call the API

```ts
import { Inboundr } from "inboundr";

const inboundr = new Inboundr(); // reads INBOUNDR_API_KEY

const { data } = await inboundr.emails.list({ direction: "inbound", limit: 20 });
const email = await inboundr.emails.get(data[0].id);

const sent = await inboundr.emails.send({
  from: "agent@mail.yourdomain.com",
  to: ["customer@example.com"],
  subject: "Re: your order",
  text: "Shipped this morning.",
}); // { id, messageId, threadId }

await inboundr.emails.reply(email.id, { text: "On it." });
```

| Resource | What it covers |
|---|---|
| `emails` | List, get, send, reply, delete, retry deliveries, attachments |
| `threads` | A whole conversation, oldest first |
| `domains` | Register, verify, catch-all wiring |
| `addresses` | The inboxes your agents read |
| `endpoints` | Webhook and forwarding destinations, test deliveries, delivery history |
| `shieldRules` | Filtering — allow, block, reroute; move one rule or reorder all |
| `senders` | Which From addresses your connected senders allow |
| `suppressions` | Addresses you can no longer send to |
| `forwardDestinations` | Consent for forwarding targets |

Every operation in the API has a method; a test fails the build if one doesn't.

Constructor: `{ apiKey, baseUrl, fetch, timeoutMs }`. Injecting `fetch` is how you test against a stub without touching the network.

### Pagination

`emails.list` and `endpoints.deliveries` return one page and a `nextCursor`. To walk all of them, iterate instead:

```ts
for await (const email of inboundr.emails.listAll({ direction: "inbound" })) {
  if (seen(email.id)) break; // stops fetching
}
```

Pages are fetched as you go, and each one counts against the account's rate limit.

### Updating a shield rule

`shieldRules.update` replaces the whole rule, and accepts a rule straight from `get`:

```ts
const rule = await inboundr.shieldRules.get(id);
await inboundr.shieldRules.update(id, { ...rule, enabled: false });
await inboundr.shieldRules.move(id, "up");
```

Request bodies are strict: a field the API doesn't accept is a `400`, and a compile error before that.

### Attachments

Webhook bodies carry metadata only — a base64'd 40 MB PDF in a webhook is a timeout, not a feature. Fetch content with a short-lived signed URL:

```ts
const { url } = await inboundr.emails.attachmentUrl(email.id, 0);

// Or stream the bytes through the API, when the storage host isn't reachable:
const file = await inboundr.emails.downloadAttachment(email.id, 0);
const bytes = await file.arrayBuffer();
```

`stored: false` means nothing was kept to download — the plan does not store attachments, or the message exceeded its size cap.

### Errors

| Class | Thrown for | Carries |
|---|---|---|
| `InboundrApiError` | Any non-2xx | `status`, `body`, `requestId` |
| `InboundrRateLimitError` | `429` (extends the above) | `retryAfterSeconds` |
| `InboundrError` | Transport failures, timeouts | `cause` |

A `400`'s `body` is the validation tree naming the offending field. It is preserved, not collapsed into "Bad Request".

> [!IMPORTANT]
> **There is no automatic retry, deliberately.** A blind retry is wrong for half of these calls: `emails.send` is not idempotent, and the rate limit is per *account* and shared with MCP, so retrying into a `429` spends a budget your other agents are drawing on too. `retryAfterSeconds` is the server's own answer for when you do want to back off.

## Runs anywhere

Zero dependencies, built on web globals — `fetch`, `crypto.subtle`, `TextEncoder`. No `node:crypto`, which is what makes the edge targets real rather than aspirational.

| Runtime | Supported |
|---|---|
| Node | 18+ |
| Bun / Deno | yes |
| Cloudflare Workers | yes |
| Vercel Edge | yes |
| Browsers | verification yes; don't ship an API key |

ESM only. `import` works everywhere; `require("inboundr")` does not. From CJS, `await import("inboundr")` works on Node 18+.

## Two conventions worth knowing

**Timestamps are strings.** Every timestamp in every type is an ISO 8601 `string`, not a `Date` — the server serializes them on the way out. `new Date(email.receivedAt)` is your step. Typing them as `Date` would compile and then hand you a string at runtime.

**Endpoint secrets are shown once.** `endpoints.create()` is the only response that ever returns `secret`. Store it then; it cannot be read back, only rotated.

## Not looking for an SDK?

If you want an agent to talk to Inboundr *directly* rather than through your app, use the MCP endpoint instead — `https://inboundr.net/api/mcp` with the same `inb_` bearer token. MCP is how the agent reaches us; this package is how your app receives mail. Different sides of the same integration.

## Maintaining the platform contract

The API this talks to and the server that signs its webhooks live in another repository. The types are kept honest by generating them from the platform's OpenAPI description rather than writing them by hand:

- **[`openapi/openapi.yaml`](./openapi/openapi.yaml)** — copied from the platform, where it is itself generated from the validators the API runs. Never edited here.
- **[`src/generated/api.ts`](./src/generated/api.ts)** — generated from it by `openapi-typescript`. [`src/types.ts`](./src/types.ts) only gives those shapes stable names.
- **[`tests/spec.test.mjs`](./tests/spec.test.mjs)** — calls every client method and fails if an operation in the spec has none, or a method calls something the spec doesn't describe.
- **[`tests/webhook.test.mjs`](./tests/webhook.test.mjs)** — the signing spec, stated in full in its header and implemented independently with `node:crypto`. Signatures aren't in the OpenAPI description, so this one is still by hand, and a change to the scheme is a **breaking change** to this package.

When the platform's API changes:

```bash
npm run spec:sync   # copy ../inbound-app/openapi/openapi.yaml (or $INBOUNDR_SPEC), regenerate types
npm test            # type errors and coverage failures show what the client needs
```

## Development

```bash
npm install
npm test            # spec:check, build, webhook/client/spec suites, type tests
npm run spec:sync   # pull the platform's spec and regenerate types
npm run spec:check  # fail if src/generated/api.ts is stale (part of npm test)
```

Releases are cut by tagging. `v0.2.0` on `main` runs the Node 18/20/22 matrix and, if green, publishes with provenance. CI checks the tag against `version` in `package.json`, because npm publishes what the file says and ignores the tag.

## License

MIT — see [LICENSE](./LICENSE).
