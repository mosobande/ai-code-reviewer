import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CodexAppServerAuthSession } from "../runtime/codex-auth-companion.ts";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.cHJvb2Y`;
}

test(
  "pinned Codex companion refreshes one isolated fake ChatGPT session",
  { timeout: 30_000 },
  async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-auth-companion-"));
    const binaryPath = resolve("node_modules/.bin/codex");
    const initialAccessToken = jwt({ sub: "proof-user", exp: 2_000_000_000 });
    const refreshedAccessToken = jwt({ sub: "proof-user", exp: 2_000_003_600 });
    await writeFile(
      join(codexHome, "auth.json"),
      `${JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: jwt({
            sub: "proof-user",
            email: "proof@example.invalid",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "proof-account",
              chatgpt_plan_type: "pro",
            },
          }),
          access_token: initialAccessToken,
          refresh_token: "proof-old-refresh-token",
          account_id: "proof-account",
        },
        last_refresh: "2026-08-25T10:00:00Z",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(codexHome, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
      {
        mode: 0o600,
      },
    );

    const refreshRequests: unknown[] = [];
    const refreshServer = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        refreshRequests.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: refreshedAccessToken,
            refresh_token: "proof-new-refresh-token",
          }),
        );
      });
    });
    await new Promise<void>((resolveListen) =>
      refreshServer.listen(0, "127.0.0.1", resolveListen),
    );
    const address = refreshServer.address();
    assert.ok(address && typeof address !== "string");

    let session: CodexAppServerAuthSession | undefined;
    try {
      session = await CodexAppServerAuthSession.create({
        binaryPath,
        codexHome,
        expectedVersion: "0.142.4",
        extraEnv: {
          CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${address.port}/oauth/token`,
          CODEX_APP_SERVER_LOGIN_CLIENT_ID: "proof-client",
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
      });
      const account = await session.readAccount(true);
      assert.equal(account?.type, "chatgpt");
      const stored = JSON.parse(
        await readFile(join(codexHome, "auth.json"), "utf8"),
      );
      assert.equal(stored.tokens.access_token, refreshedAccessToken);
      assert.equal(stored.tokens.refresh_token, "proof-new-refresh-token");
      assert.equal(stored.tokens.account_id, "proof-account");
      assert.deepEqual(refreshRequests, [
        {
          client_id: "proof-client",
          grant_type: "refresh_token",
          refresh_token: "proof-old-refresh-token",
        },
      ]);
    } finally {
      await session?.close();
      await new Promise<void>((resolveClose) =>
        refreshServer.close(() => resolveClose()),
      );
      await rm(codexHome, { recursive: true, force: true });
    }
  },
);

test("Codex companion rejects an unpinned CLI before opening auth state", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-auth-version-"));
  try {
    await assert.rejects(
      CodexAppServerAuthSession.create({
        binaryPath: resolve("node_modules/.bin/codex"),
        codexHome,
        expectedVersion: "0.0.0",
      }),
      /expected Codex 0\.0\.0/,
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("Codex companion rejects provider credential overrides", async () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_AUTH_SOURCE",
  ]) {
    await assert.rejects(
      CodexAppServerAuthSession.create({
        binaryPath: resolve("node_modules/.bin/codex"),
        codexHome: resolve("unused-codex-home"),
        expectedVersion: "0.149.1",
        extraEnv: { [name]: "must-not-cross-the-boundary" },
      }),
      new RegExp(`cannot set ${name}`),
    );
  }
});
