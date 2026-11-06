import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResolvedProfile } from "./config";

// Each profile gets an internal Docker network, which routes nowhere, and one
// forwarder container on it and on the default bridge. The forwarder relays
// TLS on 443 to the profile's hosts only; the sandbox resolves those hosts to
// the forwarder through --add-host and cannot resolve anything else. The host,
// LAN, tailnet and every other internet host stay unreachable.

const FORWARDER = readFileSync(new URL("./forwarder.js", import.meta.url), "utf8");

export interface Egress {
  network: string;
  /** --add-host values: each allowed host mapped to the forwarder. */
  addHosts: string[];
}

export function egressNames(profile: string): { network: string; forwarder: string } {
  return { network: `dc-net-${profile}`, forwarder: `dc-egress-${profile}` };
}

/** Starts or reuses the profile's network and forwarder. */
export function ensureEgress(image: string, profile: ResolvedProfile): Egress {
  const { network, forwarder } = egressNames(profile.name);
  // The forwarder is recreated whenever its script or host list changes.
  const policy = createHash("sha256").update(`${FORWARDER}\0${profile.hosts.join(",")}`).digest("hex").slice(0, 16);

  if (!docker("network", "inspect", network).ok) {
    docker("network", "create", "--internal", "--label", "dc=egress", network);
  }
  const state = docker("inspect", "-f", `{{.State.Running}} {{index .Config.Labels "dc.egress"}}`, forwarder).out;
  if (state !== `true ${policy}`) {
    docker("rm", "-f", forwarder);
    // A concurrent dc may win the name; the address check below covers both.
    docker(
      "run", "-d", "--name", forwarder, "--restart", "unless-stopped",
      "--label", `dc.egress=${policy}`,
      "--user", "0", "--read-only", "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE",
      "--entrypoint", "node", image, "-e", FORWARDER, ...profile.hosts,
    );
  }
  docker("network", "connect", network, forwarder);
  const ip = docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, forwarder).out;
  if (!ip || ip === "<no value>") {
    throw new Error(`Could not start the sandbox forwarder ${forwarder}. See: docker logs ${forwarder}`);
  }
  return { network, addHosts: profile.hosts.map((host) => `${host}:${ip}`) };
}

function docker(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}
