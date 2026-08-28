import { describe, expect, it } from 'vitest';
import type { Pipe } from 'types/pipe';
import { validateRequestBody } from '@/dev/routes/v1/pipes/run';
import { toOldPipeFormat } from '@/utils/to-old-pipe-format';
import {
	PERPLEXITY_AGENT_PRESETS,
	buildPerplexityAgentRequest,
	getPerplexityTransport
} from './agentResponse';

const legacyModels = [
	'perplexity:llama-3.1-sonar-huge-128k-online',
	'perplexity:llama-3.1-sonar-large-128k-online',
	'perplexity:llama-3.1-sonar-small-128k-online',
	'perplexity:llama-3.1-sonar-large-128k-chat',
	'perplexity:llama-3.1-sonar-small-128k-chat'
] as const;

function scaffoldPipe(model: Pipe['model']): Pipe {
	return {
		name: 'perplexity-agent',
		description: 'Perplexity Agent API example',
		status: 'private',
		model,
		stream: true,
		json: false,
		store: true,
		moderate: true,
		top_p: 1,
		max_tokens: 1000,
		temperature: 0.7,
		presence_penalty: 1,
		frequency_penalty: 1,
		stop: [],
		tool_choice: 'auto',
		parallel_tool_calls: true,
		messages: [{ role: 'system', content: 'Be concise.' }],
		variables: [],
		memory: [],
		tools: []
	};
}

describe('Perplexity transport dispatch', () => {
	it.each(legacyModels)('keeps %s on Chat Completions', model => {
		expect(getPerplexityTransport(model)).toBe('chatComplete');
	});

	it.each(PERPLEXITY_AGENT_PRESETS)(
		'routes perplexity:%s to the matching Agent preset',
		preset => {
			const model = `perplexity:${preset}` as Pipe['model'];
			expect(getPerplexityTransport(model)).toBe('agentResponse');
			expect(
				buildPerplexityAgentRequest({
					pipe: scaffoldPipe(model),
					messages: [{ role: 'user', content: 'Hello' }],
					stream: false
				}).preset
			).toBe(preset);
		}
	);
});

describe('Perplexity model string compatibility', () => {
	it.each(PERPLEXITY_AGENT_PRESETS)(
		'preserves perplexity:%s through Pipe parsing and toOldPipeFormat',
		preset => {
			const model = `perplexity:${preset}` as Pipe['model'];
			const pipe = scaffoldPipe(model);
			const parsed = validateRequestBody({
				pipe,
				stream: false,
				messages: [],
				llmApiKey: 'test-key'
			});
			expect(parsed.pipe.model).toBe(model);

			const oldPipe = toOldPipeFormat(pipe);
			expect(oldPipe.config.model).toMatchObject({
				name: preset,
				provider: 'Perplexity'
			});
			expect(
				`${oldPipe.config.model.provider.toLowerCase()}:${oldPipe.config.model.name}`
			).toBe(model);
		}
	);
});
