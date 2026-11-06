import { loadConfig } from "./config";
import { PiRpcProxy } from "./rpc-proxy";
import { checkoutOf, RunDir } from "./run-dir";
import { imageProblem } from "./image";
import { type Sandbox, startSandbox } from "./sandbox";

// dc-pi: the Pi binary of a T3 provider instance. T3 runs it in place of `pi`
// and speaks Pi's RPC over stdin/stdout. Every call runs Pi in a sandbox; host
// Pi never runs. A session (`--mode rpc` without `--no-session`) gets a clone
// of the checkout holding the working directory; every other call (version,
// model discovery, title generation) gets an empty one.
//
// T3 injects its approval and MCP extension as `--extension <host file>`. The
// sandbox has no T3 access, so that pair is dropped: the container is the
// boundary, and nothing inside it asks for approval.

export async function main(argv: string[]): Promise<number> {
  const piArgs = withoutT3Extension(argv);
  const rpc = piArgs.some((arg, i) => arg === "--mode" && piArgs[i + 1] === "rpc");
  const session = rpc && !piArgs.includes("--no-session");

  const config = loadConfig();
  // T3 cannot wait minutes for a build.
  const problem = imageProblem(config);
  if (problem) throw new Error(problem);

  const run = new RunDir(config);
  let active: Sandbox | undefined;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      active?.stop();
      run.remove();
      process.exit(143);
    });
  }
  try {
    if (session) {
      const checkout = checkoutOf(process.cwd());
      if (!checkout) throw new Error(`${process.cwd()} is not in a git checkout; a sandboxed session needs one to clone.`);
      run.clone(checkout, process.cwd());
    }
    const start = (profile: string, args: string[]) =>
      (active = startSandbox(config, { profile, run, piArgs: args, stdio: rpc ? ["pipe", "pipe", "inherit"] : "inherit" }));
    if (!rpc) return await start(config.defaultProfile, piArgs).exited;
    const proxy = new PiRpcProxy(start, piArgs, config.defaultProfile, new Set(Object.keys(config.profiles)), process.stdout);
    return await proxy.run(process.stdin);
  } finally {
    run.remove();
  }
}

function withoutT3Extension(argv: string[]): string[] {
  const extension = process.env.T3_PI_MCP_EXTENSION_PATH;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (extension && argv[i] === "--extension" && argv[i + 1] === extension) i++;
    else out.push(argv[i]!);
  }
  return out;
}
