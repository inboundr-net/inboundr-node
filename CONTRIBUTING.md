# Contributing

## Setup

```bash
npm install
npm test
```

`npm test` checks the generated types, builds `dist/`, runs the webhook, client and spec test suites, and type-checks `tests/types.test.ts`.

## Types come from the API spec

- `openapi/openapi.yaml` is copied from the platform. Don't edit it here.
- `src/generated/api.ts` is generated from it. Don't edit it either.
- `src/types.ts` gives the generated shapes stable names.

When the API changes:

```bash
npm run spec:sync   # copies ../inbound-app/openapi/openapi.yaml, or $INBOUNDR_SPEC
npm test
```

`tests/spec.test.mjs` fails if an operation in the spec has no client method, so a new API route shows up as a failing test until the client covers it.

## Webhook signatures

The signing scheme isn't part of the OpenAPI spec. It is written out at the top of `tests/webhook.test.mjs`, and those tests sign with `node:crypto` independently of the SDK's WebCrypto code. Changing the scheme is a breaking change.

## Releasing

1. Bump `version` in `package.json`.
2. Merge to `main`.
3. Tag `v<version>` and push the tag.

CI runs the tests on Node 20, 22 and 24, checks that the tag matches `package.json`, and publishes to npm with provenance. Publishing needs the `NPM_TOKEN` repository secret.
