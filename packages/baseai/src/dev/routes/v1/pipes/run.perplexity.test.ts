import { handleError } from '@/dev/hono/errors';
import documentedAgentResponse from '@/dev/providers/perplexity/fixtures/documented-agent-response.json';
import documentedAgentStream from '@/dev/providers/perplexity/fixtures/documented-agent-stream.json';
import { Hono, type Context } from 'hono';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi
} from 'vitest';
import type { Pipe } from 'types/pipe';
import { registerV1PipesRun } from './run';

vi.mock('@/utils/logger-utils', () => ({ logger: vi.fn() }));

const AGENT_ALIASES = ['fast', 'low', 'medium', 'high'] as const;
const LEGACY_MODELS = [
	'llama-3.1-sonar-huge-128k-online',
	'llama-3.1-sonar-large-128k-online',
	'llama-3.1-sonar-small-128k-online',
	'llama-3.1-sonar-large-128k-chat',
	'llama-3.1-sonar-small-128k-chat'
] as const;
const UNSUPPORTED_MODELS = ['xhigh', 'wide-research', 'typo'] as const;

function scaffoldPipe(model: string, overrides: Partial<Pipe> = {}): Pipe {
	return {
		name: 'perplexity-agent',
		description: 'Perplexity Agent route integration',
		status: 'private',
		model: model as Pipe['model'],
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
		messages: [
			{
				role: 'system',
				content: 'Answer concisely and cite factual claims.'
			}
		],
		variables: [],
		memory: [],
		tools: [],
		...overrides
	};
}

function requestBody(pipe: Pipe, stream = false) {
	return {
		pipe,
		stream,
		messages: [{ role: 'user', content: 'What is a model card?' }],
		llmApiKey: 'test-perplexity-key'
	};
}

function encodeSSE(events: object[]): string {
	return `${events
		.map(event => `data: ${JSON.stringify(event)}\n\n`)
		.join('')}data: [DONE]\n\n`;
}

function legacyResponse(model: string) {
	return {
		id: 'legacy-response',
		object: 'chat.completion',
		created: 1784292159,
		model,
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: 'Legacy response' },
				finish_reason: 'stop'
			}
		],
		usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
	};
}

describe('POST /v1/pipes/run Perplexity dispatch', () => {
	let app: Hono;
	let fetchMock: Mock<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

	beforeEach(() => {
		app = new Hono();
		app.onError((error, context) =>
			handleError(error, context as unknown as Context)
		);
		registerV1PipesRun(app);
		fetchMock = vi.fn(async (input, init) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body || '{}')) as {
				model?: string;
				stream?: boolean;
			};
			if (url.endsWith('/v1/agent')) {
				if (body.stream) {
					return new Response(encodeSSE(documentedAgentStream), {
						status: 200,
						headers: { 'content-type': 'text/event-stream' }
					});
				}
				return new Response(JSON.stringify(documentedAgentResponse), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(
				JSON.stringify(legacyResponse(body.model || '')),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			);
		});
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function runRoute(body: object): Promise<Response> {
		return app.request('http://localhost/v1/pipes/run', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	}

	it.each(AGENT_ALIASES)(
		'routes perplexity:%s through every runtime layer to /v1/agent',
		async preset => {
			const response = await runRoute(
				requestBody(scaffoldPipe(`perplexity:${preset}`))
			);
			expect(response.status).toBe(200);
			const result = await response.json();
			expect(result).toMatchObject({
				completion:
					'A model card documents intended use and limitations.[web:4]',
				model: 'openai/gpt-5.4-mini'
			});

			expect(fetchMock).toHaveBeenCalledOnce();
			const [url, init] = fetchMock.mock.calls[0] as [
				string,
				RequestInit
			];
			expect(url).toBe('https://api.perplexity.ai/v1/agent');
			expect(init.method).toBe('POST');
			expect(JSON.parse(String(init.body))).toEqual({
				preset,
				input: [
					{
						type: 'message',
						role: 'system',
						content: 'Answer concisely and cite factual claims.'
					},
					{
						type: 'message',
						role: 'user',
						content: 'What is a model card?'
					}
				],
				max_output_tokens: 1000,
				stream: false,
				temperature: 0.7,
				top_p: 1
			});
		}
	);

	it.each(LEGACY_MODELS)(
		'keeps perplexity:%s on Chat Completions without rewriting it',
		async model => {
			const response = await runRoute(
				requestBody(scaffoldPipe(`perplexity:${model}`))
			);
			expect(response.status).toBe(200);
			const [url, init] = fetchMock.mock.calls[0] as [
				string,
				RequestInit
			];
			expect(url).toBe('https://api.perplexity.ai/chat/completions');
			expect(JSON.parse(String(init.body)).model).toBe(model);
		}
	);

	it.each(UNSUPPORTED_MODELS)(
		'rejects unsupported perplexity:%s before provider fetch',
		async model => {
			const response = await runRoute(
				requestBody(scaffoldPipe(`perplexity:${model}`))
			);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				success: false,
				error: {
					status: 400,
					code: 'BAD_REQUEST',
					message: `Unsupported Perplexity model: perplexity:${model}`
				}
			});
			expect(fetchMock).not.toHaveBeenCalled();
		}
	);

	it('rejects request tools before provider fetch', async () => {
		const response = await runRoute({
			...requestBody(scaffoldPipe('perplexity:fast')),
			tools: [
				{
					type: 'function',
					function: { name: 'lookup', parameters: { type: 'object' } }
				}
			]
		});
		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('streams one Agent response through the route', async () => {
		const response = await runRoute(
			requestBody(scaffoldPipe('perplexity:fast'), true)
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('A model card');
		expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
	});

	it('surfaces a provider stream failure after response headers', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				encodeSSE([
					documentedAgentStream[0],
					{
						type: 'response.failed',
						sequence_number: 1,
						error: { message: 'stream failed' }
					}
				]),
				{
					status: 200,
					headers: { 'content-type': 'text/event-stream' }
				}
			)
		);
		const response = await runRoute(
			requestBody(scaffoldPipe('perplexity:fast'), true)
		);
		expect(response.status).toBe(200);
		await expect(response.text()).rejects.toThrow('stream failed');
	});

	it('maps an HTTP 200 failed Agent response to an internal error', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					...documentedAgentResponse,
					status: 'failed',
					error: {
						message: 'Agent execution failed',
						code: 'agent_failed',
						type: 'server_error'
					}
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			)
		);
		const response = await runRoute(
			requestBody(scaffoldPipe('perplexity:fast'))
		);
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			success: false,
			error: {
				status: 500,
				code: 'INTERNAL_SERVER_ERROR',
				message: 'Agent execution failed'
			}
		});
	});

	it.each([
		[401, 'UNAUTHORIZED'],
		[403, 'FORBIDDEN'],
		[404, 'NOT_FOUND'],
		[429, 'RATE_LIMITED'],
		[500, 'INTERNAL_SERVER_ERROR']
	] as const)(
		'preserves provider HTTP %i as %s at the route',
		async (status, code) => {
			fetchMock.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ error: { message: 'Provider error' } }),
					{
						status
					}
				)
			);
			const response = await runRoute(
				requestBody(scaffoldPipe('perplexity:fast'))
			);
			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toMatchObject({
				success: false,
				error: { status, code }
			});
		}
	);
});
