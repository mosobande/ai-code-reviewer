import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  parseGatewayCredentialProfile,
  type GatewayProvider,
} from "./model-gateway-protocol.ts";

export type ProviderAuthMode = "api-key" | "oauth";

export type ProviderRequestHeaders = Record<string, string | string[]>;

export type ProviderAuthorizationRequest = {
  path: string;
  headers: ProviderRequestHeaders;
  forceRefresh?: boolean;
};

export type AuthorizedUpstreamRequest = {
  origin: string;
  path: string;
  headers: ProviderRequestHeaders;
};

export interface ProviderCredentialAdapter {
  readonly provider: GatewayProvider;
  readonly profile: string;
  readonly mode: ProviderAuthMode;
  readonly refresh: "none" | "managed";
  authorize(
    request: ProviderAuthorizationRequest,
  ): Promise<AuthorizedUpstreamRequest>;
  close(): Promise<void>;
}

export interface CodexAuthSession {
  readAccount(forceRefresh: boolean): Promise<{ type: string } | null>;
  close(): Promise<void>;
}

export type ProviderCredentialAdapters = Partial<
  Record<GatewayProvider, ProviderCredentialAdapter>
>;

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

const OPENAI_API_ORIGIN = "https://api.openai.com";

const OPENAI_CHATGPT_ORIGIN = "https://chatgpt.com";

const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

const ANTHROPIC_OAUTH_FILE_LIMIT_BYTES = 64 * 1024;

const OPENAI_REFRESH_WINDOW_MS = 5 * 60 * 1_000;

const OPENAI_AUTH_FILE_LIMIT_BYTES = 1024 * 1024;

function secret(value: string, name: string): string {
  const parsed = value.trim();
  if (!parsed) {
    throw new Error(`${name} must be a non-empty secret`);
  }
  return parsed;
}

async function privateSecretFile(path: string, name: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error(`${name} must be absolute`);
  }
  let value: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size < 1 ||
        metadata.size > ANTHROPIC_OAUTH_FILE_LIMIT_BYTES
      ) {
        throw new Error("unsafe secret file");
      }
      value = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(`${name} is missing, invalid, or not private`);
  }
  const parsed = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!parsed || parsed.trim() !== parsed || /\s/.test(parsed)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return parsed;
}

function safeHeaders(headers: ProviderRequestHeaders): ProviderRequestHeaders {
  const result: ProviderRequestHeaders = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      name === "authorization" ||
      name === "x-api-key" ||
      name === "openai-organization" ||
      name === "openai-project" ||
      name === "chatgpt-account-id"
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

abstract class StaticCredential implements ProviderCredentialAdapter {
  abstract readonly provider: GatewayProvider;
  abstract readonly mode: ProviderAuthMode;
  readonly refresh = "none" as const;
  readonly profile: string;
  protected readonly credential: string;

  constructor(profile: string, credential: string) {
    this.profile = parseGatewayCredentialProfile(profile);
    this.credential = secret(credential, `${this.constructor.name} credential`);
  }

  abstract authorize(
    request: ProviderAuthorizationRequest,
  ): Promise<AuthorizedUpstreamRequest>;

  async close(): Promise<void> {}
}

export class AnthropicApiKeyCredential extends StaticCredential {
  readonly provider = "anthropic" as const;
  readonly mode = "api-key" as const;

  async authorize(
    request: ProviderAuthorizationRequest,
  ): Promise<AuthorizedUpstreamRequest> {
    return {
      origin: ANTHROPIC_ORIGIN,
      path: request.path,
      headers: {
        ...safeHeaders(request.headers),
        "x-api-key": this.credential,
      },
    };
  }
}

export class AnthropicOAuthCredential extends StaticCredential {
  readonly provider = "anthropic" as const;
  readonly mode = "oauth" as const;

  async authorize(
    request: ProviderAuthorizationRequest,
  ): Promise<AuthorizedUpstreamRequest> {
    const headers = safeHeaders(request.headers);
    const currentBeta = headers["anthropic-beta"];
    const betaValues = (
      Array.isArray(currentBeta) ? currentBeta : [currentBeta]
    )
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    if (!betaValues.includes(ANTHROPIC_OAUTH_BETA)) {
      betaValues.push(ANTHROPIC_OAUTH_BETA);
    }
    headers["anthropic-beta"] = betaValues.join(",");
    headers.authorization = `Bearer ${this.credential}`;
    return { origin: ANTHROPIC_ORIGIN, path: request.path, headers };
  }
}

export class OpenAIApiKeyCredential extends StaticCredential {
  readonly provider = "openai" as const;
  readonly mode = "api-key" as const;

  async authorize(
    request: ProviderAuthorizationRequest,
  ): Promise<AuthorizedUpstreamRequest> {
    return {
      origin: OPENAI_API_ORIGIN,
      path: request.path,
      headers: {
        ...safeHeaders(request.headers),
        authorization: `Bearer ${this.credential}`,
      },
    };
  }
}

type OpenAIAuthFile = {
  accountId: string;
  accessToken: string;
  expiresAtMs: number;
};

function exactFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unknown) {
    throw new Error(`${name} contains unsupported field ${unknown}`);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw new Error(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function jwtExpiration(token: string): number {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("OpenAI OAuth access token must be a JWT");
  }
  let payload: Record<string, unknown>;
  try {
    payload = object(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      "JWT payload",
    );
  } catch {
    throw new Error("OpenAI OAuth access token has an invalid JWT payload");
  }
  if (
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= 0
  ) {
    throw new Error("OpenAI OAuth access token must have a valid exp claim");
  }
  return payload.exp * 1_000;
}

async function readOpenAIAuthFile(codexHome: string): Promise<OpenAIAuthFile> {
  const authPath = join(codexHome, "auth.json");
  let authText: string;
  try {
    const handle = await open(
      authPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const authFile = await handle.stat();
      if (
        !authFile.isFile() ||
        (authFile.mode & 0o077) !== 0 ||
        authFile.size > OPENAI_AUTH_FILE_LIMIT_BYTES
      ) {
        throw new Error(
          "OpenAI OAuth auth.json must be a bounded private regular file",
        );
      }
      authText = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(
      "OpenAI OAuth auth.json is missing, invalid, or not private",
    );
  }
  let input: Record<string, unknown>;
  try {
    input = object(JSON.parse(authText), "auth.json");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("auth.json ")) {
      throw error;
    }
    throw new Error("OpenAI OAuth auth.json is missing or invalid");
  }
  exactFields(
    input,
    [
      "auth_mode",
      "OPENAI_API_KEY",
      "tokens",
      "last_refresh",
      "agent_identity",
      "personal_access_token",
      "bedrock_api_key",
    ],
    "OpenAI OAuth auth.json",
  );
  if (input.auth_mode !== "chatgpt") {
    throw new Error("OpenAI OAuth auth.json must use chatgpt mode");
  }
  if (typeof input.OPENAI_API_KEY === "string" && input.OPENAI_API_KEY.trim()) {
    throw new Error("OpenAI OAuth auth.json must not contain an API key");
  }
  const tokens = object(input.tokens, "OpenAI OAuth tokens");
  exactFields(
    tokens,
    ["id_token", "access_token", "refresh_token", "account_id"],
    "OpenAI OAuth tokens",
  );
  requiredString(tokens.id_token, "OpenAI OAuth id token");
  requiredString(tokens.refresh_token, "OpenAI OAuth refresh token");
  const accessToken = requiredString(
    tokens.access_token,
    "OpenAI OAuth access token",
  );
  return {
    accountId: requiredString(tokens.account_id, "OpenAI OAuth account ID"),
    accessToken,
    expiresAtMs: jwtExpiration(accessToken),
  };
}

function chatGptPath(path: string): string {
  const parsed = new URL(path, "http://model-gateway.invalid");
  if (parsed.origin !== "http://model-gateway.invalid") {
    throw new Error("OpenAI OAuth request path must be relative");
  }
  if (
    parsed.pathname !== "/v1/responses" &&
    parsed.pathname !== "/v1/responses/compact"
  ) {
    throw new Error("OpenAI OAuth request operation is not allowed");
  }
  return `/backend-api/codex${parsed.pathname.slice("/v1".length)}${parsed.search}`;
}

export class OpenAICodexOAuthCredential implements ProviderCredentialAdapter {
  readonly provider = "openai" as const;
  readonly mode = "oauth" as const;
  readonly refresh = "managed" as const;
  readonly profile: string;
  readonly #codexHome: string;
  readonly #session: CodexAuthSession;
  readonly #now: () => number;
  readonly #accountId: string;
  #queue: Promise<void> = Promise.resolve();

  private constructor(options: {
    profile: string;
    codexHome: string;
    session: CodexAuthSession;
    now: () => number;
    accountId: string;
  }) {
    this.profile = parseGatewayCredentialProfile(options.profile);
    this.#codexHome = options.codexHome;
    this.#session = options.session;
    this.#now = options.now;
    this.#accountId = options.accountId;
  }

  static async create(options: {
    profile: string;
    codexHome: string;
    session: CodexAuthSession;
    now?: () => number;
  }): Promise<OpenAICodexOAuthCredential> {
    if (!isAbsolute(options.codexHome)) {
      throw new Error("MODEL_GATEWAY_OPENAI_CODEX_HOME must be absolute");
    }
    const account = await options.session.readAccount(false);
    if (account?.type !== "chatgpt") {
      throw new Error("OpenAI ChatGPT OAuth session is unavailable");
    }
    const auth = await readOpenAIAuthFile(options.codexHome);
    return new OpenAICodexOAuthCredential({
      ...options,
      now: options.now ?? Date.now,
      accountId: auth.accountId,
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  authorize(
    request: ProviderAuthorizationRequest,
  ): Promise<AuthorizedUpstreamRequest> {
    return this.#serialized(async () => {
      let auth = await readOpenAIAuthFile(this.#codexHome);
      const forceRefresh =
        Boolean(request.forceRefresh) ||
        auth.expiresAtMs <= this.#now() + OPENAI_REFRESH_WINDOW_MS;
      const account = await this.#session.readAccount(forceRefresh);
      if (account?.type !== "chatgpt") {
        throw new Error("OpenAI ChatGPT OAuth session is unavailable");
      }
      auth = await readOpenAIAuthFile(this.#codexHome);
      if (auth.accountId !== this.#accountId) {
        throw new Error("OpenAI ChatGPT OAuth account identity changed");
      }
      if (auth.expiresAtMs <= this.#now() + OPENAI_REFRESH_WINDOW_MS) {
        throw new Error(
          "OpenAI ChatGPT OAuth refresh did not produce a usable access token",
        );
      }
      return {
        origin: OPENAI_CHATGPT_ORIGIN,
        path: chatGptPath(request.path),
        headers: {
          ...safeHeaders(request.headers),
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
        },
      };
    });
  }

  async close(): Promise<void> {
    await this.#queue;
    await this.#session.close();
  }
}

type CredentialLoaderDeps = {
  createCodexAuthSession?: (codexHome: string) => Promise<CodexAuthSession>;
};

function configured(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.some((name) => Boolean(env[name]?.trim()));
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function mode(
  env: NodeJS.ProcessEnv,
  provider: "ANTHROPIC" | "OPENAI",
): ProviderAuthMode {
  const name = `MODEL_GATEWAY_${provider}_AUTH_MODE`;
  const value = requiredEnv(env, name);
  if (value !== "api-key" && value !== "oauth") {
    throw new Error(`${name} must be api-key or oauth`);
  }
  return value;
}

export function modelCredentialProfile(
  provider: GatewayProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = `MODEL_GATEWAY_${provider.toUpperCase()}_PROFILE`;
  return parseGatewayCredentialProfile(requiredEnv(env, name));
}

export async function loadProviderCredentialAdapters(
  env: NodeJS.ProcessEnv = process.env,
  deps: CredentialLoaderDeps = {},
): Promise<ProviderCredentialAdapters> {
  const adapters: ProviderCredentialAdapters = {};
  const anthropicNames = [
    "MODEL_GATEWAY_ANTHROPIC_AUTH_MODE",
    "MODEL_GATEWAY_ANTHROPIC_PROFILE",
    "MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ] as const;
  if (configured(env, anthropicNames)) {
    const authMode = mode(env, "ANTHROPIC");
    const profile = modelCredentialProfile("anthropic", env);
    if (authMode === "api-key") {
      if (env.MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE?.trim()) {
        throw new Error(
          "Anthropic api-key mode does not allow MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE",
        );
      }
      if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
        throw new Error(
          "Anthropic api-key mode does not allow CLAUDE_CODE_OAUTH_TOKEN",
        );
      }
      adapters.anthropic = new AnthropicApiKeyCredential(
        profile,
        requiredEnv(env, "ANTHROPIC_API_KEY"),
      );
    } else {
      if (env.ANTHROPIC_API_KEY?.trim()) {
        throw new Error(
          "Anthropic oauth mode does not allow ANTHROPIC_API_KEY",
        );
      }
      if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
        throw new Error(
          "Anthropic oauth mode does not allow CLAUDE_CODE_OAUTH_TOKEN",
        );
      }
      const tokenFile = requiredEnv(
        env,
        "MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE",
      );
      adapters.anthropic = new AnthropicOAuthCredential(
        profile,
        await privateSecretFile(tokenFile, "Anthropic OAuth token file"),
      );
    }
  }

  const openaiNames = [
    "MODEL_GATEWAY_OPENAI_AUTH_MODE",
    "MODEL_GATEWAY_OPENAI_PROFILE",
    "MODEL_GATEWAY_OPENAI_CODEX_HOME",
    "OPENAI_API_KEY",
  ] as const;
  if (configured(env, openaiNames)) {
    const authMode = mode(env, "OPENAI");
    const profile = modelCredentialProfile("openai", env);
    if (authMode === "api-key") {
      if (env.MODEL_GATEWAY_OPENAI_CODEX_HOME?.trim()) {
        throw new Error(
          "OpenAI api-key mode does not allow MODEL_GATEWAY_OPENAI_CODEX_HOME",
        );
      }
      adapters.openai = new OpenAIApiKeyCredential(
        profile,
        requiredEnv(env, "OPENAI_API_KEY"),
      );
    } else {
      if (env.OPENAI_API_KEY?.trim()) {
        throw new Error("OpenAI oauth mode does not allow OPENAI_API_KEY");
      }
      const codexHome = requiredEnv(env, "MODEL_GATEWAY_OPENAI_CODEX_HOME");
      if (!deps.createCodexAuthSession) {
        throw new Error("OpenAI oauth mode requires the Codex auth companion");
      }
      const session = await deps.createCodexAuthSession(codexHome);
      try {
        adapters.openai = await OpenAICodexOAuthCredential.create({
          profile,
          codexHome,
          session,
        });
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
    }
  }
  return adapters;
}
