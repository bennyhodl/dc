import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { piModels } from "./pi-models";

export interface Workspace {
  /** The host checkout, and the path the clone is mounted at. */
  checkout: string;
  /** The working directory, inside the checkout. */
  workdir: string;
  /** The clone on the host. */
  clone: string;
}

/**
 * Everything one dc process gives its sandboxes: Pi's models.json and, for a
 * session, a clone of a checkout. It outlives container restarts and is
 * removed when dc exits.
 */
export class RunDir {
  readonly path = mkdtempSync(join(tmpdir(), "dc-run-"));
  readonly modelsFile = join(this.path, "models.json");
  workspace?: Workspace;

  constructor(config: Config) {
    writeFileSync(this.modelsFile, JSON.stringify(piModels(config), null, 2));
  }

  /**
   * Clones the checkout's HEAD with its history and origin/* refs. Uncommitted
   * changes and untracked files stay out. No hardlinks, so nothing written in
   * the clone reaches the host's objects.
   */
  clone(checkoutDir: string, workdirDir = checkoutDir): Workspace {
    const checkout = realpathSync(checkoutDir);
    const workdir = realpathSync(workdirDir);
    if (workdir !== checkout && !workdir.startsWith(`${checkout}/`)) {
      throw new Error(`${workdir} is not inside ${checkout}.`);
    }
    const clone = join(this.path, "src");
    git("clone", "--quiet", "--no-hardlinks", "--origin", "local", checkout, clone);
    git("-C", clone, "remote", "remove", "local");
    // origin is the checkout's own remote, so origin/<branch> means the same
    // thing inside, and a profile that can reach it can fetch.
    const origin = gitOutput("-C", checkout, "remote", "get-url", "origin");
    if (origin) {
      git("-C", clone, "remote", "add", "origin", origin);
      git("-C", clone, "fetch", "--quiet", checkout, "+refs/remotes/origin/*:refs/remotes/origin/*");
      const branch = gitOutput("-C", clone, "symbolic-ref", "--short", "-q", "HEAD");
      if (branch) gitOutput("-C", clone, "branch", "--quiet", "--set-upstream-to", `origin/${branch}`);
    }
    this.workspace = { checkout, workdir, clone };
    return this.workspace;
  }

  remove(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

/** The git checkout that holds dir, if any. */
export function checkoutOf(dir: string): string | undefined {
  return gitOutput("-C", dir, "rev-parse", "--show-toplevel") || undefined;
}

function git(...args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
}

/** stdout of a git command that may fail; empty when it does. */
function gitOutput(...args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}
