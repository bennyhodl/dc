import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Config } from "./config";

// The image is generated from the config's image section. dc adds only what it
// depends on: Pi, the node user, Pi's agent dir and the entrypoint. The image
// is labeled with a hash of the Dockerfile, so a config change is noticed.

export function dockerfile(config: Config): string {
  const { base, packages, run, env, pi } = config.image;
  const lines = [`FROM ${base}`];
  if (packages.length > 0) {
    lines.push(`RUN apt-get update && apt-get install -y ${packages.join(" ")} && rm -rf /var/lib/apt/lists/*`);
  }
  for (const step of run) lines.push(`RUN ${step}`);
  for (const [name, value] of Object.entries(env)) lines.push(`ENV ${name}=${JSON.stringify(value)}`);
  lines.push(
    `RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${pi}`,
    "USER node",
    // Exists before models.json is mounted into it, so Pi can still write there.
    "RUN mkdir -p /home/node/.pi/agent",
    "WORKDIR /tmp",
    `ENTRYPOINT ["pi"]`,
  );
  return `${lines.join("\n")}\n`;
}

function imageHash(config: Config): string {
  return createHash("sha256").update(dockerfile(config)).digest("hex").slice(0, 16);
}

export type ImageState = "ready" | "missing" | "stale";

export function imageState(config: Config): ImageState {
  const result = spawnSync("docker", ["image", "inspect", "-f", `{{index .Config.Labels "dc.image"}}`, config.image.name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return "missing";
  return result.stdout.trim() === imageHash(config) ? "ready" : "stale";
}

/** Why a sandbox cannot start on the current image, if it cannot. */
export function imageProblem(config: Config): string | undefined {
  const state = imageState(config);
  if (state === "missing") return `The image ${config.image.name} is missing. Build it with: dc build`;
  if (state === "stale") return `The image ${config.image.name} is out of date with ${config.path}. Rebuild it with: dc build`;
  return undefined;
}

export function buildImage(config: Config): boolean {
  process.stderr.write(`Building ${config.image.name}...\n`);
  const result = spawnSync("docker", ["build", "-t", config.image.name, "--label", `dc.image=${imageHash(config)}`, "-"], {
    input: dockerfile(config),
    stdio: ["pipe", "inherit", "inherit"],
  });
  return result.status === 0;
}
