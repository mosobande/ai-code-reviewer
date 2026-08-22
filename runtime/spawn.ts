import { spawn } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 5_000;

export type SpawnTextOptions = {
  signal?: AbortSignal;
  killGraceMs?: number;
};

/**
 * Non-secret process vars safe to forward to subprocesses: enough to be found on
 * PATH, locate config under HOME, write temp files, render UTF-8 output, and reach
 * the network through a proxy / custom CA. Deliberately excludes everything else so
 * service secrets are default-denied rather than inherited wholesale.
 */
export const BASE_ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "USER", "SHELL",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
] as const;

/**
 * Env allowlist for the `git` clone subprocess. It needs no secret from the
 * environment; the installation token is injected separately via GIT_CONFIG_*.
 */
export const GIT_ENV_ALLOWLIST = BASE_ENV_ALLOWLIST;

/**
 * Build a minimal subprocess environment: copy only the allowlisted names that are
 * actually set in `source`, then layer `extra` on top.
 */
export function buildSubprocessEnv(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  extra: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Spawn a CLI, feed `stdin` on standard input, and resolve with stdout.
 * Generic process infrastructure; provider-specific code decides the command,
 * args, env allowlist, and how to parse stdout.
 */
export function spawnText(
  command: string,
  args: string[],
  env: Record<string, string>,
  stdin: string,
  options: SpawnTextOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    return Promise.reject(abortError(options.signal, command));
  }

  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      detached,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let terminalError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let terminating = false;
    let settled = false;

    const signalTree = (signal: NodeJS.Signals): void => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH" && !terminalError) {
          terminalError = err instanceof Error ? err : new Error(String(err));
        }
      }
    };
    const terminateTree = (): void => {
      signalTree("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => signalTree("SIGKILL"), killGraceMs);
      }
    };
    const failAndTerminate = (err: Error): void => {
      terminalError ??= err;
      if (!terminating) {
        terminating = true;
        terminateTree();
      }
    };
    const onAbort = (): void => failAndTerminate(abortError(options.signal!, command));

    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdout.push(chunk);
    });
    child.stderr.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderr.push(chunk);
    });
    child.on("error", (err) => {
      terminalError ??= err;
      if (!child.pid && !settled) {
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        reject(terminalError);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (terminalError) reject(terminalError);
      else if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1000);
        reject(new Error(`${command} exited with code ${code}: ${detail}`));
      }
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the check/listen race for an abort that lands just before listener
    // registration. Later aborts are handled by the listener above.
    if (options.signal?.aborted) onAbort();
    child.stdin.on("error", (err) => failAndTerminate(err));
    child.stdin.end(stdin);
  });
}

function abortError(signal: AbortSignal, command: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason == null ? `${command} was cancelled` : String(signal.reason));
}
