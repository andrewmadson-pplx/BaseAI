import { describe, expect, it, vi } from 'vitest';
import type { Pipe } from 'types/pipe';
import type { ProviderMessage } from 'types/providers';
import {
	buildPerplexityAgentRequest,
	callPerplexityAgent,
	getPerplexityAgentURL,
	transformPerplexityAgentResponse,
	type PerplexityAgentResponse
} from './agentResponse';

function scaffoldPipe(overrides: Partial<Pipe> = {}): Pipe {
	return {
		name: 'perplexity-agent',
		description: 'Perplexity Agent API example',
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
		...overrides
	};
}

const messages: ProviderMessage[] = [
	{ role: 'system', content: 'Be concise.' },
	{ role: 'user', content: 'What changed?' },
	{ role: 'assistant', content: 'I will check.' }
];

const completedResponse: PerplexityAgentResponse = {
	id: 'resp_agent_123',
	object: 'response',
	created_at: 1787928000,
	status: 'completed',
	model: 'perplexity/sonar',
	output: [
		{
			type: 'search_results',
			results: [
				{ id: 1, url: 'https://example.com/one' },
				{ id: 2, url: 'https://example.com/two' }
			]
		},
		{
			type: 'message',
			id: 'msg_123',
			role: 'assistant',
			status: 'completed',
			content: [
				{
					type: 'output_text',
					text: 'Alpha[1] ',
					annotations: [
						{
							type: 'url_citation',
							start_index: 0,
							end_index: 5,
							url: 'https://example.com/direct'
						}
					]
				},
				{
					type: 'output_text',
					text: 'Beta [web:2].'
				}
			]
		}
	],
	usage: {
		input_tokens: 12,
		output_tokens: 8,
		total_tokens: 20
	}
};

describe('Perplexity Agent request adapter', () => {
	it('maps a standard scaffold changed only to perplexity:fast', () => {
		const request = buildPerplexityAgentRequest({
			pipe: scaffoldPipe(),
			messages,
			stream: true
		});

		expect(request).toEqual({
			preset: 'fast',
			input: [
				{ type: 'message', role: 'system', content: 'Be concise.' },
				{
					type: 'message',
					role: 'user',
					content: 'What changed?'
				},
				{
					type: 'message',
					role: 'assistant',
					content: 'I will check.'
				}
			],
			max_output_tokens: 1000,
			stream: true,
			temperature: 0.7,
			top_p: 1
		});
		expect(request).not.toHaveProperty('model');
		expect(request).not.toHaveProperty('store');
		expect(request).not.toHaveProperty('moderate');
		expect(request).not.toHaveProperty('tools');
	});

	it('maps supported text and image content parts', () => {
		const request = buildPerplexityAgentRequest({
			pipe: scaffoldPipe(),
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'Describe this.' },
						{
							type: 'image_url',
							image_url: { url: 'https://example.com/image.png' }
						}
					]
				}
			],
			stream: false
		});

		expect(request.input[0].content).toEqual([
			{ type: 'input_text', text: 'Describe this.' },
			{
				type: 'input_image',
				image_url: 'https://example.com/image.png'
			}
		]);
	});

	it('preserves store and moderate as platform behavior without forwarding them', () => {
		const request = buildPerplexityAgentRequest({
			pipe: scaffoldPipe({ store: false, moderate: false }),
			messages,
			stream: false
		});
		expect(request).not.toHaveProperty('store');
		expect(request).not.toHaveProperty('moderate');
	});

	it.each([
		['presence_penalty', { presence_penalty: 0 }],
		['frequency_penalty', { frequency_penalty: 0 }],
		['stop', { stop: ['END'] }],
		['json', { json: true }],
		['tool_choice', { tool_choice: 'required' }],
		['parallel_tool_calls', { parallel_tool_calls: false }],
		['max_tokens', { max_tokens: 0 }]
	])('rejects unsupported %s values by field name', (field, overrides) => {
		expect(() =>
			buildPerplexityAgentRequest({
				pipe: scaffoldPipe(overrides as Partial<Pipe>),
				messages,
				stream: false
			})
		).toThrow(field);
	});

	it('rejects Pipe tools and request tools', () => {
		const tool = {
			type: 'function',
			function: { name: 'lookup', parameters: {} },
			run: vi.fn()
		};
		expect(() =>
			buildPerplexityAgentRequest({
				pipe: scaffoldPipe({ tools: [tool] as Pipe['tools'] }),
				messages,
				stream: false
			})
		).toThrow('tools');
		expect(() =>
			buildPerplexityAgentRequest({
				pipe: scaffoldPipe(),
				messages,
				stream: false,
				paramsTools: [tool] as Pipe['tools']
			})
		).toThrow('tools');
	});

	it.each([
		[
			'messages[0].role',
			{ role: 'tool', content: 'result', tool_call_id: 'call_1' }
		],
		[
			'messages[0].tool_calls',
			{ role: 'assistant', content: null, tool_calls: [] }
		],
		[
			'messages[0].name',
			{ role: 'assistant', content: 'hello', name: 'named' }
		]
	])('rejects unsupported history at %s', (field, message) => {
		expect(() =>
			buildPerplexityAgentRequest({
				pipe: scaffoldPipe(),
				messages: [message as ProviderMessage],
				stream: false
			})
		).toThrow(field);
	});

	it('rejects unsupported content parts by field path', () => {
		expect(() =>
			buildPerplexityAgentRequest({
				pipe: scaffoldPipe(),
				messages: [
					{
						role: 'user',
						content: [{ type: 'file_url' }] as never
					}
				],
				stream: false
			})
		).toThrow('messages[0].content[0].type');
	});

	it('rejects non-empty tools before network I/O', async () => {
		const fetcher = vi.fn();
		await expect(
			callPerplexityAgent(
				{
					pipe: scaffoldPipe(),
					messages,
					llmApiKey: 'test-key',
					stream: false,
					paramsTools: [{ type: 'function' }] as never
				},
				{ fetcher: fetcher as typeof fetch }
			)
		).rejects.toThrow('tools');
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe('Perplexity Agent HTTP adapter', () => {
	it('joins Agent URLs with and without trailing slashes', () => {
		expect(getPerplexityAgentURL('https://api.perplexity.ai')).toBe(
			'https://api.perplexity.ai/v1/agent'
		);
		expect(getPerplexityAgentURL('https://api.perplexity.ai/')).toBe(
			'https://api.perplexity.ai/v1/agent'
		);
	});

	it('sends the exact method, URL, headers, preset, and request fields', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify(completedResponse), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);

		await callPerplexityAgent(
			{
				pipe: scaffoldPipe(),
				messages,
				llmApiKey: 'test-key',
				stream: false
			},
			{
				baseURL: 'https://api.perplexity.ai/',
				fetcher: fetcher as typeof fetch
			}
		);

		expect(fetcher).toHaveBeenCalledOnce();
		const [url, init] = fetcher.mock.calls[0] as unknown as [
			string,
			NonNullable<Parameters<typeof fetch>[1]>
		];
		expect(url).toBe('https://api.perplexity.ai/v1/agent');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({
			Authorization: 'Bearer test-key',
			'content-type': 'application/json',
			accept: 'application/json'
		});
		expect(JSON.parse(init.body as string)).toEqual({
			preset: 'fast',
			input: [
				{ type: 'message', role: 'system', content: 'Be concise.' },
				{
					type: 'message',
					role: 'user',
					content: 'What changed?'
				},
				{
					type: 'message',
					role: 'assistant',
					content: 'I will check.'
				}
			],
			max_output_tokens: 1000,
			stream: false,
			temperature: 0.7,
			top_p: 1
		});
	});

	it('uses only safe Agent error fields', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: 'Preset is invalid',
							type: 'invalid_request',
							private_prompt: 'must not be included'
						}
					}),
					{ status: 400 }
				)
		);

		await expect(
			callPerplexityAgent(
				{
					pipe: scaffoldPipe(),
					messages,
					llmApiKey: 'test-key',
					stream: false
				},
				{ fetcher: fetcher as typeof fetch }
			)
		).rejects.toThrow('Preset is invalid');
	});
});

describe('Perplexity Agent response adapter', () => {
	it('maps the complete BaseAI response envelope and citations', () => {
		expect(
			transformPerplexityAgentResponse(
				completedResponse,
				'perplexity:fast'
			)
		).toEqual({
			id: 'resp_agent_123',
			object: 'chat.completion',
			created: 1787928000,
			model: 'perplexity:fast',
			provider: 'Perplexity',
			choices: [
				{
					message: {
						role: 'assistant',
						content: 'Alpha[1] Beta [web:2].',
						citationMetadata: {
							citationSources: [
								{
									startIndex: 0,
									endIndex: 5,
									uri: 'https://example.com/direct'
								},
								{
									startIndex: 5,
									endIndex: 8,
									uri: 'https://example.com/one'
								},
								{
									startIndex: 14,
									endIndex: 21,
									uri: 'https://example.com/two'
								}
							]
						}
					},
					index: 0,
					logprobs: null,
					finish_reason: 'stop'
				}
			],
			usage: {
				prompt_tokens: 12,
				completion_tokens: 8,
				total_tokens: 20
			}
		});
	});

	it('uses a frozen zero-usage rule when Agent usage is absent', () => {
		const response = { ...completedResponse, usage: undefined };
		expect(
			transformPerplexityAgentResponse(response, 'perplexity:low').usage
		).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0
		});
	});

	it('maps documented token exhaustion to length', () => {
		const response: PerplexityAgentResponse = {
			...completedResponse,
			status: 'incomplete',
			incomplete_details: { reason: 'max_output_tokens' }
		};
		expect(
			transformPerplexityAgentResponse(response, 'perplexity:medium')
				.choices[0].finish_reason
		).toBe('length');
	});

	it('rejects undocumented incomplete reasons', () => {
		expect(() =>
			transformPerplexityAgentResponse(
				{
					...completedResponse,
					status: 'incomplete',
					incomplete_details: { reason: 'max_tokens' }
				},
				'perplexity:medium'
			)
		).toThrow();
	});

	it.each([
		['incomplete', undefined],
		['failed', { message: 'upstream failed' }],
		['cancelled', undefined],
		['in_progress', undefined]
	])('rejects %s responses outside token exhaustion', (status, error) => {
		expect(() =>
			transformPerplexityAgentResponse(
				{ ...completedResponse, status, error },
				'perplexity:high'
			)
		).toThrow();
	});

	it('rejects malformed and empty completed responses', () => {
		expect(() =>
			transformPerplexityAgentResponse(
				{ ...completedResponse, id: undefined },
				'perplexity:fast'
			)
		).toThrow('missing identity');
		expect(() =>
			transformPerplexityAgentResponse(
				{ ...completedResponse, output: [] },
				'perplexity:fast'
			)
		).toThrow('empty completed output');
	});
});
