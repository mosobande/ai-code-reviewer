import { main as startModelGateway } from "../runtime/model-gateway-main.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  AnthropicApiKeyCredential,
  OpenAIApiKeyCredential,
  type ProviderCredentialAdapter,
} from "../runtime/model-provider-credentials.ts";
import {
  createModelGatewayProxyServer,
  createModelGatewayControlServer,
  ModelRateLimitError,
  ModelGateway,
} from "../runtime/model-gateway-server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelGatewayClient } from "../runtime/model-gateway-client.ts";

const attemptA = "018f0d14-7b2d-7e52-a413-9a6f4fc118db";

const attemptB = "018f0d14-7b2d-7e52-a413-9a6f4fc118dc";

function credentials() {
  return {
    openai: new OpenAIApiKeyCredential("openai-primary", "upstream-openai"),
    anthropic: new AnthropicApiKeyCredential(
      "anthropic-primary",
      "upstream-anthropic",
    ),
  };
}

test("gateway grants bind an opaque token to the exact profile, path, deadline, and attempt", async () => {
  let now = Date.parse("2026-08-25T09:00:00.000Z");
  let sequence = 0;
  const gateway = new ModelGateway({
    credentials: credentials(),
    publicBaseUrl: "http://model-gateway:8787",
    now: () => now,
    randomBytes: (length) => Buffer.alloc(length, ++sequence),
  });
  const first = gateway.grant({
    version: 1,
    attemptId: attemptA,
    provider: "openai",
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  const second = gateway.grant({
    version: 1,
    attemptId: attemptB,
    provider: "openai",
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  assert.doesNotMatch(first.token, /openai|018f0d14|upstream/);
  assert.equal(first.credentialProfile, "openai-primary");
  assert.match(first.baseUrl, /\/openai\/v1$/);
  assert.equal(first.expiresAt, "2026-08-25T09:11:00.000Z");
  assert.deepEqual(
    await gateway.authorize(
      new URL(`${first.baseUrl}/responses`),
      "POST",
      `Bearer ${first.token}`,
      { "content-type": "application/json" },
    ),
    {
      provider: "openai",
      credentialProfile: "openai-primary",
      mode: "api-key",
      refresh: "none",
      upstreamOrigin: "https://api.openai.com",
      upstreamPath: "/v1/responses",
      upstreamHeaders: {
        authorization: "Bearer upstream-openai",
        "content-type": "application/json",
      },
    },
  );
  await assert.rejects(
    gateway.authorize(
      new URL(`${second.baseUrl}/responses`),
      "POST",
      `Bearer ${first.token}`,
      {},
    ),
    /does not match this attempt path/,
  );
  await assert.rejects(
    gateway.authorize(
      new URL(
        first.baseUrl.replace(/openai\/v1$/, "anthropic") + "/v1/messages",
      ),
      "POST",
      `Bearer ${first.token}`,
      {},
    ),
    /does not match this provider/,
  );
  await assert.rejects(
    gateway.authorize(
      new URL(`${first.baseUrl}/files`),
      "POST",
      `Bearer ${first.token}`,
      {},
    ),
    /request operation is not allowed/,
  );
  assert.throws(
    () =>
      gateway.grant({
        version: 1,
        attemptId: attemptA,
        provider: "openai",
        credentialProfile: "openai-secondary",
        deadlineAt: "2026-08-25T09:10:00.000Z",
      }),
    /credential profile is not active/,
  );
  gateway.revoke({ version: 1, attemptId: attemptA });
  await assert.rejects(
    gateway.authorize(
      new URL(`${first.baseUrl}/responses`),
      "POST",
      `Bearer ${first.token}`,
      {},
    ),
    /grant is unknown/,
  );
  now = Date.parse("2026-08-25T09:11:00.000Z");
  await assert.rejects(
    gateway.authorize(
      new URL(`${second.baseUrl}/responses`),
      "POST",
      `Bearer ${second.token}`,
      {},
    ),
    /grant expired/,
  );
});

test("gateway restart forgets all grants", async () => {
  const options = {
    credentials: {
      openai: new OpenAIApiKeyCredential("openai-primary", "upstream-openai"),
    },
    publicBaseUrl: "http://model-gateway:8787",
    now: () => Date.parse("2026-08-25T09:00:00.000Z"),
    randomBytes: (length: number) => Buffer.alloc(length, 7),
  } as const;
  const first = new ModelGateway(options);
  const grant = first.grant({
    version: 1,
    attemptId: attemptA,
    provider: "openai",
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  const restarted = new ModelGateway(options);
  await assert.rejects(
    restarted.authorize(
      new URL(`${grant.baseUrl}/responses`),
      "POST",
      `Bearer ${grant.token}`,
      {},
    ),
    /grant is unknown/,
  );
});

test("one grant permits sequential requests but rejects concurrent reuse and revoked uploads", async () => {
  const gateway = new ModelGateway({
    credentials: {
      openai: new OpenAIApiKeyCredential("openai-primary", "upstream-openai"),
    },
    publicBaseUrl: "http://model-gateway:8787",
    now: () => Date.parse("2026-08-25T09:00:00.000Z"),
    randomBytes: (length) => Buffer.alloc(length, 7),
  });
  const grant = gateway.grant({
    version: 1,
    attemptId: attemptA,
    provider: "openai",
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  const url = new URL(`${grant.baseUrl}/responses`);
  const authorization = `Bearer ${grant.token}`;
  await gateway.beginRequest(url, "POST", authorization, {});
  await assert.rejects(
    gateway.beginRequest(url, "POST", authorization, {}),
    /already has an active request/,
  );
  gateway.assertRequestActive(authorization);
  gateway.endRequest(authorization);
  await assert.doesNotReject(
    gateway.beginRequest(url, "POST", authorization, {}),
  );
  gateway.revoke({ version: 1, attemptId: attemptA });
  assert.throws(
    () => gateway.assertRequestActive(authorization),
    /no longer active/,
  );
  assert.doesNotThrow(() => gateway.endRequest(authorization));
});

test("gateway allows only the model operations used by each installed client", async () => {
  let sequence = 0;
  const gateway = new ModelGateway({
    credentials: credentials(),
    publicBaseUrl: "http://model-gateway:8787",
    now: () => Date.parse("2026-08-25T09:00:00.000Z"),
    randomBytes: (length) => Buffer.alloc(length, ++sequence),
  });
  const anthropic = gateway.grant({
    version: 1,
    attemptId: attemptA,
    provider: "anthropic",
    credentialProfile: "anthropic-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  const openai = gateway.grant({
    version: 1,
    attemptId: attemptB,
    provider: "openai",
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
    await assert.doesNotReject(
      gateway.authorize(
        new URL(`${anthropic.baseUrl}${path}`),
        "POST",
        `Bearer ${anthropic.token}`,
        {},
      ),
    );
  }
  for (const path of ["/responses", "/responses/compact"]) {
    await assert.doesNotReject(
      gateway.authorize(
        new URL(`${openai.baseUrl}${path}`),
        "POST",
        `Bearer ${openai.token}`,
        {},
      ),
    );
  }
});

async function requestProxy(
  port: number,
  path: string,
  token: string,
  body: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

test("proxy refreshes managed OAuth once on 401 and preserves the request and response stream", async () => {
  const upstreamBodies: string[] = [];
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
      if (request.headers.authorization === "Bearer stale") {
        response.writeHead(401).end("expired");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-proof": "streamed",
      });
      response.write("data: one\n\n");
      setImmediate(() => response.end("data: two\n\n"));
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const refreshes: boolean[] = [];
  const credential: ProviderCredentialAdapter = {
    provider: "openai",
    profile: "openai-primary",
    mode: "oauth",
    refresh: "managed",
    async authorize(request) {
      refreshes.push(Boolean(request.forceRefresh));
      return {
        origin: `http://127.0.0.1:${upstreamAddress.port}`,
        path: `/backend-api/codex${request.path.slice("/v1".length)}`,
        headers: {
          ...request.headers,
          authorization: request.forceRefresh ? "Bearer fresh" : "Bearer stale",
          "chatgpt-account-id": "account-1",
        },
      };
    },
    async close() {},
  };
  const gateway = new ModelGateway({
    credentials: { openai: credential },
    publicBaseUrl: "http://model-gateway:8787",
    now: () => Date.parse("2026-08-25T09:00:00.000Z"),
    randomBytes: (length) => Buffer.alloc(length, 7),
  });
  const grant = gateway.grant({
    version: 1,
    attemptId: attemptA,
    provider: "openai",
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  const proxy = createModelGatewayProxyServer(gateway);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== "string");
  try {
    const body = JSON.stringify({ model: "proof", stream: true });
    const result = await requestProxy(
      proxyAddress.port,
      new URL(`${grant.baseUrl}/responses`).pathname,
      grant.token,
      body,
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers["content-type"], "text/event-stream");
    assert.equal(result.headers["x-proof"], "streamed");
    assert.equal(result.body, "data: one\n\ndata: two\n\n");
    assert.deepEqual(refreshes, [false, true]);
    assert.deepEqual(upstreamBodies, [body, body]);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("proxy rejects a granted worker's non-model operation before upstream dispatch", async () => {
  const gateway = new ModelGateway({
    credentials: {
      openai: new OpenAIApiKeyCredential("openai-primary", "upstream-openai"),
    },
    publicBaseUrl: "http://127.0.0.1",
    now: () => Date.parse("2026-08-25T09:00:00.000Z"),
    randomBytes: (length) => Buffer.alloc(length, 7),
  });
  const grant = gateway.grant({
    version: 1,
    attemptId: attemptA,
    provider: "openai",
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  });
  const server = createModelGatewayProxyServer(gateway);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await requestProxy(
      address.port,
      new URL(`${grant.baseUrl}/files`).pathname,
      grant.token,
      "{}",
    );
    assert.equal(result.status, 401);
    assert.match(result.body, /request operation is not allowed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("upstream quota throttles the shared credential across grants and requests, not other providers", async (t) => {
  let now = Date.parse("2026-08-25T09:00:00.000Z");
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    upstreamCalls += 1;
    if (upstreamCalls === 1) {
      response.writeHead(429, { "retry-after": "120" }).end("quota reached");
    } else {
      response.writeHead(200).end("accepted");
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  );
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const credential: ProviderCredentialAdapter = {
    provider: "openai",
    profile: "openai-primary",
    mode: "api-key",
    refresh: "none",
    async authorize(request) {
      return {
        origin: `http://127.0.0.1:${upstreamAddress.port}`,
        path: request.path,
        headers: { authorization: "Bearer upstream-only" },
      };
    },
    async close() {},
  };
  const gateway = new ModelGateway({
    credentials: { ...credentials(), openai: credential },
    publicBaseUrl: "http://model-gateway",
    now: () => now,
  });
  t.after(() => gateway.close());
  const base = {
    version: 1 as const,
    provider: "openai" as const,
    credentialProfile: "openai-primary",
    deadlineAt: "2026-08-25T09:10:00.000Z",
  };
  const first = gateway.grant({ ...base, attemptId: attemptA });
  const second = gateway.grant({ ...base, attemptId: attemptB });
  const proxy = createModelGatewayProxyServer(gateway);
  const control = createModelGatewayControlServer(gateway);
  for (const server of [proxy, control]) {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
  }
  const proxyAddress = proxy.address();
  const controlAddress = control.address();
  assert.ok(proxyAddress && typeof proxyAddress !== "string");
  assert.ok(controlAddress && typeof controlAddress !== "string");
  const send = (grant: typeof first) =>
    requestProxy(
      proxyAddress.port,
      new URL(`${grant.baseUrl}/responses`).pathname,
      grant.token,
      '{"model":"proof"}',
    );
  assert.equal((await send(first)).status, 429);
  const rejected = await send(second);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers["retry-after"], "120");
  assert.doesNotMatch(rejected.body, /upstream-only|openai-primary/);
  const grantResponse = await requestProxy(
    controlAddress.port,
    "/v1/grants",
    "unused",
    JSON.stringify({
      ...base,
      attemptId: "018f0d14-7b2d-7e52-a413-9a6f4fc118dd",
    }),
  );
  assert.equal(grantResponse.status, 429);
  assert.equal(grantResponse.headers["retry-after"], "120");
  assert.equal(
    upstreamCalls,
    1,
    "other attempts must not hit an exhausted upstream credential",
  );
  const independent = gateway.grant({
    ...base,
    attemptId: "018f0d14-7b2d-7e52-a413-9a6f4fc118de",
    provider: "anthropic",
    credentialProfile: "anthropic-primary",
  });
  assert.equal(
    (
      await gateway.authorize(
        new URL(`${independent.baseUrl}/v1/messages`),
        "POST",
        `Bearer ${independent.token}`,
        {},
      )
    ).provider,
    "anthropic",
  );
  now += 120000;
  assert.equal(
    (await send(second)).status,
    200,
    "throttling releases the in-flight flag and expires by clock",
  );
  assert.equal(upstreamCalls, 2);
});

test("quota cooldown parses upstream retry bounds and cannot be shortened by another response", async (t) => {
  const now = Date.parse("2026-08-25T09:00:00.000Z");
  const cases: Array<[http.IncomingHttpHeaders["retry-after"], number]> = [
    ["120", 120],
    [new Date(now + 125000).toUTCString(), 125],
    ["0", 1],
    [undefined, 60],
    ["-10", 60],
    ["unavailable", 60],
    ["999999999999999999999", 60],
  ];
  for (const [header, expected] of cases) {
    const gateway = new ModelGateway({
      credentials: credentials(),
      publicBaseUrl: "http://gateway",
      now: () => now,
    });
    t.after(() => gateway.close());
    const request = {
      version: 1 as const,
      attemptId: attemptA,
      provider: "openai" as const,
      credentialProfile: "openai-primary",
      deadlineAt: "2026-08-25T09:10:00.000Z",
    };
    const grant = gateway.grant(request);
    const authorized = await gateway.authorize(
      new URL(`${grant.baseUrl}/responses`),
      "POST",
      `Bearer ${grant.token}`,
      {},
    );
    gateway.observeUpstreamResponse(authorized, 429, { "retry-after": header });
    gateway.observeUpstreamResponse(authorized, 200, {});
    gateway.observeUpstreamResponse(authorized, 429, { "retry-after": "0" });
    assert.throws(
      () => gateway.grant({ ...request, attemptId: attemptB }),
      (error: unknown) =>
        error instanceof ModelRateLimitError &&
        error.retryAfterSeconds === expected,
    );
  }
});

test("broker control client grants and revokes one profile-bound opaque attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-gateway-client-"));
  const socket = join(root, "gateway.sock");
  const gateway = new ModelGateway({
    credentials: {
      openai: new OpenAIApiKeyCredential("openai-primary", "upstream-secret"),
    },
    publicBaseUrl: "http://model-gateway:8787",
    now: () => Date.parse("2026-08-25T09:00:00.000Z"),
    randomBytes: (length) => Buffer.alloc(length, 9),
  });
  const server = createModelGatewayControlServer(gateway);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const client = new ModelGatewayClient(socket);
    assert.deepEqual(await client.capabilities(), {
      protocol: 1,
      providers: ["openai"],
      profiles: { openai: "openai-primary" },
      tokenMode: "opaque-attempt",
    });
    const attemptId = "018f0d14-7b2d-7e52-a413-9a6f4fc118db";
    const grant = await client.grant({
      version: 1,
      attemptId,
      provider: "openai",
      credentialProfile: "openai-primary",
      deadlineAt: "2026-08-25T09:10:00.000Z",
    });
    assert.doesNotMatch(JSON.stringify(grant), /upstream-secret/);
    assert.equal(grant.credentialProfile, "openai-primary");
    assert.equal(
      (
        await gateway.authorize(
          new URL(`${grant.baseUrl}/responses`),
          "POST",
          `Bearer ${grant.token}`,
          {},
        )
      ).provider,
      "openai",
    );
    await client.revoke(attemptId);
    await assert.rejects(
      gateway.authorize(
        new URL(`${grant.baseUrl}/responses`),
        "POST",
        `Bearer ${grant.token}`,
        {},
      ),
      /unknown/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway startup rejects invalid bindings or missing credentials before listening", async () => {
  await assert.rejects(
    startModelGateway({ MODEL_GATEWAY_SOCKET_PATH: "relative.sock" }),
    /must be absolute/,
  );
  for (const port of ["0", "65536", "-1", "1.5", "invalid"]) {
    await assert.rejects(
      startModelGateway({ MODEL_GATEWAY_PORT: port }),
      /MODEL_GATEWAY_PORT/,
    );
  }
  await assert.rejects(
    startModelGateway({ MODEL_GATEWAY_SOCKET_PATH: "/tmp/never-listen.sock" }),
    /at least one configured provider credential/,
  );
});
