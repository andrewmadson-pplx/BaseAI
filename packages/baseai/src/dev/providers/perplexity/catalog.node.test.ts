import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	PERPLEXITY as cliPerplexity,
	modelsByProvider as cliModels
} from '@/data/models';
import {
	PERPLEXITY as devPerplexity,
	modelsByProvider as devModels
} from '@/dev/data/models';
import {
	PERPLEXITY as corePerplexity,
	modelsByProvider as coreModels
} from '../../../../../core/src/data/models';

const expectedIds = [
	'fast',
	'low',
	'medium',
	'high',
	'llama-3.1-sonar-huge-128k-online',
	'llama-3.1-sonar-large-128k-online',
	'llama-3.1-sonar-small-128k-online',
	'llama-3.1-sonar-large-128k-chat',
	'llama-3.1-sonar-small-128k-chat'
];

describe('Perplexity model catalogs', () => {
	it('keeps all three catalog copies in parity', () => {
		const catalogs = [
			cliModels[cliPerplexity],
			devModels[devPerplexity],
			coreModels[corePerplexity]
		];
		for (const catalog of catalogs) {
			expect(catalog.map(model => model.id)).toEqual(expectedIds);
		}
	});

	it('represents dynamic Agent preset pricing explicitly', () => {
		for (const catalog of [
			cliModels[cliPerplexity],
			devModels[devPerplexity],
			coreModels[corePerplexity]
		]) {
			for (const model of catalog.slice(0, 4)) {
				expect(model).toMatchObject({
					promptCost: null,
					completionCost: null,
					requestCost: null
				});
			}
		}
	});

	it('leaves the global Pipe scaffold default unchanged', async () => {
		const file = fileURLToPath(
			new URL('../../../pipe/index.ts', import.meta.url)
		);
		const source = await readFile(file, 'utf8');
		expect(source).toContain("model: 'openai:gpt-4o-mini'");
		expect(source).not.toContain("model: 'perplexity:fast'");
	});
});
