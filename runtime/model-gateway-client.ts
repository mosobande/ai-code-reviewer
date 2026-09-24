import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  GatewayGrantRequest,
  GatewayGrantResponse,
  ModelGatewayCapabilities,
} from "./model-gateway-protocol.ts";
import {
  parseModelGatewayCapabilities,
  parseGatewayGrantResponse,
} from "./model-gateway-protocol.ts";

type JsonResponse = { status: number; value: unknown };

export class ModelGatewayRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelGatewayRateLimitError";
  }
}

export class ModelGatewayClient {
  constructor(
    private readonly socketPath = join(homedir(), ".acr", "model-gateway.sock"),
  ) {}

  async #request(path: string, body?: unknown, signal?: AbortSignal): Promise<JsonResponse> {
    const encoded =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          method: body === undefined ? "GET" : "POST",
          path,
          signal,
          headers: encoded
            ? {
                "content-type": "application/json",
                "content-length": String(encoded.length),
              }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (value: Buffer | string) => {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            length += chunk.length;
            if (length > 128 * 1024) {
              request.destroy(
                new Error("model gateway response exceeded its bound"),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              resolve({
                status: response.statusCode ?? 0,
                value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once("error", reject);
      request.setTimeout(5_000, () => request.destroy(new Error("model gateway control request timed out")));
      request.end(encoded);
    });
  }

  async grant(request: GatewayGrantRequest, signal?: AbortSignal): Promise<GatewayGrantResponse> {
    const response = await this.#request("/v1/grants", request, signal);
    if (response.status !== 200) {
      const error = (response.value as { error?: unknown })?.error;
      if (response.status === 429) {
        throw new ModelGatewayRateLimitError(
          typeof error === "string" ? error : "model credential is rate limited",
        );
      }
      throw new Error(
        typeof error === "string"
          ? error
          : `model gateway returned ${response.status}`,
      );
    }
    return parseGatewayGrantResponse(response.value);
  }

  async revoke(attemptId: string): Promise<void> {
    const response = await this.#request("/v1/revocations", {
      version: 1,
      attemptId,
    });
    if (response.status !== 200) {
      throw new Error(`model gateway revocation returned ${response.status}`);
    }
  }

  async capabilities(): Promise<ModelGatewayCapabilities> {
    const response = await this.#request("/v1/capabilities");
    if (response.status !== 200) {
      throw new Error("model gateway returned invalid capabilities");
    }
    return parseModelGatewayCapabilities(response.value);
  }
}
