/**
 * The REST client.
 *
 * A thin, typed wrapper over `/api/v1` — deliberately thin. It adds the bearer
 * header, encodes query strings, turns non-2xx into typed errors and gives you
 * response types; it does not retry, cache, poll or hold state. There is no
 * hidden behaviour to reason about when a call does something you didn't expect.
 *
 * Retries are the notable omission. A blind retry is wrong for half of these
 * endpoints — `emails.send` is not idempotent, and retrying into a 429 spends an
 * account-wide budget shared with MCP — so the decision belongs to the caller,
 * who knows which. `InboundrRateLimitError.retryAfterSeconds` carries the
 * server's own answer for when you do.
 *
 * Built on global `fetch` and nothing else, so it runs on Node 18+, Bun, Deno,
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
  CreatedDomain,
  CreateEndpointParams,
  CreateShieldRuleParams,
  CreateSuppressionParams,
  Domain,
  DomainDetail,
  Email,
  EmailSummary,
  Endpoint,
  EndpointTestResult,
  EndpointWithSecret,
  ForwardDestination,
  ForwardDestinationRequest,
  List,
  ListEmailsParams,
  Page,
  SendEmailParams,
  ShieldRule,
  Suppression,
  Thread,
  UpdateAddressParams,
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

class EmailsResource {
  constructor(private readonly request: Requester) {}

  /**
   * Newest first, with keyset pagination. Bodies are omitted — use
   * {@link EmailsResource.get} for those.
   */
  list(params: ListEmailsParams = {}): Promise<Page<EmailSummary>> {
    return this.request("GET", "/emails", { query: params });
  }

  /** One email with bodies, attachment metadata and verdicts. */
  get(id: string): Promise<Email> {
    return this.request("GET", `/emails/${segment(id)}`);
  }

  /** Sends from an address on a verified domain. Requires text or html. */
  send(params: SendEmailParams): Promise<Email> {
    return this.request("POST", "/emails", { body: params });
  }

  /** Deletes the stored message and its objects. Not recoverable. */
  delete(id: string): Promise<void> {
    return this.request("DELETE", `/emails/${segment(id)}`);
  }

  /**
   * Re-fires this message's failed webhook deliveries. Returns how many were
   * queued — `{ retried: 0 }` means nothing was in a retryable state.
   */
  retry(id: string): Promise<{ retried: number }> {
    return this.request("POST", `/emails/${segment(id)}/retry`);
  }

  /**
   * A short-lived signed URL for one attachment, by its index in the message's
   * `attachments` array.
   *
   * Fails for an attachment whose `stored` is false — nothing was kept to
   * download. The URL expires in minutes; fetch it now rather than storing it.
   */
  attachmentUrl(emailId: string, index: number): Promise<AttachmentUrl> {
    return this.request(
      "GET",
      `/emails/${segment(emailId)}/attachments/${index}`,
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
   * and it verifies on its own from there.
   */
  create(params: { domain: string }): Promise<CreatedDomain> {
    return this.request("POST", "/domains", { body: params });
  }

  get(id: string): Promise<DomainDetail> {
    return this.request("GET", `/domains/${segment(id)}`);
  }

  /**
   * Sets the catch-all wiring. `catchAllEndpointIds: []` turns catch-all off;
   * a non-empty list makes every unmatched address on the domain deliver there.
   */
  update(
    id: string,
    params: { catchAllEndpointIds?: string[] },
  ): Promise<DomainDetail> {
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

  create(params: CreateAddressParams): Promise<Address> {
    return this.request("POST", "/addresses", { body: params });
  }

  get(id: string): Promise<Address> {
    return this.request("GET", `/addresses/${segment(id)}`);
  }

  update(id: string, params: UpdateAddressParams): Promise<Address> {
    return this.request("PATCH", `/addresses/${segment(id)}`, { body: params });
  }

  delete(id: string): Promise<void> {
    return this.request("DELETE", `/addresses/${segment(id)}`);
  }
}

class EndpointsResource {
  constructor(private readonly request: Requester) {}

  /** Secrets are redacted here — they exist only in the create response. */
  list(): Promise<List<Endpoint>> {
    return this.request("GET", "/endpoints");
  }

  /**
   * Creates an endpoint. **The response is the only time `secret` is ever
   * returned** — store it now; it cannot be read back, only rotated.
   */
  create(params: CreateEndpointParams): Promise<EndpointWithSecret> {
    return this.request("POST", "/endpoints", { body: params });
  }

  get(id: string): Promise<Endpoint> {
    return this.request("GET", `/endpoints/${segment(id)}`);
  }

  update(id: string, params: UpdateEndpointParams): Promise<Endpoint> {
    return this.request("PATCH", `/endpoints/${segment(id)}`, { body: params });
  }

  delete(id: string): Promise<void> {
    return this.request("DELETE", `/endpoints/${segment(id)}`);
  }

  /**
   * Fires a signed test delivery at the endpoint and reports what happened.
   *
   * The payload is a real `email.received` envelope carrying a placeholder
   * message, signed with the endpoint's live secret — so this exercises your
   * verification code, not just your URL.
   */
  test(id: string): Promise<EndpointTestResult> {
    return this.request("POST", `/endpoints/${segment(id)}/test`);
  }
}

class ShieldRulesResource {
  constructor(private readonly request: Requester) {}

  /** In evaluation order: lower `priority` first. */
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

  update(
    id: string,
    params: Partial<CreateShieldRuleParams>,
  ): Promise<ShieldRule> {
    return this.request("PUT", `/shield-rules/${segment(id)}`, { body: params });
  }

  delete(id: string): Promise<void> {
    return this.request("DELETE", `/shield-rules/${segment(id)}`);
  }

  /**
   * Replaces the whole evaluation order.
   *
   * `order` must be a permutation of *every* rule on the account — a partial
   * list is rejected rather than applied, so a client working from a stale read
   * gets an error instead of quietly reordering rules it never saw.
   */
  reorder(order: string[]): Promise<{ order: string[] }> {
    return this.request("PUT", "/shield-rules", { body: { order } });
  }
}

class SuppressionsResource {
  constructor(private readonly request: Requester) {}

  /** Addresses this account can no longer send to, newest first. */
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
   * Asks an address to confirm it will accept forwarded mail, or re-asks.
   *
   * Consent is required before a forwarding endpoint may use the address, so
   * this is a prerequisite for `endpoints.create({ type: "forward" })` — not a
   * formality that can be skipped.
   */
  create(params: { address: string }): Promise<ForwardDestinationRequest> {
    return this.request("POST", "/forward-destinations", { body: params });
  }

  /** Withdraws consent. Endpoints forwarding there stop doing so. */
  delete(address: string): Promise<void> {
    return this.request("DELETE", `/forward-destinations/${segment(address)}`);
  }
}
