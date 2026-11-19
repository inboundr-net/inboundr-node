// Compile-only: `tsc -p tests/tsconfig.json` must pass. Each block is real
// usage, checked against the built declarations in dist/ — what a customer's
// editor sees. A `@ts-expect-error` line must fail to compile, so the API
// rejecting a wrong call is tested too.
import {
  Inboundr,
  verifyWebhook,
  verifyWebhookIds,
  type EmailSummary,
  type SentEmail,
} from "../dist/index.js";

declare const req: Request;
const inboundr = new Inboundr({ apiKey: "inb_x" });

export async function consoleSnippets() {
  // The two snippets the console shows (src/components/connect-agent.tsx).
  const { data } = await inboundr.emails.list({ direction: "inbound", limit: 20 });
  const first: EmailSummary | undefined = data[0];
  const { email } = await verifyWebhook(req, "whsec_x");
  const from: string = email.from;
  const subject: string | null = email.subject;
  return { first, from, subject };
}

export async function sendReturnsIds() {
  const sent: SentEmail = await inboundr.emails.send({
    from: "agent@acme.dev",
    to: ["a@b.dev"],
    subject: "hi",
    text: "hello",
  });
  const threadId: string = sent.threadId;
  // @ts-expect-error send returns ids, not the stored email
  sent.textBody;
  return threadId;
}

export async function ruleRoundTrip(id: string) {
  // The fetch-modify-replace flow the API accepts on purpose.
  const rule = await inboundr.shieldRules.get(id);
  return inboundr.shieldRules.update(id, { ...rule, enabled: false });
}

export async function strictBodies() {
  // @ts-expect-error unknown field: the API answers 400, so the types refuse it
  await inboundr.addresses.create({ domainId: "dom_1", localPart: "a", endpointId: "ep_1" });
  // @ts-expect-error catchAllEndpointIds is required
  await inboundr.domains.update("dom_1", {});
  // @ts-expect-error not a direction
  await inboundr.shieldRules.move("sr_1", "left");
}

export async function iterate() {
  for await (const email of inboundr.emails.listAll({ deliveryStatus: "failed" })) {
    const id: string = email.id;
    void id;
  }
  for await (const delivery of inboundr.endpoints.listAllDeliveries("ep_1", { status: "dead" })) {
    const attempts: number = delivery.attempts;
    void attempts;
  }
}

export async function bodyless(headers: Headers) {
  const { emailId } = await verifyWebhookIds(headers, "whsec_x");
  return inboundr.emails.get(emailId);
}
