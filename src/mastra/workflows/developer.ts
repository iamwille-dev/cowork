import { driveReadToolIDs } from '../tools/drive.ts';
import { developer, liveModel } from '../agents/index.ts';
import { guardrailReply } from '../guardrails/feedback.ts';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coworkStateDir } from '../../state.ts';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { captureStandalonePreview, implementStandalone } from './standalone.ts';

export const dataRoot = resolve(coworkStateDir, 'artifacts');
const taskSchema = z.object({
  ID: z.string().regex(/^[a-f0-9]{48}$/),
  Title: z.string(),
  Brief: z.string(),
  Repository: z.string(),
  UI: z.boolean(),
  WorkspaceID: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;

interface Implementation {
  html?: string;
  uiChanged?: boolean;
  screenshot?: Buffer;
}
interface Runner {
  standalone?: boolean;
  supports?(task: Task): boolean;
  create(task: Task, directory: string, options?: { replacement: true }): Promise<unknown>;
  checkout(sandbox: unknown, repository: string): Promise<void>;
  implement(sandbox: unknown, task: Task, plan: string, requestContext?: RequestContext): Promise<Implementation>;
  stagePreview?(sandbox: unknown, task: Task, directory: string): Promise<string | null>;
  openPullRequest(sandbox: unknown, task: Task, implementation: Implementation): Promise<string | null>;
}

const fixtureRunner: Runner = {
  async create(_task, directory) {
    return directory;
  },
  async checkout() {
    throw new Error('Repository checkout requires a configured sandbox runner.');
  },
  implement: implementStandalone,
  async openPullRequest() {
    return null;
  },
};

const configuredRunner: Runner = process.env.COWORK_RUNNER
  ? (await import(pathToFileURL(resolve(process.env.COWORK_RUNNER)).href)).default
  : fixtureRunner;

function httpsURL(value: string) {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password ? url.href : null;
}

async function stagePreview(runner: Runner, task: Task, directory: string, sandbox?: unknown) {
  if (!runner.stagePreview) throw new Error('The sandbox runner must support restoring live previews.');
  let target = await runner.stagePreview(sandbox, task, directory);
  const restored = target === null;
  if (restored) {
    sandbox = await runner.create(task, directory, { replacement: true });
    target = await runner.stagePreview(sandbox, task, directory);
  }
  const url = target && httpsURL(target);
  if (!url) throw new Error('The sandbox runner did not return a ready HTTPS preview URL.');
  return { url, sandbox, restored };
}

const openingPreviews = new Map<string, Promise<string>>();

export function openSandboxPreview(id: string) {
  const pending = openingPreviews.get(id);
  if (pending) return pending;
  const directory = resolve(dataRoot, id);
  const opening = (async () => {
    const task = taskSchema.parse(JSON.parse(await readFile(resolve(directory, 'preview-task.json'), 'utf8')));
    if (task.ID !== id || configuredRunner.supports?.(task) === false) throw new Error('Preview runner unavailable.');
    return (await stagePreview(configuredRunner, task, directory)).url;
  })().finally(() => openingPreviews.delete(id));
  openingPreviews.set(id, opening);
  return opening;
}

const resultSchema = z.object({
  Steps: z.array(z.string()),
  Artifacts: z.array(z.object({ Name: z.string(), URL: z.string() })),
  Error: z.string(),
});

const execute = createStep({
  id: 'developer-delivery',
  inputSchema: taskSchema,
  outputSchema: resultSchema,
  execute: async ({ inputData: task, requestContext }) => {
    const runner = configuredRunner.supports?.(task) === false ? fixtureRunner : configuredRunner;
    const directory = resolve(dataRoot, task.ID);
    const result: z.infer<typeof resultSchema> = { Steps: [], Artifacts: [], Error: '' };
    const publish = async (file: string, label: string, data: string | Buffer) => {
      await writeFile(resolve(directory, file), data);
      result.Artifacts.push({ Name: label, URL: `/api/artifact/${task.ID}/${file}` });
    };

    try {
      let plan: string;
      if (liveModel) {
        const brief = [task.Title, task.Brief, task.Repository && `Repository: ${task.Repository}`, task.UI && 'Include a UI screenshot.']
          .filter(Boolean).join('\n\n');
        const planned = await developer.generate(brief, {
          system: 'Write an implementation plan in Markdown, with verification and acceptance criteria.',
          activeTools: requestContext?.getRaw('driveRequest') ? driveReadToolIDs : [], maxSteps: 4, requestContext, abortSignal: AbortSignal.timeout(24_000),
        });
        if (planned.tripwire) throw new Error(guardrailReply(planned.tripwire));
        plan = planned.text;
      } else {
        plan = `# ${task.Title}\n\n## Brief\n\n${task.Brief}\n\n## Plan\n\n1. Build the requested UI as a standalone preview.\n2. Verify the page renders at 1280 × 800.\n3. Share the preview and screenshot for review.\n`;
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let sandbox = await runner.create(task, directory);
      result.Steps.push(runner.standalone ? 'Selected workspace sandbox' : 'Created sandbox');
      if (task.Repository) {
        await runner.checkout(sandbox, task.Repository);
        result.Steps.push('Checked out latest repository revision');
      }

      await publish('plan.md', 'Implementation plan', plan);
      result.Steps.push('Saved implementation plan');

      const implementation = await runner.implement(sandbox, task, plan, requestContext);
      result.Steps.push('Implemented the task');

      if (implementation.html) {
        await publish('preview.html', 'Sandbox preview', implementation.html);
      } else {
        const preview = await stagePreview(runner, task, directory, sandbox);
        if (preview.restored) result.Steps.push('Restored changes in a replacement sandbox');
        sandbox = preview.sandbox;
        const manifest = resolve(directory, 'preview-task.json');
        await writeFile(`${manifest}.tmp`, JSON.stringify(task), { mode: 0o600 });
        await rename(`${manifest}.tmp`, manifest);
        result.Artifacts.push({ Name: 'Sandbox preview', URL: `/api/artifact/${task.ID}/preview` });
      }
      result.Steps.push('Shared sandbox preview');

      if (task.UI || implementation.uiChanged) {
        const screenshot = implementation.screenshot ?? (implementation.html && await captureStandalonePreview(implementation.html));
        if (!screenshot) throw new Error('The sandbox runner did not return a UI screenshot.');
        await publish('screenshot.png', 'UI screenshot', screenshot);
        result.Steps.push('Captured UI screenshot');
      }

      const pullRequest = await runner.openPullRequest(sandbox, task, implementation);
      if (pullRequest && httpsURL(pullRequest)) {
        result.Artifacts.push({ Name: 'Pull request', URL: pullRequest });
        result.Steps.push('Opened pull request');
      } else if (task.Repository || pullRequest || (runner !== fixtureRunner && !runner.standalone)) {
        throw new Error('The sandbox runner did not return a pull request URL.');
      } else {
        result.Steps.push('Pull request requires a repository runner');
      }
    } catch (error) {
      result.Error = error instanceof Error ? error.message : 'Developer workflow failed.';
    }
    return result;
  },
});

export const developerWorkflow = createWorkflow({
  id: 'developer-task',
  inputSchema: taskSchema,
  outputSchema: resultSchema,
}).then(execute).commit();
