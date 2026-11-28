import { ModelRouterLanguageModel } from '@mastra/core/llm';

// Bound the built-in processors' internal model calls independently of the main agent.
class GuardrailModel extends ModelRouterLanguageModel {
  override doStream(options: Parameters<ModelRouterLanguageModel['doStream']>[0]) {
    const timeout = AbortSignal.timeout(8_000);
    const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
    return super.doStream({ ...options, abortSignal });
  }
}

export const guardrailModel = new GuardrailModel(
  `openrouter/${process.env.OPENROUTER_GUARDRAIL_MODEL?.trim() || 'openai/gpt-4.1-mini'}`,
);
