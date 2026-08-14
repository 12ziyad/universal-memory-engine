import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	itsukiApiRequest,
	listAllMemories,
	validateConversation,
	waitForPacket,
} from './GenericFunctions';

export class Itsuki implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Itsuki',
		name: 'itsuki',
		icon: { light: 'file:itsuki.svg', dark: 'file:itsuki.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Long-term memory for workflows and AI Agents: save durable facts, recall them in any later run',
		defaults: { name: 'Itsuki' },
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [{ name: 'itsukiApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'recall',
				options: [
					{ name: 'Delete All Memories', value: 'deleteAll', description: 'Preview or destroy every memory in scope — previews by default', action: 'Delete all memories' },
					{ name: 'Delete Memory', value: 'delete', description: 'Delete one memory by ID (destructive)', action: 'Delete a memory' },
					{ name: 'Get Memory', value: 'get', description: 'Fetch one memory by ID', action: 'Get a memory' },
					{ name: 'List Memories', value: 'list', description: 'List stored memories (one page, or return all)', action: 'List memories' },
					{ name: 'Recall Memory', value: 'recall', description: 'Semantic recall: prompt-ready context plus structured items', action: 'Recall memories' },
					{ name: 'Save Conversation', value: 'saveConversation', description: 'Store a batch of chat messages for extraction', action: 'Save a conversation' },
					{ name: 'Save Memory', value: 'saveMemory', description: 'Store one durable fact', action: 'Save a memory' },
					{ name: 'Wait for Packet', value: 'waitForPacket', description: 'Poll a save receipt until extraction settles', action: 'Wait for a packet' },
					{ name: 'Who Am I', value: 'whoami', description: 'Connection health, identity, and plan usage — never memory content', action: 'Check the connection' },
				],
			},

			// ------------------------------------------------- saveMemory
			{
				displayName: 'Content',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['saveMemory'] } },
				description: 'The durable fact to remember, in plain language',
			},

			// ------------------------------------------- saveConversation
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				required: true,
				displayOptions: { show: { operation: ['saveConversation'] } },
				description: 'The conversation to extract memories from, oldest first. Order is preserved.',
				options: [
					{
						name: 'message',
						displayName: 'Message',
						values: [
							{
								displayName: 'Role',
								name: 'role',
								type: 'options',
								default: 'user',
								options: [
									{ name: 'User', value: 'user' },
									{ name: 'Assistant', value: 'assistant' },
									{ name: 'System', value: 'system' },
									{ name: 'Tool', value: 'tool' },
								],
							},
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: { rows: 2 },
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Extraction Narrowing',
				name: 'narrowing',
				type: 'collection',
				placeholder: 'Add narrowing',
				default: {},
				displayOptions: { show: { operation: ['saveConversation'] } },
				description: 'Narrow what this call extracts. Narrowing can only reduce, never broaden, what project policy allows.',
				options: [
					{
						displayName: 'Scope',
						name: 'scope',
						type: 'options',
						default: 'full',
						options: [
							{ name: 'Full Conversation', value: 'full' },
							{ name: 'Last N Messages', value: 'lastN' },
							{ name: 'Topic Only', value: 'topic' },
							{ name: 'Summary Only', value: 'summary' },
						],
						description: 'Which part of the batch extraction should consider',
					},
					{
						displayName: 'N (Last Messages)',
						name: 'n',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 30 },
						default: 10,
						description: 'How many trailing messages count when Scope is Last N',
					},
					{
						displayName: 'Topic',
						name: 'topic',
						type: 'string',
						default: '',
						description: 'The topic to focus on when Scope is Topic Only',
					},
				],
			},

			// ---------------------------------------------------- recall
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['recall'] } },
				description: 'What to look for, in natural language',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				displayOptions: { show: { operation: ['recall'] } },
				description: 'Max number of results to return',
			},

			// ------------------------------------------------- get/delete
			{
				displayName: 'Memory ID',
				name: 'memoryId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['get', 'delete'] } },
				description: 'A prefixed memory ID (node_…, page_…, slice_…, or candidate ID)',
			},
			{
				displayName: 'This permanently deletes the memory and its satellites (search index, vectors, graph edges). It cannot be undone.',
				name: 'deleteNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { operation: ['delete'] } },
			},

			// ------------------------------------------------------ list
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['list'] } },
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Page Size',
				name: 'pageSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 200 },
				default: 50,
				displayOptions: { show: { operation: ['list'] } },
				description: 'How many memories per page',
			},
			{
				displayName: 'Max Items',
				name: 'maxItems',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 5000 },
				default: 500,
				displayOptions: { show: { operation: ['list'], returnAll: [true] } },
				description: 'Hard cap on items fetched when returning all — protects against unbounded loops',
			},
			{
				displayName: 'Filters',
				name: 'listFilters',
				type: 'collection',
				placeholder: 'Add filter',
				default: {},
				displayOptions: { show: { operation: ['list'] } },
				options: [
					{
						displayName: 'Kind',
						name: 'kind',
						type: 'options',
						default: 'all',
						options: [
							{ name: 'All', value: 'all' },
							{ name: 'Facts (Nodes)', value: 'node' },
							{ name: 'Pages', value: 'page' },
						],
					},
					{
						displayName: 'Text Filter',
						name: 'q',
						type: 'string',
						default: '',
						description: 'Case-insensitive substring match on the memory text',
					},
					{
						displayName: 'Cursor',
						name: 'cursor',
						type: 'string',
						default: '',
						description: 'Resume from a previous page\'s next_cursor (single-page mode only)',
					},
				],
			},

			// ------------------------------------------------- deleteAll
			{
				displayName: 'Delete All previews by default: it reports what WOULD be removed and touches nothing. Destruction happens only with Confirm Destruction enabled.',
				name: 'deleteAllNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { operation: ['deleteAll'] } },
			},
			{
				displayName: 'Confirm Destruction',
				name: 'confirmDestruction',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['deleteAll'] } },
				description: 'Whether to actually destroy. Off = preview only. This cannot be undone.',
			},
			{
				displayName: 'Bulk Filters',
				name: 'bulkFilters',
				type: 'collection',
				placeholder: 'Add filter',
				default: {},
				displayOptions: { show: { operation: ['deleteAll'] } },
				description: 'Narrow the bulk operation. With no filters it covers every memory in the resolved scope.',
				options: [
					{
						displayName: 'Source',
						name: 'source',
						type: 'string',
						default: '',
						description: 'Only memories from this source (for example save_memory, ingest)',
					},
					{
						displayName: 'Before',
						name: 'before',
						type: 'string',
						default: '',
						placeholder: 'YYYY-MM-DD or epoch ms',
						description: 'Only memories created before this time',
					},
					{
						displayName: 'After',
						name: 'after',
						type: 'string',
						default: '',
						placeholder: 'YYYY-MM-DD or epoch ms',
						description: 'Only memories created after this time',
					},
				],
			},

			// --------------------------------------------- waitForPacket
			{
				displayName: 'Packet ID',
				name: 'packetId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['waitForPacket'] } },
				description: 'The source_packet_id from a save receipt',
			},

			// --------------------------------- wait options (save ops + wait)
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: { show: { operation: ['saveMemory', 'saveConversation'] } },
				description: 'Whether to poll until extraction settles before the next node runs. On timeout the save is still accepted — the output says so honestly.',
			},
			{
				displayName: 'Wait Options',
				name: 'waitOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { operation: ['saveMemory', 'saveConversation', 'waitForPacket'] } },
				options: [
					{
						displayName: 'Timeout (Seconds)',
						name: 'timeoutSeconds',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 300 },
						default: 60,
						description: 'How long to wait before returning the honest in-progress state',
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'intervalSeconds',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 30 },
						default: 2,
						description: 'How often to poll the packet status',
					},
				],
			},

			// ------------------------------------------- shared additional
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: {
					show: { operation: ['saveMemory', 'saveConversation', 'recall', 'list', 'get', 'delete', 'deleteAll', 'waitForPacket'] },
				},
				options: [
					{
						displayName: 'Conversation ID',
						name: 'conversationId',
						type: 'string',
						default: '',
						description: 'Attribution: which conversation this came from',
					},
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						description: 'A stable unique key for this save. Retries with the same key cannot double-write, and the node will only auto-retry writes that carry one.',
					},
					{
						displayName: 'Source ID',
						name: 'sourceId',
						type: 'string',
						default: '',
						description: 'Attribution: which system or document produced this',
					},
					{
						displayName: 'Thread ID',
						name: 'threadId',
						type: 'string',
						default: '',
						description: 'Attribution: which thread within the conversation',
					},
					{
						displayName: 'User ID (Sub-Tenant)',
						name: 'userId',
						type: 'string',
						default: '',
						description: 'Isolate this call to one end user\'s memory space under your key. Use the same stable value on save and recall. Tenancy itself always comes from the credential — this can only narrow, never widen.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
				const userId = additional.userId ? String(additional.userId) : undefined;
				let out: IDataObject;

				switch (operation) {
					case 'saveMemory': {
						const content = String(this.getNodeParameter('content', i));
						if (!content.trim()) {
							throw new NodeOperationError(this.getNode(), 'Content is empty. A memory needs content.', { itemIndex: i });
						}
						const body: IDataObject = { content };
						for (const field of ['userId', 'conversationId', 'threadId', 'sourceId', 'idempotencyKey'] as const) {
							if (additional[field]) body[field] = additional[field];
						}
						out = await itsukiApiRequest.call(this, {
							method: 'POST', path: '/v1/save', body, idempotent: Boolean(additional.idempotencyKey),
						});
						out = await maybeWait.call(this, i, out);
						break;
					}

					case 'saveConversation': {
						const raw = this.getNodeParameter('messages', i, {}) as IDataObject;
						const list = Array.isArray(raw.message) ? raw.message : [];
						let messages;
						try {
							messages = validateConversation(list);
						} catch (error) {
							throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex: i });
						}
						const body: IDataObject = { mode: 'conversation', messages };
						const narrowing = this.getNodeParameter('narrowing', i, {}) as IDataObject;
						if (narrowing.scope && narrowing.scope !== 'full') body.scope = narrowing.scope;
						if (narrowing.scope === 'lastN' && narrowing.n) body.n = narrowing.n;
						if (narrowing.scope === 'topic' && narrowing.topic) body.topic = narrowing.topic;
						for (const field of ['userId', 'conversationId', 'threadId', 'sourceId', 'idempotencyKey'] as const) {
							if (additional[field]) body[field] = additional[field];
						}
						out = await itsukiApiRequest.call(this, {
							method: 'POST', path: '/v1/save', body, idempotent: Boolean(additional.idempotencyKey),
						});
						out = await maybeWait.call(this, i, out);
						break;
					}

					case 'recall': {
						const query = String(this.getNodeParameter('query', i));
						if (!query.trim()) {
							throw new NodeOperationError(this.getNode(), 'Query is empty. Recall needs a question.', { itemIndex: i });
						}
						const body: IDataObject = { query, limit: this.getNodeParameter('limit', i, 10) };
						if (userId) body.userId = userId;
						const response = await itsukiApiRequest.call(this, { method: 'POST', path: '/v1/recall', body });
						// count 0 is a legitimate empty result, never an error.
						out = {
							found: Number(response.count ?? 0) > 0,
							count: response.count ?? 0,
							context: response.context ?? '',
							items: response.items ?? [],
						};
						break;
					}

					case 'list': {
						const filters = this.getNodeParameter('listFilters', i, {}) as IDataObject;
						const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
						const pageSize = this.getNodeParameter('pageSize', i, 50) as number;
						const qs: IDataObject = {};
						if (filters.kind && filters.kind !== 'all') qs.kind = filters.kind;
						if (filters.q) qs.q = filters.q;
						if (userId) qs.userId = userId;
						if (returnAll) {
							const maxItems = this.getNodeParameter('maxItems', i, 500) as number;
							const all = await listAllMemories.call(this, qs, { returnAll: true, maxItems, pageSize });
							out = { count: all.length, items: all };
						} else {
							if (filters.cursor) qs.cursor = filters.cursor;
							out = await itsukiApiRequest.call(this, {
								method: 'GET', path: '/v1/memories', qs: { ...qs, limit: pageSize },
							});
						}
						break;
					}

					case 'get': {
						const memoryId = String(this.getNodeParameter('memoryId', i)).trim();
						if (!memoryId) throw new NodeOperationError(this.getNode(), 'Memory ID is empty.', { itemIndex: i });
						const qs: IDataObject = {};
						if (userId) qs.userId = userId;
						out = await itsukiApiRequest.call(this, {
							method: 'GET', path: `/v1/memories/${encodeURIComponent(memoryId)}`, qs,
						});
						break;
					}

					case 'delete': {
						const memoryId = String(this.getNodeParameter('memoryId', i)).trim();
						if (!memoryId) throw new NodeOperationError(this.getNode(), 'Memory ID is empty.', { itemIndex: i });
						const qs: IDataObject = {};
						if (userId) qs.userId = userId;
						// A 404 surfaces as an error — never silently reported as deleted.
						out = await itsukiApiRequest.call(this, {
							method: 'DELETE', path: `/v1/memories/${encodeURIComponent(memoryId)}`, qs,
						});
						break;
					}

					case 'deleteAll': {
						const confirm = this.getNodeParameter('confirmDestruction', i, false) as boolean;
						const filters = this.getNodeParameter('bulkFilters', i, {}) as IDataObject;
						const qs: IDataObject = {};
						for (const field of ['source', 'before', 'after'] as const) {
							if (filters[field]) qs[field] = filters[field];
						}
						if (userId) qs.userId = userId;
						if (confirm) qs.confirm = 'true';
						else qs.dry_run = 'true';
						out = await itsukiApiRequest.call(this, { method: 'DELETE', path: '/v1/memories', qs });
						out = { mode: confirm ? 'destroyed' : 'preview_only', ...out };
						break;
					}

					case 'whoami': {
						const status = await itsukiApiRequest.call(this, { method: 'GET', path: '/v1/status' });
						let quota: IDataObject | null = null;
						try {
							const usage = await itsukiApiRequest.call(this, {
								method: 'GET', path: '/v1/usage', qs: { range: '1d' }, maxRetries: 0,
							});
							quota = (usage.quota as IDataObject) ?? null;
						} catch {
							quota = null; // health must not fail because usage is briefly unavailable
						}
						out = { ok: true, status, ...(quota ? { quota } : {}) };
						break;
					}

					case 'waitForPacket': {
						const packetId = String(this.getNodeParameter('packetId', i)).trim();
						if (!packetId) throw new NodeOperationError(this.getNode(), 'Packet ID is empty.', { itemIndex: i });
						out = await runWait.call(this, i, packetId);
						break;
					}

					default:
						throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, { itemIndex: i });
				}

				returnData.push({ json: out, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}

/** Shared wait wiring for the two save operations. */
async function maybeWait(this: IExecuteFunctions, itemIndex: number, saveResult: IDataObject): Promise<IDataObject> {
	const wait = this.getNodeParameter('waitForCompletion', itemIndex, true) as boolean;
	const packetId = typeof saveResult.source_packet_id === 'string' ? saveResult.source_packet_id : null;
	if (!wait || !packetId) return saveResult;
	const settled = await runWait.call(this, itemIndex, packetId);
	return { ...saveResult, completion: settled };
}

async function runWait(this: IExecuteFunctions, itemIndex: number, packetId: string): Promise<IDataObject> {
	const options = this.getNodeParameter('waitOptions', itemIndex, {}) as IDataObject;
	const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const userId = additional.userId ? String(additional.userId) : undefined;
	const timeoutMs = Math.min(Math.max(Number(options.timeoutSeconds ?? 60), 1), 300) * 1_000;
	const intervalMs = Math.min(Math.max(Number(options.intervalSeconds ?? 2), 1), 30) * 1_000;
	const result = await waitForPacket.call(this, packetId, { timeoutMs, intervalMs, userId });
	if (result.timed_out) {
		// Honest state: accepted and still processing — neither success nor failure.
		return { ...result, accepted: true, processing: true, note: 'Timed out waiting; the save was accepted and is still processing on the server. This is not a failure.' };
	}
	return result;
}
