import { PERPLEXITY } from '@/dev/data/models';
import { ApiError } from '@/dev/hono/errors';
import { Stream } from '@/dev/utils/stream/stream';
import type { Pipe } from 'types/pipe';
import type {
	ChatCompletionResponse,
	CitationSource,
	ContentType,
	ProviderMessage
} from 'types/providers';
import type { PipeTool } from 'types/tools';
import PerplexityAIApiConfig from './api';

export const PERPLEXITY_AGENT_PRESETS = [
	'fast',
	'low',
	'medium',
	'high'
] as const;

export type PerplexityAgentPreset = (typeof PERPLEXITY_AGENT_PRESETS)[number];

type AgentInputContentPart =
	| { type: 'input_text'; text: string }
	| { type: 'input_image'; image_url: string };

interface AgentInputMessage {
	type: 'message';
	role: 'system' | 'user' | 'assistant';
	content: string | AgentInputContentPart[];
}

export interface PerplexityAgentRequest {
	input: AgentInputMessage[];
	max_output_tokens: number;
	preset: PerplexityAgentPreset;
	stream: boolean;
	temperature: number;
	top_p: number;
}

interface AgentAnnotation {
	end_index?: number;
	id?: number | string;
	search_result_id?: number | string;
	source_id?: number | string;
	start_index?: number;
	type?: string;
	uri?: string;
	url?: string;
}

interface AgentOutputText {
	annotations?: AgentAnnotation[];
	text: string;
	type: 'output_text';
}

interface AgentMessageOutput {
	content: AgentOutputText[];
	id: string;
	role: 'assistant';
	status: string;
	type: 'message';
}

interface AgentSearchResult {
	id: number | string;
	url: string;
}

interface AgentSearchResultsOutput {
	results: AgentSearchResult[];
	type: 'search_results';
}

type AgentOutputItem =
	| AgentMessageOutput
	| AgentSearchResultsOutput
	| { type: string; [key: string]: unknown };

interface AgentUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

interface AgentErrorInfo {
	code?: string;
	message?: string;
	type?: string;
}

export interface PerplexityAgentResponse {
	created_at?: number;
	error?: AgentErrorInfo | null;
	id?: string;
	incomplete_details?: {
		reason?: string;
	} | null;
	model?: string;
	object?: string;
	output?: AgentOutputItem[];
	status?: string;
	usage?: AgentUsage;
}

interface AgentStreamEvent {
	content_index?: number;
	delta?: string;
	error?: AgentErrorInfo;
	event?: string;
	item_id?: string;
	output_index?: number;
	response?: PerplexityAgentResponse;
	sequence_number?: number;
	type?: string;
	data?: AgentStreamEvent;
}

interface AgentCallOptions {
	baseURL?: string;
	fetcher?: typeof fetch;
}

const AGENT_OBJECT = 'chat.completion';
const AGENT_STREAM_OBJECT = 'chat.completion.chunk';

export function isPerplexityAgentModel(model: string): boolean {
	const preset = model.startsWith('perplexity:')
		? model.slice('perplexity:'.length)
		: model;
	return PERPLEXITY_AGENT_PRESETS.includes(preset as PerplexityAgentPreset);
}

export function getPerplexityTransport(
	model: string
): 'agentResponse' | 'chatComplete' {
	return isPerplexityAgentModel(model) ? 'agentResponse' : 'chatComplete';
}

function getAgentPreset(model: string): PerplexityAgentPreset {
	const preset = model.startsWith('perplexity:')
		? model.slice('perplexity:'.length)
		: model;
	if (!isPerplexityAgentModel(preset)) {
		throw new ApiError({
			code: 'BAD_REQUEST',
			message: `Unsupported Perplexity Agent preset: ${model}`
		});
	}
	return preset as PerplexityAgentPreset;
}

function unsupportedField(field: string, detail: string): never {
	throw new ApiError({
		code: 'BAD_REQUEST',
		message: `Perplexity Agent API field "${field}" is unsupported: ${detail}`
	});
}

function validateAgentPipeFields(
	pipe: Pipe,
	paramsTools: PipeTool[] | undefined
) {
	if (pipe.presence_penalty !== 1) {
		unsupportedField(
			'presence_penalty',
			'only the BaseAI scaffold default of 1 can be omitted'
		);
	}
	if (pipe.frequency_penalty !== 1) {
		unsupportedField(
			'frequency_penalty',
			'only the BaseAI scaffold default of 1 can be omitted'
		);
	}
	if (pipe.stop.length > 0) {
		unsupportedField('stop', 'non-empty stop sequences are not supported');
	}
	if (pipe.json) {
		unsupportedField('json', 'structured output is outside this release');
	}

	const hasPipeTools = pipe.tools.length > 0;
	const hasParamTools = Boolean(paramsTools?.length);
	if (hasPipeTools || hasParamTools) {
		unsupportedField(
			'tools',
			'custom tools cannot preserve Agent thought signatures yet'
		);
	}
	if (pipe.tool_choice !== 'auto') {
		unsupportedField(
			'tool_choice',
			'only the BaseAI scaffold default of "auto" can be omitted'
		);
	}
	if (pipe.parallel_tool_calls !== true) {
		unsupportedField(
			'parallel_tool_calls',
			'only the BaseAI scaffold default of true can be omitted'
		);
	}
	if (pipe.max_tokens < 1) {
		unsupportedField('max_tokens', 'the value must be at least 1');
	}
}

function convertContentPart(
	part: ContentType,
	messageIndex: number,
	partIndex: number
): AgentInputContentPart {
	const path = `messages[${messageIndex}].content[${partIndex}]`;
	if (part.type === 'text' || part.type === 'input_text') {
		if (typeof part.text !== 'string') {
			unsupportedField(`${path}.text`, 'text content must be a string');
		}
		return { type: 'input_text', text: part.text };
	}

	if (part.type === 'image_url' || part.type === 'input_image') {
		const image = part.image_url as { url?: string } | string | undefined;
		const imageURL = typeof image === 'string' ? image : image?.url;
		if (!imageURL) {
			unsupportedField(
				`${path}.image_url`,
				'an HTTPS URL or data URI is required'
			);
		}
		return { type: 'input_image', image_url: imageURL };
	}

	unsupportedField(`${path}.type`, `content type "${part.type}"`);
}

function convertMessage(
	message: ProviderMessage,
	messageIndex: number
): AgentInputMessage {
	const path = `messages[${messageIndex}]`;
	if (!['system', 'user', 'assistant'].includes(message.role)) {
		unsupportedField(
			`${path}.role`,
			`role "${message.role}" cannot be replayed`
		);
	}
	if (message.function_call !== undefined) {
		unsupportedField(
			`${path}.function_call`,
			'function history is unsupported'
		);
	}
	if (message.tool_calls !== undefined) {
		unsupportedField(
			`${path}.tool_calls`,
			'tool-call history is unsupported'
		);
	}
	if (message.tool_call_id !== undefined) {
		unsupportedField(`${path}.tool_call_id`, 'tool history is unsupported');
	}
	if (message.name !== undefined) {
		unsupportedField(`${path}.name`, 'named messages are unsupported');
	}
	if (message.content === null || message.content === undefined) {
		unsupportedField(`${path}.content`, 'message content is required');
	}

	const content = Array.isArray(message.content)
		? message.content.map((part, partIndex) =>
				convertContentPart(part, messageIndex, partIndex)
			)
		: message.content;

	return {
		type: 'message',
		role: message.role as AgentInputMessage['role'],
		content
	};
}

export function buildPerplexityAgentRequest({
	pipe,
	messages,
	stream,
	paramsTools
}: {
	pipe: Pipe;
	messages: ProviderMessage[];
	stream: boolean;
	paramsTools?: PipeTool[];
}): PerplexityAgentRequest {
	validateAgentPipeFields(pipe, paramsTools);

	return {
		preset: getAgentPreset(pipe.model),
		input: messages.map(convertMessage),
		max_output_tokens: pipe.max_tokens,
		stream,
		temperature: pipe.temperature,
		top_p: pipe.top_p
	};
}

export function getPerplexityAgentURL(
	baseURL: string,
	endpoint = PerplexityAIApiConfig.agentResponse || '/v1/agent'
): string {
	return `${baseURL.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

function getSearchResultURLs(output: AgentOutputItem[]): Map<string, string> {
	const urls = new Map<string, string>();
	for (const item of output) {
		if (item.type !== 'search_results') continue;
		for (const result of (item as AgentSearchResultsOutput).results || []) {
			if (result.url) urls.set(String(result.id), result.url);
		}
	}
	return urls;
}

function citationIdFromMarker(marker: string): string | undefined {
	return marker.match(/^\[(?:web:)?(\d+)\]$/i)?.[1];
}

function extractTextAndCitations(output: AgentOutputItem[]): {
	text: string;
	citations: CitationSource[];
} {
	const searchResultURLs = getSearchResultURLs(output);
	const textParts: string[] = [];
	const citations: CitationSource[] = [];
	const seenCitations = new Set<string>();
	let textOffset = 0;

	const addCitation = (citation: CitationSource) => {
		const key = `${citation.startIndex ?? ''}:${citation.endIndex ?? ''}:${citation.uri ?? ''}`;
		if (seenCitations.has(key)) return;
		seenCitations.add(key);
		citations.push(citation);
	};

	for (const item of output) {
		if (item.type !== 'message') continue;
		const message = item as AgentMessageOutput;
		if (message.role !== 'assistant') {
			throw new Error(
				'Invalid Perplexity Agent response: non-assistant output'
			);
		}

		for (const part of message.content || []) {
			if (part.type !== 'output_text' || typeof part.text !== 'string') {
				throw new Error(
					'Invalid Perplexity Agent response: malformed output text'
				);
			}
			textParts.push(part.text);

			for (const annotation of part.annotations || []) {
				const start = annotation.start_index;
				const end = annotation.end_index;
				const marker =
					typeof start === 'number' && typeof end === 'number'
						? part.text.slice(start, end)
						: '';
				const resultId =
					annotation.search_result_id ??
					annotation.source_id ??
					annotation.id ??
					citationIdFromMarker(marker);
				const uri =
					annotation.url ??
					annotation.uri ??
					(resultId === undefined
						? undefined
						: searchResultURLs.get(String(resultId)));

				if (!uri) continue;
				addCitation({
					startIndex:
						typeof start === 'number'
							? textOffset + start
							: undefined,
					endIndex:
						typeof end === 'number' ? textOffset + end : undefined,
					uri
				});
			}

			const markerPattern = /\[(?:web:)?(\d+)\]/gi;
			for (const marker of part.text.matchAll(markerPattern)) {
				const uri = searchResultURLs.get(marker[1]);
				if (!uri || marker.index === undefined) continue;
				addCitation({
					startIndex: textOffset + marker.index,
					endIndex: textOffset + marker.index + marker[0].length,
					uri
				});
			}

			textOffset += part.text.length;
		}
	}

	return { text: textParts.join(''), citations };
}

function responseFailureMessage(response: PerplexityAgentResponse): string {
	return (
		response.error?.message ||
		`Perplexity Agent response ended with status "${response.status || 'unknown'}"`
	);
}

export function transformPerplexityAgentResponse(
	response: PerplexityAgentResponse,
	requestedModel: string
): ChatCompletionResponse & { provider: string } {
	const status = response.status;
	const isTokenLimit =
		status === 'incomplete' &&
		response.incomplete_details?.reason === 'max_output_tokens';
	if (status !== 'completed' && !isTokenLimit) {
		throw new Error(responseFailureMessage(response));
	}
	if (!response.id || typeof response.created_at !== 'number') {
		throw new Error('Invalid Perplexity Agent response: missing identity');
	}
	if (!Array.isArray(response.output)) {
		throw new Error('Invalid Perplexity Agent response: missing output');
	}

	const { text, citations } = extractTextAndCitations(response.output);
	if (!text) {
		throw new Error(
			'Invalid Perplexity Agent response: empty completed output'
		);
	}

	const inputTokens = response.usage?.input_tokens ?? 0;
	const outputTokens = response.usage?.output_tokens ?? 0;
	const totalTokens =
		response.usage?.total_tokens ?? inputTokens + outputTokens;

	return {
		id: response.id,
		object: AGENT_OBJECT,
		created: response.created_at,
		model: requestedModel,
		provider: PERPLEXITY,
		choices: [
			{
				message: {
					role: 'assistant',
					content: text,
					...(citations.length > 0 && {
						citationMetadata: { citationSources: citations }
					})
				},
				index: 0,
				logprobs: null,
				finish_reason: isTokenLimit ? 'length' : 'stop'
			}
		],
		usage: {
			prompt_tokens: inputTokens,
			completion_tokens: outputTokens,
			total_tokens: totalTokens
		}
	};
}

function normalizeStreamEvent(event: AgentStreamEvent): AgentStreamEvent {
	if (event.event && event.data) {
		return {
			...event.data,
			type: event.data.type || event.event
		};
	}
	return event;
}

function streamError(event: AgentStreamEvent): Error {
	const message =
		event.error?.message ||
		event.response?.error?.message ||
		`Perplexity Agent stream ended with event "${event.type || 'unknown'}"`;
	return new Error(message);
}

function makeStreamChunk({
	id,
	created,
	model,
	delta,
	finishReason
}: {
	id: string;
	created: number;
	model: string;
	delta: Record<string, string>;
	finishReason: string | null;
}) {
	return `data: ${JSON.stringify({
		id,
		object: AGENT_STREAM_OBJECT,
		created,
		model,
		provider: PERPLEXITY,
		choices: [
			{
				delta,
				index: 0,
				finish_reason: finishReason
			}
		]
	})}\n\n`;
}

export function transformPerplexityAgentStream(
	response: Response,
	requestedModel: string,
	abortController = new AbortController()
): ReadableStream<Uint8Array> {
	const events = Stream.fromSSEResponse<AgentStreamEvent>(
		response,
		abortController
	);
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let responseId: string | undefined;
			let createdAt: number | undefined;
			let lastSequence = -1;
			let terminalSeen = false;
			let roleEmitted = false;
			let textSeen = false;
			let lastOutputIndex = -1;
			let lastContentIndex = -1;
			const itemByPosition = new Map<string, string>();

			try {
				for await (const rawEvent of events) {
					if (
						!rawEvent ||
						typeof rawEvent !== 'object' ||
						Array.isArray(rawEvent)
					) {
						throw new Error(
							'Perplexity Agent stream event is malformed'
						);
					}
					const event = normalizeStreamEvent(rawEvent);
					if (typeof event.type !== 'string') {
						throw new Error(
							'Perplexity Agent stream event is malformed'
						);
					}
					if (terminalSeen) {
						throw new Error(
							'Perplexity Agent stream emitted data after a terminal event'
						);
					}

					if (typeof event.sequence_number === 'number') {
						if (event.sequence_number <= lastSequence) {
							throw new Error(
								'Perplexity Agent stream sequence is duplicate or out of order'
							);
						}
						lastSequence = event.sequence_number;
					}

					if (
						event.type === 'response.created' ||
						event.type === 'response.in_progress'
					) {
						const id = event.response?.id;
						const created = event.response?.created_at;
						if (!id || typeof created !== 'number') {
							throw new Error(
								'Perplexity Agent stream identity event is malformed'
							);
						}
						if (responseId && responseId !== id) {
							throw new Error(
								'Perplexity Agent stream response identity changed'
							);
						}
						if (createdAt !== undefined && createdAt !== created) {
							throw new Error(
								'Perplexity Agent stream response identity changed'
							);
						}
						responseId = id;
						createdAt = created;
						continue;
					}

					if (event.type === 'response.output_text.delta') {
						if (!responseId || createdAt === undefined) {
							throw new Error(
								'Perplexity Agent stream emitted text before identity'
							);
						}
						if (
							typeof event.delta !== 'string' ||
							typeof event.item_id !== 'string' ||
							typeof event.output_index !== 'number' ||
							typeof event.content_index !== 'number'
						) {
							throw new Error(
								'Perplexity Agent stream text delta is malformed'
							);
						}

						const isEarlierPosition =
							event.output_index < lastOutputIndex ||
							(event.output_index === lastOutputIndex &&
								event.content_index < lastContentIndex);
						if (isEarlierPosition) {
							throw new Error(
								'Perplexity Agent stream text indexes are out of order'
							);
						}

						const position = `${event.output_index}:${event.content_index}`;
						const knownItem = itemByPosition.get(position);
						if (knownItem && knownItem !== event.item_id) {
							throw new Error(
								'Perplexity Agent stream item identity changed'
							);
						}
						itemByPosition.set(position, event.item_id);
						lastOutputIndex = event.output_index;
						lastContentIndex = event.content_index;

						if (!roleEmitted) {
							controller.enqueue(
								encoder.encode(
									makeStreamChunk({
										id: responseId,
										created: createdAt,
										model: requestedModel,
										delta: {
											role: 'assistant',
											content: ''
										},
										finishReason: null
									})
								)
							);
							roleEmitted = true;
						}

						controller.enqueue(
							encoder.encode(
								makeStreamChunk({
									id: responseId,
									created: createdAt,
									model: requestedModel,
									delta: { content: event.delta },
									finishReason: null
								})
							)
						);
						textSeen ||= event.delta.length > 0;
						continue;
					}

					if (
						event.type === 'response.failed' ||
						event.type === 'response.incomplete' ||
						event.type === 'response.cancelled'
					) {
						terminalSeen = true;
						throw streamError(event);
					}

					if (event.type === 'response.completed') {
						terminalSeen = true;
						if (
							event.response?.status !== 'completed' ||
							!responseId ||
							createdAt === undefined ||
							event.response.id !== responseId ||
							event.response.created_at !== createdAt
						) {
							throw new Error(
								'Perplexity Agent stream completion event is malformed'
							);
						}
						continue;
					}
				}

				if (abortController.signal.aborted) return;
				if (!terminalSeen) {
					throw new Error(
						'Perplexity Agent stream ended before response.completed'
					);
				}
				if (!textSeen || !responseId || createdAt === undefined) {
					throw new Error(
						'Perplexity Agent stream completed without output text'
					);
				}

				controller.enqueue(
					encoder.encode(
						makeStreamChunk({
							id: responseId,
							created: createdAt,
							model: requestedModel,
							delta: {},
							finishReason: 'stop'
						})
					)
				);
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			} catch (error) {
				controller.error(
					error instanceof Error
						? error
						: new Error('Perplexity Agent stream failed')
				);
			}
		},
		cancel() {
			abortController.abort();
		}
	});
}

async function getSafeAgentError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: AgentErrorInfo };
		return body.error?.message || `HTTP ${response.status}`;
	} catch {
		return `HTTP ${response.status}`;
	}
}

export async function callPerplexityAgent(
	{
		pipe,
		messages,
		llmApiKey,
		stream,
		paramsTools
	}: {
		pipe: Pipe;
		messages: ProviderMessage[];
		llmApiKey: string;
		stream: boolean;
		paramsTools?: PipeTool[];
	},
	options: AgentCallOptions = {}
) {
	const request = buildPerplexityAgentRequest({
		pipe,
		messages,
		stream,
		paramsTools
	});
	const baseURL =
		options.baseURL ||
		PerplexityAIApiConfig.baseURL ||
		'https://api.perplexity.ai';
	const url = getPerplexityAgentURL(baseURL);
	const abortController = new AbortController();
	const fetcher = options.fetcher || fetch;
	const response = await fetcher(url, {
		method: 'POST',
		headers: PerplexityAIApiConfig.headers(llmApiKey),
		body: JSON.stringify(request),
		signal: abortController.signal
	});

	if (!response.ok) {
		throw new ApiError({
			code: 'BAD_REQUEST',
			message: await getSafeAgentError(response)
		});
	}

	if (stream) {
		return transformPerplexityAgentStream(
			response,
			pipe.model,
			abortController
		);
	}

	let body: PerplexityAgentResponse;
	try {
		body = (await response.json()) as PerplexityAgentResponse;
	} catch {
		throw new Error('Invalid Perplexity Agent response: malformed JSON');
	}
	return transformPerplexityAgentResponse(body, pipe.model);
}
