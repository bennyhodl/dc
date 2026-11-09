# dc

Run the Pi coding agent with full access inside a Docker container that
cannot touch the host. Pi works on a throwaway clone of a checkout. A profile
decides exactly what the container can reach and which credentials it gets;
by default that is only its model endpoint.

`dc-pi` puts this behind T3 Code as one provider. Every profile's models show
up in T3's model picker, so choosing a model also chooses the sandbox.

## Install

Setting up with T3 Code: [INSTALL.md](INSTALL.md).

```sh
bun install
bun link                                         # puts dc and dc-pi in ~/.bun/bin
cp config.example.json ~/.config/dc/config.json  # then edit it
dc build                                         # once, and after changing "image"
```

Requires Docker and Bun. Without a terminal, dc never builds the image: a
missing image, or one built from a different `image` section, is an error.

## Config

`~/.config/dc/config.json` (or `$XDG_CONFIG_HOME/dc/config.json`, or
`$DC_CONFIG`). Types and comments: `src/config.ts`. Everything a sandbox has
comes from here; adding a profile, a host or a tool needs no code.

```jsonc
{
  "version": 1,
  "image": {
    "name": "dc-sandbox",
    "base": "node:22-bookworm",                    // Debian-based, with node and a node user
    "pi": "1.4.0",
    "packages": ["git", "curl", "ripgrep"],         // apt
    "run": ["npm install -g pnpm"],                // build steps, as root
    "env": { "PATH": "/usr/local/go/bin:$PATH" }
  },
  "hosts": {
    "github": ["github.com", "api.github.com", "codeload.github.com"]
  },
  "defaultProfile": "offline",
  "endpoints": {
    "maple": {
      "baseUrl": "https://ai.example.ts.net/v1",      // https on 443
      "api": "openai-completions",                   // Pi's API kind (default)
      "apiKey": { "file": "~/.config/ai-proxy/key" }, // or {env}, {command}, a literal
      "models": [{ "id": "maple/kimi-k3", "name": "Kimi K3", "reasoning": true }]
    }
  },
  "profiles": {
    "offline": { "label": "Offline" },
    "github": {
      "label": "GitHub",
      "allow": ["@github"],
      "env": { "GH_TOKEN": { "command": "gh auth token" } },
      "git": {
        "credential.https://github.com.helper": "!gh auth git-credential",
        "url.https://github.com/.insteadOf": ["git@github.com:", "ssh://git@github.com/"]
      }
    }
  }
}
```

- **image**: dc generates the Dockerfile from it and adds Pi, the node user and
  the entrypoint (`dc build --print` shows it). The image is labeled with a
  hash of that Dockerfile, so after a change dc refuses to start until
  `dc build`. Nothing else in the config needs a rebuild.
- **hosts**: named host groups, used in `allow` as `@name`.

- **endpoints**: model APIs. `models` entries are Pi model definitions, passed
  to Pi as-is (context window, reasoning, thinking levels).
- **profiles**: one kind of sandbox each.
  - `models`: `"<endpoint>/<model id>"` entries; default all.
  - `allow`: hosts reachable on 443 besides the profile's endpoints, or
    `@group` from `hosts`.
  - `env`: variables set inside. Values are read on the host each time a
    sandbox starts.
  - `git`: git config set inside this profile only (through git's
    `GIT_CONFIG_*` variables); a list sets a multi-valued key.
- Secrets are references (`{file}`, `{env}`, `{command}`), so the config holds
  no keys.

`dc profiles` prints each profile's models, hosts and env.

## Usage

```
dc run [--profile p] [--clone <dir> [--workdir <dir>]] [-- pi args]
dc shell [--profile p] [--clone <dir> [--workdir <dir>]]
dc profiles
dc build [--print]
```

```sh
dc run --clone ~/projects/my-app
dc shell --profile github --clone ~/projects/my-app
dc run --clone ~/projects/my-app -- -p --no-session --model offline.maple/maple/kimi-k3 "Summarize the README."
```

## What the container gets

| Host | Container | Mode |
| --- | --- | --- |
| `git clone` of the checkout's HEAD | the checkout's own path | rw, deleted afterwards |
| generated `models.json` (every profile's models) | `/home/node/.pi/agent/models.json` | ro |
| `$PI_CODING_AGENT_SESSION_DIR` (default `~/.local/state/dc/sessions`) | the same path | rw |
| each endpoint's key | env `DC_KEY_<ENDPOINT>` | |
| the profile's `env` and `git` | env | |

The clone has the checkout's history, its `origin` remote and `origin/*`
refs. Uncommitted changes and untracked files (`.env`) are not in it, and
nothing written in it reaches the host's checkout or git objects. No git
config, SSH keys or host environment go in.

## Network

Each profile gets an internal Docker network, `dc-net-<profile>`, which routes
nowhere, and a forwarder container, `dc-egress-<profile>`, on it and on the
default bridge. The sandbox resolves the profile's hosts to the forwarder
(`--add-host`) and nothing else. The forwarder reads the server name from each
TLS handshake and relays the connection only to an allowed host; TLS stays
end to end. The host, LAN, tailnet and every other internet host are
unreachable. `docker logs dc-egress-<profile>` lists refused names.

The example `github` profile allows `@github`, sets `GH_TOKEN`, and uses its
`git` settings to route git's GitHub auth through `gh` and rewrite SSH remotes
to HTTPS, so the sandbox can use `gh`, fetch and push. Whatever that token can
do, the sandbox can do.

## T3 Code: dc-pi

`dc-pi` stands in for the `pi` binary of one T3 Pi provider instance:

| Setting | Value |
| --- | --- |
| driver | `pi` |
| binaryPath | `~/.bun/bin/dc-pi` (absolute) |
| launchArgs | `--approve` (the clone's own `.pi` skills load) |
| env `PI_CODING_AGENT_SESSION_DIR` | an absolute path; T3 reads usage from it too |

Each profile's models appear as Pi providers named `<profile>.<endpoint>`
(`offline.maple/maple/kimi-k3`, labeled "Offline · Kimi K3"). A session starts
in the default profile's sandbox. When T3 selects a model from another
profile, dc-pi restarts Pi in that profile's sandbox on the same session and
clone, then passes the selection on. T3 selects models only between turns, so
switching profile mid-thread works and costs a container start (about 2s).

A session (`--mode rpc` without `--no-session`) gets a clone of the checkout
holding T3's working directory. Version, model discovery and title generation
run in an empty sandbox. dc-pi drops T3's injected approval/MCP extension (a
host file), so nothing asks for approval and the sandbox has no T3 access.

T3 probes the provider's models when its own settings change, not when the dc
config does. After editing profiles or models, refresh the provider in T3's
settings.

T3 reports the image's Pi version. Update it by changing `image.pi` and
running `dc build`, not with T3's Update button.

## Agent skill

`skills/sandbox-agent` teaches an agent in T3 to delegate to the Sandbox
provider. Link it into your agents with `benbot link skills/sandbox-agent`, or
copy it into a skills folder.

## Tests

`bun test` runs end-to-end tests against Docker with their own config, image
(`dc-test`, built on first run) and profiles: network isolation and git
settings per profile, the profile switch over RPC, clone cleanup, and refusing
an out-of-date image. They need internet access.
