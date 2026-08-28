import { describe, expect, it, vi } from 'vitest';
import { transformPerplexityAgentStream } from './agentResponse';
import documentedAgentStream from './fixtures/documented-agent-stream.json';

const created = {
	type: 'response.created',
	sequence_number: 0,
	response: {
		id: 'resp_stream_123',
		created_at: 1787928000,
		status: 'in_progress',
		model: 'openai/gpt-5.4-mini'
	}
};

const delta = (text: string, sequenceNumber = 1) => ({
	type: 'response.output_text.delta',
	sequence_number: sequenceNumber,
	item_id: 'msg_stream_123',
	output_index: 0,
	content_index: 0,
	delta: text
});

const completed = (sequenceNumber = 2) => ({
	type: 'response.completed',
	sequence_number: sequenceNumber,
	response: {
		id: 'resp_stream_123',
		created_at: 1787928000,
		status: 'completed',
		model: 'openai/gpt-5.4-mini'
	}
});

function sse(
	events: object[],
	lineEnding: '\n' | '\r\n' = '\n',
	includeDone = true
): string {
	const body = events
		.map(
			event => `data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`
		)
		.join('');
	return includeDone ? `${body}data: [DONE]${lineEnding}${lineEnding}` : body;
}

function responseFromChunks(chunks: Uint8Array[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
}

function responseFromText(text: string): Response {
	return responseFromChunks([new TextEncoder().encode(text)]);
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		text += decoder.decode(value, { stream: true });
	}
}

describe('Perplexity Agent stream reducer', () => {
	it.each(['\n', '\r\n'] as const)(
		'accepts %j SSE delimiters and emits one terminal and one DONE',
		async lineEnding => {
			const output = await readText(
				transformPerplexityAgentStream(
					responseFromText(sse(documentedAgentStream, lineEnding))
				)
			);

			const frames = output
				.split('\n\n')
				.filter(Boolean)
				.map(frame => frame.replace(/^data: /, ''));
			expect(frames).toHaveLength(4);
			expect(JSON.parse(frames[0]).choices[0]).toEqual({
				delta: { role: 'assistant', content: '' },
				index: 0,
				finish_reason: null
			});
			expect(JSON.parse(frames[1]).choices[0].delta).toEqual({
				content: 'A model card'
			});
			expect(JSON.parse(frames[2]).choices[0]).toEqual({
				delta: {},
				index: 0,
				finish_reason: 'stop'
			});
			expect(frames[3]).toBe('[DONE]');
			for (const frame of frames.slice(0, 3)) {
				expect(JSON.parse(frame).model).toBe('openai/gpt-5.4-mini');
			}
			expect(output.match(/finish_reason":"stop"/g)).toHaveLength(1);
			expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
		}
	);

	it('preserves fragmented UTF-8 text', async () => {
		const source = new TextEncoder().encode(
			sse([created, delta('café 🛰️'), completed()])
		);
		const splitAt = source.findIndex(byte => byte === 0xf0);
		const response = responseFromChunks([
			source.slice(0, splitAt + 1),
			source.slice(splitAt + 1, splitAt + 3),
			source.slice(splitAt + 3)
		]);

		const output = await readText(transformPerplexityAgentStream(response));
		expect(output).toContain('café 🛰️');
		expect(output).not.toContain('�');
	});

	it('accepts multiline SSE data fields', async () => {
		const createdJSON = JSON.stringify(created);
		const splitAt = createdJSON.indexOf(',"response"') + 1;
		const multilineCreated =
			`data: ${createdJSON.slice(0, splitAt)}\n` +
			`data: ${createdJSON.slice(splitAt)}\n\n`;
		const response = responseFromText(
			multilineCreated + sse([delta('Hello'), completed()])
		);

		await expect(
			readText(transformPerplexityAgentStream(response))
		).resolves.toContain('Hello');
	});

	it('accepts named SSE events whose data omits type', async () => {
		const withoutType = <T extends { type: string }>({
			type: _type,
			...event
		}: T) => event;
		const source =
			`event: response.created\ndata: ${JSON.stringify(withoutType(created))}\n\n` +
			`event: response.output_text.delta\ndata: ${JSON.stringify(
				withoutType(delta('Named event'))
			)}\n\n` +
			`event: response.completed\ndata: ${JSON.stringify(
				withoutType(completed())
			)}\n\n` +
			'data: [DONE]\n\n';

		await expect(
			readText(transformPerplexityAgentStream(responseFromText(source)))
		).resolves.toContain('Named event');
	});

	it('redacts malformed SSE content from logging and errors', async () => {
		const consoleError = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const response = responseFromText(
			'data: {"private_prompt":"do not log"\n\n'
		);

		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow(
			'Could not parse Perplexity Agent SSE message as JSON'
		);
		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it.each(['{}', '42'])(
		'rejects structurally malformed SSE data: %s',
		async data => {
			const response = responseFromText(`data: ${data}\n\n`);
			await expect(
				readText(transformPerplexityAgentStream(response))
			).rejects.toThrow('stream event is malformed');
		}
	);

	it('fails on response.failed without success terminal output', async () => {
		const terminal = {
			type: 'response.failed',
			sequence_number: 1,
			error: { message: 'upstream failed' }
		};
		const response = responseFromText(sse([created, terminal]));
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('upstream failed');
	});

	it('fails on duplicate terminal events', async () => {
		const response = responseFromText(
			sse([created, delta('Hello'), completed(), completed(3)])
		);
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('after a terminal event');
	});

	it('fails on out-of-order terminal sequences', async () => {
		const response = responseFromText(
			sse([created, delta('Hello', 3), completed(2)])
		);
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('duplicate or out of order');
	});

	it('requires a sequence number on every event', async () => {
		const response = responseFromText(
			sse([{ ...created, sequence_number: undefined }])
		);
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('sequence is malformed');
	});

	it('fails on out-of-order output indexes', async () => {
		const laterOutput = {
			...delta('later', 1),
			output_index: 1,
			item_id: 'msg_later'
		};
		const earlierOutput = {
			...delta('earlier', 2),
			output_index: 0
		};
		const response = responseFromText(
			sse([created, laterOutput, earlierOutput, completed(3)])
		);
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('text indexes are out of order');
	});

	it('fails when response identity changes', async () => {
		const changedIdentity = {
			type: 'response.in_progress',
			sequence_number: 1,
			response: {
				id: 'resp_stream_123',
				created_at: 1787928001,
				status: 'in_progress',
				model: 'openai/gpt-5.4-mini'
			}
		};
		const response = responseFromText(sse([created, changedIdentity]));
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('response identity changed');
	});

	it('fails when the executing model changes', async () => {
		const changedModel = {
			type: 'response.in_progress',
			sequence_number: 1,
			response: {
				id: 'resp_stream_123',
				created_at: 1787928000,
				status: 'in_progress',
				model: 'anthropic/claude-sonnet-4-6'
			}
		};
		const response = responseFromText(sse([created, changedModel]));
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('response identity changed');
	});

	it('fails on premature EOF and premature DONE', async () => {
		const prematureEOF = responseFromText(
			sse([created, delta('partial')], '\n', false)
		);
		await expect(
			readText(transformPerplexityAgentStream(prematureEOF))
		).rejects.toThrow('before response.completed');

		const prematureDone = responseFromText(
			sse([created, delta('partial')])
		);
		await expect(
			readText(transformPerplexityAgentStream(prematureDone))
		).rejects.toThrow('before response.completed');
	});

	it('fails when a completed stream contains no text', async () => {
		const response = responseFromText(sse([created, completed(1)]));
		await expect(
			readText(transformPerplexityAgentStream(response))
		).rejects.toThrow('without output text');
	});
});
