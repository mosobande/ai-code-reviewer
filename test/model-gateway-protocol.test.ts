import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseGatewayGrantRequest,
  parseGatewayGrantResponse,
  parseGatewayRevokeRequest,
  parseModelGatewayCapabilities,
} from "../runtime/model-gateway-protocol.ts";

const attemptId = "018f0d14-7b2d-7e52-a413-9a6f4fc118db";

test("model gateway protocol accepts only closed attempt-scoped messages", () => {
  assert.deepEqual(
    parseModelGatewayCapabilities({
      protocol: 1,
      providers: ["openai", "anthropic"],
      profiles: { openai: "openai-primary", anthropic: "anthropic-primary" },
      tokenMode: "opaque-attempt",
    }),
    {
      protocol: 1,
      providers: ["anthropic", "openai"],
      profiles: { anthropic: "anthropic-primary", openai: "openai-primary" },
      tokenMode: "opaque-attempt",
    },
  );
  assert.deepEqual(
    parseGatewayGrantRequest({
      version: 1,
      attemptId,
      provider: "openai",
      credentialProfile: "openai-primary",
      deadlineAt: "2026-08-25T10:00:00.000Z",
    }),
    {
      version: 1,
      attemptId,
      provider: "openai",
      credentialProfile: "openai-primary",
      deadlineAt: "2026-08-25T10:00:00.000Z",
    },
  );
  assert.deepEqual(
    parseGatewayGrantResponse({
      version: 1,
      provider: "openai",
      credentialProfile: "openai-primary",
      token: "opaque-attempt-token-0000000000000001",
      baseUrl: "http://model-gateway:8787/attempts/audience/openai",
      expiresAt: "2026-08-25T10:01:00.000Z",
    }),
    {
      version: 1,
      provider: "openai",
      credentialProfile: "openai-primary",
      token: "opaque-attempt-token-0000000000000001",
      baseUrl: "http://model-gateway:8787/attempts/audience/openai",
      expiresAt: "2026-08-25T10:01:00.000Z",
    },
  );
  assert.deepEqual(parseGatewayRevokeRequest({ version: 1, attemptId }), {
    version: 1,
    attemptId,
  });
});

test("model gateway protocol rejects authority and caller-selected destinations", () => {
  const capabilities = {
    protocol: 1,
    providers: ["openai"],
    profiles: { openai: "openai-primary" },
    tokenMode: "opaque-attempt",
  };
  for (const invalid of [
    null,
    [],
    { ...capabilities, protocol: 2 },
    { ...capabilities, tokenMode: "reusable" },
    { ...capabilities, upstreamUrl: "https://attacker.invalid" },
    { ...capabilities, providers: ["openai", "openai"] },
    { ...capabilities, providers: ["unknown"] },
    { ...capabilities, profiles: {} },
    { ...capabilities, profiles: { openai: "../secret" } },
    {
      ...capabilities,
      profiles: { openai: "openai-primary", anthropic: "unexpected" },
    },
    ...Object.keys(capabilities).map((missing) =>
      Object.fromEntries(
        Object.entries(capabilities).filter(([key]) => key !== missing),
      ),
    ),
  ]) {
    assert.throws(
      () => parseModelGatewayCapabilities(invalid),
      /gateway|credentialProfile/,
    );
  }
  for (const extra of [
    { apiKey: "secret" },
    { upstreamUrl: "https://attacker.invalid" },
    { audiencePath: "/chosen" },
    { token: "chosen" },
  ]) {
    assert.throws(
      () =>
        parseGatewayGrantRequest({
          version: 1,
          attemptId,
          provider: "openai",
          credentialProfile: "openai-primary",
          deadlineAt: "2026-08-25T10:00:00.000Z",
          ...extra,
        }),
      /unknown gateway grant field/,
    );
  }
});

test("model gateway protocol requires one safe credential-profile identity", () => {
  for (const credentialProfile of [
    undefined,
    "",
    "../openai",
    "openai primary",
    "a".repeat(129),
  ]) {
    assert.throws(
      () =>
        parseGatewayGrantRequest({
          version: 1,
          attemptId,
          provider: "openai",
          credentialProfile,
          deadlineAt: "2026-08-25T10:00:00.000Z",
        }),
      /credentialProfile/,
    );
  }
});
