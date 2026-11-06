import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, type TestEnv, testEnv } from "./helpers";

let t: TestEnv;
beforeAll(() => (t = testEnv()), 600_000);
afterAll(() => t.cleanup());

/** Runs a script in a profile's sandbox; returns each probe's curl result. */
function probe(profile: string): Record<string, string> {
  const script = `
    fwd=$(getent hosts example.com | cut -d' ' -f1)
    p() { name=$1; shift; echo "$name=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true)"; }
    p endpoint https://example.com
    p github https://api.github.com
    p forged-sni --resolve example.org:443:$fwd https://example.org
    p github-via-forwarder --resolve api.github.com:443:$fwd https://api.github.com
    p host http://host.docker.internal:3773
    p raw-ip -k https://1.1.1.1
  `;
  const result = spawnSync(join(ROOT, "dc"), ["shell", "--profile", profile], { input: script, env: t.env, encoding: "utf8" });
  expect(result.status).toBe(0);
  return Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=") as [string, string]));
}

test("an offline profile reaches its model endpoint and nothing else", () => {
  expect(probe("test-offline")).toEqual({
    endpoint: "200",
    github: "000",
    "forged-sni": "000",
    "github-via-forwarder": "000",
    host: "000",
    "raw-ip": "000",
  });
}, 60_000);

test("a profile's allow list opens exactly those hosts", () => {
  expect(probe("test-github")).toEqual({
    endpoint: "200",
    github: "200",
    "forged-sni": "000",
    "github-via-forwarder": "200",
    host: "000",
    "raw-ip": "000",
  });
}, 60_000);

test("a profile's git settings apply only inside it", () => {
  const read = (profile: string) =>
    spawnSync(join(ROOT, "dc"), ["shell", "--profile", profile], {
      input: "git config --get-all url.https://github.com/.insteadOf",
      env: t.env,
      encoding: "utf8",
    }).stdout.trim();
  expect(read("test-github").split("\n")).toEqual(["git@github.com:", "ssh://git@github.com/"]);
  expect(read("test-offline")).toBe("");
}, 60_000);
