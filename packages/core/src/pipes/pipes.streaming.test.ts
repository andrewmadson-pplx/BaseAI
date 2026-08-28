import {describe, expect, it, vi} from 'vitest';
import type {Pipe as PipeConfig} from '../../types/pipes';
import {Pipe, type RunResponseStream} from './pipes';

function toolFreePipe(): PipeConfig {
	return {
		apiKey: 'test-api-key',
		name: 'perplexity-agent',
		description: 'Perplexity Agent streaming test',
		status: 'private',
		model: 'perplexity:fast',
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
		messages: [],
		variables: [],
		memory: [],
		tools: [],
	};
}

describe('Pipe tool-free streaming', () => {
	it('returns the stream before the upstream source finishes', async () => {
		let terminalReached = false;
		let finishSource!: () => void;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('first chunk'));
				finishSource = () => {
					terminalReached = true;
					controller.close();
				};
			},
		});
		const response: RunResponseStream = {stream: source, threadId: null};
		const pipe = new Pipe({...toolFreePipe(), prod: true});
		const post = vi.fn().mockResolvedValue(response);
		(pipe as unknown as {request: {post: typeof post}}).request = {post};

		const delayedTerminal = setTimeout(() => finishSource(), 100);
		const result = await pipe.run({messages: [], stream: true});

		expect(result).toBe(response);
		expect(terminalReached).toBe(false);
		const reader = result.stream.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe('first chunk');
		reader.releaseLock();
		clearTimeout(delayedTerminal);
		finishSource();
	});
});
