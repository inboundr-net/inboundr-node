![Inboundr](https://raw.githubusercontent.com/inboundr-net/inboundr-node/refs/heads/main/assets/banner.png)

# Inboundr Node.js SDK

[![npm](https://img.shields.io/npm/v/inboundr?color=0f766e&label=npm)](https://www.npmjs.com/package/inboundr)
[![license](https://img.shields.io/badge/license-MIT-0f766e)](./LICENSE)

Node.js and TypeScript library for the [Inboundr](https://inboundr.net) API: receive email over signed webhooks, read and reply to it, and manage domains, addresses and endpoints.

- [Quickstart](https://inboundr.net/docs/quickstart)
- [API reference](https://inboundr.net/docs/api-reference/introduction)
- [Verifying webhooks](https://inboundr.net/docs/webhooks/verifying-signatures)

## Install

```bash
npm install inboundr
# or
pnpm add inboundr
yarn add inboundr
bun add inboundr
```

No runtime dependencies. Runs on Node 20+, Bun, Deno, Cloudflare Workers and Vercel Edge.

## Setup

Create an API key in the console under **API keys**, then:

```ts
import { Inboundr } from "inboundr";

const inboundr = new Inboundr("inb_123456789");
```

With no argument, the key is read from `INBOUNDR_API_KEY`.

## Receive email

Every inbound email is delivered to your endpoint as a signed `POST`. Verify it before using it:

```ts
// app/api/inbound/route.ts
import { verifyWebhook } from "inboundr";

export async function POST(req: Request) {
  const { email } = await verifyWebhook(req, process.env.INBOUNDR_WEBHOOK_SECRET!);

  console.log(email.from, email.subject, email.text);

  return new Response(null, { status: 204 });
}
```

The secret is the `whsec_` value returned when you create the endpoint. `verifyWebhook` reads the request body, so call it before anything else reads it.

It throws `InboundrSignatureError` when a request can't be verified. Respond with `400`:

```ts
import { verifyWebhook, InboundrSignatureError } from "inboundr";

try {
  const { email } = await verifyWebhook(req, secret);
} catch (err) {
  if (err instanceof InboundrSignatureError) {
    return new Response(null, { status: 400 });
  }
  throw err;
}
```

### Express

Use `express.raw()` so the body reaches the verifier unparsed:

```ts
import express from "express";
import { verifyWebhookPayload } from "inboundr";

app.post("/inbound", express.raw({ type: "application/json" }), async (req, res) => {
  const { email } = await verifyWebhookPayload(req.body, req.headers, secret);
  res.sendStatus(204);
});
```

### Retries

Failed deliveries are retried with the same delivery id. Use it to skip deliveries you have already handled:

```ts
import { readWebhookHeaders } from "inboundr";

const { deliveryId } = readWebhookHeaders(req.headers);
```

### Missing body

Some hosts drop the request body. The delivery still carries a signed email id, so you can fetch the email instead:

```ts
import { verifyWebhookIds } from "inboundr";

// when verifyWebhook throws with err.reason === "missing_body"
const { emailId } = await verifyWebhookIds(req.headers, secret);
const email = await inboundr.emails.get(emailId);
```

### Failure reasons

`InboundrSignatureError.reason` is one of:

| Reason | Meaning |
| --- | --- |
| `missing_secret` | No secret was passed. |
| `missing_header` | No signature header. |
| `malformed_header` | The signature header can't be parsed. |
| `invalid_signature` | The signature doesn't match. |
| `timestamp_out_of_tolerance` | Signed more than 5 minutes ago (set `toleranceSeconds` to change). |
| `missing_body` | Signed, but the body is empty. |
| `body_already_read` | The body was read or parsed before verification. |
| `invalid_payload` | Verified, but not a known event. |

## Read email

```ts
const { data, nextCursor } = await inboundr.emails.list({
  direction: "inbound",
  limit: 20,
});

const email = await inboundr.emails.get(data[0].id);
const thread = await inboundr.threads.get(email.threadId);
```

To go through every page:

```ts
for await (const email of inboundr.emails.listAll({ direction: "inbound" })) {
  console.log(email.subject);
}
```

## Reply and send

```ts
await inboundr.emails.reply(email.id, {
  text: "Thanks, we're on it.",
});

await inboundr.emails.send({
  from: "agent@yourdomain.com",
  to: ["customer@example.com"],
  subject: "Your order shipped",
  html: "<p>It's on the way.</p>",
});
```

Sending needs a connected sender or a verified domain with sending enabled.

## Attachments

```ts
// A signed URL, valid for 15 minutes
const { url } = await inboundr.emails.attachmentUrl(email.id, 0);

// Or the file itself
const file = await inboundr.emails.downloadAttachment(email.id, 0);
const bytes = await file.arrayBuffer();
```

## Resources

| Resource | Methods |
| --- | --- |
| `emails` | `list`, `listAll`, `get`, `send`, `reply`, `delete`, `retry`, `attachmentUrl`, `downloadAttachment` |
| `threads` | `get` |
| `domains` | `list`, `create`, `get`, `update`, `delete` |
| `addresses` | `list`, `create`, `get`, `update`, `delete` |
| `endpoints` | `list`, `create`, `get`, `update`, `delete`, `test`, `deliveries`, `listAllDeliveries` |
| `shieldRules` | `list`, `create`, `get`, `update`, `delete`, `move`, `reorder` |
| `senders` | `list` |
| `suppressions` | `list`, `create`, `delete` |
| `forwardDestinations` | `list`, `create`, `delete` |

See the [API reference](https://inboundr.net/docs/api-reference/introduction) for parameters and responses. All types are exported:

```ts
import type { Email, Endpoint, SendEmailParams } from "inboundr";
```

## Errors

| Error | Thrown when | Properties |
| --- | --- | --- |
| `InboundrApiError` | The API returns a non-2xx status | `status`, `body`, `requestId` |
| `InboundrRateLimitError` | The API returns `429` | `retryAfterSeconds` |
| `InboundrError` | The request fails or times out | `cause` |

```ts
import { InboundrApiError } from "inboundr";

try {
  await inboundr.domains.create({ domain: "example.com" });
} catch (err) {
  if (err instanceof InboundrApiError) {
    console.log(err.status, err.body);
  }
}
```

Requests are not retried automatically.

## Options

```ts
const inboundr = new Inboundr({
  apiKey: "inb_123456789",
  baseUrl: "https://inboundr.net", // default
  timeoutMs: 30_000,               // default, 0 to disable
  fetch: customFetch,              // defaults to global fetch
});
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
