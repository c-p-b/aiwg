/**
 * An identity profile layered over an organisation base, rendered for Claude
 * Code with no credentials and with tool filters from both layers.
 *
 * @source @src/mcp/cli.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const cliPath = resolve(__dirname, "../../../src/mcp/cli.mjs");

let root: string;
let org: string;
let identity: string;

function write(dir: string, file: string, data: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2) + "\n");
}

function run(args: string[]) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, AIWG_CONFIG_LAYERS: [org, identity].join(delimiter) },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiwg-mcp-identity-"));
  org = join(root, "org");
  identity = join(root, "identity");
  write(org, "mcp-servers.json", {
    apiVersion: "aiwg.io/v1",
    kind: "McpServerRegistry",
    servers: {
      github: { name: "github", type: "http", url: "https://egress.local/github/mcp" },
      tracker: { name: "tracker", type: "http", url: "https://egress.local/tracker/mcp" },
    },
  });
  write(org, "mcp-profiles.json", {
    apiVersion: "aiwg.io/v1",
    kind: "McpProfileRegistry",
    profiles: { "org-base": { name: "org-base", servers: ["github"], providerOverrides: { "*": { toolDeny: ["github__delete_repo"] } } } },
  });
  write(identity, "mcp-profiles.json", {
    apiVersion: "aiwg.io/v1",
    kind: "McpProfileRegistry",
    profiles: {
      "acme-dev": { name: "acme-dev", extends: ["org-base"], servers: ["tracker"], providerOverrides: { "*": { toolDeny: ["tracker__*"] } } },
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("identity profile over an organisation base", () => {
  it("renders .mcp.json and a settings file with filters from both layers and no credentials", () => {
    const out = join(root, "session", ".mcp.json");
    const stdout = run(["inject", "--provider", "claude", "--profile", "acme-dev", "--ephemeral", "--out", out, "--no-credentials"]);
    const settings = join(root, "session", ".mcp.settings.json");
    expect(stdout).toContain(`claude --mcp-config ${out} --settings ${settings}`);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual({
      mcpServers: {
        github: { type: "http", url: "https://egress.local/github/mcp" },
        tracker: { type: "http", url: "https://egress.local/tracker/mcp" },
      },
    });
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({
      permissions: { deny: ["mcp__github__delete_repo", "mcp__tracker"], allow: [] },
    });
    expect(existsSync(join(root, "home"))).toBe(false);
  });

  it("refuses the whole render when a layer adds a credential", () => {
    write(identity, "mcp-servers.json", {
      apiVersion: "aiwg.io/v1",
      kind: "McpServerRegistry",
      servers: { tracker: { name: "tracker", type: "http", url: "https://tracker.example/mcp", headerEnv: { Authorization: "TRACKER_TOKEN" } } },
    });
    const out = join(root, "session", ".mcp.json");
    expect(() => run(["inject", "--provider", "claude", "--profile", "acme-dev", "--ephemeral", "--out", out, "--no-credentials"]))
      .toThrow(/tracker \(headerEnv\)/);
    expect(existsSync(out)).toBe(false);
  });
});
