export type GatewayProvider = "anthropic" | "openai";

export type GatewayCredentialProfiles = Partial<
  Record<GatewayProvider, string>
>;

export type ModelGatewayCapabilities = {
  protocol: 1;
  providers: GatewayProvider[];
  profiles: GatewayCredentialProfiles;
  tokenMode: "opaque-attempt";
};

export type GatewayGrantRequest = {
  version: 1;
  attemptId: string;
  provider: GatewayProvider;
  credentialProfile: string;
  deadlineAt: string;
};

export type GatewayGrantResponse = {
  version: 1;
  provider: GatewayProvider;
  credentialProfile: string;
  token: string;
  baseUrl: string;
  expiresAt: string;
};

export type GatewayRevokeRequest = {
  version: 1;
  attemptId: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  input: Record<string, unknown>,
  fields: readonly string[],
  name: string,
): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) {
    throw new Error(`unknown ${name} field: ${unknown}`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function attemptId(value: unknown): string {
  const id = text(value, "attemptId");
  if (!UUID.test(id)) {
    throw new Error("attemptId must be a UUID");
  }
  return id;
}

function timestamp(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return parsed;
}

function provider(value: unknown): GatewayProvider {
  if (value !== "anthropic" && value !== "openai") {
    throw new Error("gateway provider must be anthropic or openai");
  }
  return value;
}

export function parseGatewayCredentialProfile(value: unknown): string {
  const profile = text(value, "credentialProfile");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(profile)) {
    throw new Error("credentialProfile must be a safe lowercase identifier");
  }
  return profile;
}

export function parseGatewayCredentialProfiles(
  value: unknown,
  providers: readonly GatewayProvider[],
): GatewayCredentialProfiles {
  const input = record(value, "gateway credential profiles");
  const expected = new Set(providers);
  const unknown = Object.keys(input).find(
    (name) => name !== "anthropic" && name !== "openai",
  );
  if (unknown) {
    throw new Error(`gateway capabilities contain unknown profile: ${unknown}`);
  }
  const unexpected = Object.keys(input).find(
    (name) => !expected.has(name as GatewayProvider),
  );
  if (unexpected) {
    throw new Error(
      `gateway capabilities include a profile without provider: ${unexpected}`,
    );
  }
  const missing = providers.find((name) => !(name in input));
  if (missing) {
    throw new Error(`gateway capabilities are missing profile: ${missing}`);
  }
  return Object.fromEntries(
    [...providers]
      .sort()
      .map((provider) => [
        provider,
        parseGatewayCredentialProfile(input[provider]),
      ]),
  ) as GatewayCredentialProfiles;
}

export function parseModelGatewayCapabilities(
  value: unknown,
): ModelGatewayCapabilities {
  const input = record(value, "gateway capabilities");
  const fields = ["protocol", "providers", "profiles", "tokenMode"];
  exact(input, fields, "gateway capabilities");
  const missing = fields.find((field) => !(field in input));
  if (missing) {
    throw new Error(`missing gateway capabilities field: ${missing}`);
  }
  if (input.protocol !== 1 || input.tokenMode !== "opaque-attempt") {
    throw new Error("gateway capabilities are incompatible");
  }
  if (
    !Array.isArray(input.providers) ||
    input.providers.some(
      (provider) => provider !== "anthropic" && provider !== "openai",
    ) ||
    new Set(input.providers).size !== input.providers.length
  ) {
    throw new Error("gateway providers are invalid");
  }
  const providers = [...input.providers].sort() as GatewayProvider[];
  return {
    protocol: 1,
    providers,
    profiles: parseGatewayCredentialProfiles(input.profiles, providers),
    tokenMode: "opaque-attempt",
  };
}

export function parseGatewayGrantRequest(value: unknown): GatewayGrantRequest {
  const input = record(value, "gateway grant");
  exact(
    input,
    ["version", "attemptId", "provider", "credentialProfile", "deadlineAt"],
    "gateway grant",
  );
  if (input.version !== 1) {
    throw new Error("gateway grant version must be 1");
  }
  return {
    version: 1,
    attemptId: attemptId(input.attemptId),
    provider: provider(input.provider),
    credentialProfile: parseGatewayCredentialProfile(input.credentialProfile),
    deadlineAt: timestamp(input.deadlineAt, "deadlineAt"),
  };
}

export function parseGatewayGrantResponse(
  value: unknown,
): GatewayGrantResponse {
  const input = record(value, "gateway grant response");
  exact(
    input,
    [
      "version",
      "provider",
      "credentialProfile",
      "token",
      "baseUrl",
      "expiresAt",
    ],
    "gateway grant response",
  );
  if (input.version !== 1) {
    throw new Error("gateway grant response version must be 1");
  }
  const token = text(input.token, "gateway token");
  if (token.length < 32) {
    throw new Error("gateway token is not opaque enough");
  }
  const baseUrl = text(input.baseUrl, "gateway baseUrl");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("gateway baseUrl must be an absolute URL");
  }
  if (
    !parsed.pathname.startsWith("/attempts/") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("gateway baseUrl is invalid");
  }
  return {
    version: 1,
    provider: provider(input.provider),
    credentialProfile: parseGatewayCredentialProfile(input.credentialProfile),
    token,
    baseUrl,
    expiresAt: timestamp(input.expiresAt, "expiresAt"),
  };
}

export function parseGatewayRevokeRequest(
  value: unknown,
): GatewayRevokeRequest {
  const input = record(value, "gateway revoke");
  exact(input, ["version", "attemptId"], "gateway revoke");
  if (input.version !== 1) {
    throw new Error("gateway revoke version must be 1");
  }
  return { version: 1, attemptId: attemptId(input.attemptId) };
}
