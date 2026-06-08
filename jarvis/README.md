# Alcover Jarvis

An on-demand development agent that ships across Alcover repos and **evolves its own
definition** over time.

## The two-layer brain

| Layer | File | How it changes | Review? |
|---|---|---|---|
| **Memory** — conventions, per-repo notes, lessons | `MEMORY.md` | Jarvis commits directly to `main` | none (low-risk) |
| **Identity** — system prompt, tools | `jarvis.agent.yaml` | Jarvis opens a PR; merge re-applies it via CI | you approve |
| **Skills** — reusable workflows | `skills/*.md` | Jarvis opens a PR | you approve |

"Updates itself" = it freely writes to its own memory every session, and proposes
edits to its own personality/skills as reviewable PRs. The
`.github/workflows/jarvis-redeploy.yml` workflow makes an approved self-edit go live.

## Cadence

On-demand: you (or a script) hand Jarvis a task and it runs a session to completion.

```sh
tsx jarvis/dispatch-jarvis.ts \
  https://github.com/javiergarcferrer/rosetsoft \
  "Polish the quote editor's loading and empty states"
```

## One-time control-plane setup (needs your Anthropic API key — cannot be done from the sandbox)

```sh
# 0. ant CLI + key
npm install -g @anthropic-ai/ant
export ANTHROPIC_API_KEY=sk-ant-...

# 1. Register the agent, capture its ID
export JARVIS_AGENT_ID=$(ant beta:agents create < jarvis/jarvis.agent.yaml --transform id -r)

# 2. Cloud environment with unrestricted networking (so the GitHub MCP is reachable)
export ENV_ID=$(ant beta:environments create \
  --name jarvis-env --networking unrestricted --transform id -r)

# 3. Vault holding the GitHub MCP OAuth credential (an OAuth bearer token, NOT a PAT)
export VAULT_ID=$(ant beta:vaults create --name github-mcp --transform id -r)
ant beta:vaults:credentials create --vault-id "$VAULT_ID" <<'JSON'
{
  "display_name": "GitHub MCP (Copilot)",
  "auth": {
    "type": "mcp_oauth",
    "mcp_server_url": "https://api.githubcopilot.com/mcp/",
    "access_token": "<github-oauth-access-token>",
    "refresh": {
      "refresh_token": "<github-oauth-refresh-token>",
      "client_id": "<your-oauth-client-id>",
      "token_endpoint": "https://github.com/login/oauth/access_token",
      "token_endpoint_auth": { "type": "none" }
    }
  }
}
JSON

# 4. Repo token for clone/push (fine-grained PAT, Contents: Read and write)
export GITHUB_REPO_TOKEN=github_pat_...

# 5. GitHub secrets on this repo so the redeploy workflow can re-apply Jarvis:
#    ANTHROPIC_API_KEY and JARVIS_AGENT_ID
```

Then dispatch (step under "Cadence").

## Splitting the brain into its own repo later

Today the brain lives here under `jarvis/` because the provisioning sandbox could only
reach the `rosetsoft` repo. To move it to a dedicated `alcover/jarvis` repo:
1. Move `jarvis/*` and `.github/workflows/jarvis-redeploy.yml` into the new repo (drop
   the `jarvis/` path prefix, or keep it — just stay consistent).
2. Set `JARVIS_BRAIN_REPO=https://github.com/alcover/jarvis` for the dispatcher.
3. Update the workflow's `paths:` filter to match the new location.

That's the whole migration — no code changes.
