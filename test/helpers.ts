import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { egressNames } from "../src/egress";
import { buildImage, imageState } from "../src/image";

// End-to-end tests run the real dc and dc-pi against Docker, with their own
// config, image and profile names so they never touch yours.

export const ROOT = join(import.meta.dir, "..");

export interface TestEnv {
  env: Record<string, string>;
  config: Record<string, any>;
  dir: string;
  /** A git checkout with one commit. */
  checkout: string;
  cleanup(): void;
}

/**
 * A config with two profiles, test-offline (endpoint only) and test-github
 * (+ @github, with git settings), on a minimal image built on first use.
 */
export function testEnv(): TestEnv {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dc-test-")));
  const config = {
    version: 1,
    image: { name: "dc-test", pi: "1.4.0" },
    hosts: { github: ["github.com", "api.github.com"] },
    defaultProfile: "test-offline",
    endpoints: {
      // The endpoint's host is what an offline profile may reach.
      fake: {
        baseUrl: "https://example.com/v1",
        apiKey: "not-a-key",
        models: [{ id: "model-a", name: "Model A", reasoning: true }],
      },
    },
    profiles: {
      "test-offline": { label: "Offline" },
      "test-github": {
        label: "GitHub",
        allow: ["@github"],
        git: { "url.https://github.com/.insteadOf": ["git@github.com:", "ssh://git@github.com/"] },
      },
    },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const loaded = loadConfig(join(dir, "config.json"));
  if (imageState(loaded) !== "ready" && !buildImage(loaded)) throw new Error("Could not build the test image");
  const checkout = join(dir, "repo");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "README.md"), "test\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) {
    spawnSync("git", ["-C", checkout, ...args], { stdio: "ignore" });
  }
  return {
    dir,
    config,
    checkout,
    env: { ...(process.env as Record<string, string>), DC_CONFIG: join(dir, "config.json"), PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions") },
    cleanup() {
      for (const profile of Object.keys(config.profiles)) {
        const { network, forwarder } = egressNames(profile);
        spawnSync("docker", ["rm", "-f", forwarder], { stdio: "ignore" });
        spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
