/**
 * Dispatch Alcover Jarvis on a task.
 *
 * Usage:
 *   tsx jarvis/dispatch-jarvis.ts <target-repo-url> <task...>
 * Example:
 *   tsx jarvis/dispatch-jarvis.ts \
 *     https://github.com/javiergarcferrer/rosetsoft \
 *     "Polish the quote editor's loading and empty states"
 *
 * Requires env: JARVIS_AGENT_ID, ENV_ID, VAULT_ID (GitHub MCP creds),
 *               GITHUB_REPO_TOKEN (Contents: R+W on the repos), ANTHROPIC_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const AGENT_ID = process.env.JARVIS_AGENT_ID!;
const ENV_ID = process.env.ENV_ID!;
const VAULT_ID = process.env.VAULT_ID!; // GitHub MCP creds
const GH_TOKEN = process.env.GITHUB_REPO_TOKEN!; // Contents: R+W

// Jarvis's brain. Hosted inside rosetsoft for now; override once it has its own repo.
const BRAIN_REPO =
  process.env.JARVIS_BRAIN_REPO ?? "https://github.com/javiergarcferrer/rosetsoft";

// Pass the target repo + task on the CLI.
const [TARGET_REPO, ...taskParts] = process.argv.slice(2);
const TASK = taskParts.join(" ");

async function drain(stream: AsyncIterable<any>): Promise<void> {
  for await (const e of stream) {
    if (e.type === "agent.message") {
      for (const b of e.content) if (b.type === "text") process.stdout.write(b.text);
    } else if (e.type === "session.error") {
      console.error("\n[error]", e);
    } else if (e.type === "session.status_terminated") {
      return;
    } else if (e.type === "session.status_idle") {
      if (e.stop_reason?.type === "requires_action") continue; // waiting on us
      return; // terminal
    }
  }
}

async function main(): Promise<void> {
  if (!TARGET_REPO || !TASK) {
    throw new Error("usage: tsx jarvis/dispatch-jarvis.ts <target-repo-url> <task...>");
  }

  // Mount the brain first, then the target repo. Dedupe if the task targets the
  // brain repo itself (the common case while the brain lives in rosetsoft).
  const repoUrls = Array.from(new Set([BRAIN_REPO, TARGET_REPO]));
  const resources = repoUrls.map((url) => ({
    type: "github_repository" as const,
    url,
    authorization_token: GH_TOKEN,
  }));

  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENV_ID,
    title: `Jarvis: ${TASK.slice(0, 50)}`,
    vault_ids: [VAULT_ID],
    resources,
  });

  console.log(
    `Watch: https://platform.claude.com/workspaces/default/sessions/${session.id}\n`,
  );

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text:
              `Target repo: ${TARGET_REPO}\nTask:\n${TASK}\n\n` +
              `Load jarvis/MEMORY.md and the target repo's CLAUDE.md first. When done, ` +
              `run your hybrid self-update protocol: commit memory directly, propose ` +
              `identity changes as a PR.`,
          },
        ],
      },
    ],
  });

  await drain(stream);
  console.log("\n\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
