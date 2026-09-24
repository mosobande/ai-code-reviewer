import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AnthropicApiKeyCredential,
  AnthropicOAuthCredential,
  loadProviderCredentialAdapters,
  OpenAIApiKeyCredential,
  OpenAICodexOAuthCredential,
  type CodexAuthSession,
} from "../runtime/model-provider-credentials.ts";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.cHJvb2Y`;
}

async function codexHome(accountId = "account-1") {
  const root = await mkdtemp(join(tmpdir(), "model-credential-codex-"));
  const accessToken = jwt({ sub: "user-1", exp: 2_000_000_000 });
  const writeAuth = async (overrides: Record<string, unknown> = {}) => {
    await writeFile(
      join(root, "auth.json"),
      `${JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: jwt({ sub: "user-1" }),
          access_token: accessToken,
          refresh_token: "refresh-token",
          account_id: accountId,
        },
        last_refresh: "2026-08-25T10:00:00Z",
        ...overrides,
      })}\n`,
      { mode: 0o600 },
    );
  };
  await writeAuth();
  return { root, writeAuth, accessToken };
}

class FakeCodexAuthSession implements CodexAuthSession {
  reads: boolean[] = [];
  account: { type: string } | null = { type: "chatgpt" };
  closed = false;
  onRead?: (forceRefresh: boolean) => Promise<void>;

  async readAccount(forceRefresh: boolean) {
    this.reads.push(forceRefresh);
    await this.onRead?.(forceRefresh);
    return this.account;
  }

  async close() {
    this.closed = true;
  }
}

test("provider adapters own their authentication and upstream routing", async () => {
  const anthropicApi = new AnthropicApiKeyCredential(
    "anthropic-primary",
    "anthropic-api-key",
  );
  assert.deepEqual(
    await anthropicApi.authorize({
      path: "/v1/messages?beta=true",
      headers: { "anthropic-version": "2023-06-01" },
    }),
    {
      origin: "https://api.anthropic.com",
      path: "/v1/messages?beta=true",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "anthropic-api-key",
      },
    },
  );

  const anthropicOAuth = new AnthropicOAuthCredential(
    "anthropic-primary",
    "anthropic-oauth-token",
  );
  assert.deepEqual(
    await anthropicOAuth.authorize({
      path: "/v1/messages",
      headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
    }),
    {
      origin: "https://api.anthropic.com",
      path: "/v1/messages",
      headers: {
        authorization: "Bearer anthropic-oauth-token",
        "anthropic-beta": "prompt-caching-2024-07-31,oauth-2025-04-20",
      },
    },
  );

  const openaiApi = new OpenAIApiKeyCredential(
    "openai-primary",
    "openai-api-key",
  );
  assert.deepEqual(
    await openaiApi.authorize({ path: "/v1/responses", headers: {} }),
    {
      origin: "https://api.openai.com",
      path: "/v1/responses",
      headers: { authorization: "Bearer openai-api-key" },
    },
  );
});

test("Anthropic OAuth loads only a private gateway-owned setup-token file", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-credential-anthropic-"));
  const tokenPath = join(root, "oauth-token");
  const linkedTokenPath = join(root, "linked-token");
  await writeFile(tokenPath, "anthropic-oauth-token\n", { mode: 0o600 });
  await symlink(tokenPath, linkedTokenPath);

  let credential: AnthropicOAuthCredential | undefined;
  try {
    const adapters = await loadProviderCredentialAdapters({
      MODEL_GATEWAY_ANTHROPIC_AUTH_MODE: "oauth",
      MODEL_GATEWAY_ANTHROPIC_PROFILE: "anthropic-primary",
      MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE: tokenPath,
    });
    credential = adapters.anthropic as AnthropicOAuthCredential;
    assert.deepEqual(
      await adapters.anthropic?.authorize({
        path: "/v1/messages",
        headers: {},
      }),
      {
        origin: "https://api.anthropic.com",
        path: "/v1/messages",
        headers: {
          authorization: "Bearer anthropic-oauth-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
    );

    await assert.rejects(
      loadProviderCredentialAdapters({
        MODEL_GATEWAY_ANTHROPIC_AUTH_MODE: "oauth",
        MODEL_GATEWAY_ANTHROPIC_PROFILE: "anthropic-primary",
        MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE: "relative/oauth-token",
      }),
      /must be absolute/,
    );
    await assert.rejects(
      loadProviderCredentialAdapters({
        MODEL_GATEWAY_ANTHROPIC_AUTH_MODE: "oauth",
        MODEL_GATEWAY_ANTHROPIC_PROFILE: "anthropic-primary",
        MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE: linkedTokenPath,
      }),
      /missing, invalid, or not private/,
    );
    await chmod(tokenPath, 0o644);
    await assert.rejects(
      loadProviderCredentialAdapters({
        MODEL_GATEWAY_ANTHROPIC_AUTH_MODE: "oauth",
        MODEL_GATEWAY_ANTHROPIC_PROFILE: "anthropic-primary",
        MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE: tokenPath,
      }),
      /missing, invalid, or not private/,
    );
  } finally {
    await credential?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth uses the Codex-owned session and ChatGPT backend without exposing state", async () => {
  const home = await codexHome();
  const session = new FakeCodexAuthSession();
  try {
    const credential = await OpenAICodexOAuthCredential.create({
      profile: "openai-primary",
      codexHome: home.root,
      session,
    });
    const authorized = await credential.authorize({
      path: "/v1/responses/compact?trace=1",
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(authorized, {
      origin: "https://chatgpt.com",
      path: "/backend-api/codex/responses/compact?trace=1",
      headers: {
        authorization: `Bearer ${home.accessToken}`,
        "chatgpt-account-id": "account-1",
        "content-type": "application/json",
      },
    });
    assert.deepEqual(session.reads, [false, false]);
    await credential.close();
    assert.equal(session.closed, true);
  } finally {
    await rm(home.root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth refreshes near expiry and fails closed on account change or logout", async () => {
  const home = await codexHome();
  const session = new FakeCodexAuthSession();
  try {
    const credential = await OpenAICodexOAuthCredential.create({
      profile: "openai-primary",
      codexHome: home.root,
      session,
      now: () => Date.parse("2026-08-25T10:00:00Z"),
    });
    await home.writeAuth({
      tokens: {
        id_token: jwt({ sub: "user-1" }),
        access_token: jwt({
          sub: "user-1",
          exp: Date.parse("2026-08-25T10:03:00Z") / 1_000,
        }),
        refresh_token: "refresh-token",
        account_id: "account-1",
      },
    });
    session.onRead = async (forceRefresh) => {
      if (!forceRefresh) {
        return;
      }
      await home.writeAuth({
        tokens: {
          id_token: jwt({ sub: "user-1" }),
          access_token: jwt({
            sub: "user-1",
            exp: Date.parse("2026-08-25T11:00:00Z") / 1_000,
          }),
          refresh_token: "refreshed-token",
          account_id: "account-1",
        },
      });
    };
    await credential.authorize({ path: "/v1/responses", headers: {} });
    assert.deepEqual(session.reads, [false, true]);

    session.onRead = undefined;
    await home.writeAuth({
      tokens: {
        id_token: jwt({ sub: "user-1" }),
        access_token: jwt({
          sub: "user-1",
          exp: Date.parse("2026-08-25T11:00:00Z") / 1_000,
        }),
        refresh_token: "refresh-token",
        account_id: "account-2",
      },
    });
    await assert.rejects(
      credential.authorize({ path: "/v1/responses", headers: {} }),
      /account identity changed/,
    );

    session.account = null;
    await assert.rejects(
      credential.authorize({
        path: "/v1/responses",
        headers: {},
        forceRefresh: true,
      }),
      /ChatGPT OAuth session is unavailable/,
    );
  } finally {
    await credentialClose(session);
    await rm(home.root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth rechecks that auth.json remains private", async () => {
  const home = await codexHome();
  const session = new FakeCodexAuthSession();
  try {
    await chmod(join(home.root, "auth.json"), 0o644);
    await assert.rejects(
      OpenAICodexOAuthCredential.create({
        profile: "openai-primary",
        codexHome: home.root,
        session,
      }),
      /missing, invalid, or not private/,
    );
  } finally {
    await credentialClose(session);
    await rm(home.root, { recursive: true, force: true });
  }
});

async function credentialClose(session: FakeCodexAuthSession): Promise<void> {
  if (!session.closed) {
    await session.close();
  }
}

test("gateway credential configuration requires one explicit mode and profile per provider", async () => {
  await assert.rejects(
    loadProviderCredentialAdapters({ OPENAI_API_KEY: "openai-key" }),
    /MODEL_GATEWAY_OPENAI_AUTH_MODE/,
  );
  await assert.rejects(
    loadProviderCredentialAdapters({
      MODEL_GATEWAY_OPENAI_AUTH_MODE: "oauth",
      MODEL_GATEWAY_OPENAI_PROFILE: "openai-primary",
      MODEL_GATEWAY_OPENAI_CODEX_HOME: "/credentials/openai",
      OPENAI_API_KEY: "must-not-fallback",
    }),
    /does not allow OPENAI_API_KEY/,
  );
  await assert.rejects(
    loadProviderCredentialAdapters({
      MODEL_GATEWAY_ANTHROPIC_AUTH_MODE: "api-key",
      MODEL_GATEWAY_ANTHROPIC_PROFILE: "anthropic-primary",
      ANTHROPIC_API_KEY: "anthropic-key",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-fallback",
    }),
    /does not allow CLAUDE_CODE_OAUTH_TOKEN/,
  );
  await assert.rejects(
    loadProviderCredentialAdapters({
      MODEL_GATEWAY_ANTHROPIC_AUTH_MODE: "oauth",
      MODEL_GATEWAY_ANTHROPIC_PROFILE: "anthropic-primary",
      CLAUDE_CODE_OAUTH_TOKEN: "legacy-env-token",
    }),
    /does not allow CLAUDE_CODE_OAUTH_TOKEN/,
  );

  const adapters = await loadProviderCredentialAdapters({
    MODEL_GATEWAY_ANTHROPIC_AUTH_MODE: "api-key",
    MODEL_GATEWAY_ANTHROPIC_PROFILE: "anthropic-primary",
    ANTHROPIC_API_KEY: "anthropic-key",
    MODEL_GATEWAY_OPENAI_AUTH_MODE: "api-key",
    MODEL_GATEWAY_OPENAI_PROFILE: "openai-primary",
    OPENAI_API_KEY: "openai-key",
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(adapters).map(([provider, adapter]) => [
        provider,
        {
          profile: adapter?.profile,
          mode: adapter?.mode,
        },
      ]),
    ),
    {
      anthropic: { profile: "anthropic-primary", mode: "api-key" },
      openai: { profile: "openai-primary", mode: "api-key" },
    },
  );
});
