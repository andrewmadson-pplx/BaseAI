import { dlog } from '../utils/dlog';
import transformToProviderRequest from '../utils/provider-handlers/transfrom-to-provider-request';
import { handleProviderRequest } from '../utils/provider-handlers/provider-request-handler';

import { PERPLEXITY } from '../data/models';
import {
	callPerplexityAgent,
	getPerplexityTransport
} from '../providers/perplexity/agentResponse';
import { handleLlmError } from './utils';
import { ApiError } from '../hono/errors';
import type { Message, Pipe } from 'types/pipe';
import type { ModelParams } from 'types/providers';
import type { PipeTool } from 'types/tools';

export async function callPerplexity({
	pipe,
	messages,
	llmApiKey,
	stream,
	paramsTools
}: {
	pipe: Pipe;
	llmApiKey: string;
	stream: boolean;
	messages: Message[];
	paramsTools?: PipeTool[];
}) {
	if (getPerplexityTransport(pipe.model) === 'agentResponse') {
		return await callPerplexityAgent({
			pipe,
			messages,
			llmApiKey,
			stream,
			paramsTools
		});
	}

	try {
		const modelParams = buildModelParams(pipe, stream, messages);

		// Transform params according to provider's format
		const transformedRequestParams = transformToProviderRequest({
			provider: PERPLEXITY,
			params: modelParams,
			fn: 'chatComplete'
		});
		dlog('Perplexity request params', transformedRequestParams);

		const providerOptions = { provider: PERPLEXITY, llmApiKey };
		return await handleProviderRequest({
			providerOptions,
			inputParams: modelParams,
			endpoint: 'chatComplete',
			transformedRequestParams
		});
	} catch (error: any) {
		if (error instanceof ApiError) throw error;
		handleLlmError({ error, provider: PERPLEXITY });
	}
}

function buildModelParams(
	pipe: Pipe,
	stream: boolean,
	messages: Message[]
): ModelParams {
	const model = pipe.model.split(':')[1];
	const {
		top_p,
		max_tokens,
		temperature,
		presence_penalty,
		frequency_penalty,
		stop
	} = pipe;
	return {
		messages,
		stream,
		model,
		top_p,
		max_tokens,
		temperature,
		presence_penalty,
		frequency_penalty,
		stop
	};
}
