import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLines } from "../src/jsonl";
import { ROOT, type TestEnv, testEnv } from "./helpers";

let t: TestEnv;
beforeAll(() => (t = testEnv()), 600_000);
afterAll(() => t.cleanup());

/** dc-pi driven the way T3 drives it: RPC over stdin/stdout, from a checkout. */
function startRpc() {
  const proc = spawn(join(ROOT, "dc-pi"), ["--mode", "rpc"], { cwd: t.checkout, env: t.env, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<string, (record: any) => void>();
  readLines(proc.stdout, (line) => {
    const record = JSON.parse(line.toString());
    if (record.type === "response") replies.get(record.id)?.(record);
  });
  let seq = 0;
  const request = (command: object) =>
    new Promise<any>((resolve) => {
      const id = `t${++seq}`;
      replies.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  return { proc, request };
}

/** Profiles of the sandbox containers this dc-pi process is running. */
function runningProfiles(pid: number): string[] {
  const out = spawnSync("docker", ["ps", "--filter", `name=^dc-${pid}-`, "--format", '{{.Label "dc.profile"}}'], { encoding: "utf8" });
  return out.stdout.trim().split("\n").filter(Boolean);
}

test("selecting another profile's model moves the session into that profile's sandbox", async () => {
  const { proc, request } = startRpc();
  try {
    await request({ type: "new_session" });
    const before = (await request({ type: "get_state" })).data;
    expect(runningProfiles(proc.pid!)).toEqual(["test-offline"]);

    await request({ type: "set_thinking_level", level: "high" });
    expect((await request({ type: "get_state" })).data.thinkingLevel).toBe("high");
    const selected = await request({ type: "set_model", provider: "test-github.fake", modelId: "model-a" });
    expect(selected.success).toBe(true);
    expect(runningProfiles(proc.pid!)).toEqual(["test-github"]);

    const after = (await request({ type: "get_state" })).data;
    expect(after.sessionFile).toBe(before.sessionFile);
    expect(after.thinkingLevel).toBe("high");
    expect(after.model).toMatchObject({ provider: "test-github.fake", id: "model-a" });

    // A model in the same profile keeps the sandbox.
    await request({ type: "set_model", provider: "test-github.fake", modelId: "model-a" });
    expect(runningProfiles(proc.pid!)).toEqual(["test-github"]);
  } finally {
    proc.kill("SIGTERM");
    await new Promise((resolve) => proc.on("exit", resolve));
  }
  expect(runningProfiles(proc.pid!)).toEqual([]);
}, 90_000);

test("every profile's models are offered to the client", async () => {
  const { proc, request } = startRpc();
  try {
    const { models } = (await request({ type: "get_available_models" })).data;
    expect(models.map((m: any) => `${m.provider}/${m.id}`).sort()).toEqual(["test-github.fake/model-a", "test-offline.fake/model-a"]);
    expect(models.map((m: any) => m.name).sort()).toEqual(["GitHub · Model A", "Offline · Model A"]);
  } finally {
    proc.kill("SIGTERM");
    await new Promise((resolve) => proc.on("exit", resolve));
  }
}, 60_000);

test("a session runs on a clone of the checkout, removed when dc-pi is stopped", async () => {
  const { proc, request } = startRpc();
  await request({ type: "get_state" });
  const [name] = spawnSync("docker", ["ps", "--filter", `name=^dc-${proc.pid}-`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.split("\n");
  const mounts: { Source: string; Destination: string }[] = JSON.parse(
    spawnSync("docker", ["inspect", "-f", "{{json .Mounts}}", name!], { encoding: "utf8" }).stdout,
  );
  const clone = mounts.find((m) => m.Destination === t.checkout)!.Source;
  expect(clone).not.toBe(t.checkout);
  expect(existsSync(join(clone, "README.md"))).toBe(true);
  proc.kill("SIGTERM");
  await new Promise((resolve) => proc.on("exit", resolve));
  expect(existsSync(clone)).toBe(false);
}, 60_000);

test("a sandbox will not start on an image built from a different image config", () => {
  const changed = join(t.dir, "changed.json");
  writeFileSync(changed, JSON.stringify({ ...t.config, image: { ...t.config.image, packages: ["jq"] } }));
  const result = spawnSync(join(ROOT, "dc-pi"), ["--version"], { env: { ...t.env, DC_CONFIG: changed }, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("out of date");
});
