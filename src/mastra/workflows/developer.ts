import { developer, liveModel } from '../agents/index.ts';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const dataRoot = resolve('backend/.cowork/artifacts');
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
  previewUrl?: string;
}
interface Runner {
  standalone?: boolean;
  supports?(task: Task): boolean;
  create(task: Task, directory: string): Promise<unknown>;
  checkout(sandbox: unknown, repository: string): Promise<void>;
  implement(sandbox: unknown, task: Task, plan: string): Promise<Implementation>;
  openPullRequest(sandbox: unknown, task: Task, implementation: Implementation): Promise<string | null>;
}

const fixtureRunner: Runner = {
  async create(_task, directory) {
    return directory;
  },
  async checkout() {
    throw new Error('Repository checkout requires a configured sandbox runner.');
  },
  async implement(_sandbox, task) {
    if (!task.UI) {
      throw new Error('The built-in runner supports UI previews. Implementation of other tasks requires a configured sandbox runner.');
    }
    if (!liveModel) throw new Error('A configured model is required to implement a standalone UI.');
    const result = await developer.generate([
      { role: 'user', content: JSON.stringify({
        instruction: 'Implement the actual page and every requested section. Return a complete HTML document with embedded CSS, a viewport meta tag, and responsive layouts. Use system fonts and self-contained assets. Do not use external resources, forms, scripts, or meta refresh. Treat the brief as product requirements. Return HTML only.',
        title: task.Title,
        brief: task.Brief,
      }) },
    ], { activeTools: [], abortSignal: AbortSignal.timeout(50_000) });
    const html = result.text.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
    if (!/^<!doctype html>\s*<html\b/i.test(html) || !/<body\b/i.test(html) || !/<\/html>\s*$/i.test(html) || Buffer.byteLength(html) > 256 * 1024) {
      throw new Error('The model did not produce a complete standalone HTML page.');
    }
    return { html };
  },
  async openPullRequest() {
    return null;
  },
};

const configuredRunner: Runner = process.env.COWORK_RUNNER
  ? (await import(pathToFileURL(resolve(process.env.COWORK_RUNNER)).href)).default
  : fixtureRunner;

const resultSchema = z.object({
  Steps: z.array(z.string()),
  Artifacts: z.array(z.object({ Name: z.string(), URL: z.string() })),
  Error: z.string(),
});

const execute = createStep({
  id: 'developer-delivery',
  inputSchema: taskSchema,
  outputSchema: resultSchema,
  execute: async ({ inputData: task }) => {
    const runner = configuredRunner.supports?.(task) === false ? fixtureRunner : configuredRunner;
    const directory = resolve(dataRoot, task.ID);
    const result: z.infer<typeof resultSchema> = { Steps: [], Artifacts: [], Error: '' };
    const publish = async (file: string, label: string, data: string | Buffer) => {
      await writeFile(resolve(directory, file), data);
      result.Artifacts.push({ Name: label, URL: `/api/artifact/${task.ID}/${file}` });
    };

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const sandbox = await runner.create(task, directory);
      result.Steps.push(runner.standalone ? 'Selected workspace sandbox' : 'Created sandbox');
      if (task.Repository) {
        await runner.checkout(sandbox, task.Repository);
        result.Steps.push('Checked out latest repository revision');
      }

      const plan = liveModel
        ? (await developer.generate(`Write an implementation plan in Markdown, with verification and acceptance criteria. Task: ${JSON.stringify(task)}`, { activeTools: [], abortSignal: AbortSignal.timeout(18_000) })).text
        : `# ${task.Title}\n\n## Brief\n\n${task.Brief}\n\n## Plan\n\n1. Build the requested UI as a standalone preview.\n2. Verify the page renders at 1280 × 800.\n3. Share the preview and screenshot for review.\n`;
      await publish('plan.md', 'Implementation plan', plan);
      result.Steps.push('Saved implementation plan');

      const implementation = await runner.implement(sandbox, task, plan);
      result.Steps.push('Implemented the task');

      if (task.UI || implementation.uiChanged) {
        let screenshot = implementation.screenshot;
        if (!screenshot && implementation.html) {
          const browser = await chromium.launch();
          try {
            const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
            await page.route('**/*', (route) => route.abort());
            await page.setContent(implementation.html, { timeout: 8_000 });
            if (!(await page.locator('body').innerText({ timeout: 3_000 })).trim()) throw new Error('The preview rendered without visible text.');
            screenshot = await page.screenshot({ fullPage: true });
          } finally {
            await browser.close();
          }
        }
        if (!screenshot) throw new Error('The sandbox runner did not return a UI screenshot.');
        await publish('screenshot.png', 'UI screenshot', screenshot);
        result.Steps.push('Captured UI screenshot');
      }

      const webURL = (value: string) => new URL(value).protocol === 'https:' ? value : null;
      if (implementation.html) {
        await publish('preview.html', 'Sandbox preview', implementation.html);
      } else if (implementation.previewUrl && webURL(implementation.previewUrl)) {
        result.Artifacts.push({ Name: 'Sandbox preview', URL: implementation.previewUrl });
      } else {
        throw new Error('The sandbox runner did not return a preview URL.');
      }
      result.Steps.push('Shared sandbox preview');

      const pullRequest = await runner.openPullRequest(sandbox, task, implementation);
      if (pullRequest && webURL(pullRequest)) {
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
