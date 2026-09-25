import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type {
  ProviderAuthMode,
  ProviderCredentialAdapter,
  ProviderCredentialAdapters,
  ProviderRequestHeaders,
} from "./model-provider-credentials.ts";
import type {
  GatewayGrantRequest,
  GatewayGrantResponse,
  GatewayProvider,
  GatewayRevokeRequest,
} from "./model-gateway-protocol.ts";
import {
  parseGatewayGrantRequest,
  parseGatewayRevokeRequest,
} from "./model-gateway-protocol.ts";

type Grant = {
  attemptId: string;
  provider: GatewayProvider;
  credentialProfile: string;
  audience: string;
  expiresAtMs: number;
  inFlight: boolean;
};

export type AuthorizedGatewayRequest = {
  provider: GatewayProvider;
  credentialProfile: string;
  mode: ProviderAuthMode;
  refresh: "none" | "managed";
  upstreamOrigin: string;
  upstreamPath: string;
  upstreamHeaders: ProviderRequestHeaders;
};

export type ModelGatewayOptions = {
  credentials: ProviderCredentialAdapters;
  publicBaseUrl: string;
  now?: () => number;
  randomBytes?: (length: number) => Buffer;
};

const PROVIDER_API_PREFIX: Record<GatewayProvider, string> = {
  anthropic: "",
  openai: "/v1",
};

const ALLOWED_MODEL_OPERATIONS: Record<GatewayProvider, ReadonlySet<string>> = {
  anthropic: new Set(["POST /v1/messages", "POST /v1/messages/count_tokens"]),
  openai: new Set(["POST /v1/responses", "POST /v1/responses/compact"]),
};

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function bearer(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) {
    throw new Error("model gateway authorization is missing or invalid");
  }
  return match[1];
}

export class ModelRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(
      `model credential is rate limited; retry after ${retryAfterSeconds} seconds`,
    );
    this.name = "ModelRateLimitError";
  }
}

function retryAfterMilliseconds(
  value: string | string[] | undefined,
  now: number,
): number {
  if (typeof value !== "string") {
    return 60_000;
  }
  const text = value.trim();
  const delay = /^\d+$/.test(text)
    ? Number(text) * 1_000
    : /^[A-Za-z]{3}, /.test(text)
      ? Date.parse(text) - now
      : NaN;
  return Number.isSafeInteger(delay) &&
    delay <= Number.MAX_SAFE_INTEGER - now &&
    delay >= 0
    ? Math.max(1_000, delay)
    : 60_000;
}

export class ModelGateway {
  readonly #credentials: ProviderCredentialAdapters;
  readonly #publicBaseUrl: string;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Buffer;
  readonly #grants = new Map<string, Grant>();
  readonly #attempts = new Map<string, string>();
  readonly #cooldowns = new Map<string, number>();
  #closed = false;

  constructor(options: ModelGatewayOptions) {
    const base = new URL(options.publicBaseUrl);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username ||
      base.password ||
      base.href !== `${base.origin}/`
    ) {
      throw new Error("model gateway public base URL is invalid");
    }
    for (const provider of ["anthropic", "openai"] as const) {
      const credential = options.credentials[provider];
      if (credential && credential.provider !== provider) {
        throw new Error(
          `model gateway ${provider} credential has the wrong provider identity`,
        );
      }
    }
    this.#credentials = options.credentials;
    this.#publicBaseUrl = base.toString().replace(/\/$/, "");
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  #credential(provider: GatewayProvider): ProviderCredentialAdapter {
    if (this.#closed) {
      throw new Error("model gateway is closed");
    }
    const credential = this.#credentials[provider];
    if (!credential) {
      throw new Error(`model gateway provider ${provider} is unavailable`);
    }
    return credential;
  }

  providers(): GatewayProvider[] {
    return (["anthropic", "openai"] as const).filter((provider) =>
      Boolean(this.#credentials[provider]),
    );
  }

  profiles(): Partial<Record<GatewayProvider, string>> {
    return Object.fromEntries(
      this.providers().map((provider) => [
        provider,
        this.#credentials[provider]!.profile,
      ]),
    );
  }

  #assertQuotaAvailable(provider: GatewayProvider, profile: string): void {
    const key = `${provider}:${profile}`;
    const remaining = (this.#cooldowns.get(key) ?? 0) - this.#now();
    if (remaining > 0) {
      throw new ModelRateLimitError(Math.ceil(remaining / 1_000));
    }
    this.#cooldowns.delete(key);
  }

  /** Only trusted upstream responses can throttle an active credential profile. */
  observeUpstreamResponse(
    authorized: AuthorizedGatewayRequest,
    status: number | undefined,
    headers: IncomingHttpHeaders,
  ): void {
    if (status !== 429 || this.#closed) {
      return;
    }
    const credential = this.#credential(authorized.provider);
    if (credential.profile !== authorized.credentialProfile) {
      return;
    }
    const key = `${authorized.provider}:${authorized.credentialProfile}`;
    const now = this.#now();
    const retryAt = now + retryAfterMilliseconds(headers["retry-after"], now);
    this.#cooldowns.set(key, Math.max(retryAt, this.#cooldowns.get(key) ?? 0));
  }

  grant(value: unknown): GatewayGrantResponse {
    const request: GatewayGrantRequest = parseGatewayGrantRequest(value);
    const credential = this.#credential(request.provider);
    if (credential.profile !== request.credentialProfile) {
      throw new Error(
        `model gateway credential profile is not active for ${request.provider}`,
      );
    }
    this.#assertQuotaAvailable(request.provider, request.credentialProfile);
    const deadlineMs = Date.parse(request.deadlineAt);
    if (deadlineMs <= this.#now()) {
      throw new Error("model gateway deadline has already passed");
    }
    this.revoke({ version: 1, attemptId: request.attemptId });
    const token = this.#randomBytes(32).toString("base64url");
    const audience = this.#randomBytes(24).toString("base64url");
    const expiresAtMs = deadlineMs + 60_000;
    const digest = tokenDigest(token);
    this.#grants.set(digest, {
      attemptId: request.attemptId,
      provider: request.provider,
      credentialProfile: request.credentialProfile,
      audience,
      expiresAtMs,
      inFlight: false,
    });
    this.#attempts.set(request.attemptId, digest);
    return {
      version: 1,
      provider: request.provider,
      credentialProfile: request.credentialProfile,
      token,
      baseUrl:
        `${this.#publicBaseUrl}/attempts/${audience}/${request.provider}` +
        PROVIDER_API_PREFIX[request.provider],
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  revoke(value: unknown): void {
    const request: GatewayRevokeRequest = parseGatewayRevokeRequest(value);
    const digest = this.#attempts.get(request.attemptId);
    if (!digest) {
      return;
    }
    this.#grants.delete(digest);
    this.#attempts.delete(request.attemptId);
  }

  async authorize(
    url: URL,
    method: string | undefined,
    authorization: string | undefined,
    headers: ProviderRequestHeaders,
    forceRefresh = false,
  ): Promise<AuthorizedGatewayRequest> {
    const token = bearer(authorization);
    const grant = this.#grants.get(tokenDigest(token));
    if (!grant) {
      throw new Error("model gateway grant is unknown");
    }
    if (this.#now() >= grant.expiresAtMs) {
      this.revoke({ version: 1, attemptId: grant.attemptId });
      throw new Error("model gateway grant expired");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "attempts" || segments[1] !== grant.audience) {
      throw new Error("model gateway grant does not match this attempt path");
    }
    if (segments[2] !== grant.provider) {
      throw new Error("model gateway grant does not match this provider");
    }
    const suffix = `/${segments.slice(3).join("/")}`;
    if (
      suffix.includes("..") ||
      url.pathname.includes("%2e") ||
      url.pathname.includes("%2E")
    ) {
      throw new Error("model gateway request path is invalid");
    }
    const operation = `${method?.toUpperCase() ?? ""} ${suffix}`;
    if (!ALLOWED_MODEL_OPERATIONS[grant.provider].has(operation)) {
      throw new Error("model gateway request operation is not allowed");
    }
    const credential = this.#credential(grant.provider);
    if (credential.profile !== grant.credentialProfile) {
      throw new Error(
        "model gateway grant credential profile is no longer active",
      );
    }
    this.#assertQuotaAvailable(grant.provider, grant.credentialProfile);
    const upstream = await credential.authorize({
      path: `${suffix}${url.search}`,
      headers,
      forceRefresh,
    });
    return {
      provider: grant.provider,
      credentialProfile: grant.credentialProfile,
      mode: credential.mode,
      refresh: credential.refresh,
      upstreamOrigin: upstream.origin,
      upstreamPath: upstream.path,
      upstreamHeaders: upstream.headers,
    };
  }

  async beginRequest(
    url: URL,
    method: string | undefined,
    authorization: string | undefined,
    headers: ProviderRequestHeaders,
  ): Promise<AuthorizedGatewayRequest> {
    const token = bearer(authorization);
    const digest = tokenDigest(token);
    const grant = this.#grants.get(digest);
    if (!grant) {
      throw new Error("model gateway grant is unknown");
    }
    if (grant.inFlight) {
      throw new Error("model gateway grant already has an active request");
    }
    grant.inFlight = true;
    try {
      return await this.authorize(url, method, authorization, headers);
    } catch (error) {
      if (this.#grants.get(digest) === grant) {
        grant.inFlight = false;
      }
      throw error;
    }
  }

  assertRequestActive(authorization: string | undefined): void {
    const token = bearer(authorization);
    const grant = this.#grants.get(tokenDigest(token));
    if (!grant || !grant.inFlight) {
      throw new Error("model gateway grant is no longer active");
    }
    if (this.#now() >= grant.expiresAtMs) {
      this.revoke({ version: 1, attemptId: grant.attemptId });
      throw new Error("model gateway grant expired");
    }
    this.#assertQuotaAvailable(grant.provider, grant.credentialProfile);
  }

  endRequest(authorization: string | undefined): void {
    const token = bearer(authorization);
    const grant = this.#grants.get(tokenDigest(token));
    if (grant) {
      grant.inFlight = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#grants.clear();
    this.#attempts.clear();
    this.#cooldowns.clear();
    await Promise.all(
      this.providers().map((provider) => this.#credentials[provider]!.close()),
    );
  }
}

const CONTROL_BODY_LIMIT = 64 * 1_024;

const MODEL_BODY_LIMIT = 8 * 1_024 * 1_024;

const HOP_BY_HOP = new Set([
  "authorization",
  "connection",
  "host",
  "keep-alive",
  "openai-organization",
  "openai-project",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

async function boundedBody(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > limit) {
      throw new Error("model gateway request exceeded its bound");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  return JSON.parse(
    (await boundedBody(request, CONTROL_BODY_LIMIT)).toString("utf8"),
  );
}

function reply(
  response: ServerResponse,
  status: number,
  value: unknown,
  retryAfterSeconds?: number,
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...(retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(retryAfterSeconds) }),
  });
  response.end(body);
}

export function createModelGatewayControlServer(
  gateway: ModelGateway,
): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/capabilities") {
        reply(response, 200, {
          protocol: 1,
          providers: gateway.providers(),
          profiles: gateway.profiles(),
          tokenMode: "opaque-attempt",
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/grants") {
        reply(response, 200, gateway.grant(await jsonBody(request)));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/revocations") {
        gateway.revoke(await jsonBody(request));
        reply(response, 200, { status: "revoked" });
        return;
      }
      reply(response, 404, { error: "not found" });
    } catch (error) {
      const limited = error instanceof ModelRateLimitError;
      reply(
        response,
        limited ? 429 : 400,
        {
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            2_000,
          ),
          ...(limited ? { code: "model_rate_limited" } : {}),
        },
        limited ? error.retryAfterSeconds : undefined,
      );
    }
  });
}

function proxyAuthorization(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization) {
    return authorization;
  }
  const apiKey = request.headers["x-api-key"];
  return typeof apiKey === "string" ? `Bearer ${apiKey}` : undefined;
}

function proxyHeaders(headers: IncomingHttpHeaders): ProviderRequestHeaders {
  const result: ProviderRequestHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
      continue;
    }
    result[name.toLowerCase()] = value;
  }
  return result;
}

function upstreamRequest(
  authorized: AuthorizedGatewayRequest,
  method: string | undefined,
  body: Buffer,
  timeoutMs: number,
): Promise<IncomingMessage> {
  const origin = new URL(authorized.upstreamOrigin);
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/"
  ) {
    throw new Error(
      "model gateway credential returned an invalid upstream origin",
    );
  }
  const target = new URL(authorized.upstreamPath, origin);
  if (target.origin !== origin.origin) {
    throw new Error(
      "model gateway credential returned an invalid upstream path",
    );
  }
  const headers = { ...authorized.upstreamHeaders };
  headers["content-length"] = String(body.length);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      { method, headers, timeout: timeoutMs },
      resolve,
    );
    request.once("timeout", () =>
      request.destroy(new Error("model gateway upstream timed out")),
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function discard(response: IncomingMessage): Promise<void> {
  response.resume();
  if (response.readableEnded) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    response.once("end", resolve);
    response.once("error", reject);
  });
}

function responseHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

export function createModelGatewayProxyServer(
  gateway: ModelGateway,
  requestTimeoutMs = 30 * 60 * 1_000,
): http.Server {
  return http.createServer(async (request, response) => {
    let upstreamStarted = false;
    let activeRequest = false;
    let streamingResponse = false;
    let authorization: string | undefined;
    try {
      const requestUrl = new URL(
        request.url || "/",
        "http://model-gateway.invalid",
      );
      authorization = proxyAuthorization(request);
      const headers = proxyHeaders(request.headers);
      let authorized = await gateway.beginRequest(
        requestUrl,
        request.method,
        authorization,
        headers,
      );
      activeRequest = true;
      const body = await boundedBody(request, MODEL_BODY_LIMIT);
      gateway.assertRequestActive(authorization);
      upstreamStarted = true;
      let upstream = await upstreamRequest(
        authorized,
        request.method,
        body,
        requestTimeoutMs,
      );
      if (upstream.statusCode === 401 && authorized.refresh === "managed") {
        await discard(upstream);
        gateway.assertRequestActive(authorization);
        authorized = await gateway.authorize(
          requestUrl,
          request.method,
          authorization,
          headers,
          true,
        );
        gateway.assertRequestActive(authorization);
        upstream = await upstreamRequest(
          authorized,
          request.method,
          body,
          requestTimeoutMs,
        );
      }
      gateway.observeUpstreamResponse(
        authorized,
        upstream.statusCode,
        upstream.headers,
      );
      response.writeHead(
        upstream.statusCode ?? 502,
        responseHeaders(upstream.headers),
      );
      const finish = (): void => {
        if (!activeRequest) {
          return;
        }
        activeRequest = false;
        gateway.endRequest(authorization);
      };
      upstream.once("end", finish);
      upstream.once("close", finish);
      upstream.once("error", (error) => {
        finish();
        response.destroy(error);
      });
      response.once("close", () => upstream.destroy());
      upstream.pipe(response);
      streamingResponse = true;
    } catch (error) {
      const limited = error instanceof ModelRateLimitError;
      const status = limited ? 429 : upstreamStarted ? 502 : 401;
      if (!response.headersSent) {
        reply(
          response,
          status,
          {
            error: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 2_000),
            ...(limited ? { code: "model_rate_limited" } : {}),
          },
          limited ? error.retryAfterSeconds : undefined,
        );
      } else {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      if (activeRequest && !streamingResponse) {
        gateway.endRequest(authorization);
      }
    }
  });
}
