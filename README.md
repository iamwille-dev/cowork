# Cowork

Cowork is a local prototype of a shared agent workspace. Encore.go owns accounts, sessions, workspace membership, conversation history, tasks, reminders, channel settings, and artifact access. Mastra runs all four chat agents and the Developer workflow. The browser frontend is a Next.js App Router app. The conversation uses Chat SDK’s Web adapter for message transport and assistant-ui for rendering. Encore owns the shared message history.

## Run locally

Install Node.js 22.18 or newer, Go 1.25 or newer, the Encore CLI, and PostgreSQL. From the project root:

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

## Upgrade an existing installation

Stop the old backend and back up its `.cowork` directory. Keep that directory mounted at the same path, set `DATABASE_URL` to a fresh Cowork database, set `COWORK_REQUIRE_LEGACY_STATE=1`, and start the updated backend. The first database connection creates the tables and imports `backend/.cowork/state.json` in a single transaction. The backend verifies the imported records before committing and logs aggregate counts after the commit. PostgreSQL records the completed import, so restarts keep using the current database records. Verify that an existing account can sign in and open its conversations before archiving the original file. The import leaves `state.json` on disk, so protect it as a backup. It may contain plaintext Agent Connection credentials.

Keep using the original `AGENT_CONNECTION_ENCRYPTION_KEY` or the original `.cowork/agent-connection.key` file so existing encrypted credentials remain readable. Back up PostgreSQL and the artifact volume after cutover.

## Try the Developer workflow

1. Create an account with the Developer role.
2. Assign a task with a title and brief, leave the repository blank, and enable the screenshot option.
3. Open the task’s plan, sandbox preview, and screenshot. The built-in runner renders a standalone title-and-description page and captures it with Chromium.
4. To try a shared conversation, copy the invite code from Workspace settings and use it during account creation in a second browser profile.

## Configure OpenRouter

Copy `.env.example` to `.env` in the project root and set `OPENROUTER_API_KEY` to your [OpenRouter key](https://openrouter.ai/settings/keys). Restart `npm start` to load it. The same server-side key serves all four roles. Set `OPENROUTER_MODEL` to an OpenRouter model ID such as `openai/gpt-4.1-mini` to override the default. Chat and its tools require a key. The manual task form can still use the built-in Developer planning and preview runner.

## Connect a work Gmail mailbox

In Agent Connections, connect the work mailbox and create a **Gmail read credential** for the agent. In Cowork, the workspace owner opens **Settings → Agent Connection**, enables the integration, pastes the named agent key, and saves. The workspace agent can search and read the mailbox from an internal Cowork conversation. Use **Remove key** to clear the saved credential and disable access. Revoke the credential in Agent Connections to invalidate it at the gateway.

The worker talks to the deployed Agent Connections MCP endpoint. Cowork encrypts workspace keys with AES-256-GCM before writing them to PostgreSQL. The backend encrypts any plaintext Agent Connection keys during the legacy import. Cowork shows a saved-key indicator in Settings. Agent Connection chat requires a conversation without an active guest invitation or guest session. Conversations where the integration has been made available cannot be shared with external guests later.

For production, set `AGENT_CONNECTION_ENCRYPTION_KEY` on the **Encore backend** to a stable 32-byte base64 secret, generated with `openssl rand -base64 32`, before the first save or migration. Keep it in the deployment secret store separately from state backups. Without that variable, Cowork creates `backend/.cowork/agent-connection.key` with owner-only permissions and reuses it across restarts. Preserve that file if using the local fallback. To move from the fallback file to a deployment secret, use the same key value. Backups made before migration can still contain plaintext credentials.

For a deployment-managed key, set `AGENT_CONNECTION_KEY` and `AGENT_CONNECTION_WORKSPACE_ID` in the agent worker environment and restart the worker. Use the workspace ID returned as `workspace.ID` by the authenticated `/api/workspace` endpoint. Enable Agent Connection in that workspace's settings. A key saved in the workspace takes precedence over the deployment key. Other workspaces configure their own keys through Settings.

## Create work from a conversation

Type `Create a task to draft the launch page` or `Remind me to review the launch tomorrow at 10 am`. When required details are missing, the agent asks in the conversation. The `createTask` and `createReminder` Mastra tools submit validated inputs to Encore under the caller’s current session. Dates and times are interpreted in the browser’s time zone. Developer tasks run the workflow, while assignments in other roles are recorded for tracking.

## Invite a guest to a conversation

Open a conversation, choose **Invite people**, and enter an email address under **By email**. Cowork sends a single-use invitation link through Amazon SES. Guests choose a display name and can read and reply only in the invited conversation. The invitation and guest session expire seven days after the link is created. Use **Workspace teammate** for in-app invitations to current members.

Set `COWORK_PUBLIC_URL` to the externally reachable frontend URL for email links. Cowork also accepts the previous `NEXT_PUBLIC_COWORK_URL` setting.

Set `AWS_SES_REGION` and `AWS_SES_FROM_EMAIL` on the frontend server. You can supply `AWS_SES_ACCESS_KEY` and `AWS_SES_SECRET_KEY` (and `AWS_SES_SESSION_TOKEN` for temporary credentials), or use the AWS SDK’s standard credential chain. The sender identity must be verified in that region. An SES sandbox can send to verified recipients and the SES mailbox simulator.

## Extend the prototype

The role selector supports four roles. Developer has an implemented chat agent and task workflow. Product Manager, Sales Lead, and Social Media use the same workspace and each has a role-specific chat agent. Chat history is shared by workspace and attributed to the person who sent each message. Reminders can be scheduled and marked complete in the workspace. Slack, Telegram, and WhatsApp settings persist destination IDs. Provider authorization, inbound webhooks, outbound messages, and reminder delivery are pending.

Set `COWORK_RUNNER` to the path of a trusted ES module to enable repository-backed work. Its default export implements these methods:

| Method | Expected behavior |
| --- | --- |
| `create(task, directory)` | Create an isolated workspace and return its handle. The provided directory is the artifact directory. |
| `checkout(sandbox, repository)` | Check out the latest revision of an authorized repository. |
| `implement(sandbox, task, plan)` | Apply the work. Return `{ previewUrl, uiChanged, screenshot }` where the preview is an HTTPS URL and the screenshot is PNG bytes for UI changes. For self-contained static work, return `html` instead of `previewUrl`. |
| `openPullRequest(sandbox, task, implementation)` | Publish the reviewed change set as a pull request and return its HTTPS URL. |

The workflow calls the runner in that order, saves the plan before implementation, and validates the screenshot and preview before calling the pull request step. The built-in runner skips pull request creation for standalone preview tasks. Repository-backed tasks require a runner that supplies isolated execution, authorized repository access, and Git credentials. No repository service is configured by default.

Cowork stores workspace records in PostgreSQL and executes work during the task request. The backend is configured for a single instance with a persistent artifact volume.

## Checks

```sh
npm run check
(cd backend && TEST_DATABASE_URL='postgres://cowork:cowork@127.0.0.1:5432/cowork?sslmode=disable' go test ./...)
```

PostgreSQL integration tests create and drop isolated schemas in the database specified by `TEST_DATABASE_URL`.

Framework references are available in the [Mastra quickstart](https://mastra.ai/docs), [Chat SDK Web adapter docs](https://chat-sdk.dev/adapters/official/web), and [Encore.go API docs](https://encore.dev/docs/go/primitives/defining-apis).

## Coolify deployment

Cowork runs as one container with Next.js on port 4400 and the Encore and Mastra services on loopback. `deploy/package.sh` builds the Encore Linux/amd64 release and prints a temporary release directory. Build locally with `docker build -f RELEASE/Dockerfile RELEASE`. For a Coolify build without a Git checkout, stage `RELEASE/cowork-release.tar.xz` on a private endpoint reachable from the build server. Replace the Dockerfile’s copy step with a checksum-verified archive download and extraction into `/app`. The package includes source and the compiled backend. It omits `.env` and local workspace data.

Before deploying this version, configure a PostgreSQL database reachable from the app container and set its connection URL as the runtime-only `DATABASE_URL`. For a PostgreSQL service on the same Coolify network, use its internal hostname. Mount persistent storage at `/app/backend/.cowork` for artifacts, the local encryption key, and the legacy import. Configure OpenRouter and SES as runtime-only variables, set `COWORK_PUBLIC_URL` to the public HTTPS URL, and use `/api/health` on port 4400 for health checks. When Cloudflare Tunnel provides HTTPS, set the Coolify application URL to `http://cowork.iamwille.xyz:4400` so the proxy targets Cowork’s internal port. Set `COWORK_PUBLIC_URL=https://cowork.iamwille.xyz` for guest links.

### Deploy from GitHub main

The [Cowork release workflow](.github/workflows/coolify.yml) builds the Encore backend and container, checks the landing and health endpoints, and publishes `ghcr.io/iamwille-dev/cowork:main` and a commit SHA tag.

Once Coolify can pull the image, switch the existing Cowork application to **Docker Image** and select `ghcr.io/iamwille-dev/cowork:main`. Keep the domain, internal port, runtime variables, and persistent storage configured on that application. For a private GHCR package, configure a read-only registry login on the Coolify server first.

In the GitHub repository’s Actions settings, set the `COOLIFY_API_URL` variable to the Coolify API base URL ending in `/api/v1`, set `COOLIFY_APP_UUID` to the existing Cowork application UUID, and add `COOLIFY_DEPLOY_TOKEN` as a secret with permission to deploy that application. The workflow queues a deployment after each successful image build on `main`.
