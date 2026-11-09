# Install with T3 Code

This sets up dc as a T3 Code provider. Its models appear in T3's model picker,
and each thread runs Pi with full access in a Docker sandbox on a throwaway
clone of your checkout. The README explains how the sandbox works.

## 1. Requirements

- Docker, running
- [Bun](https://bun.sh)
- git
- T3 Code, with the Pi provider driver
- An OpenAI-compatible model endpoint over https on 443 (OpenRouter works) and
  its API key

## 2. Install dc

```sh
git clone https://github.com/bennyhodl/dc.git
cd dc
bun install
bun link            # puts dc and dc-pi in ~/.bun/bin
```

Check with `~/.bun/bin/dc --help`.

## 3. Configure

```sh
mkdir -p ~/.config/dc
cp config.example.json ~/.config/dc/config.json
```

Edit `~/.config/dc/config.json`:

- **endpoints**: your model API. The example uses OpenRouter with Kimi K2. Add
  the models you want. Each entry is a Pi model definition (`id`, `name`,
  `contextWindow`, `maxTokens`, `reasoning`).
- **apiKey**: use `{ "file": "~/.config/dc/openrouter.key" }` (recommended) or
  `{ "command": "..." }`. `{ "env": "OPENROUTER_API_KEY" }` only works under T3
  when the variable is in T3's environment or in the provider instance's
  environment (step 6).
- **profiles**: `offline` reaches only the model endpoint. `github` also
  reaches GitHub with your `gh` token, so it can fetch and push. Remove
  profiles you don't want.

The config holds references to secrets, never the secrets themselves.
Every field is documented in the README and `src/config.ts`.

```sh
dc profiles
```

This lists each profile with its hosts and its model ids. A model id has the
form `<profile>.<endpoint>/<model id>`, for example
`offline.openrouter/moonshotai/kimi-k2`.

## 4. Build the image

```sh
dc build
```

Run it again whenever you change the config's `image` section. dc-pi never
builds under T3. When the image is missing or out of date, the provider fails
with an error telling you to run `dc build`.

## 5. Try it from the shell

```sh
dc run --clone ~/path/to/some/repo -- -p --no-session \
  --model offline.openrouter/moonshotai/kimi-k2 "Summarize the README."
```

If that prints a summary, the image, key and network are working.
`dc shell --clone ~/path/to/some/repo` opens bash in the same sandbox.

## 6. Add the provider to T3 Code

In T3's provider settings, add a provider instance:

| Setting | Value |
| --- | --- |
| Driver | `pi` |
| Display name | `Sandbox` (any) |
| Binary path | `/Users/<you>/.bun/bin/dc-pi` (absolute; run `which dc-pi`) |
| Launch args | `--approve` |
| Env `PI_CODING_AGENT_SESSION_DIR` | an absolute path, e.g. `/Users/<you>/.pi/sandbox/sessions` |

`--approve` lets the clone's own `.pi` skills load. T3 also reads usage from
the session directory, so the path must be absolute.

You can also add the instance to `~/.t3/userdata/settings.json` under
`providerInstances`. Edit the file while T3 is closed:

```json
"sandbox": {
  "driver": "pi",
  "displayName": "Sandbox",
  "enabled": true,
  "config": {
    "binaryPath": "/Users/<you>/.bun/bin/dc-pi",
    "launchArgs": "--approve"
  },
  "environment": [
    { "name": "PI_CODING_AGENT_SESSION_DIR", "value": "/Users/<you>/.pi/sandbox/sessions", "sensitive": false }
  ]
}
```

If the API key comes from `{ "env": ... }`, add the key to `environment` here
with `"sensitive": true`.

## 7. Use it

Open a thread in a project that is a git checkout, then pick a Sandbox model.
The model's label names its profile, for example "Offline · Kimi K2".

- The sandbox clones the checkout's HEAD. It does not see uncommitted changes
  or untracked files like `.env`, so commit first.
- Edits stay in the clone, and the clone is deleted when the session ends.
  To push, use a profile that allows it, such as `github`.
- Switching to a model from another profile between turns restarts Pi in
  that profile's sandbox on the same session. This takes about 2 seconds.
- T3 does not see dc config changes on its own. After editing profiles or
  models, refresh the provider in T3's settings.
- The version T3 reports is `image.pi`. To update Pi, change that value and
  run `dc build`. Don't use T3's Update button.

## 8. Optional: let agents delegate to it

`skills/sandbox-agent/SKILL.md` teaches a T3 agent to send work to the Sandbox
instance through `delegate_task`. It is written for the author's setup:
instance id `sandbox`, `maple` models, and the author's paths. Copy it into
your agents' skills folder (for Claude Code, `~/.claude/skills/sandbox-agent/`).
Then change the instance id, model ids, paths and the "What the child gets"
table to match your config.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "image ... out of date" or missing | `dc build` |
| "is not in a git checkout" | Open the T3 thread in a git repo |
| "PI_CODING_AGENT_SESSION_DIR must be an absolute path" | Use a full path in the instance env |
| A host is unreachable from inside | Add it to the profile's `allow`. `docker logs dc-egress-<profile>` lists refused names |
| No models in T3 | `dc profiles`, then refresh the provider in T3 |
| Key errors | Check the `apiKey` reference resolves for the process T3 launches (step 3) |
