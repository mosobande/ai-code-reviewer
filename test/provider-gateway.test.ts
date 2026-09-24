import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview, type ReviewProvider } from "../provider.ts";
import type { GatewayGrantRequest } from "../runtime/model-gateway-protocol.ts";

test("each review attempt receives and revokes its own gateway grant", async () => {
  const grants: GatewayGrantRequest[] = [];
  const revocations: string[] = [];
  const tokens: string[] = [];
  const provider: ReviewProvider = {
    name: "claude",
    validateConfig() {},
    async run(_prompt, opts) {
      assert.equal(opts?.gateway?.baseUrl, "http://127.0.0.1:8080/attempts/a/anthropic");
      assert.ok(opts?.gateway?.token);
      tokens.push(opts.gateway.token);
      if (tokens.length === 1) throw new Error("malformed model response");
      return { summary: "ok", comments: [] };
    },
  };
  const gatewayClient = {
    async grant(request: GatewayGrantRequest) {
      grants.push(request);
      return {
        version: 1 as const, provider: request.provider,
        credentialProfile: request.credentialProfile,
        token: `opaque-${request.attemptId}`,
        baseUrl: "http://127.0.0.1:8080/attempts/a/anthropic",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async revoke(attemptId: string) { revocations.push(attemptId); },
  };
  const result = await runReview(provider, "review", {}, {
    env: {
      MODEL_GATEWAY_SOCKET_PATH: "/tmp/acr-gateway.sock",
      MODEL_GATEWAY_ANTHROPIC_PROFILE: "review",
    },
    gatewayClient,
  });
  assert.equal(result.summary, "ok");
  assert.equal(grants.length, 2);
  assert.equal(grants[0]?.provider, "anthropic");
  assert.equal(grants[0]?.credentialProfile, "review");
  assert.notEqual(grants[0]?.attemptId, grants[1]?.attemptId);
  assert.deepEqual(revocations, grants.map(({ attemptId }) => attemptId));
  assert.notEqual(tokens[0], tokens[1]);
});

test("a mismatched gateway grant is revoked before a reviewer starts", async () => {
  let ran = false;
  let revoked = false;
  const provider: ReviewProvider = {
    name: "claude", validateConfig() {},
    async run() { ran = true; return { summary: "unexpected", comments: [] }; },
  };
  await assert.rejects(runReview(provider, "review", {}, {
    env: {
      MODEL_GATEWAY_SOCKET_PATH: "/tmp/acr-gateway.sock",
      MODEL_GATEWAY_ANTHROPIC_PROFILE: "review",
    },
    gatewayClient: {
      async grant() {
        return {
          version: 1, provider: "openai", credentialProfile: "other",
          token: "opaque-token", baseUrl: "http://127.0.0.1:8080/attempts/a/openai/v1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async revoke() { revoked = true; },
    },
  }), /different provider or profile/);
  assert.equal(ran, false);
  assert.equal(revoked, true);
});
