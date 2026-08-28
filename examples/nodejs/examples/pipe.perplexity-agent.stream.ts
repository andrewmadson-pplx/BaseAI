import 'dotenv/config';
import {getRunner, Pipe} from '@baseai/core';
import perplexityAgentPipe from '../baseai/pipes/perplexity-agent';

const pipe = new Pipe(perplexityAgentPipe());

async function main() {
	const {stream} = await pipe.run({
		messages: [
			{
				role: 'user',
				content:
					'What changed in the latest JavaScript language release?',
			},
		],
		stream: true,
	});

	const runner = getRunner(stream);
	runner.on('content', content => process.stdout.write(content));
	runner.on('end', () => process.stdout.write('\n'));
	runner.on('error', error => console.error(error));
}

main();
