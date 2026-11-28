# Cowork

Cowork is a local prototype of a shared agent workspace. Encore.go owns accounts, sessions, workspace membership, conversation history, tasks, reminders, channel settings, and artifact access. Mastra runs all four chat agents and the Developer workflow. The browser frontend is a Next.js App Router app. The conversation uses Chat SDK’s Web adapter for message transport and assistant-ui for rendering. Encore owns the shared message history.

## Run locally

Install Node.js 22.18 or newer, Go 1.25 or newer, the Encore CLI, Git, and PostgreSQL. From the project root:

```sh
npm ci
npx playwright install chromium
```

Create an empty PostgreSQL database for Cowork. Use a database role that can create tables in its schema. For a local PostgreSQL instance with Docker, run:

```sh
docker run -d --name cowork-postgres -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=cowork -e POSTGRES_PASSWORD=cowork -e POSTGRES_DB=cowork \
  -v cowork-postgres:/var/lib/postgresql/data postgres:17-alpine
```

Start Encore from the backend directory with the connection URL:

```sh
cd backend
DATABASE_URL='postgres://cowork:cowork@127.0.0.1:5432/cowork?sslmode=disable' \
  encore run --listen 127.0.0.1:4000
```

In a second terminal, start the frontend and agent from the project root:

```sh
npm run dev:web
```

For a production-mode local preview, run `npm run build` followed by `npm start`.

Open http://localhost:4400. Workspace records live in PostgreSQL. Task artifacts and the local Agent Connection encryption key live under `backend/.cowork/`.

For local agent and workflow development, run `npm run dev` from the project root and open Mastra Studio at http://localhost:4111. The TypeScript entry point is `src/mastra/index.ts`. Studio can inspect agents, tools, and workflows. Workspace writes require an authenticated Cowork chat session.

## Clerk sign-in and workspace setup

Set `COWORK_AUTH=clerk`, `COWORK_PUBLIC_URL`, `COWORK_CLERK_ISSUER`, `CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY` in the runtime environment shared by Next.js and Encore. For local development, use `COWORK_PUBLIC_URL=http://localhost:4400` and open that exact origin. Set up email verification on the Clerk instance. Use the same instance as the standalone Agent Connections deployment to preserve its user IDs and access grants.

New users choose and name one or more agents, optionally connect tools, and choose where to work. Users with a Cowork invite code can join their teammate's workspace after signing in. Existing users link their Clerk sign-in to their Cowork account by confirming their previous password. Imported Clerk users whose server-managed `external_id` is their Cowork account ID can confirm the link after signing in. Both flows retain the existing workspace and account IDs. Guest invitation links continue to work independently. Leaving `COWORK_AUTH` unset retains the legacy sign-in path while preparing the migration.

## Move Agent Connections into Cowork

Set `AGENT_CONNECTIONS_ENABLED=1` on Encore and set `LOCAL_ENCRYPTION_KEY` to a stable 32-byte base64 key. Agent Connections uses the existing `DATABASE_URL` in its own `agent_connections` schema. Add provider credentials for the deployment. The service uses Cowork's Clerk issuer unless a matching `CLERK_ISSUER` is set explicitly.

For a fresh Cowork deployment on an existing PostgreSQL instance and persistent volume, set `COWORK_DATABASE_SCHEMA` to an unused schema and `COWORK_STATE_DIR` to a new absolute directory inside the existing volume. Set `COWORK_REQUIRE_LEGACY_STATE=0` to allow empty state. The prior schema and state directory remain available for recovery.

For installations that need to preserve standalone gateway records, initialize the destination first and copy connection, grant, credential, and activity tables once. Keep the source encryption key, owner IDs, row IDs, credential hashes, and activity sequence. An explicit `AGENT_CONNECTIONS_DATABASE_URL` still supports a separately managed gateway database with its existing migration ledger. Let the standalone process finish in-flight operations before switching clients.

Register these paths on the public Cowork origin and verify new authorizations before switching clients.

- Google redirect URI: `/integrations/agent-connections/google/callback`
- GitHub App callback URL: `/integrations/agent-connections/github/callback`
- GitHub App setup URL: `/integrations/agent-connections/github/setup`
- Clerk MCP resource and external client URL: `/mcp`

Set `MCP_RESOURCE_URL` to the full public MCP URL. Set the worker's `AGENT_CONNECTIONS_MCP_URL` to the new service, for example `http://127.0.0.1:4000/mcp` in the shared container. Existing bearer keys can be used at the new URL. Clerk OAuth clients sign in again for the new resource audience. The Agent Connections service exposes the original encrypted accounts to the Cowork owner with the same verified Clerk identity. A Cowork agent can use the accounts granted to it under **Settings → Agent Connections**. Stored agent keys in Cowork continue to use `AGENT_CONNECTION_ENCRYPTION_KEY`.

For private repository commit history, the GitHub App installation must include the repository and grant **Contents: Read-only** or higher. If you add the permission to an existing app, the installation owner must approve it in GitHub. Agents discover `github_list_commits` through their configured MCP gateway. Pass a branch as `ref` and set `limit` to 1 to get its latest commit, or omit `ref` for the repository's default branch.

## Upgrade an existing installation

Stop the old backend and back up its `.cowork` directory. Keep that directory mounted at the same path, set `DATABASE_URL` to a fresh Cowork database, set `COWORK_REQUIRE_LEGACY_STATE=1`, and start the updated backend. The first database connection creates the tables and imports `backend/.cowork/state.json` in a single transaction. The backend verifies the imported records before committing and logs aggregate counts after the commit. PostgreSQL records the completed import, so restarts keep using the current database records. Verify that an existing account can sign in and open its conversations before archiving the original file. The import leaves `state.json` on disk, so protect it as a backup. It may contain plaintext Agent Connection credentials.

Keep using the original `AGENT_CONNECTION_ENCRYPTION_KEY` or the original `.cowork/agent-connection.key` file so existing encrypted credentials remain readable. Back up PostgreSQL and the artifact volume after cutover.

## Try the Developer workflow

1. Create an account with the Developer role.
2. Assign a task with a title and brief, leave the repository blank, and enable the screenshot option.
3. Open the task’s plan, sandbox preview, and screenshot. The built-in runner renders a standalone title-and-description page and captures it with Chromium.
4. To try a shared conversation, copy the invite code from Workspace settings and use it during account creation in a second browser profile.

## Configure OpenRouter

Copy `.env.example` to `.env` in the project root and set `OPENROUTER_API_KEY` to your [OpenRouter key](https://openrouter.ai/settings/keys). Restart `npm start` to load it. The same server-side key serves all four roles. Set `OPENROUTER_MODEL` to an OpenRouter model ID such as `openai/gpt-4.1-mini` to override the chat model. `OPENROUTER_CLASSIFIER_MODEL` defaults to `typesafe/jev-1.14` and can be set to another OpenRouter decision model supported by the System One endpoint.

Cowork checks each incoming chat request and agent task assignment against the requested role. The check also applies to scheduled work and task reassignments. If a request belongs to a different role, Cowork names that role so the user can choose it. Agent chat and assignments require a working classifier. Tasks can still be assigned to team members when the classifier is unavailable.

Define the scope for new roles in `src/mastra/agents/roles.ts` when adding them to Cowork's agent catalog. Mastra uses those scopes for both agent instructions and classifier choices.

All Cowork roles use the default processors in `src/mastra/guardrails` and `src/mastra/processors`. Input checks for prompt injection, moderation, and language run concurrently. Non-English messages are translated for the agent, which replies in the original language by default. The agent follows the current tone request and uses saved personal preferences when the conversation has access to them. Moderation and system-prompt scrubbing run concurrently on buffered reply text before it is released. Safety checks use the existing `OPENROUTER_API_KEY` and default to `openai/gpt-4.1-mini`, which can be overridden with `OPENROUTER_GUARDRAIL_MODEL`.

## Add the agent to Slack

In Cowork, the workspace owner opens **Settings → Messaging channels → Slack** and selects **Add to Slack** on an agent. The first time, generate an app configuration token for your Slack workspace under **Your App Configuration Tokens** and enter its refresh token in Cowork. Cowork stores and rotates it on the server so the workspace can connect additional agents without entering another token. [Slack app settings](https://api.slack.com/apps) · [Slack configuration tokens](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/#managing-configuration-tokens)

Cowork creates one Slack app per agent using the saved Cowork name for both the app and the bot. Approve the installation in Slack. If Cowork shows a verification link, use it to verify the Events API request URL in the Slack app’s **App Manifest** settings. Then DM the bot, or invite it to a channel and mention it by name. Slack app names can be up to 35 characters, and Slack normalizes the bot’s mention username. [Slack manifest reference](https://docs.slack.dev/reference/app-manifest/)

Set `COWORK_PUBLIC_URL` to the public HTTPS origin, `MASTRA_ENCRYPTION_KEY` to a stable random secret of at least 32 characters on the worker and Encore, and `OPENROUTER_API_KEY` on the worker. Cowork stores provisioning credentials and installation tokens in the worker’s `slack-oauth.db`. Keep that state volume and encryption key across restarts. The app installs in the Slack workspace that issued the configuration token.

Disconnecting removes the Slack installation from the workspace. Reconnecting reuses the same app and applies the agent’s current Cowork name. For an agent already connected through a shared or fixed-name app, disconnect that installation before adding its dedicated app.

### Manage legacy Slack installations

Existing shared Cowork apps use `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` on the worker. Their OAuth and Events API URLs are in the [legacy app manifest](deploy/slack-app-manifest.json).

Each Slack workspace is associated with one Cowork workspace. When the workspace owner chooses Slack as an agent's preferred channel, its internal public Slack threads are mirrored into Cowork under a stable conversation ID. Participants reply in Slack. Direct messages and private Slack channels keep their history in Slack. Run one worker per deployment.

## Telegram group conversations

1. Open [BotFather](https://t.me/BotFather), send `/newbot`, and create a dedicated bot for the Cowork agent.
2. In **Settings → Messaging channels → Telegram**, choose the agent and paste the BotFather token. Cowork verifies the bot and registers its webhook.
3. Select **Choose Telegram group** and pick the group in Telegram. Cowork shows the linked group in Settings.
4. Send `/ask@your_bot_username` followed by a message, or reply to the bot. Cowork keeps each group's conversation and forum topics separate. Messages the bot receives in the linked group appear in Cowork Conversations.

Cowork registers the official [Mastra Telegram adapter](https://mastra.ai/integrations/channels/telegram#self-managed-setup) on its existing agents. New connections use the public HTTPS `MASTRA_SERVER_URL` or `COWORK_PUBLIC_URL` for the agent's Telegram webhook. Local development without public HTTPS uses polling. Run one worker per deployment when using polling.

Use the same `MASTRA_ENCRYPTION_KEY` on the worker and Encore, or set the same `COWORK_TELEGRAM_BRIDGE_SECRET` as an override. Cowork encrypts saved bot tokens with the workspace credential key. Telegram's default group privacy supports `/ask@username` and replies. To mirror all group messages or use plain mentions, disable group privacy in BotFather and re-add the bot to the group.

## Fixed-name Slack apps and Telegram bots

The legacy Slack apps are **Ada** for Developer work and **Sam** for Sales Lead work. In Telegram, tag each connected bot’s registered `@username` or reply to its message.

For legacy fixed-name Slack installations, the worker reads the app ID, OAuth client ID and secret, and signing secret from the matching `SLACK_ADA_` or `SLACK_SAM_` variables listed in `.env.example`.

The fixed-name apps use `/api/agents/developer/channels/slack/webhook` for Ada and `/api/agents/sales-lead/channels/slack/webhook` for Sam. Existing installations can continue using their `/integrations/slack/<name>/events` URLs.

Cowork uses the workspace's chosen agent name on replies when Slack grants `chat:write.customize`. Update the Slack app manifest and reauthorize existing installations to grant this scope. The installed app listing and @mention use Slack's configured bot identity.

Use one Telegram bot per Cowork agent. Several agents can connect to the same group. Existing polling installations appear in Telegram settings alongside the workspace agents.

## Workspace tools in Slack and Telegram

After a Cowork workspace owner connects Slack or Telegram, people in the linked channel can create, find, update, and schedule Cowork tasks. Developer tasks run through the linked workspace’s configured workflow and sandbox. Other agents produce written results from the saved brief.

Slack and Telegram inherit the agent’s existing Agent Connections grants from Cowork web chat. Tool results in replies are visible to people who can read the conversation. Slack tool access is limited to full members of the installed Slack workspace. Externally shared Slack Connect channels are excluded. Telegram access covers participants in the configured group. Set the same `MASTRA_ENCRYPTION_KEY` on the worker and Encore for channel tools. Telegram also supports a `COWORK_TELEGRAM_BRIDGE_SECRET` override.

Ask an agent in either channel to save a reminder with a due date and time. The reminder appears on the Cowork Reminders page. Slack supplies the requester’s time zone when available.

## Connect a work Gmail mailbox

In Agent Connections, connect the work mailbox and create a **Gmail read credential** for the agent. In Cowork, the workspace owner opens **Settings → Agent Connection**, enables the integration, pastes the named agent key, and saves. The workspace agent can search and read the mailbox from an internal Cowork conversation. Use **Remove key** to clear the saved credential and disable access. Revoke the credential in Agent Connections to invalidate it at the gateway.

The worker talks to the deployed Agent Connections MCP endpoint. Cowork encrypts workspace keys with AES-256-GCM before writing them to PostgreSQL. The backend encrypts any plaintext Agent Connection keys during the legacy import. Cowork shows a saved-key indicator in Settings. Agent Connection chat requires a conversation without an active guest invitation or guest session. Conversations where the integration has been made available cannot be shared with external guests later.

For production, set `AGENT_CONNECTION_ENCRYPTION_KEY` on the **Encore backend** to a stable 32-byte base64 secret, generated with `openssl rand -base64 32`, before the first save or migration. Keep it in the deployment secret store separately from state backups. Without that variable, Cowork creates `backend/.cowork/agent-connection.key` with owner-only permissions and reuses it across restarts. Preserve that file if using the local fallback. To move from the fallback file to a deployment secret, use the same key value. Backups made before migration can still contain plaintext credentials.

For a deployment-managed key, set `AGENT_CONNECTION_KEY` and `AGENT_CONNECTION_WORKSPACE_ID` in the agent worker environment and restart the worker. Use the workspace ID returned as `workspace.ID` by the authenticated `/api/workspace` endpoint. Enable Agent Connection in that workspace's settings. A key saved in the workspace takes precedence over the deployment key. Other workspaces configure their own keys through Settings.

## Git repository access

A workspace owner can save, replace, or remove GitHub.com and GitLab.com access tokens under **Settings → Git tokens**. Use read-only tokens scoped to the repositories workspace members may access. Cowork encrypts tokens in PostgreSQL using the same encryption key as Agent Connection.

In an internal conversation, ask the agent to pull a repository by its HTTPS URL, for example, “Pull https://github.com/my-org/my-repo and summarize the README.” The agent fetches the latest default branch and can read text files during that turn. Cowork deletes temporary checkouts when the turn ends. Conversations where the tools have been made available are protected from guest invitations.

## Workspace memory

Ask the agent “Remember that the launch codename is Sky Lantern.” Later in another signed-in conversation in the same workspace, ask “What is the launch codename?” You can also ask the agent to update or forget a saved detail. Forgetting a detail removes it from working memory. It can still appear in the chat transcript.

All four roles use Mastra working memory for durable project facts and decisions. Signed-in Cowork conversations share memory within the workspace. Slack threads, Telegram groups and forum topics, and Cowork conversations with guest access each have their own conversation memory. Channel turns carry the authenticated sender's identity and run separately, so a follow-up uses the new sender's tool context. Cowork reads the conversation transcript from Encore and Slack. An email invitation shares the existing transcript, including earlier agent replies. Scheduled tasks use their saved briefs.

Mention the Slack agent to start a conversation in a channel or group. Members can follow up inside the subscribed thread without repeating the mention.

Memory is stored in `backend/.cowork/memory.db` and survives worker restarts. Keep the existing persistent volume mounted to retain it across deployments.

## Create work from a conversation

Type `Create a task to draft the launch page` or `Remind me to review the launch tomorrow at 10 am`. When required details are missing, the agent asks in the conversation. The `createTask` and `createReminder` Mastra tools submit validated inputs to Encore under the caller’s current session. Dates and times are interpreted in the browser’s time zone. Developer tasks run the workflow, while assignments in other roles are recorded for tracking.

Agent-assigned tasks in Planned form the work queue. Cowork checks PostgreSQL every two seconds and checks again when a background task finishes. Each workspace agent works on one task at a time. Due schedules take priority, then the agent picks up the oldest queued assignment. Manually moving an agent’s work to In progress reserves that agent until the task leaves that column. Team member assignments stay under team control. Successful runs move to In review. Open a task to read its dated agent notes alongside the deliverable or any blocker. Each recurring run has its own notes.

Ask in a signed-in conversation to run work later, for example, “In 10 minutes, draft a three-sentence launch announcement using the details above.” For recurring work, try “Every Monday at 9 am, draft a planning agenda using this brief.” Daily and weekly schedules follow the local time zone of the conversation. The Tasks page shows the next run and a separate result for each execution. Open a recurring schedule there to pause, resume, edit, or cancel it. Resuming skips occurrences missed during the pause. Canceling stops future runs and keeps past results. After downtime, a recurring schedule runs once to catch up and then resumes its regular schedule. The dispatcher runs in the backend with the browser closed. Scheduled runs use the assigned role and saved brief for self-contained work such as drafts and summaries.

## Invite a guest to a conversation

Open a conversation, choose **Invite people**, and enter an email address under **By email**. Cowork sends a single-use invitation link through Amazon SES. Guests choose a display name and can read and reply only in the invited conversation. The invitation and guest session expire seven days after the link is created. Use **Workspace teammate** for in-app invitations to current members.

Set `COWORK_PUBLIC_URL` to the externally reachable frontend URL for email links. Cowork also accepts the previous `NEXT_PUBLIC_COWORK_URL` setting.

Set `AWS_SES_REGION` and `AWS_SES_FROM_EMAIL` on the frontend server. You can supply `AWS_SES_ACCESS_KEY` and `AWS_SES_SECRET_KEY` (and `AWS_SES_SESSION_TOKEN` for temporary credentials), or use the AWS SDK’s standard credential chain. The sender identity must be verified in that region. An SES sandbox can send to verified recipients and the SES mailbox simulator.

## Extend the prototype

The role selector supports four roles. Developer has an implemented chat agent and task workflow. Product Manager, Sales Lead, and Social Media use the same workspace and each has a role-specific chat agent. Chat history is shared by workspace and attributed to the person who sent each message. Reminders can be scheduled and marked complete in the workspace. Telegram group conversations appear in Conversations through Mastra Channels. Slack uses Mastra Channels for messaging and Cowork for workspace OAuth. WhatsApp settings persist destination IDs. Reminder delivery is pending.

Set `COWORK_RUNNER` to the path of a trusted ES module to enable repository-backed work. Its default export implements these methods:

| Method | Expected behavior |
| --- | --- |
| `create(task, directory)` | Create an isolated workspace and return its handle. The provided directory is the artifact directory. |
| `checkout(sandbox, repository)` | Check out the latest revision of an authorized repository. |
| `implement(sandbox, task, plan)` | Apply the work. Return `{ previewUrl, uiChanged, screenshot }` where the preview is an HTTPS URL and the screenshot is PNG bytes for UI changes. For self-contained static work, return `html` instead of `previewUrl`. |
| `openPullRequest(sandbox, task, implementation)` | Publish the reviewed change set as a pull request and return its HTTPS URL. |

The workflow calls the runner in that order, saves the plan before implementation, and validates the screenshot and preview before calling the pull request step. The built-in runner skips pull request creation for standalone preview tasks. Repository-backed tasks require a runner that supplies isolated execution, authorized repository access, and Git credentials. No repository service is configured by default.

Cowork stores workspace records in PostgreSQL and runs immediate Developer work during the task request. The backend is configured for a single instance with a persistent artifact volume.

The [Developer sandbox pilot](deploy/sandbox/README.md) documents the KubeVirt-backed runner for one workspace.

## Remote Docker sandbox for chat agents

Set these environment variables on the Mastra worker to enable the Docker workspace tools for signed-in web conversations and linked Slack and Telegram conversations.

```sh
MASTRA_DOCKER_HOST=mastra-sandbox.airplane-achernar.ts.net
MASTRA_DOCKER_CERT_DIR=/run/secrets/mastra-docker
```

Mount the client bundle (`ca.pem`, `cert.pem`, and `key.pem`) read-only at that path in the worker container. The worker runs as the `node` user in the production image and needs permission to read the files. Use the Docker hostname without a scheme or port. The worker connects over HTTPS on port 443 and verifies the daemon certificate using the supplied CA. The Docker and model credentials stay on the worker.

The first sandbox tool call starts a `node:22-slim` container. Follow-up turns in the same conversation can reuse files under `/workspace`. Each container has 1 GiB of memory, one CPU of quota, and a 256-process limit. One worker manages up to four containers and removes them after 30 minutes of inactivity. Keep `COWORK_STATE_DIR` on the persistent worker volume so idle cleanup can resume after a restart. Sandbox files are temporary.

Run the connection check from the worker host or container with the same mounted client bundle. It creates two containers, verifies Node.js execution and file isolation, and removes both containers. The check requires no model API key.

```sh
node --env-file-if-exists=.env deploy/sandbox/docker-smoke.ts
```

For an end-to-end check, ask a signed-in Cowork agent to write a file in `/workspace` and run it with Node.js. Ask it to read the file in a follow-up, then open a second conversation and verify that the file is absent there.

## Checks

```sh
npm run check
(cd backend && TEST_DATABASE_URL='postgres://cowork:cowork@127.0.0.1:5432/cowork?sslmode=disable' go test ./...)
```

PostgreSQL integration tests create and drop isolated schemas in the database specified by `TEST_DATABASE_URL`.

Framework references are available in the [Mastra quickstart](https://mastra.ai/docs), [Chat SDK Web adapter docs](https://chat-sdk.dev/adapters/official/web), and [Encore.go API docs](https://encore.dev/docs/go/primitives/defining-apis).

## Coolify deployment

Cowork runs as one container with Next.js on port 4400 and the Encore and Mastra services on loopback. `deploy/package.sh` builds the Encore Linux/amd64 release and prints a temporary release directory. Build locally with `docker build -f RELEASE/Dockerfile RELEASE`. For a Coolify build without a Git checkout, stage `RELEASE/cowork-release.tar.xz` on a private endpoint reachable from the build server. Replace the Dockerfile’s copy step with a checksum-verified archive download and extraction into `/app`. The package includes source and the compiled backend. It omits `.env` and local workspace data.

Before deploying this version, configure a PostgreSQL database reachable from the app container and set its connection URL as the runtime-only `DATABASE_URL`. For a PostgreSQL service on the same Coolify network, use its internal hostname. Mount persistent storage at `/app/backend/.cowork` for artifacts, conversation memory, the local encryption key, and the legacy import. Configure OpenRouter and SES as runtime-only variables, set `COWORK_PUBLIC_URL` to the public HTTPS URL, and use `/api/health` on port 4400 for health checks. When Cloudflare Tunnel provides HTTPS, set the Coolify application URL to `http://cowork.iamwille.xyz:4400` so the proxy targets Cowork’s internal port. Set `COWORK_PUBLIC_URL=https://cowork.iamwille.xyz` for guest links.

### Deploy from GitHub main

The [Cowork release workflow](.github/workflows/coolify.yml) builds the Encore backend and container, checks the landing and health endpoints, and publishes `ghcr.io/iamwille-dev/cowork:main` and a commit SHA tag.

Once Coolify can pull the image, switch the existing Cowork application to **Docker Image** and select `ghcr.io/iamwille-dev/cowork:main`. Keep the domain, internal port, runtime variables, and persistent storage configured on that application. For a private GHCR package, configure a read-only registry login on the Coolify server first.

In the GitHub repository’s Actions settings, set the `COOLIFY_API_URL` variable to the Coolify API base URL ending in `/api/v1`, set `COOLIFY_APP_UUID` to the existing Cowork application UUID, and add `COOLIFY_DEPLOY_TOKEN` as a secret with permission to deploy that application. The workflow queues a deployment after each successful image build on `main`.
