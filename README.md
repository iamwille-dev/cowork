# Cowork

Cowork is a local prototype of a shared agent workspace. Encore.go owns accounts, sessions, workspace membership, conversation history, tasks, reminders, channel settings, and artifact access. Mastra runs all four chat agents and the Developer workflow. The browser frontend is a Next.js App Router app. The conversation uses Chat SDK’s Web adapter for message transport and assistant-ui for rendering. Encore owns the shared message history.

## Run locally

Install Node.js 22.18 or newer, Go 1.25 or newer, and the Encore CLI. From the project root:

```sh
npm ci
npx playwright install chromium
```

Start Encore from the backend directory:

```sh
cd backend
encore run --listen 127.0.0.1:4000
```

In a second terminal, start the frontend and agent from the project root:

```sh
npm run dev:web
```

For a production-mode local preview, run `npm run build` followed by `npm start`.

Open http://localhost:4400. Account records and artifacts live under `backend/.cowork/`.

For local agent and workflow development, run `npm run dev` from the project root and open Mastra Studio at http://localhost:4111. The TypeScript entry point is `src/mastra/index.ts`. Studio can inspect agents, tools, and workflows. Workspace writes require an authenticated Cowork chat session.

## Try the Developer workflow

1. Create an account with the Developer role.
2. Assign a task with a title and brief, leave the repository blank, and enable the screenshot option.
3. Open the task’s plan, sandbox preview, and screenshot. The built-in runner renders a standalone title-and-description page and captures it with Chromium.
4. To try a shared conversation, copy the invite code from Workspace settings and use it during account creation in a second browser profile.

## Configure OpenRouter

Copy `.env.example` to `.env` in the project root and set `OPENROUTER_API_KEY` to your [OpenRouter key](https://openrouter.ai/settings/keys). Restart `npm start` to load it. The same server-side key serves all four roles. Set `OPENROUTER_MODEL` to an OpenRouter model ID such as `openai/gpt-4.1-mini` to override the default. Chat and its tools require a key. The manual task form can still use the built-in Developer planning and preview runner.

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

The local prototype stores data on disk and executes work during the task request. Deploying it to multiple backend instances would require shared storage and durable job execution.

## Checks

```sh
npm run check
(cd backend && go test ./...)
```

Framework references are available in the [Mastra quickstart](https://mastra.ai/docs), [Chat SDK Web adapter docs](https://chat-sdk.dev/adapters/official/web), and [Encore.go API docs](https://encore.dev/docs/go/primitives/defining-apis).

## Coolify deployment

Cowork runs as one container with Next.js on port 4400 and the Encore and Mastra services on loopback. `deploy/package.sh` builds the Encore Linux/amd64 release and prints a temporary release directory. Build locally with `docker build -f RELEASE/Dockerfile RELEASE`. For a Coolify build without a Git checkout, stage `RELEASE/cowork-release.tar.xz` on a private endpoint reachable from the build server. Replace the Dockerfile’s copy step with a checksum-verified archive download and extraction into `/app`. The package includes source and the compiled backend. It omits `.env` and local workspace data.

Mount persistent storage at `/app/backend/.cowork` for workspace data and artifacts. Configure OpenRouter and SES as runtime-only variables, set `COWORK_PUBLIC_URL` to the public HTTPS URL, and use `/api/health` on port 4400 for health checks. When Cloudflare Tunnel provides HTTPS, set the Coolify application URL to `http://cowork.iamwille.xyz:4400` so the proxy targets Cowork’s internal port. Set `COWORK_PUBLIC_URL=https://cowork.iamwille.xyz` for guest links.
