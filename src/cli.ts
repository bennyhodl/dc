import { type Config, configPath, loadConfig } from "./config";
import { piProvider } from "./pi-models";
import { checkoutOf, RunDir } from "./run-dir";
import { buildImage, dockerfile, imageProblem } from "./image";
import { startSandbox } from "./sandbox";

const USAGE = `Usage: dc <command> [options]

Runs the Pi coding agent with full access inside a Docker container that
cannot touch the host. What the container can reach is set per profile in
${configPath()}.

Commands:
  run [options] [-- pi args]   Run Pi in a sandbox
  shell [options]              Open bash in a sandbox
  profiles                     List profiles with their models, hosts and env
  build [--print]              Build the sandbox image from the config (--print: show its Dockerfile)

Options for run and shell:
  --profile <name>   Sandbox profile (default: the config's defaultProfile)
  --clone <dir>      Clone this git checkout into the sandbox, at its own path
  --workdir <dir>    Working directory inside the clone (default: its root)

T3 Code runs sandboxes through dc-pi, the Pi binary of a provider instance.
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    case "build":
      if (rest[0] === "--print") {
        process.stdout.write(dockerfile(loadConfig()));
        return 0;
      }
      return buildImage(loadConfig()) ? 0 : 1;
    case "profiles":
      return listProfiles(loadConfig());
    case "run":
    case "shell":
      return runSandbox(command, rest);
    default:
      throw new Error(`Unknown command ${command}. See: dc help`);
  }
}

function listProfiles(config: Config): number {
  for (const profile of Object.values(config.profiles)) {
    const isDefault = profile.name === config.defaultProfile ? " (default)" : "";
    console.log(`${profile.name}${isDefault}: ${profile.label}`);
    console.log(`  hosts:  ${profile.hosts.join(", ")}`);
    console.log(`  env:    ${Object.keys(profile.env).join(", ") || "-"}`);
    console.log(`  git:    ${profile.git.map(([key, value]) => `${key}=${value}`).join(", ") || "-"}`);
    console.log("  models:");
    for (const { endpoint, model } of profile.models) console.log(`    ${piProvider(profile.name, endpoint)}/${model.id}`);
  }
  return 0;
}

async function runSandbox(command: "run" | "shell", argv: string[]): Promise<number> {
  const config = loadConfig();
  let profile = config.defaultProfile;
  let clone: string | undefined;
  let workdir: string | undefined;
  const piArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i] ?? (() => { throw new Error(`${arg} needs a value.`); })();
    if (arg === "--profile") profile = value();
    else if (arg === "--clone") clone = value();
    else if (arg === "--workdir") workdir = value();
    else if (arg === "--" && command === "run") {
      piArgs.push(...argv.slice(i + 1));
      break;
    } else throw new Error(`Unknown option ${arg}.${command === "run" ? " Put Pi's arguments after --." : ""}`);
  }
  if (workdir && !clone) throw new Error("--workdir needs --clone.");

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const problem = imageProblem(config);
  if (problem) {
    if (!tty) throw new Error(problem);
    if (!buildImage(config)) return 1;
  }

  const run = new RunDir(config);
  try {
    if (clone) {
      const checkout = checkoutOf(clone);
      if (!checkout) throw new Error(`${clone} is not in a git checkout.`);
      const workspace = run.clone(checkout, workdir ?? checkout);
      process.stderr.write(`dc: ${profile} sandbox on a clone of ${workspace.checkout}\n`);
    }
    const sandbox = startSandbox(config, {
      profile,
      run,
      piArgs,
      command: command === "shell" ? ["bash"] : undefined,
      tty,
      stdio: "inherit",
    });
    return await sandbox.exited;
  } finally {
    run.remove();
  }
}
