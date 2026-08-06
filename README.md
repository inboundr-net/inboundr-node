![Inboundr TypeScript SDK — signed webhooks, verified in one call](https://raw.githubusercontent.com/inboundr-net/inboundr/refs/heads/main/assets/banner.png)

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
import { verifyWebhookPayload, SIGNATURE_HEADER } from "inboundr";

app.post("/inbound", express.raw({ type: "application/json" }), async (req, res) => {
  const { email } = await verifyWebhookPayload(
    req.body.toString("utf8"),
    req.get(SIGNATURE_HEADER),
    process.env.INBOUNDR_WEBHOOK_SECRET,
  );
  res.sendStatus(204);
});
```

`express.raw()`, not `express.json()`. The signature covers the bytes we sent, and `JSON.stringify(JSON.parse(body))` is a different set of bytes.

### Handling retries safely

Retries reuse the delivery id, so that is the key to dedupe on:

```ts
import { DELIVERY_ID_HEADER } from "inboundr";

const deliveryId = req.headers.get(DELIVERY_ID_HEADER);
if (await alreadyHandled(deliveryId)) return new Response(null, { status: 204 });
```

The email's own `id` is **not** a substitute — a message fanned out to several endpoints shares it.

### Why a verification failed

`InboundrSignatureError.reason` is a stable string, safe to log and switch on:

| `reason` | What happened |
|---|---|
| `missing_header` | No signature header. Not ours, or a proxy stripped it. |
| `malformed_header` | Header present but not `t=…,v1=…`. |
| `invalid_signature` | MAC did not match. Wrong secret, or a forgery. |
| `timestamp_out_of_tolerance` | Authentic, but outside the replay window. |
| `body_already_read` | Something consumed the body first. |
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

await inboundr.emails.send({
  from: "agent@mail.yourdomain.com",
  to: ["customer@example.com"],
  subject: "Re: your order",
  text: "Shipped this morning.",
});
```

| Resource | What it covers |
|---|---|
| `emails` | List, get, send, delete, retry deliveries, attachment URLs |
| `threads` | A whole conversation, oldest first |
| `domains` | Register, verify, catch-all wiring |
| `addresses` | The inboxes your agents read |
| `endpoints` | Webhook and forwarding destinations, plus test deliveries |
| `shieldRules` | Filtering — allow, block, reroute, and rule ordering |
| `suppressions` | Addresses you can no longer send to |
| `forwardDestinations` | Consent for forwarding targets |

Constructor: `{ apiKey, baseUrl, fetch, timeoutMs }`. Injecting `fetch` is how you test against a stub without touching the network.

### Attachments

Webhook bodies carry metadata only — a base64'd 40 MB PDF in a webhook is a timeout, not a feature. Fetch content with a short-lived signed URL:

```ts
const { url } = await inboundr.emails.attachmentUrl(email.id, 0);
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

This repository holds only the client. The API it talks to and the server that signs its webhooks live elsewhere, which has one consequence worth being blunt about:

**Nothing here can detect a platform-side change.** There is no codegen and no shared types. If a response gains, loses or renames a field, this package's build stays green and its types quietly become wrong. Green CI means the client is self-consistent, not that it matches production.

So the contract is maintained by hand, in two places:

- **[`src/types.ts`](./src/types.ts)** — the wire types, written against the `/api/v1` routes.
- **[`tests/webhook.test.mjs`](./tests/webhook.test.mjs)** — the signing spec, stated in full in that file's header and implemented independently with `node:crypto` so it cross-checks the SDK's WebCrypto path.

A change to the signing scheme is a **breaking change** to this package.

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # build, then both suites (46 tests)
```

Releases are cut by tagging. `v0.1.0` on `main` runs the Node 18/20/22 matrix and, if green, publishes with provenance. CI checks the tag against `version` in `package.json`, because npm publishes what the file says and ignores the tag.

## License

MIT — see [LICENSE](./LICENSE).
