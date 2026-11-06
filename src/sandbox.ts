import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { constants, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Config, ConfigError, readSecret } from "./config";
import { ensureEgress } from "./egress";
import { keyEnv } from "./pi-models";
import type { RunDir } from "./run-dir";

export interface SandboxOptions {
  profile: string;
  run: RunDir;
  /** Pi's arguments. */
  piArgs?: string[];
  /** Run this instead of Pi, such as ["bash"]. */
  command?: string[];
  /** Give the container a TTY. */
  tty?: boolean;
  stdio: StdioOptions;
}

export interface Sandbox {
  name: string;
  profile: string;
  proc: ChildProcess;
  /** Resolves with the container's exit code. */
  exited: Promise<number>;
  /** Removes the container now. */
  stop(): Promise<number>;
}

let started = 0;

/** Where Pi keeps sessions, at the same absolute path inside and outside. */
export function sessionDir(): string {
  const dir = process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".local", "state", "dc", "sessions");
  if (!isAbsolute(dir)) throw new ConfigError("PI_CODING_AGENT_SESSION_DIR must be an absolute path.");
  return dir;
}

/** Starts one container for a profile. Nothing it runs can reach the host beyond what is mounted. */
export function startSandbox(config: Config, opts: SandboxOptions): Sandbox {
  const profile = config.profiles[opts.profile];
  if (!profile) throw new ConfigError(`No profile "${opts.profile}" in ${config.path}.`);

  // Values go to docker through its environment (-e NAME), never its arguments.
  const env: Record<string, string> = {};
  const envArgs: string[] = [];
  for (const [endpoint, e] of Object.entries(config.endpoints)) {
    env[keyEnv(endpoint)] = readSecret(e.apiKey, `endpoints.${endpoint}.apiKey`);
    envArgs.push("-e", keyEnv(endpoint));
  }
  for (const [name, secret] of Object.entries(profile.env)) {
    env[name] = readSecret(secret, `profiles.${profile.name}.env.${name}`);
    envArgs.push("-e", name);
  }
  // git reads config from these, so a profile's git settings apply only inside it.
  if (profile.git.length > 0) {
    env.GIT_CONFIG_COUNT = String(profile.git.length);
    envArgs.push("-e", "GIT_CONFIG_COUNT");
    profile.git.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
      envArgs.push("-e", `GIT_CONFIG_KEY_${i}`, "-e", `GIT_CONFIG_VALUE_${i}`);
    });
  }

  const sessions = sessionDir();
  mkdirSync(sessions, { recursive: true });
  const egress = ensureEgress(config.image.name, profile);
  const name = `dc-${process.pid}-${++started}`;
  const workspace = opts.run.workspace;

  const args = [
    "run", "--rm", "--init", "--name", name, "--label", `dc.profile=${profile.name}`,
    opts.tty ? "-it" : "-i",
    "--network", egress.network,
    ...egress.addHosts.flatMap((host) => ["--add-host", host]),
    "-v", `${opts.run.modelsFile}:/home/node/.pi/agent/models.json:ro`,
    "-v", `${sessions}:${sessions}`, "-e", `PI_CODING_AGENT_SESSION_DIR=${sessions}`,
    ...envArgs,
    ...(workspace ? ["-v", `${workspace.clone}:${workspace.checkout}`, "-w", workspace.workdir] : ["-w", "/tmp"]),
  ];
  if (opts.command) args.push("--entrypoint", opts.command[0]!, config.image.name, ...opts.command.slice(1));
  else args.push(config.image.name, ...(opts.piArgs ?? []));

  const proc = spawn("docker", args, { stdio: opts.stdio, env: { ...process.env, ...env } });
  const exited = new Promise<number>((resolve) => {
    proc.on("error", () => resolve(127));
    proc.on("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  return {
    name,
    profile: profile.name,
    proc,
    exited,
    stop() {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      return exited;
    },
  };
}
