import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basicAuthHeader, cloneRef, removeWorkdir } from "../clone.ts";

test("basicAuthHeader base64-encodes <user>:<token> (GitHub x-access-token)", () => {
  const header = basicAuthHeader("x-access-token", "ghs_secret123");
  const expected = Buffer.from("x-access-token:ghs_secret123").toString("base64");
  assert.equal(header, `AUTHORIZATION: basic ${expected}`);
});

test("basicAuthHeader supports the GitLab oauth2 username", () => {
  const header = basicAuthHeader("oauth2", "glpat-secret123");
  const expected = Buffer.from("oauth2:glpat-secret123").toString("base64");
  assert.equal(header, `AUTHORIZATION: basic ${expected}`);
});

test("the raw token never appears in the header (only its base64 form)", () => {
  // Guards the security property: the token is encoded, so a value that leaks the
  // header (e.g. a log line) doesn't directly expose the token string.
  for (const header of [basicAuthHeader("x-access-token", "ghs_topsecret"), basicAuthHeader("oauth2", "glpat_topsecret")]) {
    assert.ok(!header.includes("topsecret"));
  }
});

test("cloneRef verifies the fetched head against the admitted SHA", async () => {
  const source = mkdtempSync(join(tmpdir(), "acr-clone-source-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(source, "file.txt"), "review this\n");
    git("add", "file.txt");
    git("commit", "-qm", "fixture");
    const head = git("rev-parse", "HEAD");
    const spec = {
      cloneUrl: source,
      fetchRef: "refs/heads/main",
      authHeader: basicAuthHeader("test", "token"),
    };
    const checkedOut = await cloneRef({ ...spec, expectedHeadSha: head });
    try {
      assert.equal(execFileSync("git", ["-C", checkedOut, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
    } finally {
      await removeWorkdir(checkedOut);
    }
    await assert.rejects(
      cloneRef({ ...spec, expectedHeadSha: "0".repeat(40) }),
      /differs from the admitted source SHA/,
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
