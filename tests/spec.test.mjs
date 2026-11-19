/**
 * The client must cover the whole API. Every SDK method is called against a
 * stub fetch, each request is matched to an operation in openapi/openapi.yaml,
 * and any operation no method reaches — or any request that matches nothing —
 * fails the run. Adding a route on the platform therefore fails this suite
 * after the next `npm run spec:sync`, until the client grows a method for it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { Inboundr } from "../dist/index.js";

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

const spec = yaml.load(readFileSync(new URL("../openapi/openapi.yaml", import.meta.url), "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"];
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({
    key: `${m.toUpperCase()} ${path}`,
    method: m.toUpperCase(),
    pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
    hasBody: Boolean(item[m].requestBody),
  })),
);

const hits = new Map();
const unmatched = [];
const inboundr = new Inboundr({
  apiKey: "inb_test",
  fetch: async (url, init) => {
    const { pathname } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, "");
    const op = operations.find((o) => o.method === init.method && o.pattern.test(path));
    if (op) hits.set(op.key, init);
    else unmatched.push(`${init.method} ${path}`);
    return new Response(JSON.stringify({ data: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

const drain = async (iterable) => {
  for await (const _ of iterable) break;
};

// One call per SDK method. Argument values only need to reach the transport.
const calls = [
  () => inboundr.emails.list(),
  () => drain(inboundr.emails.listAll()),
  () => inboundr.emails.get("em_1"),
  () => inboundr.emails.send({ from: "a@x.dev", to: ["b@x.dev"], subject: "s", text: "t" }),
  () => inboundr.emails.reply("em_1", { text: "t" }),
  () => inboundr.emails.delete("em_1"),
  () => inboundr.emails.retry("em_1"),
  () => inboundr.emails.attachmentUrl("em_1", 0),
  () => inboundr.emails.downloadAttachment("em_1", 0),
  () => inboundr.threads.get("thr_1"),
  () => inboundr.domains.list(),
  () => inboundr.domains.create({ domain: "x.dev" }),
  () => inboundr.domains.get("dom_1"),
  () => inboundr.domains.update("dom_1", { catchAllEndpointIds: [] }),
  () => inboundr.domains.delete("dom_1"),
  () => inboundr.addresses.list(),
  () => inboundr.addresses.create({ domainId: "dom_1", localPart: "a" }),
  () => inboundr.addresses.get("addr_1"),
  () => inboundr.addresses.update("addr_1", { active: false }),
  () => inboundr.addresses.delete("addr_1"),
  () => inboundr.endpoints.list(),
  () => inboundr.endpoints.create({ name: "n", url: "https://x.dev" }),
  () => inboundr.endpoints.get("ep_1"),
  () => inboundr.endpoints.update("ep_1", { active: false }),
  () => inboundr.endpoints.delete("ep_1"),
  () => inboundr.endpoints.test("ep_1"),
  () => inboundr.endpoints.deliveries("ep_1"),
  () => drain(inboundr.endpoints.listAllDeliveries("ep_1")),
  () => inboundr.shieldRules.list(),
  () =>
    inboundr.shieldRules.create({
      name: "n",
      action: "block",
      conditions: [{ field: "subject", operator: "contains", value: "x" }],
    }),
  () => inboundr.shieldRules.get("sr_1"),
  () =>
    inboundr.shieldRules.update("sr_1", {
      name: "n",
      action: "block",
      conditions: [{ field: "subject", operator: "contains", value: "x" }],
    }),
  () => inboundr.shieldRules.delete("sr_1"),
  () => inboundr.shieldRules.move("sr_1", "up"),
  () => inboundr.shieldRules.reorder(["sr_1"]),
  () => inboundr.senders.list(),
  () => inboundr.suppressions.list(),
  () => inboundr.suppressions.create({ address: "a@x.dev" }),
  () => inboundr.suppressions.delete("a@x.dev"),
  () => inboundr.forwardDestinations.list(),
  () => inboundr.forwardDestinations.create({ address: "a@x.dev" }),
  () => inboundr.forwardDestinations.delete("a@x.dev"),
];

await test("every SDK call matches an operation in the spec", async () => {
  for (const call of calls) await call();
  assert.deepEqual(unmatched, [], `requests the spec doesn't describe: ${unmatched.join(", ")}`);
});

await test("every operation in the spec has an SDK method", async () => {
  const missing = operations.map((o) => o.key).filter((k) => !hits.has(k));
  assert.deepEqual(missing, [], `no SDK method calls: ${missing.join(", ")}`);
});

await test("a body is sent exactly where the spec defines one", async () => {
  const wrong = operations
    .filter((o) => hits.has(o.key))
    .filter((o) => o.hasBody !== (hits.get(o.key).body !== undefined))
    .map((o) => `${o.key} (spec body: ${o.hasBody})`);
  assert.deepEqual(wrong, []);
});

console.log(`spec: ${passed} passed, ${failures.length} failed (${operations.length} operations)`);
for (const f of failures) console.error(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
