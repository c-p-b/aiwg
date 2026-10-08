/**
 * `aiwg mcp inject` CLI rendering tests.
 *
 * Runs the real CLI against a temporary AIWG_CONFIG and HOME and compares the
 * rendered provider files byte for byte.
 *
 * @source @src/mcp/cli.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync,
  chmodSync, lstatSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const cliPath = resolve(__dirname, "../../../src/mcp/cli.mjs");

let root: string;
let configDir: string;
let homeDir: string;
let projectDir: string;

function writeRegistry(servers: Record<string, unknown>) {
  writeFileSync(join(configDir, "mcp-servers.json"), JSON.stringify({
    apiVersion: "aiwg.io/v1",
    kind: "McpServerRegistry",
    servers,
  }));
}

function runCli(args: string[]) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: homeDir, AIWG_CONFIG: configDir, TMPDIR: root },
  });
}

function runCliWithOutput(args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: homeDir, AIWG_CONFIG: configDir, TMPDIR: root },
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiwg-mcp-cli-"));
  configDir = join(root, "config");
  homeDir = join(root, "home");
  projectDir = join(root, "project");
  for (const dir of [configDir, homeDir, projectDir]) mkdirSync(dir, { recursive: true });
  writeRegistry({
    remote: { name: "remote", type: "http", url: "https://synthetic.example/mcp" },
    local: { name: "local", type: "stdio", command: "synthetic-command", args: ["--flag"] },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("aiwg mcp inject --provider claude", () => {
  it("writes .mcp.json with typed HTTP entries and leaves .claude/ alone", () => {
    runCli(["inject", "--provider", "claude"]);
    expect(existsSync(join(projectDir, ".claude"))).toBe(false);
    expect(JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf-8"))).toEqual({
      mcpServers: {
        remote: { type: "http", url: "https://synthetic.example/mcp" },
        local: { command: "synthetic-command", args: ["--flag"] },
      },
    });
  });

  it("warns about literal env and header values without printing them", () => {
    writeRegistry({
      local: { name: "local", type: "stdio", command: "synthetic-command", env: { API_TOKEN: "canary-value-123" } },
      remote: { name: "remote", type: "http", url: "https://synthetic.example/mcp", headers: { Authorization: "Bearer canary-hdr-456" } },
    });

    const result = runCliWithOutput(["inject", "--provider", "claude"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("local writes literal env/header values (API_TOKEN)");
    expect(result.stderr).toContain("remote writes literal env/header values (Authorization)");
    expect(result.stderr).toContain(".mcp.json");
    expect(`${result.stdout}${result.stderr}`).not.toContain("canary-value-123");
    expect(`${result.stdout}${result.stderr}`).not.toContain("canary-hdr-456");
  });

  it("does not warn for user-scope injection", () => {
    writeRegistry({
      local: { name: "local", type: "stdio", command: "synthetic-command", env: { API_TOKEN: "canary-value-123" } },
    });
    const result = runCliWithOutput(["inject", "--provider", "claude", "--scope", "user"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("WARNING:");
  });

  it("does not warn for servers without literal env or headers", () => {
    const result = runCliWithOutput(["inject", "--provider", "claude"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("WARNING:");
  });

  it("writes an ephemeral --mcp-config file in Claude Code's entry shape", () => {
    const out = join(root, "ephemeral.json");
    const stdout = runCli(["inject", "--provider", "claude", "--ephemeral", "--out", out]);
    expect(stdout).toContain(`claude --mcp-config ${out}`);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual({
      mcpServers: {
        remote: { type: "http", url: "https://synthetic.example/mcp" },
        local: { command: "synthetic-command", args: ["--flag"] },
      },
    });
  });

  it("writes an ephemeral opencode file in opencode's entry shape", () => {
    const out = join(root, "opencode.json");
    runCli(["inject", "--provider", "opencode", "--ephemeral", "--out", out]);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual({
      mcp: {
        remote: { type: "remote", url: "https://synthetic.example/mcp" },
        local: { type: "local", command: ["synthetic-command", "--flag"] },
      },
    });
  });

  it("writes default ephemeral files inside a private directory under TMPDIR", () => {
    const stdout = runCli(["inject", "--provider", "claude", "--ephemeral"]);
    const out = stdout.match(/^claude-code: (.+)$/m)![1];
    expect(dirname(dirname(out))).toBe(root);
    expect(basename(dirname(out))).toMatch(/^aiwg-mcp-/);
    expect(basename(out)).toBe("custom-claude-code.json");
    expect(JSON.parse(readFileSync(out, "utf-8")).mcpServers.remote.url).toBe("https://synthetic.example/mcp");
    if (process.platform !== "win32") {
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(out)).mode & 0o777).toBe(0o700);
    }
  });

  it.each([false, true])("writes owner-only --out files (pre-existing: %s)", preExisting => {
    const out = join(root, "ephemeral.json");
    if (preExisting) {
      writeFileSync(out, "old config");
      if (process.platform !== "win32") chmodSync(out, 0o644);
    }
    runCli(["inject", "--provider", "claude", "--ephemeral", "--out", out]);
    expect(JSON.parse(readFileSync(out, "utf-8")).mcpServers).toHaveProperty("remote");
    if (process.platform !== "win32") expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("refuses symlink --out paths without modifying the target", () => {
    const target = join(root, "target.json");
    const out = join(root, "ephemeral.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, out);
    const result = runCliWithOutput(["inject", "--provider", "claude", "--ephemeral", "--out", out]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to write ephemeral MCP config to symbolic link");
    expect(readFileSync(target, "utf-8")).toBe("untouched");
    expect(lstatSync(out).isSymbolicLink()).toBe(true);
  });

  it("writes nothing for ephemeral dry runs, with or without --out", () => {
    const before = readdirSync(root);
    runCli(["inject", "--provider", "claude", "--ephemeral", "--dry-run"]);
    const out = join(root, "new-dir", "ephemeral.json");
    runCli(["inject", "--provider", "claude", "--ephemeral", "--out", out, "--dry-run"]);
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(out)).toBe(false);
  });
});

describe("aiwg mcp credential display", () => {
  it.each(["list", "profile show"])("redacts URL userinfo and omits env/header values in %s", command => {
    writeRegistry({
      remote: { name: "remote", type: "http", url: "https://user:canary-pass-789@example.test/mcp",
        headers: { Authorization: "canary-header-456" } },
      local: { name: "local", type: "stdio", command: "synthetic-command", env: { TOKEN: "canary-env-123" } },
    });
    runCli(["profile", "add", "test-profile", "--servers", "remote,local"]);
    const stdout = runCli(command === "list" ? ["list"] : ["profile", "show", "test-profile"]);
    expect(stdout).toContain("https://***@example.test/mcp");
    for (const value of ["canary-pass-789", "user:", "canary-header-456", "canary-env-123"]) {
      expect(stdout).not.toContain(value);
    }
  });

  it("leaves URLs without userinfo and unparseable URLs unchanged", () => {
    writeRegistry({
      plain: { name: "plain", type: "http", url: "https://example.test:443/mcp" },
      invalid: { name: "invalid", type: "http", url: "not a URL" },
    });
    const stdout = runCli(["list"]);
    expect(stdout).toContain("URL: https://example.test:443/mcp");
    expect(stdout).toContain("URL: not a URL");
  });
});

describe("aiwg mcp install claude", () => {
  it("writes the AIWG server to .mcp.json", () => {
    runCli(["install", "claude", projectDir]);
    const written = JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf-8"));
    expect(written.mcpServers.aiwg).toMatchObject({ command: "aiwg", args: ["mcp", "serve"] });
    expect(existsSync(join(projectDir, ".claude", "settings.local.json"))).toBe(false);
  });
});
