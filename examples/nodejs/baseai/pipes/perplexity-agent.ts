import {PipeI} from '@baseai/core';

const perplexityAgentPipe = (): PipeI => ({
	apiKey: process.env.LANGBASE_API_KEY!,
	name: 'perplexity-agent',
	description: 'Research with a Perplexity Agent API preset.',
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
	messages: [
		{
			role: 'system',
			content: 'Answer concisely and cite sources for factual claims.',
		},
	],
	variables: [],
	memory: [],
	tools: [],
});

export default perplexityAgentPipe;
