import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPEN_AI, PERPLEXITY } from '@/dev/data/models';
import { handleStreamingMode } from '@/dev/utils/provider-handlers/response-handler-utils';
import { PerplexityAIChatCompleteStreamChunkTransform } from './chatComplete';

async function readText(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		text += decoder.decode(value, { stream: true });
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('existing provider streaming regressions', () => {
	it('preserves the legacy Perplexity Chat Completions chunk envelope', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1787928000000);
		const upstreamChunk = {
			id: 'legacy-123',
			object: 'chat.completion.chunk',
			created: 1787927999,
			model: 'llama-3.1-sonar-small-128k-chat',
			usage: {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0
			},
			choices: [
				{
					message: { role: 'assistant', content: '' },
					delta: { role: 'assistant', content: 'Hello' },
					index: 0,
					finish_reason: null
				}
			]
		};
		const upstream = `data: ${JSON.stringify(upstreamChunk)}\r\n\r\n`;
		const stream = await handleStreamingMode(
			new Response(upstream),
			PERPLEXITY,
			PerplexityAIChatCompleteStreamChunkTransform,
			'https://api.perplexity.ai/chat/completions'
		);

		expect(await readText(stream)).toBe(
			`data: ${JSON.stringify({
				id: 'legacy-123',
				object: 'chat.completion.chunk',
				created: 1787928000,
				model: 'llama-3.1-sonar-small-128k-chat',
				provider: 'Perplexity',
				choices: [
					{
						delta: { role: 'assistant', content: 'Hello' },
						index: 0,
						finish_reason: null
					}
				]
			})}\n\n`
		);
	});

	it('passes another existing provider stream through byte for byte', async () => {
		const upstream =
			'data: {"id":"openai-1","delta":"one"}\n\n' +
			'data: {"id":"openai-1","delta":"two"}\n\n';
		const stream = await handleStreamingMode(
			new Response(upstream),
			OPEN_AI,
			undefined,
			'https://api.openai.com/v1/chat/completions'
		);

		expect(await readText(stream)).toBe(upstream);
	});
});
