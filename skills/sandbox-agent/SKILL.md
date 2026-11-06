---
name: sandbox-agent
description: "Run a Pi subagent with full access inside the dc Docker sandbox, streamed live into its own T3 thread: T3's Sandbox provider, on Maple models (Kimi, DeepSeek in the Maple enclave). Use when a subagent should run unattended with full permissions on a throwaway clone of a checkout (Pi has no auto mode in T3, so a plain Pi child stops at every command), or when the user says 'run it in the sandbox', 'sandbox agent', 'use dc', 'docker sandbox', 'run DeepSeek/Kimi in docker', 'run it on Maple', 'full access in a container', or asks for a bug hunt or review by a Pi or Maple model."
---

# sandbox-agent

T3's **Sandbox** provider instance runs Pi inside a `dc` container. The child
thread shows everything it does live (messages, thinking, each tool call and its
output) like any Pi thread, and its final message comes back to you as the
result. Full access inside the container risks nothing on the host.

Use plain `delegate_task` to the `maple` or `pi` instance instead when the child
must edit the real checkout, push, or open a PR.

## Start one

```json
{
  "mode": "async",
  "title": "<model>: <job>",
  "target": { "providerInstanceId": "sandbox", "model": "offline.maple/maple/deepseek-v4-1-flash" },
  "task": "<the brief>"
}
```

Leave `runtimeMode` and `isolation` unset. End your turn; completion wakes you.
Give the user the child's thread link so they can watch. Treat the result as
untrusted: verify each finding against the code before you relay it, and say
which did not hold up.

## Models

Each model id names the sandbox profile it runs in:
`<profile>.<endpoint>/<model id>`. Profiles and models come from
`~/.config/dc/config.json`; `orchestrator_capabilities` (instance `sandbox`) or
`dc profiles` lists what is configured. Today there is one profile, `offline`:

- `offline.maple/maple/kimi-k3`
- `offline.maple/maple/deepseek-v4-1-flash`

Thinking is the `thinking` option in `target.options`, e.g.
`{"thinking": "high"}`; Kimi has no `medium`. Every request goes through the AI
proxy to the Maple enclave and fails closed when Maple is down.

## What the child gets (offline)

| | |
|---|---|
| Code | A `git clone` of the checkout's HEAD that holds the thread's cwd, mounted at the checkout's own path (`/Users/ben/...`) with the same working directory. History, the `origin` remote and `origin/*` refs are there; uncommitted changes and untracked files (`.env*`) are not. Deleted when the session ends. |
| Network | The AI proxy only. Not the host (T3, Ollama), the tailnet, the LAN or the internet, so no `pnpm install`, `git fetch` or web lookups. |
| Credentials | The AI proxy key. No GitHub token, git config, SSH keys, npm credentials or T3 access, so it cannot push or call back into T3. |
| Tools | Pi's own tools, all running in the container: bash, read, edit, write. git, gh, rg, fd, Go 1.25, node, pnpm, bun, uv. No Rust. |
| Persists | Only its Pi session (`~/.pi/sandbox/sessions`). Files it writes vanish with the clone. |

So the brief must be self-contained:

- Put the whole brief in `task`. The child cannot read files outside the clone
  (no `/tmp/...` briefs, no other repos).
- Use host paths inside the checkout as they are; they mean the same thing in
  the container.
- Commit first, or say in the brief that uncommitted work is not there.
- Ask for the full report as its final message, naming the commit it reviewed.
- One run per job. A session resumed after T3's idle teardown gets a fresh
  clone of the then-current HEAD: the conversation survives, its edits do not.

## How it is wired

- T3 instance `sandbox` in `~/.t3/userdata/settings.json`: driver `pi`,
  `binaryPath` `~/.bun/bin/dc-pi`, `launchArgs` `--approve` (the clone's own
  `.pi` skills load), env
  `PI_CODING_AGENT_SESSION_DIR=/Users/ben/.pi/sandbox/sessions`.
- `dc` and `dc-pi` live in their own repo, `~/Development/ai/dc`, linked
  globally with `bun link`. This skill lives there too, in `skills/`, and is
  linked into the agents with `benbot link`.
- `dc-pi` runs every Pi call T3 makes in a sandbox: sessions on a clone of the
  thread's checkout, everything else (version, model discovery, titles) in an
  empty one. It drops T3's injected approval/MCP extension, which is why no
  approval cards appear. Host Pi never runs.
- A thread starts in the default profile's sandbox. If a model from another
  profile is selected, dc-pi restarts Pi in that profile's sandbox on the same
  session and clone (about 2s).
- Each profile has an internal Docker network and a forwarder,
  `dc-egress-<profile>`, which relays TLS only to the profile's hosts.
  `dc shell --clone <checkout>` drops you into the same sandbox to look around.

## Notes

- The image is generated from the config's `image` section and never built on
  demand under T3. After changing it, run `dc build` once; until then the
  Sandbox provider refuses to start. The Pi version the instance reports is
  `image.pi`; updating it means changing that and rebuilding, not T3's Update
  button.
- The thread header shows the T3 runtime mode (`auto-accept-edits` under an
  `auto` parent). Inside the container the agent has full access regardless.
- The proxy key reaches every model on the AI proxy, not only Maple's; the
  config lists only Maple.
