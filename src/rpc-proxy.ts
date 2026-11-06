import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { readLines } from "./jsonl";
import { profileOf } from "./pi-models";
import type { Sandbox } from "./sandbox";

/** Starts Pi in a profile's sandbox with these arguments. */
export type StartPi = (profile: string, piArgs: string[]) => Sandbox;

const OWN_ID = "dc-proxy:";
const NL = Buffer.from("\n");

/**
 * Stands between an RPC client (T3) and Pi. Every record passes through
 * unchanged. When the client selects a model from another profile, the proxy
 * restarts Pi in that profile's sandbox on the same session first, then passes
 * the selection on. T3 selects models only between turns, so no turn is cut.
 */
export class PiRpcProxy {
  private sandbox: Sandbox;
  private readonly retired = new WeakSet<Sandbox>();
  private readonly waiting = new Map<string, (record: any) => void>();
  private seq = 0;
  private queue = Promise.resolve();
  private finish: (code: number) => void = () => {};

  constructor(
    private readonly startPi: StartPi,
    private piArgs: string[],
    profile: string,
    private readonly profiles: ReadonlySet<string>,
    private readonly output: Writable,
  ) {
    this.sandbox = this.attach(startPi(profile, piArgs));
  }

  get current(): Sandbox {
    return this.sandbox;
  }

  /** Relays input to Pi until Pi exits; resolves with its exit code. */
  run(input: Readable): Promise<number> {
    const done = new Promise<number>((resolve) => (this.finish = resolve));
    readLines(input, (line) => this.enqueue(() => this.fromClient(line))).then(() =>
      this.enqueue(async () => void this.sandbox.proc.stdin?.end()),
    );
    return done;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error) => {
      process.stderr.write(`dc-pi: ${(error as Error).message}\n`);
      this.retired.add(this.sandbox);
      this.sandbox.stop();
      this.finish(1);
    });
  }

  private attach(sandbox: Sandbox): Sandbox {
    const stdout = sandbox.proc.stdout!;
    readLines(stdout, (line) => {
      if (this.waiting.size > 0 && line.includes(OWN_ID)) {
        const record = parse(line);
        const reply = record?.type === "response" && this.waiting.get(record.id);
        if (reply) return reply(record);
      }
      if (!this.output.write(Buffer.concat([line, NL]))) {
        stdout.pause();
        this.output.once("drain", () => stdout.resume());
      }
    });
    sandbox.exited.then((code) => {
      if (!this.retired.has(sandbox)) this.finish(code);
    });
    return sandbox;
  }

  private async fromClient(line: Buffer): Promise<void> {
    if (line.includes('"set_model"')) {
      const record = parse(line);
      const target = record?.type === "set_model" && typeof record.provider === "string" ? profileOf(record.provider) : undefined;
      if (target && target !== this.sandbox.profile && this.profiles.has(target)) await this.switchTo(target);
    }
    await this.write(line);
  }

  private async switchTo(profile: string): Promise<void> {
    const state = await this.request({ type: "get_state" });
    const old = this.sandbox;
    this.retired.add(old);
    await old.stop();
    // Pi writes a session file lazily, but --session on a path it has not
    // written yet keeps that path, so the client's session id stays valid.
    this.piArgs = resumeArgs(this.piArgs, state?.sessionFile);
    this.sandbox = this.attach(this.startPi(profile, this.piArgs));
    if (typeof state?.thinkingLevel === "string") {
      await this.request({ type: "set_thinking_level", level: state.thinkingLevel });
    }
    if (typeof state?.sessionName === "string") {
      await this.request({ type: "set_session_name", name: state.sessionName });
    }
  }

  private async request(command: { type: string; [field: string]: unknown }): Promise<any> {
    const id = `${OWN_ID}${++this.seq}`;
    const reply = new Promise<any>((resolve, reject) => {
      this.waiting.set(id, resolve);
      setTimeout(() => reject(new Error(`Pi did not answer ${command.type}`)), 30_000).unref();
    });
    try {
      await this.write(Buffer.from(JSON.stringify({ ...command, id })));
      const record = await reply;
      if (record.success === false) throw new Error(`Pi rejected ${command.type}: ${record.error ?? "no reason"}`);
      return record.data;
    } finally {
      this.waiting.delete(id);
    }
  }

  private async write(line: Buffer): Promise<void> {
    const stdin = this.sandbox.proc.stdin!;
    if (!stdin.write(Buffer.concat([line, NL]))) await once(stdin, "drain");
  }
}

/** Pi's arguments for reopening a session, or for a fresh in-memory one. */
export function resumeArgs(args: string[], sessionFile: unknown): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--session" || arg === "--session-id" || arg === "--fork") i++;
    else if (arg !== "--no-session" && arg !== "--continue" && arg !== "--resume") out.push(arg);
  }
  return typeof sessionFile === "string" ? [...out, "--session", sessionFile] : [...out, "--no-session"];
}

function parse(line: Buffer): any {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
}
