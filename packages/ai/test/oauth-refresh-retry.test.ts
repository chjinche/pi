import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { OAuthAuth } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import { createFauxCore, fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Context } from "../src/types.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";

describe("OAuth refresh retry", () => {
	it("preserves a safe retry signal from a wrapped refresh failure", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("test-oauth", async () => ({
			type: "oauth",
			access: "expired",
			refresh: "refresh-token",
			expires: 0,
		}));

		let refreshes = 0;
		const oauth: OAuthAuth = {
			name: "Test OAuth",
			login: async () => {
				throw new Error("not used");
			},
			refresh: async (credential) => {
				refreshes++;
				if (refreshes === 1) {
					throw new Error("502 : <!DOCTYPE html><html>gateway error</html>");
				}
				return { ...credential, access: "refreshed", expires: Date.now() + 60_000 };
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const faux = createFauxCore({ provider: "test-oauth" });
		faux.setResponses([fauxAssistantMessage("recovered")]);
		const provider = createProvider({
			id: "test-oauth",
			auth: { oauth },
			models: faux.models,
			api: { stream: faux.stream, streamSimple: faux.streamSimple },
		});
		const models = createModels({ credentials });
		models.setProvider(provider);
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const onRetryScheduled = vi.fn();

		const result = await retryAssistantCall(
			() => models.completeSimple(faux.getModel(), context),
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			undefined,
			{ onRetryScheduled },
		);

		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(refreshes).toBe(2);
		expect(onRetryScheduled).toHaveBeenCalledWith(1, 1, 0, "OAuth refresh failed for test-oauth: 502");
		expect(onRetryScheduled.mock.calls[0]?.[3]).not.toContain("DOCTYPE");
	});
});
