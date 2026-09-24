import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { CodexAppServerAuthSession } from "./codex-auth-companion.ts";
import {
  createModelGatewayControlServer,
  createModelGatewayProxyServer,
  ModelGateway,
} from "./model-gateway-server.ts";
import { loadProviderCredentialAdapters } from "./model-provider-credentials.ts";

const PINNED_CODEX_VERSION = "0.142.4";

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isSocket()) {
      throw new Error(`${path} exists and is not a Unix socket`);
    }
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function port(value: string | undefined): number {
  const parsed = Number(value?.trim() || "8080");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("MODEL_GATEWAY_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

function codexBinaryPath(env: NodeJS.ProcessEnv): string {
  return (
    env.MODEL_GATEWAY_CODEX_BINARY_PATH?.trim() ||
    fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url))
  );
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const socketPath =
    env.MODEL_GATEWAY_SOCKET_PATH?.trim() || join(homedir(), ".acr", "model-gateway.sock");
  if (!socketPath.startsWith("/")) {
    throw new Error("MODEL_GATEWAY_SOCKET_PATH must be absolute");
  }
  const listenHost = env.MODEL_GATEWAY_HOST?.trim() || "127.0.0.1";
  const listenPort = port(env.MODEL_GATEWAY_PORT);
  const publicBaseUrl =
    env.MODEL_GATEWAY_PUBLIC_BASE_URL?.trim() ||
    `http://127.0.0.1:${listenPort}`;
  const credentials = await loadProviderCredentialAdapters(env, {
    createCodexAuthSession: (codexHome) =>
      CodexAppServerAuthSession.create({
        binaryPath: codexBinaryPath(env),
        codexHome,
        expectedVersion: PINNED_CODEX_VERSION,
        baseEnv: env,
      }),
  });
  const gateway = new ModelGateway({ publicBaseUrl, credentials });
  if (gateway.providers().length === 0) {
    await gateway.close();
    throw new Error(
      "model gateway requires at least one configured provider credential",
    );
  }

  const control = createModelGatewayControlServer(gateway);
  const proxy = createModelGatewayProxyServer(gateway);
  let closed = false;

  const closeServer = (server: Server): Promise<void> => {
    if (!server.listening) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await Promise.allSettled([closeServer(control), closeServer(proxy)]);
    await gateway.close().catch(() => undefined);
    await rm(socketPath, { force: true }).catch(() => undefined);
  };

  try {
    const socketDirectory = dirname(socketPath);
    await mkdir(socketDirectory, { recursive: true, mode: 0o750 });
    const directory = await lstat(socketDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (directory.mode & 0o007) !== 0
      || (directory.mode & 0o020) !== 0
      || (process.getuid && directory.uid !== process.getuid())) {
      throw new Error("model gateway socket directory must be private, non-writable by its group, and owned by this user");
    }
    await removeStaleSocket(socketPath);
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(socketPath, resolve);
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(listenPort, listenHost, resolve);
    });
    await chmod(socketPath, 0o660);
  } catch (error) {
    await close();
    throw error;
  }

  const stop = (): void => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error("model gateway failed to start:", error);
    process.exit(1);
  });
}
