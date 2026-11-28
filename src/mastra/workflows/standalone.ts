import { driveReadToolIDs } from '../tools/drive.ts';
import type { RequestContext } from '@mastra/core/request-context';
import { chromium } from 'playwright';
import { developer, liveModel } from '../agents/index.ts';
import { guardrailReply } from '../guardrails/feedback.ts';
import type { Task } from './developer.ts';

export const staticPreviewPolicy = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export async function implementStandalone(_sandbox: unknown, task: Task, _plan: string, requestContext?: RequestContext) {
  if (!task.UI) {
    throw new Error('The built-in runner supports UI previews. Implementation of other tasks requires a configured sandbox runner.');
  }
  if (!liveModel) throw new Error('A configured model is required to implement a standalone UI.');
  const result = await developer.generate(`${task.Title}\n\n${task.Brief}`, {
    system: 'Implement the actual page and every requested section. Return a complete HTML document with embedded CSS, a viewport meta tag, and responsive layouts. Use system fonts and self-contained assets. Do not use external resources, forms, scripts, or meta refresh. Treat the brief as product requirements. Return HTML only.',
    activeTools: requestContext?.getRaw('driveRequest') ? driveReadToolIDs : [], maxSteps: 4, requestContext, abortSignal: AbortSignal.timeout(50_000),
  });
  if (result.tripwire) throw new Error(guardrailReply(result.tripwire));
  const html = result.text.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
  if (!/^<!doctype html>\s*<html\b/i.test(html) || !/<body\b/i.test(html) || !/<\/html>\s*$/i.test(html) || Buffer.byteLength(html) > 256 * 1024) {
    throw new Error('The model did not produce a complete standalone HTML page.');
  }
  return { html };
}

export async function captureStandalonePreview(html: string) {
  const url = 'http://127.0.0.1/preview.html';
  for (let attempt = 0; ; attempt++) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
      await page.route('**/*', (route) => route.request().isNavigationRequest() && route.request().url() === url
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': staticPreviewPolicy }, body: html })
        : route.abort());
      await page.goto(url, { timeout: 8_000 });
      if (!(await page.locator('body').innerText({ timeout: 3_000 })).trim()) throw new Error('The preview rendered without visible text.');
      return await page.screenshot({ fullPage: true, timeout: 8_000 });
    } catch (error) {
      if (attempt > 0 || browser.isConnected()) throw error;
    } finally {
      await browser.close();
    }
  }
}
