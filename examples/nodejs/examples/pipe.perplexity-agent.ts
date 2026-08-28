import 'dotenv/config';
import {Pipe} from '@baseai/core';
import perplexityAgentPipe from '../baseai/pipes/perplexity-agent';

const pipe = new Pipe(perplexityAgentPipe());

async function main() {
	const response = await pipe.run({
		messages: [
			{
				role: 'user',
				content:
					'What changed in the latest JavaScript language release?',
			},
		],
	});

	console.log(response.completion);
	console.log(response.choices[0]?.message.citationMetadata);
}

main();
