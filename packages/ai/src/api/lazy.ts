import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

const MAX_SETUP_ERROR_CAUSE_DEPTH = 8;
const MAX_SETUP_ERROR_CAUSE_SUMMARY_CHARS = 200;

function formatSetupError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);

	const parts = [error.message || error.name];
	const seen = new Set<Error>([error]);
	let current = error.cause;
	let depth = 0;
	while (current instanceof Error && !seen.has(current) && depth < MAX_SETUP_ERROR_CAUSE_DEPTH) {
		seen.add(current);
		depth++;
		const firstLine = current.message.split(/\r?\n/, 1)[0]?.trim() ?? "";
		const htmlBodyStart = firstLine.search(/<(?:!doctype|html)\b/i);
		const summary = (htmlBodyStart >= 0 ? firstLine.slice(0, htmlBodyStart).replace(/[:\s]+$/, "") : firstLine)
			.trim()
			.slice(0, MAX_SETUP_ERROR_CAUSE_SUMMARY_CHARS);
		if (summary && summary !== parts.at(-1)) parts.push(summary);
		current = current.cause;
	}
	return parts.join(": ");
}

function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: formatSetupError(error),
		timestamp: Date.now(),
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	setup()
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};
}
