/**
 * The Processor argument and result types, derived from the host interface.
 *
 * Mastra does not export `ProcessInputArgs` and friends from its package root,
 * and approximating them with hand-written shapes would compile against a lie:
 * the compiler would stop telling us when the host changed. Reading them back
 * off `Processor` itself means a signature change in a 1.x minor fails the
 * typecheck here, which is exactly the early warning a young host needs.
 */

import type { Processor } from "@mastra/core/processors";

type ProcessInputFn = NonNullable<Processor["processInput"]>;
type ProcessOutputResultFn = NonNullable<Processor["processOutputResult"]>;

export type ProcessInputArgs = Parameters<ProcessInputFn>[0];
export type ProcessInputResult = Awaited<ReturnType<ProcessInputFn>>;

export type ProcessOutputResultArgs = Parameters<ProcessOutputResultFn>[0];
export type ProcessOutputResult = Awaited<ReturnType<ProcessOutputResultFn>>;

/** The message type the host threads through processors. */
export type HostMessage = ProcessInputArgs["messages"][number];

/** The system-message type `processInput` may add to. */
export type HostSystemMessage = ProcessInputArgs["systemMessages"][number];
