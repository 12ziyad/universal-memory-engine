/** Bounded, credential-safe MCP lifecycle probe used only by a trusted hook. */

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUIRED_TOOLS = ["save_memory", "save_conversation", "recall_memory"];

class ProbeError extends Error {
	constructor(code, httpStatus = null) {
		super(code);
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

async function cancelResponse(response) {
	try { await response?.body?.cancel(); } catch {}
}

async function boundedText(response) {
	const announced = Number(response.headers.get("content-length"));
	if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
		await response.body?.cancel().catch(() => {});
		throw new ProbeError("protocol_error");
	}
	if (!response.body?.getReader) {
		await cancelResponse(response);
		throw new ProbeError("protocol_error");
	}
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				throw new ProbeError("protocol_error");
			}
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		try { await reader.cancel(); } catch {}
		if (error instanceof ProbeError) throw error;
		throw new ProbeError("network_error");
	} finally {
		try { reader.releaseLock(); } catch {}
	}
	return Buffer.concat(chunks, bytes).toString("utf8");
}

function parseJson(text) {
	try { return JSON.parse(text); }
	catch { throw new ProbeError("protocol_error"); }
}

function validJsonRpcMessage(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") return false;
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (Object.hasOwn(value, "method")) {
		return typeof value.method === "string" && value.method.length > 0 && !hasResult && !hasError;
	}
	return Object.hasOwn(value, "id") && hasResult !== hasError;
}

function responseMessages(text, contentType) {
	const mediaType = String(contentType).split(";", 1)[0].trim().toLowerCase();
	if (mediaType === "application/json") {
		const value = parseJson(text);
		if (!validJsonRpcMessage(value)) throw new ProbeError("protocol_error");
		return [value];
	}
	if (mediaType !== "text/event-stream") throw new ProbeError("protocol_error");
	const values = [];
	for (const event of String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/)) {
		const data = event.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data) {
			const value = parseJson(data);
			if (!validJsonRpcMessage(value)) throw new ProbeError("protocol_error");
			values.push(value);
		}
	}
	if (!values.length) throw new ProbeError("protocol_error");
	return values;
}

function correlated(messages, id) {
	const matches = messages.filter((message) => message?.jsonrpc === "2.0" && message?.id === id);
	if (matches.length !== 1 || Object.hasOwn(matches[0], "error") || !Object.hasOwn(matches[0], "result")) {
		throw new ProbeError("protocol_error");
	}
	return matches[0].result;
}

function validHeaderValue(value, max = 1024) {
	return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

async function send(fetchFn, baseUrl, apiKey, body, {
	id = null, sessionId = null, initialized = false, notification = false, timeoutMs,
} = {}) {
	let response;
	try {
		response = await fetchFn(`${baseUrl}/mcp`, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
				...(initialized ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } : {}),
			},
			body: JSON.stringify(body),
		});
	} catch {
		throw new ProbeError("network_error");
	}
	if (response.status === 401 || response.status === 403) {
		await cancelResponse(response);
		throw new ProbeError("credential_rejected", response.status);
	}
	if (notification) {
		if (response.status !== 202) {
			await cancelResponse(response);
			throw new ProbeError("protocol_error", response.status);
		}
		const text = response.body ? await boundedText(response) : "";
		if (text.length !== 0) throw new ProbeError("protocol_error", response.status);
		return { response, result: null };
	}
	if (!response.ok) {
		await cancelResponse(response);
		throw new ProbeError("protocol_error", response.status);
	}
	const text = await boundedText(response);
	return {
		response,
		result: correlated(responseMessages(text, response.headers.get("content-type") || ""), id),
	};
}

export async function probeMcp({ apiKey, baseUrl, fetchFn = fetch, timeoutMs = 1_500 } = {}) {
	let sessionId = null;
	try {
		const initialized = await send(fetchFn, baseUrl, apiKey, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "itsuki-hook-doctor", version: "1" },
			},
		}, { id: 1, timeoutMs });
		const toolsCapability = initialized.result?.capabilities?.tools;
		if (initialized.result?.protocolVersion !== MCP_PROTOCOL_VERSION
			|| typeof initialized.result?.serverInfo?.name !== "string"
			|| typeof initialized.result?.serverInfo?.version !== "string"
			|| !toolsCapability
			|| typeof toolsCapability !== "object"
			|| Array.isArray(toolsCapability)
			|| (Object.hasOwn(toolsCapability, "listChanged") && typeof toolsCapability.listChanged !== "boolean")) {
			throw new ProbeError("protocol_error");
		}
		const assigned = initialized.response.headers.get("mcp-session-id");
		if (assigned !== null && !validHeaderValue(assigned)) throw new ProbeError("protocol_error");
		sessionId = assigned;

		await send(fetchFn, baseUrl, apiKey, {
			jsonrpc: "2.0",
			method: "notifications/initialized",
		}, { sessionId, initialized: true, notification: true, timeoutMs });
		const listed = await send(fetchFn, baseUrl, apiKey, {
			jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
		}, { id: 2, sessionId, initialized: true, timeoutMs });
		const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : [];
		const names = tools.map((tool) => tool?.name);
		const cursorValid = !Object.hasOwn(listed.result ?? {}, "nextCursor")
			|| typeof listed.result.nextCursor === "string";
		const toolsValid = cursorValid
			&& tools.length > 0
			&& tools.every((tool) => {
				const schema = tool?.inputSchema;
				return typeof tool?.name === "string"
					&& tool.name.length > 0
					&& schema
					&& typeof schema === "object"
					&& !Array.isArray(schema)
					&& schema.type === "object"
					&& (!Object.hasOwn(schema, "properties")
						|| (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)))
					&& (!Object.hasOwn(schema, "required")
						|| (Array.isArray(schema.required) && schema.required.every((field) => typeof field === "string")));
			})
			&& new Set(names).size === names.length
			&& REQUIRED_TOOLS.every((name) => names.includes(name));
		if (!toolsValid) throw new ProbeError("protocol_error");

		const called = await send(fetchFn, baseUrl, apiKey, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "recall_memory", arguments: { query: "Itsuki doctor connection check" } },
		}, { id: 3, sessionId, initialized: true, timeoutMs });
		const toolResult = called.result;
		const contentValid = Array.isArray(toolResult?.content)
			&& toolResult.content.length > 0
			&& toolResult.content.every((item) => item?.type === "text" && typeof item.text === "string");
		const structured = toolResult?.structuredContent;
		if ((Object.hasOwn(toolResult ?? {}, "isError") && toolResult.isError !== false)
			|| !contentValid
			|| !structured
			|| typeof structured !== "object"
			|| Array.isArray(structured)
			|| structured.ok !== true) {
			throw new ProbeError("protocol_error");
		}
		return { outcome: "ok", toolsValid: true, httpStatus: 200 };
	} catch (error) {
		return {
			outcome: ["credential_rejected", "network_error"].includes(error?.code) ? error.code : "protocol_error",
			toolsValid: false,
			httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
		};
	} finally {
		if (sessionId) {
			try {
				const response = await fetchFn(`${baseUrl}/mcp`, {
					method: "DELETE",
					redirect: "manual",
					signal: AbortSignal.timeout(timeoutMs),
					headers: {
						authorization: `Bearer ${apiKey}`,
						"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
						"MCP-Session-Id": sessionId,
					},
				});
				await boundedText(response).catch(() => "");
			} catch {}
		}
	}
}
