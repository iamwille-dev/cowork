import { developer, liveModel } from '../agents/index.ts';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const dataRoot = resolve('backend/.cowork/artifacts');
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] ?? character));

const taskSchema = z.object({
  ID: z.string().regex(/^[a-f0-9]{48}$/),
  Title: z.string(),
  Brief: z.string(),
  Repository: z.string(),
  UI: z.boolean(),
});
export type Task = z.infer<typeof taskSchema>;

interface Implementation {
  html?: string;
  uiChanged?: boolean;
  screenshot?: Buffer;
  previewUrl?: string;
}
interface Runner {
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
    const copy = liveModel
      ? (await developer.generate([
        { role: 'user', content: JSON.stringify({ instruction: 'Write a short subtitle for a prototype page based on this brief. Return plain text.', brief: task.Brief }) },
      ])).text.trim()
      : task.Brief;
    return { html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(task.Title)}</title><style>
      *{box-sizing:border-box} body{margin:0;background:#f1efe8;color:#171f1a;font:18px/1.6 system-ui;padding:8vw}main{max-width:960px;margin:auto;border-top:2px solid #1a3927;padding:6vw 0}small{color:#345943;letter-spacing:.12em;text-transform:uppercase}h1{font:clamp(3rem,8vw,7rem)/.97 Georgia,serif;letter-spacing:-.06em;margin:28px 0}p{max-width:620px;white-space:pre-wrap}</style>
      <main><small>Cowork sandbox preview</small><h1>${escape(task.Title)}</h1><p>${escape(copy)}</p></main></html>` };
  },
  async openPullRequest() {
    return null;
  },
};

const runner: Runner = process.env.COWORK_RUNNER
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
    const directory = resolve(dataRoot, task.ID);
    const result: z.infer<typeof resultSchema> = { Steps: [], Artifacts: [], Error: '' };
    const publish = async (file: string, label: string, data: string | Buffer) => {
      await writeFile(resolve(directory, file), data);
      result.Artifacts.push({ Name: label, URL: `/api/artifact/${task.ID}/${file}` });
    };

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const sandbox = await runner.create(task, directory);
      result.Steps.push('Created sandbox');
      if (task.Repository) {
        await runner.checkout(sandbox, task.Repository);
        result.Steps.push('Checked out latest repository revision');
      }

      const plan = liveModel
        ? (await developer.generate(`Write an implementation plan in Markdown, with verification and acceptance criteria. Task: ${JSON.stringify(task)}`)).text
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
            await page.setContent(implementation.html);
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
      } else if (task.Repository || runner !== fixtureRunner) {
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
