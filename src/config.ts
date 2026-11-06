import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A value read on the host each time a sandbox starts. */
export type Secret = string | { env: string } | { file: string } | { command: string };

/** A Pi model definition, passed to Pi as-is (Pi's models-configuration docs). */
export interface PiModel {
  id: string;
  name?: string;
  [field: string]: unknown;
}

/** The sandbox image. dc adds Pi, the node user and the entrypoint. */
export interface ImageConfig {
  /** Docker image name (default dc-sandbox). */
  name?: string;
  /** A Debian-based Node image with a `node` user (default node:22-bookworm). */
  base?: string;
  /** The Pi version to install. */
  pi: string;
  /** apt packages. */
  packages?: string[];
  /** Shell commands run as root while building, in order. */
  run?: string[];
  /** Environment variables baked into the image; values may use $VAR. */
  env?: Record<string, string>;
}

/** A model API the sandbox may call, such as an OpenAI-compatible endpoint. */
export interface Endpoint {
  name?: string;
  /** https URL. The sandbox reaches its host on port 443 only. */
  baseUrl: string;
  /** Pi's API kind for this endpoint (default openai-completions). */
  api?: string;
  apiKey: Secret;
  models: PiModel[];
}

/** One kind of sandbox. In T3, each profile's models appear in the model picker. */
export interface Profile {
  /** Shown in front of each model name in T3's picker. */
  label?: string;
  /** "<endpoint>/<model id>" entries. Default: every model of every endpoint. */
  models?: string[];
  /** Hosts the sandbox may reach on 443 besides its endpoints, or "@group" from hosts. */
  allow?: string[];
  /** Environment variables set inside the sandbox. */
  env?: Record<string, Secret>;
  /** git config set inside the sandbox; a list sets a multi-valued key. */
  git?: Record<string, string | string[]>;
}

/** The config file's shape. */
export interface ConfigFile {
  version: 1;
  image: ImageConfig;
  /** Named host groups, used in a profile's allow list as "@name". */
  hosts?: Record<string, string[]>;
  defaultProfile: string;
  endpoints: Record<string, Endpoint>;
  profiles: Record<string, Profile>;
}

export interface SandboxModel {
  endpoint: string;
  model: PiModel;
}

export interface ResolvedProfile {
  name: string;
  label: string;
  models: SandboxModel[];
  /** Every host the sandbox may reach: its endpoints and its allow list. */
  hosts: string[];
  env: Record<string, Secret>;
  git: [key: string, value: string][];
}

export interface Config {
  path: string;
  image: Required<ImageConfig>;
  defaultProfile: string;
  endpoints: Record<string, Endpoint>;
  profiles: Record<string, ResolvedProfile>;
}

export class ConfigError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function configPath(): string {
  if (process.env.DC_CONFIG) return process.env.DC_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "dc", "config.json");
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError(`No config at ${path}. Copy config.example.json there and edit it.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  return parseConfig(raw, path);
}

export function parseConfig(raw: unknown, path: string): Config {
  const fail = (message: string): never => {
    throw new ConfigError(`${path}: ${message}`);
  };
  const strings = (value: unknown, at: string): string[] =>
    Array.isArray(value) && value.every((v) => typeof v === "string") ? value : fail(`${at} must be a list of strings`);

  if (!isObject(raw)) fail("must be a JSON object");
  const file = raw as unknown as ConfigFile;
  if (file.version !== 1) fail(`"version" must be 1`);

  const image = file.image;
  if (!isObject(image)) fail(`"image" must be an object`);
  if (typeof image.pi !== "string" || image.pi === "") fail(`image.pi must name a Pi version`);
  for (const key of ["name", "base"] as const) {
    if (image[key] !== undefined && typeof image[key] !== "string") fail(`image.${key} must be a string`);
  }
  const imageEnv = image.env ?? {};
  if (!isObject(imageEnv) || !Object.entries(imageEnv).every(([k, v]) => ENV_NAME.test(k) && typeof v === "string")) {
    fail(`image.env must map variable names to strings`);
  }

  const groups = file.hosts ?? {};
  if (!isObject(groups)) fail(`"hosts" must map group names to host lists`);
  for (const [name, hosts] of Object.entries(groups)) {
    if (!NAME.test(name)) fail(`hosts.${name}: names use a-z, 0-9 and -`);
    for (const host of strings(hosts, `hosts.${name}`)) if (!HOST.test(host)) fail(`hosts.${name}: ${host} is not a host name`);
  }

  if (!isObject(file.endpoints) || Object.keys(file.endpoints).length === 0) {
    fail(`"endpoints" must name at least one endpoint`);
  }
  for (const [name, endpoint] of Object.entries(file.endpoints)) {
    const at = `endpoints.${name}`;
    if (!NAME.test(name)) fail(`${at}: names use a-z, 0-9 and -`);
    if (!isObject(endpoint)) fail(`${at} must be an object`);
    const url = parseUrl(endpoint.baseUrl);
    if (!url || url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
      fail(`${at}.baseUrl must be an https URL on port 443`);
    }
    if (endpoint.api !== undefined && typeof endpoint.api !== "string") fail(`${at}.api must be a string`);
    if (!isSecret(endpoint.apiKey)) fail(`${at}.apiKey must be a string or {env}, {file} or {command}`);
    if (!Array.isArray(endpoint.models) || endpoint.models.length === 0) fail(`${at}.models must list models`);
    for (const model of endpoint.models) {
      if (!isObject(model) || typeof model.id !== "string") fail(`${at}.models entries need a string "id"`);
    }
  }

  if (!isObject(file.profiles) || Object.keys(file.profiles).length === 0) {
    fail(`"profiles" must name at least one profile`);
  }
  const profiles: Record<string, ResolvedProfile> = {};
  for (const [name, profile] of Object.entries(file.profiles)) {
    const at = `profiles.${name}`;
    if (!NAME.test(name)) fail(`${at}: names use a-z, 0-9 and -`);
    if (!isObject(profile)) fail(`${at} must be an object`);
    if (profile.label !== undefined && typeof profile.label !== "string") fail(`${at}.label must be a string`);

    let models: SandboxModel[];
    if (profile.models === undefined) {
      models = Object.entries(file.endpoints).flatMap(([endpoint, e]) => e.models.map((model) => ({ endpoint, model })));
    } else {
      models = strings(profile.models, `${at}.models`).map((ref) => {
        const slash = ref.indexOf("/");
        const endpoint = slash > 0 ? ref.slice(0, slash) : "";
        const model = file.endpoints[endpoint]?.models.find((m) => m.id === ref.slice(slash + 1));
        return model ? { endpoint, model } : fail(`${at}.models: no model ${JSON.stringify(ref)} ("<endpoint>/<model id>")`);
      });
      if (models.length === 0) fail(`${at}.models must list models`);
    }

    const allowed = strings(profile.allow ?? [], `${at}.allow`).flatMap((entry) => {
      if (entry.startsWith("@")) return groups[entry.slice(1)] ?? fail(`${at}.allow: no host group ${entry} in "hosts"`);
      return HOST.test(entry) ? [entry] : fail(`${at}.allow: ${entry} is not a host name or @group`);
    });
    const endpointHosts = models.map(({ endpoint }) => new URL(file.endpoints[endpoint]!.baseUrl).hostname);

    const env = profile.env ?? {};
    if (!isObject(env)) fail(`${at}.env must be an object`);
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_NAME.test(key)) fail(`${at}.env: ${key} is not a variable name`);
      if (!isSecret(value)) fail(`${at}.env.${key} must be a string or {env}, {file} or {command}`);
    }

    const gitConfig = profile.git ?? {};
    if (!isObject(gitConfig)) fail(`${at}.git must map git config keys to values`);
    const git = Object.entries(gitConfig).flatMap(([key, value]) =>
      (typeof value === "string" ? [value] : strings(value, `${at}.git.${key}`)).map((v) => [key, v] as [string, string]),
    );

    profiles[name] = {
      name,
      label: profile.label ?? name,
      models,
      hosts: [...new Set([...endpointHosts, ...allowed])].sort(),
      env,
      git,
    };
  }

  if (typeof file.defaultProfile !== "string" || !profiles[file.defaultProfile]) {
    fail(`"defaultProfile" must name a profile`);
  }
  return {
    path,
    image: {
      name: image.name ?? "dc-sandbox",
      base: image.base ?? "node:22-bookworm",
      pi: image.pi,
      packages: strings(image.packages ?? [], "image.packages"),
      run: strings(image.run ?? [], "image.run"),
      env: imageEnv,
    },
    defaultProfile: file.defaultProfile,
    endpoints: file.endpoints,
    profiles,
  };
}

/** Reads a secret's value on the host. */
export function readSecret(secret: Secret, label: string): string {
  if (typeof secret === "string") return secret;
  let value: string | undefined;
  let source: string;
  if ("env" in secret) {
    source = `env ${secret.env}`;
    value = process.env[secret.env];
  } else if ("file" in secret) {
    const file = expandHome(secret.file);
    source = `file ${file}`;
    value = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } else {
    source = `command \`${secret.command}\``;
    const result = spawnSync("/bin/sh", ["-c", secret.command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    value = result.status === 0 ? result.stdout : undefined;
  }
  value = value?.trim();
  if (!value) throw new ConfigError(`${label}: ${source} gave no value`);
  return value;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecret(value: unknown): value is Secret {
  if (typeof value === "string") return true;
  if (!isObject(value) || Object.keys(value).length !== 1) return false;
  const [key, inner] = Object.entries(value)[0]!;
  return ["env", "file", "command"].includes(key) && typeof inner === "string" && inner !== "";
}

function parseUrl(value: unknown): URL | undefined {
  try {
    return typeof value === "string" ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}
