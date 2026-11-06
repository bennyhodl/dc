import type { Config } from "./config";

// Each profile appears to Pi (and so to T3's model picker) as its own
// providers, named "<profile>.<endpoint>". The model a client selects names the
// sandbox it should run in, and Pi itself sees an ordinary models.json.

export function piProvider(profile: string, endpoint: string): string {
  return `${profile}.${endpoint}`;
}

/** The profile a Pi provider name belongs to, if it is one of ours. */
export function profileOf(provider: string): string | undefined {
  const dot = provider.indexOf(".");
  return dot > 0 ? provider.slice(0, dot) : undefined;
}

/** The variable that carries an endpoint's API key into the sandbox. */
export function keyEnv(endpoint: string): string {
  return `DC_KEY_${endpoint.toUpperCase().replaceAll("-", "_")}`;
}

/** Pi's models.json: every profile's models, keys read from the environment. */
export function piModels(config: Config): { providers: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  for (const profile of Object.values(config.profiles)) {
    for (const { endpoint, model } of profile.models) {
      const id = piProvider(profile.name, endpoint);
      const e = config.endpoints[endpoint]!;
      const provider = (providers[id] ??= {
        name: `${profile.label} (${e.name ?? endpoint})`,
        baseUrl: e.baseUrl,
        api: e.api ?? "openai-completions",
        apiKey: `$${keyEnv(endpoint)}`,
        models: [],
      }) as { models: unknown[] };
      provider.models.push({ ...model, name: `${profile.label} · ${model.name ?? model.id}` });
    }
  }
  return { providers };
}
