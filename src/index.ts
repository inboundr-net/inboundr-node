/**
 * inboundr — TypeScript SDK for the Inboundr API.
 *
 * Two things live here, and they are used at opposite ends of an integration:
 *
 * - {@link verifyWebhook} proves an incoming POST came from us, and hands back a
 *   typed event. This is the part worth installing a package for.
 * - {@link Inboundr} is a typed REST client for managing domains, addresses,
 *   endpoints and rules, and for reading or sending mail.
 *
 * Everything is built on web globals — `fetch`, `crypto.subtle`, `TextEncoder` —
 * with no dependencies, so it runs on Node 18+, Bun, Deno, Cloudflare Workers
 * and Vercel Edge unchanged.
 */

export {
  DEFAULT_TOLERANCE_SECONDS,
  DELIVERY_ID_HEADER,
  EMAIL_ID_HEADER,
  EVENT_HEADER,
  ID_SIGNATURE_HEADER,
  LEGACY_DELIVERY_ID_HEADER,
  LEGACY_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
  readWebhookHeaders,
  verifyWebhook,
  verifyWebhookIds,
  verifyWebhookPayload,
  type HeadersLike,
  type VerifyWebhookOptions,
  type WebhookHeaders,
  type WebhookIdValues,
} from "./webhook.js";

export {
  API_KEY_ENV_VAR,
  DEFAULT_BASE_URL,
  Inboundr,
  type FetchLike,
  type InboundrOptions,
} from "./client.js";

export {
  InboundrApiError,
  InboundrError,
  InboundrRateLimitError,
  InboundrSignatureError,
  type SignatureFailureReason,
} from "./errors.js";

export type {
  Address,
  ApiErrorBody,
  AttachmentUrl,
  CreateAddressParams,
  CreateDomainParams,
  CreatedAddress,
  CreatedDomain,
  CreateEndpointParams,
  CreateShieldRuleParams,
  CreateSuppressionParams,
  Delivery,
  DeliveryStatus,
  DnsRecord,
  Domain,
  DomainDetail,
  DomainState,
  DomainStatus,
  Email,
  EmailAttachment,
  EmailDirection,
  EmailReceivedEvent,
  EmailSummary,
  EmailVerdicts,
  Endpoint,
  EndpointTestResult,
  EndpointType,
  EndpointWithSecret,
  ForwardDestination,
  ForwardDestinationRequest,
  InboundEmail,
  InboundrEvent,
  List,
  ListDeliveriesParams,
  ListEmailsParams,
  Page,
  ReplaceShieldRuleParams,
  ReplyParams,
  Sender,
  SendEmailParams,
  SendStatus,
  SentEmail,
  ShieldAction,
  ShieldCondition,
  ShieldField,
  ShieldOperator,
  ShieldRule,
  ShieldRuleOrder,
  Suppression,
  SuppressionReason,
  Thread,
  UpdateAddressParams,
  UpdateDomainParams,
  UpdatedDomain,
  UpdateEndpointParams,
  ValidationErrorTree,
  Verdict,
  WebhookAttachment,
  WebhookDeliveryStatus,
} from "./types.js";
