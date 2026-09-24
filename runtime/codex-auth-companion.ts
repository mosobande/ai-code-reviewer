import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CodexAuthSession } from "./model-provider-credentials.ts";

const VERSION_TIMEOUT_MS = 5_000;

const REQUEST_TIMEOUT_MS = 15_000;

const CLOSE_TIMEOUT_MS = 2_000;

const STDOUT_LINE_LIMIT_BYTES = 256 * 1_024;

const STDERR_LIMIT_BYTES = 64 * 1_024;

const FORBIDDEN_CHILD_ENV = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_AUTH_SOURCE",
] as const;

const FORBIDDEN_CHILD_ENV_SET = new Set<string>(FORBIDDEN_CHILD_ENV);

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

export type CodexAppServerAuthSessionOptions = {
  binaryPath: string;
  codexHome: string;
  expectedVersion: string;
  extraEnv?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
};

function childEnvironment(
  options: CodexAppServerAuthSessionOptions,
): NodeJS.ProcessEnv {
  if (!isAbsolute(options.codexHome)) {
    throw new Error("Codex auth home must be absolute");
  }
  const env = { ...(options.baseEnv ?? process.env) };
  for (const name of FORBIDDEN_CHILD_ENV) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(options.extraEnv ?? {})) {
    if (name === "CODEX_HOME" || FORBIDDEN_CHILD_ENV_SET.has(name)) {
      throw new Error(
        `Codex auth companion extra environment cannot set ${name}`,
      );
    }
    env[name] = value;
  }
  env.CODEX_HOME = options.codexHome;
  env.RUST_LOG = env.RUST_LOG?.trim() || "error";
  return env;
}

async function commandVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["--version"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let length = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Codex version check timed out"));
    }, VERSION_TIMEOUT_MS);
    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += chunk.length;
      if (length > 1_024) {
        child.kill("SIGKILL");
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Codex version check failed: ${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || length > 1_024) {
        reject(new Error("Codex version check failed"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

async function validateCredentialPath(codexHome: string): Promise<void> {
  const [home, authFile] = await Promise.all([
    lstat(codexHome),
    lstat(join(codexHome, "auth.json")),
  ]).catch(() => {
    throw new Error(
      "Codex auth companion requires a private home with auth.json",
    );
  });
  if (!home.isDirectory() || !authFile.isFile()) {
    throw new Error(
      "Codex auth companion requires a private home with auth.json",
    );
  }
  if ((home.mode & 0o077) !== 0 || (authFile.mode & 0o077) !== 0) {
    throw new Error(
      "Codex auth home and auth.json must not grant group or other permissions",
    );
  }
}

export class CodexAppServerAuthSession implements CodexAuthSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  #nextId = 0;
  #closed = false;
  #failed = false;
  #stdoutBuffer = Buffer.alloc(0);
  #stderrBytes = 0;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.on("data", (value: Buffer | string) =>
      this.#receiveChunk(value),
    );
    child.stderr.on("data", (value: Buffer | string) => {
      this.#stderrBytes = Math.min(
        STDERR_LIMIT_BYTES + 1,
        this.#stderrBytes + Buffer.byteLength(value),
      );
    });
    child.once("error", () =>
      this.#fail(new Error("Codex auth companion process failed")),
    );
    child.once("exit", () => {
      if (!this.#closed) {
        this.#fail(new Error("Codex auth companion exited"));
      }
    });
  }

  #receiveChunk(value: Buffer | string): void {
    if (this.#closed || this.#failed) {
      return;
    }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (this.#stdoutBuffer.length + chunk.length > STDOUT_LINE_LIMIT_BYTES) {
      this.#fail(
        new Error("Codex auth companion exceeded its response-line bound"),
      );
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    let newline = this.#stdoutBuffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.#stdoutBuffer
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line) {
        this.#receive(line);
      }
      if (this.#failed) {
        return;
      }
      newline = this.#stdoutBuffer.indexOf(0x0a);
    }
  }

  static async create(
    options: CodexAppServerAuthSessionOptions,
  ): Promise<CodexAppServerAuthSession> {
    const env = childEnvironment(options);
    const version = await commandVersion(options.binaryPath, env);
    if (version !== `codex-cli ${options.expectedVersion}`) {
      throw new Error(
        `expected Codex ${options.expectedVersion}, received ${version || "no version"}`,
      );
    }
    await validateCredentialPath(options.codexHome);
    const child = spawn(
      options.binaryPath,
      [
        "app-server",
        "--stdio",
        "--strict-config",
        "-c",
        'cli_auth_credentials_store="file"',
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const session = new CodexAppServerAuthSession(child);
    try {
      const initialized = (await session.#request("initialize", {
        clientInfo: {
          name: "acr_model_gateway",
          title: "ACR model gateway",
          version: "1",
        },
      })) as Record<string, unknown>;
      if (!initialized || typeof initialized !== "object") {
        throw new Error(
          "Codex auth companion returned an invalid initialize response",
        );
      }
      const actualHome =
        typeof initialized.codexHome === "string"
          ? await realpath(initialized.codexHome)
          : "";
      if (actualHome !== (await realpath(options.codexHome))) {
        throw new Error(
          "Codex auth companion opened the wrong credential home",
        );
      }
      session.#notify("initialized", {});
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  #receive(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.#fail(new Error("Codex auth companion returned malformed JSON"));
      return;
    }
    if (typeof response.id !== "number") {
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.error) {
      const code =
        typeof response.error.code === "number"
          ? ` (${response.error.code})`
          : "";
      pending.reject(
        new Error(`Codex auth companion rejected the request${code}`),
      );
      return;
    }
    pending.resolve(response.result);
  }

  #fail(error: Error): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    if (!this.#closed) {
      this.#child.kill("SIGTERM");
    }
  }

  #write(value: unknown): void {
    if (this.#closed || this.#failed || !this.#child.stdin.writable) {
      throw new Error("Codex auth companion is closed");
    }
    if (this.#stderrBytes > STDERR_LIMIT_BYTES) {
      throw new Error(
        "Codex auth companion exceeded its diagnostic output bound",
      );
    }
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Codex auth companion request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async readAccount(forceRefresh: boolean): Promise<{ type: string } | null> {
    const result = await this.#request("account/read", {
      refreshToken: forceRefresh,
    });
    const response =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : undefined;
    const account = response?.account;
    if (account === null || account === undefined) {
      return null;
    }
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw new Error(
        "Codex auth companion returned an invalid account response",
      );
    }
    const type = (account as Record<string, unknown>).type;
    if (typeof type !== "string" || !type) {
      throw new Error(
        "Codex auth companion returned an invalid account response",
      );
    }
    return { type };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex auth companion closed"));
    }
    this.#pending.clear();
    this.#child.stdin.end();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) =>
      this.#child.once("exit", () => resolve()),
    );
    const waitForExit = async (): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          exited.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
    if (!(await waitForExit())) {
      this.#child.kill("SIGTERM");
      if (!(await waitForExit())) {
        this.#child.kill("SIGKILL");
        await exited;
      }
    }
  }
}
