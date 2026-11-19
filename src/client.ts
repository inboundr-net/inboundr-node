/**
 * The REST client.
 *
 * A thin, typed wrapper over `/api/v1` — deliberately thin. It adds the bearer
 * header, encodes query strings, turns non-2xx into typed errors and gives you
 * response types, all generated from the API's OpenAPI description. It does
 * not retry, cache or hold state; the only thing that makes more than one
 * request is a `listAll*` iterator, and only as you iterate it. There is no
 * hidden behaviour to reason about when a call does something you didn't expect.
 *
 * Retries are the notable omission. A blind retry is wrong for half of these
 * endpoints — `emails.send` is not idempotent, and retrying into a 429 spends an
 * account-wide budget shared with MCP — so the decision belongs to the caller,
 * who knows which. `InboundrRateLimitError.retryAfterSeconds` carries the
 * server's own answer for when you do.
 *
 * Built on global `fetch` and nothing else, so it runs on Node 20+, Bun, Deno,
 * Cloudflare Workers and Vercel Edge unchanged.
 */

import {
  InboundrApiError,
  InboundrError,
  InboundrRateLimitError,
} from "./errors.js";
import type {
  Address,
  AttachmentUrl,
  CreateAddressParams,
  CreateDomainParams,
  CreatedAddress,
  CreateEndpointParams,
  CreateShieldRuleParams,
  CreateSuppressionParams,
  Delivery,
  DomainDetail,
  Domain,
  Email,
  EmailSummary,
  Endpoint,
  EndpointTestResult,
  EndpointWithSecret,
  ForwardDestination,
  ForwardDestinationRequest,
  List,
  ListDeliveriesParams,
  ListEmailsParams,
  Page,
  ReplaceShieldRuleParams,
  ReplyParams,
  Sender,
  SendEmailParams,
  SentEmail,
  ShieldRule,
  ShieldRuleOrder,
  Suppression,
  Thread,
  UpdateAddressParams,
  UpdateDomainParams,
  UpdatedDomain,
  UpdateEndpointParams,
} from "./types.js";

/** Where the API lives unless you say otherwise. */
export const DEFAULT_BASE_URL = "https://inboundr.net";

/** Env var the API key is read from when none is passed. */
export const API_KEY_ENV_VAR = "INBOUNDR_API_KEY";

/** Just enough of `fetch` to be swappable in tests. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type InboundrOptions = {
  /**
   * An `inb_…` key. Defaults to `process.env.INBOUNDR_API_KEY` where a `process`
   * exists — on a runtime without one (Workers, Deno without env access) it must
   * be passed explicitly.
   */
  apiKey?: string;
  /** Origin only, no path. Defaults to `https://inboundr.net`. */
  baseUrl?: string;
  /** Injectable `fetch`, for tests or a custom agent. Defaults to the global. */
  fetch?: FetchLike;
  /**
   * Per-request timeout. Default 30s.
   *
   * Applies to each call individually, not to a sequence of them. Set to 0 to
   * disable and let the platform decide.
   */
  timeoutMs?: number;
};

/**
 * Reads an env var without assuming `process` exists.
 *
 * `process.env.X` throws a ReferenceError on Cloudflare Workers rather than
 * returning undefined, which would make merely constructing a client fail on a
 * runtime this package claims to support.
 */
function readEnv(name: string): string | undefined {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  return proc?.env?.[name];
}

/** Pulls a human-readable message out of whatever the API returned. */
function messageFor(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string") return error;
    // A 400 from a Zod-validated route carries an error *tree* rather than a
    // string. Serializing it beats discarding it: it names the offending field,
    // which is the one thing that makes the 400 actionable.
    return `${status} ${JSON.stringify(error)}`;
  }
  if (typeof body === "string" && body.trim() !== "") return `${status} ${body}`;
  return `Request failed with status ${status}`;
}

function toQueryString(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

type RequestOptions = {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Return the successful Response untouched, for a binary download. */
  raw?: boolean;
};

/** The bound transport each resource group is handed. */
type Requester = <T>(
  method: string,
  path: string,
  options?: RequestOptions,
) => Promise<T>;

export class Inboundr {
  readonly emails: EmailsResource;
  readonly threads: ThreadsResource;
  readonly domains: DomainsResource;
  readonly addresses: AddressesResource;
  readonly endpoints: EndpointsResource;
  readonly shieldRules: ShieldRulesResource;
  readonly senders: SendersResource;
  readonly suppressions: SuppressionsResource;
  readonly forwardDestinations: ForwardDestinationsResource;

  readonly baseUrl: string;

  #apiKey: string;
  #fetch: FetchLike;
  #timeoutMs: number;

  /**
   * ```ts
   * const inboundr = new Inboundr();                 // reads INBOUNDR_API_KEY
   * const inboundr = new Inboundr("inb_live_…");     // key directly
   * const inboundr = new Inboundr({ apiKey, baseUrl });
   * ```
   */
  constructor(options: InboundrOptions | string = {}) {
    const resolved: InboundrOptions =
      typeof options === "string" ? { apiKey: options } : options;

    const apiKey = resolved.apiKey ?? readEnv(API_KEY_ENV_VAR);
    if (!apiKey) {
      throw new InboundrError(
        `No API key. Pass one as new Inboundr({ apiKey }) or set ${API_KEY_ENV_VAR}. ` +
          "Create a key in the console under Keys.",
      );
    }

    this.#apiKey = apiKey;
    // Trailing slashes would produce `//api/v1/...`, which some proxies
    // normalize and others 404 on. Strip once here rather than at every call.
    this.baseUrl = (resolved.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = resolved.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = resolved.timeoutMs ?? 30_000;

    const request: Requester = (method, path, opts) =>
      this.#request(method, path, opts);

    this.emails = new EmailsResource(request);
    this.threads = new ThreadsResource(request);
    this.domains = new DomainsResource(request);
    this.addresses = new AddressesResource(request);
    this.endpoints = new EndpointsResource(request);
    this.shieldRules = new ShieldRulesResource(request);
    this.senders = new SendersResource(request);
    this.suppressions = new SuppressionsResource(request);
    this.forwardDestinations = new ForwardDestinationsResource(request);
  }

  async #request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}${toQueryString(options.query)}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.#timeoutMs)
        : undefined;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      // An abort here is almost always our own timer, and "The operation was
      // aborted" alone sends people hunting for a bug in their own code.
      if (controller.signal.aborted) {
        throw new InboundrError(
          `${method} ${path} timed out after ${this.#timeoutMs}ms.`,
          { cause },
        );
      }
      throw new InboundrError(`${method} ${path} failed: ${String(cause)}`, {
        cause,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const requestId = response.headers.get("x-request-id");

    if (options.raw && response.ok) return response as T;

    // 204 is the documented success for every delete. Reading a body that isn't
    // there and parsing "" as JSON would throw on the happy path.
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let body: unknown = text;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON — a proxy error page, most likely. Keep the text for `body`
        // so the caller can see what actually came back.
      }
    }

    if (!response.ok) {
      if (response.status === 429) {
        // Parse defensively rather than via Number(): `Number(null)` is 0, so a
        // missing header would come out as "retry immediately" — the opposite of
        // what its absence means.
        const header = response.headers.get("retry-after");
        const retryAfter = header !== null ? Number(header) : Number.NaN;
        throw new InboundrRateLimitError(messageFor(response.status, body), {
          status: response.status,
          body,
          requestId,
          retryAfterSeconds:
            Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
        });
      }
      throw new InboundrApiError(messageFor(response.status, body), {
        status: response.status,
        body,
        requestId,
      });
    }

    return body as T;
  }
}

/** Percent-encodes a path segment. Ids are safe; email addresses are not. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Walks a keyset-paginated listing, one request per page, yielding items.
 *
 * Pages are fetched lazily as you iterate, so breaking out of the loop stops
 * the requests. Each page is a call against the account's shared rate limit;
 * a long walk can run into it, and the error surfaces from the loop.
 */
async function* paginate<T, P extends { cursor?: string }>(
  params: P,
  fetchPage: (params: P) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor = params.cursor;
  do {
    const page = await fetchPage({ ...params, cursor });
    yield* page.data;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

class EmailsResource {
  constructor(private readonly request: Requester) {}

  /**
   * One page, newest first. Bodies are omitted — use
   * {@link EmailsResource.get} for those.
   */
  list(params: ListEmailsParams = {}): Promise<Page<EmailSummary>> {
    return this.request("GET", "/emails", { query: params });
  }

  /**
   * Every matching email, newest first, fetching pages as you iterate.
   *
   * ```ts
   * for await (const email of inboundr.emails.listAll({ direction: "inbound" })) { … }
   * ```
   */
  listAll(params: ListEmailsParams = {}): AsyncGenerator<EmailSummary> {
    return paginate(params, (p) => this.list(p));
  }

  /** One email with bodies, attachment metadata and verdicts. */
  get(id: string): Promise<Email> {
    return this.request("GET", `/emails/${segment(id)}`);
  }

  /**
   * Sends through a connected sender, or from a verified domain where outbound
   * is enabled. Requires `text` or `html`. Not idempotent: retrying a send that
   * timed out can deliver it twice.
   */
  send(params: SendEmailParams): Promise<SentEmail> {
    return this.request("POST", "/emails", { body: params });
  }

  /**
   * Answers a received email. Recipients, subject and threading headers come
   * from the stored message; `replyAll` adds its other recipients.
   */
  reply(id: string, params: ReplyParams): Promise<SentEmail> {
    return this.request("POST", `/emails/${segment(id)}/reply`, { body: params });
  }

  /** Deletes the stored message and its objects. Not recoverable. */
  delete(id: string): Promise<void> {
    return this.request("DELETE", `/emails/${segment(id)}`);
  }

  /**
   * Re-fires this message's failed webhook deliveries. Returns how many were
   * retried — `{ retried: 0 }` means nothing was in a retryable state.
   */
  retry(id: string): Promise<{ retried: number }> {
    return this.request("POST", `/emails/${segment(id)}/retry`);
  }

  /**
   * A short-lived signed URL for one attachment, by its index in the message's
   * `attachments` array.
   *
   * Fails for an attachment whose `stored` is false — nothing was kept to
   * download. The URL expires in 15 minutes; fetch it now rather than storing it.
   */
  attachmentUrl(emailId: string, index: number): Promise<AttachmentUrl> {
    return this.request(
      "GET",
      `/emails/${segment(emailId)}/attachments/${index}`,
    );
  }

  /**
   * The attachment's bytes, streamed through the API instead of a signed
   * storage URL — for a client that can't reach the storage host.
   *
   * Returns the `Response`: read it with `.arrayBuffer()`, `.blob()`, or pipe
   * `.body`. `content-type` and `content-disposition` carry the file's type and
   * name.
   */
  downloadAttachment(emailId: string, index: number): Promise<Response> {
    return this.request(
      "GET",
      `/emails/${segment(emailId)}/attachments/${index}`,
      { query: { download: "1" }, raw: true },
    );
  }
}

class ThreadsResource {
  constructor(private readonly request: Requester) {}

  /** Every message in a conversation, oldest first. */
  get(threadId: string): Promise<Thread> {
    return this.request("GET", `/threads/${segment(threadId)}`);
  }
}

class DomainsResource {
  constructor(private readonly request: Requester) {}

  list(): Promise<List<Domain>> {
    return this.request("GET", "/domains");
  }

  /**
   * Registers a domain. It lands `pending`; publish the returned `dnsRecords`
   * and poll {@link DomainsResource.get} until `state` is `verified`.
   */
  create(params: CreateDomainParams): Promise<DomainDetail> {
    return this.request("POST", "/domains", { body: params });
  }

  /** Re-checks verification, so polling this is how you learn a domain is ready. */
  get(id: string): Promise<DomainDetail> {
    return this.request("GET", `/domains/${segment(id)}`);
  }

  /**
   * Sets the catch-all endpoints. `catchAllEndpointIds: []` turns catch-all
   * off; a non-empty list makes every unrouted address on the domain deliver
   * there.
   */
  update(id: string, params: UpdateDomainParams): Promise<UpdatedDomain> {
    return this.request("PATCH", `/domains/${segment(id)}`, { body: params });
  }

  /** Removes the domain, its addresses and their stored mail. */
  delete(id: string): Promise<void> {
    return this.request("DELETE", `/domains/${segment(id)}`);
  }
}

class AddressesResource {
  constructor(private readonly request: Requester) {}

  list(): Promise<List<Address>> {
    return this.request("GET", "/addresses");
  }

  /** With no `endpointIds` the address is store-only: kept, not delivered. */
  create(params: CreateAddressParams): Promise<CreatedAddress> {
    return this.request("POST", "/addresses", { body: params });
  }

  get(id: string): Promise<Address> {
    return this.request("GET", `/addresses/${segment(id)}`);
  }

  /** `endpointIds` replaces the whole set; `[]` makes the address store-only. */
  update(id: string, params: UpdateAddressParams): Promise<Address> {
    return this.request("PATCH", `/addresses/${segment(id)}`, { body: params });
  }

  delete(id: string): Promise<void> {
    return this.request("DELETE", `/addresses/${segment(id)}`);
  }
}

class EndpointsResource {
  constructor(private readonly request: Requester) {}

  /** Secrets are never included — they exist only in the create response. */
  list(): Promise<List<Endpoint>> {
    return this.request("GET", "/endpoints");
  }

  /**
   * Creates an endpoint. **The response is the only time `secret` is ever
   * returned** — store it now; it cannot be read back.
   */
  create(params: CreateEndpointParams): Promise<EndpointWithSecret> {
    return this.request("POST", "/endpoints", { body: params });
  }

  get(id: string): Promise<Endpoint> {
    return this.request("GET", `/endpoints/${segment(id)}`);
  }

  /** A partial update: send only the fields you are changing. */
  update(id: string, params: UpdateEndpointParams): Promise<Endpoint> {
    return this.request("PATCH", `/endpoints/${segment(id)}`, { body: params });
  }

  /** Removes the endpoint and its delivery history. */
  delete(id: string): Promise<void> {
    return this.request("DELETE", `/endpoints/${segment(id)}`);
  }

  /**
   * Fires a signed test delivery at the endpoint and reports what happened.
   *
   * The payload is a real `email.received` envelope carrying a placeholder
   * message, signed with the endpoint's live secret — so this exercises your
   * verification code, not just your URL. Webhook, Slack and Discord only.
   */
  test(id: string): Promise<EndpointTestResult> {
    return this.request("POST", `/endpoints/${segment(id)}/test`);
  }

  /**
   * One page of this endpoint's deliveries, newest first. `failed` is still
   * being retried; `dead` has run out of attempts.
   */
  deliveries(
    id: string,
    params: ListDeliveriesParams = {},
  ): Promise<Page<Delivery>> {
    return this.request("GET", `/endpoints/${segment(id)}/deliveries`, {
      query: params,
    });
  }

  /** Every matching delivery, newest first, fetching pages as you iterate. */
  listAllDeliveries(
    id: string,
    params: ListDeliveriesParams = {},
  ): AsyncGenerator<Delivery> {
    return paginate(params, (p) => this.deliveries(id, p));
  }
}

class ShieldRulesResource {
  constructor(private readonly request: Requester) {}

  /** In evaluation order. The first rule that matches a message wins. */
  list(): Promise<List<ShieldRule>> {
    return this.request("GET", "/shield-rules");
  }

  /** Creates a rule. It lands last in the order. */
  create(params: CreateShieldRuleParams): Promise<ShieldRule> {
    return this.request("POST", "/shield-rules", { body: params });
  }

  get(id: string): Promise<ShieldRule> {
    return this.request("GET", `/shield-rules/${segment(id)}`);
  }

  /**
   * Replaces the rule. A full replace, not a merge — but a rule from
   * {@link ShieldRulesResource.get} can be passed back with changes, since its
   * read-only fields are accepted and ignored:
   *
   * ```ts
   * const rule = await inboundr.shieldRules.get(id);
   * await inboundr.shieldRules.update(id, { ...rule, enabled: false });
   * ```
   *
   * Its place in the order doesn't change; use `move` or `reorder` for that.
   */
  update(id: string, params: ReplaceShieldRuleParams): Promise<ShieldRule> {
    return this.request("PUT", `/shield-rules/${segment(id)}`, { body: params });
  }

  delete(id: string): Promise<void> {
    return this.request("DELETE", `/shield-rules/${segment(id)}`);
  }

  /**
   * Swaps the rule with its neighbour. Moving past either end does nothing.
   * Returns the full order afterwards.
   */
  move(id: string, direction: "up" | "down"): Promise<ShieldRuleOrder> {
    return this.request("POST", `/shield-rules/${segment(id)}/move`, {
      body: { direction },
    });
  }

  /**
   * Replaces the whole evaluation order.
   *
   * `order` must be a permutation of *every* rule on the account — a partial
   * list is rejected with a 409 rather than applied, so a client working from
   * a stale read gets an error instead of quietly reordering rules it never saw.
   */
  reorder(order: string[]): Promise<ShieldRuleOrder> {
    return this.request("PUT", "/shield-rules", { body: { order } });
  }
}

class SendersResource {
  constructor(private readonly request: Requester) {}

  /**
   * Senders connected in the console, so an agent can tell which From
   * addresses it may use. Read-only: credentials are added in the console,
   * never through an API key.
   */
  list(): Promise<List<Sender>> {
    return this.request("GET", "/senders");
  }
}

class SuppressionsResource {
  constructor(private readonly request: Requester) {}

  /** Addresses this account can no longer send to. Not on the Free plan. */
  list(): Promise<List<Suppression>> {
    return this.request("GET", "/suppressions");
  }

  /** Blocks an address by hand. Bounces and complaints add entries on their own. */
  create(params: CreateSuppressionParams): Promise<{ address: string }> {
    return this.request("POST", "/suppressions", { body: params });
  }

  /**
   * Lets mail flow to an address again.
   *
   * Worth a moment's thought for a `bounce` or `complaint` entry: the address
   * ended up here because a remote server rejected it or someone marked it spam,
   * and sending again damages your domain's reputation.
   */
  delete(address: string): Promise<void> {
    return this.request("DELETE", `/suppressions/${segment(address)}`);
  }
}

class ForwardDestinationsResource {
  constructor(private readonly request: Requester) {}

  list(): Promise<List<ForwardDestination>> {
    return this.request("GET", "/forward-destinations");
  }

  /**
   * Asks an address to confirm it will accept forwarded mail, or re-asks
   * (which invalidates earlier confirmation links).
   *
   * Nothing is forwarded to an address until it confirms, so this is a
   * prerequisite for `endpoints.create({ type: "forward" })`.
   */
  create(params: { address: string }): Promise<ForwardDestinationRequest> {
    return this.request("POST", "/forward-destinations", { body: params });
  }

  /**
   * Withdraws consent. Endpoints keep the address, but nothing is delivered to
   * it until it confirms again.
   */
  delete(address: string): Promise<void> {
    return this.request("DELETE", `/forward-destinations/${segment(address)}`);
  }
}
