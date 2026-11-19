/**
 * Public types.
 *
 * Every shape here is an alias of src/generated/api.ts, which is generated from
 * the API's OpenAPI description (openapi/openapi.yaml, copied from the platform
 * by `npm run spec:sync`). Nothing is written by hand, so a field the API adds,
 * renames or removes shows up as a type change on the next sync rather than as
 * a silent mismatch. The names are the stable part: they are what callers
 * import, and they don't change when the spec's internal names do.
 */
import type { components, operations } from "./generated/api.js";

type Schemas = components["schemas"];
type JsonBody<R> = R extends { content: { "application/json": infer B } } ? B : never;
type Query<Op extends keyof operations> = NonNullable<
  operations[Op]["parameters"]["query"]
>;

// ------------------------------------------------------------------ shared

/** A paginated list. Pass `nextCursor` back as `cursor` for the next page. */
export type Page<T> = { data: T[]; nextCursor: string | null };
/** An unpaginated list. */
export type List<T> = { data: T[] };

// The two generics above are the only shapes here not taken from the spec, so
// the compiler checks them against it: each line fails to build if the
// response it names stops being exactly Page<…> or List<…>.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Ok<Op extends keyof operations> = operations[Op]["responses"] extends { 200: infer R }
  ? JsonBody<R>
  : never;
export type _SpecShapes = [
  Assert<Equal<Ok<"listEmails">, Page<Schemas["EmailSummary"]>>>,
  Assert<Equal<Ok<"listEndpointDeliveries">, Page<Schemas["Delivery"]>>>,
  Assert<Equal<Ok<"listDomains">, List<Schemas["Domain"]>>>,
  Assert<Equal<Ok<"listAddresses">, List<Schemas["Address"]>>>,
  Assert<Equal<Ok<"listEndpoints">, List<Schemas["Endpoint"]>>>,
  Assert<Equal<Ok<"listShieldRules">, List<Schemas["ShieldRule"]>>>,
  Assert<Equal<Ok<"listSenders">, List<Schemas["Sender"]>>>,
  Assert<Equal<Ok<"listSuppressions">, List<Schemas["Suppression"]>>>,
  Assert<Equal<Ok<"listForwardDestinations">, List<Schemas["ForwardDestination"]>>>,
];

/** The `error` field of a failed response: a message, or a field tree on a 400. */
export type ApiErrorBody = Schemas["Error"];
export type ValidationErrorTree = Schemas["ValidationErrorTree"];

// ------------------------------------------------------------------ emails

export type EmailDirection = Schemas["EmailDirection"];
/** Rollup of an email's webhook deliveries. */
export type DeliveryStatus = Schemas["EmailDeliveryStatus"];
/** Where an outbound email stands. */
export type SendStatus = Schemas["EmailSendStatus"];
/** A verdict string from the receiving pipeline, e.g. "PASS" or "FAIL". */
export type Verdict = string;

export type EmailSummary = Schemas["EmailSummary"];
export type Email = Schemas["Email"];
export type EmailAttachment = Schemas["Attachment"];
export type AttachmentUrl = Schemas["AttachmentUrl"];
export type Thread = JsonBody<operations["getThread"]["responses"][200]>;
/** What send and reply return: the new message's ids. */
export type SentEmail = Schemas["SentEmail"];

export type ListEmailsParams = Query<"listEmails">;
export type SendEmailParams = Schemas["SendEmailRequest"];
export type ReplyParams = Schemas["ReplyRequest"];

// ------------------------------------------------------------------ domains

export type DomainStatus = Schemas["Domain"]["status"];
/** What the domain can do now. Prefer this over `status`. */
export type DomainState = Schemas["DomainState"];
export type Domain = Schemas["Domain"];
export type DnsRecord = Schemas["DnsRecord"];
/** A domain with the DNS records to publish (create and get). */
export type DomainDetail = Schemas["DomainWithDns"];
/** @deprecated Same as {@link DomainDetail}. */
export type CreatedDomain = DomainDetail;
/** A domain after an update, with its catch-all endpoints. */
export type UpdatedDomain = JsonBody<operations["updateDomain"]["responses"][200]>;

export type CreateDomainParams = Schemas["CreateDomainRequest"];
export type UpdateDomainParams = Schemas["UpdateDomainRequest"];

// ------------------------------------------------------------------ addresses

export type Address = Schemas["Address"];
export type CreatedAddress = Schemas["CreatedAddress"];
export type CreateAddressParams = Schemas["CreateAddressRequest"];
export type UpdateAddressParams = Schemas["UpdateAddressRequest"];

// ------------------------------------------------------------------ endpoints

export type EndpointType = Schemas["EndpointType"];
export type Endpoint = Schemas["Endpoint"];
/** The create response. `secret` is returned here and never again. */
export type EndpointWithSecret = Schemas["CreatedEndpoint"];
export type EndpointTestResult = Schemas["TestDeliveryResult"];
export type CreateEndpointParams = Schemas["CreateEndpointRequest"];
export type UpdateEndpointParams = Schemas["UpdateEndpointRequest"];

/** One webhook delivery attempt record. */
export type Delivery = Schemas["Delivery"];
export type WebhookDeliveryStatus = Schemas["DeliveryStatus"];
export type ListDeliveriesParams = Query<"listEndpointDeliveries">;

// ------------------------------------------------------------------ shield rules

export type ShieldAction = Schemas["ShieldAction"];
export type ShieldField = Schemas["ShieldField"];
export type ShieldOperator = Schemas["ShieldOperator"];
export type ShieldCondition = Schemas["ShieldCondition"];
export type ShieldRule = Schemas["ShieldRule"];
export type CreateShieldRuleParams = Schemas["ShieldRuleInput"];
/** A full replace. A rule fetched with `get` can be passed back as-is. */
export type ReplaceShieldRuleParams = Schemas["ReplaceShieldRuleRequest"];
export type ShieldRuleOrder = Schemas["ShieldRuleOrder"];

// ------------------------------------------------------------------ senders, suppressions, forwarding

export type Sender = Schemas["Sender"];
export type SuppressionReason = Schemas["SuppressionReason"];
export type Suppression = Schemas["Suppression"];
export type CreateSuppressionParams = Schemas["CreateSuppressionRequest"];
export type ForwardDestination = Schemas["ForwardDestination"];
export type ForwardDestinationRequest = Schemas["ForwardDestinationRequest"];

// ------------------------------------------------------------------ webhooks

export type EmailReceivedEvent = Schemas["EmailReceivedEvent"];
/** Every event a webhook can carry. One today; a union as more are added. */
export type InboundrEvent = EmailReceivedEvent;
/** The email inside an `email.received` event. */
export type InboundEmail = EmailReceivedEvent["email"];
export type EmailVerdicts = InboundEmail["verdicts"];
export type WebhookAttachment = InboundEmail["attachments"][number];
