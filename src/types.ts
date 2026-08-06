/**
 * The wire types of the Inboundr API and its webhooks.
 *
 * Everything here describes JSON that has already crossed the network, which
 * has one consequence worth stating loudly: **every timestamp is an ISO 8601
 * string, not a Date.** The server stores them as timestamps and `JSON.stringify`
 * flattens them on the way out, so `new Date(email.receivedAt)` is your step,
 * not ours. Typing them as `Date` would compile and then hand you a string.
 *
 * These types are maintained by hand against the routes under `/api/v1`. See
 * the "Keeping this in sync" section of the README for why, and for what to
 * check when the API changes.
 */

/**
 * A string union that still accepts anything.
 *
 * Used for values the server stores as free text but only ever sets from a
 * known set — SES verdicts being the case that matters. You get autocomplete
 * for the values you'll actually see, and a new verdict from Amazon doesn't
 * become a type error in your code.
 */
type Known<T extends string> = T | (string & {});

/** SES's judgement on one axis. `undefined` when SES did not report it. */
export type Verdict = Known<"PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED">;

/** The spam/virus/auth results SES attached to a received message. */
export type EmailVerdicts = {
  spam?: Verdict;
  virus?: Verdict;
  spf?: Verdict;
  dkim?: Verdict;
};

/** Whether we received a message or sent it. */
export type EmailDirection = "inbound" | "outbound";

/** Rollup of an inbound message's webhook deliveries. */
export type DeliveryStatus = "delivered" | "pending" | "failed";

/** Rollup of an outbound message's SES events. */
export type SendStatus =
  | "sent"
  | "delivered"
  | "delayed"
  | "rejected"
  | "bounced"
  | "complained";

/** Where a domain is in verification. */
export type DomainStatus = "pending" | "verified" | "failed";

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * An attachment as it appears in a webhook body: metadata only.
 *
 * Bytes are deliberately not inlined — a base64'd 40 MB PDF in a webhook body
 * is a timeout, not a feature. Fetch the content with
 * `inboundr.emails.attachmentUrl(emailId, index)`, which returns a short-lived
 * signed URL. `filename` and `contentType` are nullable because MIME lets a
 * part omit both.
 */
export type WebhookAttachment = {
  filename: string | null;
  contentType: string | null;
  /** Bytes, as reported by the parser. */
  size: number;
};

/** The message inside an `email.received` event. */
export type InboundEmail = {
  id: string;
  /** Groups a conversation; the same value on every reply we can thread. */
  threadId: string;
  /** RFC 5322 Message-ID. Null when the sender omitted one. */
  messageId: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string | null;
  /** Plain-text body. Null when the message was HTML-only. */
  text: string | null;
  /** HTML body. Null when the message was text-only. */
  html: string | null;
  attachments: WebhookAttachment[];
  verdicts: EmailVerdicts;
  /** ISO 8601. */
  receivedAt: string;
};

/** Fired when a message arrives at one of your addresses. */
export type EmailReceivedEvent = {
  event: "email.received";
  email: InboundEmail;
};

/**
 * Every event we send to a webhook endpoint.
 *
 * A one-member union today. It is a union rather than a bare type so that
 * `switch (event.event)` in your handler keeps compiling — and starts warning
 * on a missing case — when a second event ships.
 */
export type InboundrEvent = EmailReceivedEvent;

// ---------------------------------------------------------------------------
// REST: emails
// ---------------------------------------------------------------------------

/**
 * One page of a list endpoint.
 *
 * `nextCursor` is null on the last page. Pass it back as `cursor` to continue;
 * it encodes a (receivedAt, id) position rather than an offset, so rows arriving
 * mid-pagination cannot make you skip or repeat one.
 */
export type Page<T> = {
  data: T[];
  nextCursor: string | null;
};

/** A `{ data }` envelope with no pagination — the un-paged list endpoints. */
export type List<T> = { data: T[] };

/**
 * An email as it appears in a list or thread: no bodies.
 *
 * Bodies are omitted because a 100-row page of them is megabytes. Fetch one
 * with `emails.get(id)` when you need the content.
 *
 * Note the field names differ from the webhook shape (`fromAddress` here,
 * `from` there). That is the API's doing, not a mistake in these types.
 */
export type EmailSummary = {
  id: string;
  direction: EmailDirection;
  threadId: string;
  messageId: string | null;
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  spamVerdict: Verdict | null;
  attachmentCount: number;
  /** ISO 8601. */
  receivedAt: string;
};

/** An attachment on a fetched email. */
export type EmailAttachment = {
  filename: string | null;
  contentType: string | null;
  size: number;
  /**
   * Whether the bytes are retrievable. False when the message arrived on a
   * plan that does not store attachments, or exceeded the plan's size cap — the
   * metadata is kept so the message still tells you what came with it, but
   * `attachmentUrl()` will 402/404 for it.
   */
  stored: boolean;
};

/** A single email with bodies, attachments and verdicts. */
export type Email = {
  id: string;
  userId: string;
  domainId: string | null;
  direction: EmailDirection;
  messageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  threadId: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: EmailAttachment[];
  spamVerdict: Verdict | null;
  spfVerdict: Verdict | null;
  dkimVerdict: Verdict | null;
  deliveryStatus: DeliveryStatus | null;
  sendStatus: SendStatus | null;
  /** ISO 8601. */
  receivedAt: string;
  /** ISO 8601. */
  createdAt: string;
};

/** Filters for `emails.list()`. */
export type ListEmailsParams = {
  direction?: EmailDirection;
  /** Only mail addressed to this address, matching To *or* Cc. */
  to?: string;
  threadId?: string;
  /** 1–100. The server clamps anything outside that; the default is 50. */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
};

/** Body for `emails.send()`. At least one of `text`/`html` is required. */
export type SendEmailParams = {
  /** Must be an address on a verified domain you own. */
  from: string;
  /** 1–50 recipients. */
  to: string[];
  /** Up to 50. */
  cc?: string[];
  /** Up to 10. */
  replyTo?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Message-ID of the mail you are replying to. Sets up threading. */
  inReplyTo?: string;
};

/** All messages in one conversation, oldest first. */
export type Thread = {
  threadId: string;
  data: EmailSummary[];
};

/** A short-lived download URL for one attachment. */
export type AttachmentUrl = {
  url: string;
  /** ISO 8601 — typically minutes away. Don't persist the URL past this. */
  expiresAt: string;
};

// ---------------------------------------------------------------------------
// REST: domains and addresses
// ---------------------------------------------------------------------------

export type Domain = {
  id: string;
  userId: string;
  domain: string;
  status: DomainStatus;
  /** CNAME tokens to publish for DKIM. Empty until SES issues them. */
  dkimTokens: string[];
  /** ISO 8601, or null when not suspended. */
  suspendedAt: string | null;
  suspensionReason: string | null;
  autoSuspended: boolean;
  /** ISO 8601, or null while `status` is not "verified". */
  verifiedAt: string | null;
  warmupExempt: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
};

/** A domain fetched by id, which also reports its catch-all wiring. */
export type DomainDetail = Domain & {
  /** Endpoints every unmatched address on the domain delivers to. */
  catchAllEndpointIds: string[];
};

/** One DNS record to publish before a domain can verify. */
export type DnsRecord = {
  type: "CNAME" | "MX" | "TXT";
  /** Fully qualified. Some registrars want this relative to the zone. */
  name: string;
  value: string;
  /** What breaks if it is missing — safe to show to whoever edits the zone. */
  purpose: string;
};

/**
 * The create-domain response.
 *
 * `dnsRecords` is the whole point of the call: the domain lands `pending` and
 * stays there until these are published and verification catches up, so this is
 * the list to hand to whoever administers the zone.
 */
export type CreatedDomain = Domain & {
  dnsRecords: DnsRecord[];
};

export type Address = {
  id: string;
  domainId: string;
  domain: string;
  localPart: string;
  /** `localPart@domain`, precomputed. */
  address: string;
  active: boolean;
  /** Endpoints this address delivers to. */
  endpointIds: string[];
  /** ISO 8601. */
  createdAt: string;
};

export type CreateAddressParams = {
  domainId: string;
  localPart: string;
  /**
   * Endpoints to deliver to. An address with none is store-only: the mail is
   * kept and retrievable through the API, but nothing is POSTed anywhere.
   */
  endpointIds?: string[];
};

export type UpdateAddressParams = {
  endpointIds?: string[];
  active?: boolean;
};

// ---------------------------------------------------------------------------
// REST: endpoints
// ---------------------------------------------------------------------------

/**
 * A delivery destination.
 *
 * `secret` is absent here on purpose — the API redacts it everywhere except the
 * response that creates the endpoint, which is the only time it is ever
 * transmitted. If you did not store it then, rotate it; it cannot be read back.
 */
export type Endpoint = {
  id: string;
  name: string;
  /** Null for forwarding endpoints. */
  url: string | null;
  /** Custom headers sent with each POST. Reserved names are rejected. */
  headers: Record<string, string> | null;
  timeoutSeconds: number;
  maxAttempts: number;
  active: boolean;
  /** ISO 8601. */
  createdAt: string;
};

/** The create response — the one and only time `secret` is returned. */
export type EndpointWithSecret = Endpoint & {
  /**
   * The signing secret (`whsec_…`). Pass this to `verifyWebhook`. Shown once;
   * store it now.
   */
  secret: string;
};

export type CreateEndpointParams = {
  name: string;
  type?: "webhook" | "forward";
  /** Required when `type` is "webhook" (the default). http or https. */
  url?: string;
  /** Required when `type` is "forward". A confirmed forward destination. */
  forwardTo?: string | string[];
  forwardAttachments?: boolean;
  headers?: Record<string, string>;
};

export type UpdateEndpointParams = Partial<CreateEndpointParams> & {
  active?: boolean;
  timeoutSeconds?: number;
  maxAttempts?: number;
};

/** Result of firing a test delivery at an endpoint. */
export type EndpointTestResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// REST: shield rules
// ---------------------------------------------------------------------------

/** What a shield condition inspects. */
export type ShieldField =
  | "from"
  | "from_domain"
  | "to"
  | "subject"
  | "body"
  | "has_attachment"
  | "attachment_name"
  | "attachment_type"
  | "spam_verdict"
  | "spf_verdict"
  | "dkim_verdict";

/**
 * How a condition compares.
 *
 * No regex, deliberately: these patterns run against attacker-supplied text on
 * every inbound message, and a user-authored regex there is a denial-of-service
 * waiting to happen. Spell OR as two rules.
 */
export type ShieldOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "starts_with"
  | "ends_with"
  | "is_true"
  | "is_false";

export type ShieldCondition = {
  field: ShieldField;
  operator: ShieldOperator;
  /** Compared case-insensitively. Ignored by `is_true`/`is_false`. */
  value: string;
};

/** Allow it, drop it, or send it somewhere other than its address would. */
export type ShieldAction = "allow" | "block" | "route";

/**
 * One rule.
 *
 * Conditions are ANDed, rules are evaluated in `priority` order, and the first
 * match wins — so ordering is the whole behaviour. Evaluation is per recipient,
 * not per message: one message naming several of your addresses gets one verdict
 * each.
 */
export type ShieldRule = {
  id: string;
  name: string;
  action: ShieldAction;
  /** Lower runs first. */
  priority: number;
  enabled: boolean;
  /** Derived from which of `domainId`/`addressId` is set. */
  scope: "account" | "domain" | "address";
  domainId: string | null;
  addressId: string | null;
  conditions: ShieldCondition[];
  /** Destinations for a `route` action; empty otherwise. */
  endpointIds: string[];
  /** ISO 8601. */
  createdAt: string;
};

export type CreateShieldRuleParams = {
  name: string;
  action: ShieldAction;
  conditions: ShieldCondition[];
  enabled?: boolean;
  /** Omit both to scope the rule account-wide. Set at most one. */
  domainId?: string | null;
  addressId?: string | null;
  /** Required when `action` is "route". */
  endpointIds?: string[];
};

// ---------------------------------------------------------------------------
// REST: suppressions and forward destinations
// ---------------------------------------------------------------------------

/** Why an address is suppressed. Automatic entries are never "manual". */
export type SuppressionReason = "bounce" | "complaint" | "manual";

/** An address this account may no longer send to. */
export type Suppression = {
  id: string;
  address: string;
  reason: SuppressionReason;
  /** The remote server's explanation, when there was one. */
  detail: string | null;
  /** The message that caused it, for automatic entries. */
  emailId: string | null;
  /** ISO 8601. */
  createdAt: string;
};

export type CreateSuppressionParams = {
  address: string;
  /** Defaults to "manual". */
  reason?: SuppressionReason;
  /** Free-text note, up to 500 characters. */
  detail?: string;
};

/**
 * A mailbox that has agreed to receive forwarded mail.
 *
 * Forwarding to an address requires its consent, so an unverified destination
 * cannot be used by an endpoint until the holder confirms.
 */
export type ForwardDestination = {
  address: string;
  verified: boolean;
  /** ISO 8601, or null while unverified. */
  verifiedAt: string | null;
};

/**
 * The result of asking an address to confirm.
 *
 * `verified: false` with `confirmationSent: true` is the normal first outcome —
 * the mail is on its way and the destination becomes usable once the holder
 * clicks through. Asking again for an already-confirmed address is a no-op that
 * reports `verified: true`.
 */
export type ForwardDestinationRequest = {
  address: string;
  verified: boolean;
  confirmationSent: boolean;
};
