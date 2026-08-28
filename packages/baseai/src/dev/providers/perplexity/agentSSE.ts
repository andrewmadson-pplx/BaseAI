interface SSEMessage {
	event: string | null;
	data: string;
}

function findEventBoundary(
	buffer: string
): { index: number; length: number } | null {
	const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
	return match ? { index: match.index, length: match[0].length } : null;
}

function parseSSEMessage(block: string): SSEMessage | null {
	let event: string | null = null;
	const data: string[] = [];

	for (const line of block.split(/\r\n|\n|\r/)) {
		if (!line || line.startsWith(':')) continue;
		const separator = line.indexOf(':');
		const field = separator === -1 ? line : line.slice(0, separator);
		const value =
			separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');

		if (field === 'event') event = value;
		if (field === 'data') data.push(value);
	}

	return data.length ? { event, data: data.join('\n') } : null;
}

function parseAgentEvent<T>(message: SSEMessage): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(message.data);
	} catch {
		throw new Error('Could not parse Perplexity Agent SSE message as JSON');
	}

	if (
		message.event &&
		parsed &&
		typeof parsed === 'object' &&
		!Array.isArray(parsed) &&
		!('type' in parsed)
	) {
		return { ...parsed, type: message.event } as T;
	}
	return parsed as T;
}

export async function* iterateAgentSSE<T>(
	response: Response,
	abortController: AbortController
): AsyncGenerator<T, void, unknown> {
	if (!response.body) {
		throw new Error('Perplexity Agent stream response has no body');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let doneMarkerSeen = false;
	const cancelReader = () => {
		void reader.cancel().catch(() => undefined);
	};
	abortController.signal.addEventListener('abort', cancelReader, {
		once: true
	});

	const consumeBlock = (block: string): T | undefined => {
		const message = parseSSEMessage(block);
		if (!message) return;
		if (doneMarkerSeen) {
			throw new Error(
				'Perplexity Agent stream emitted data after the [DONE] marker'
			);
		}
		if (message.data.trim() === '[DONE]') {
			doneMarkerSeen = true;
			return;
		}
		return parseAgentEvent<T>(message);
	};

	try {
		while (!abortController.signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let boundary = findEventBoundary(buffer);
			while (boundary) {
				const block = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				const event = consumeBlock(block);
				if (event !== undefined) yield event;
				boundary = findEventBoundary(buffer);
			}
		}

		buffer += decoder.decode();
		if (buffer.trim()) {
			const event = consumeBlock(buffer);
			if (event !== undefined) yield event;
		}
	} finally {
		abortController.signal.removeEventListener('abort', cancelReader);
		reader.releaseLock();
	}
}
