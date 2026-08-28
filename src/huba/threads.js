/**
 * Huba conversation threads (migration 0061).
 *
 * A conversation used to live in the browser tab and die with it. Threads
 * make it an object: pick one up again, switch between them, delete one.
 *
 * Every function here takes the userId resolved from the SESSION and scopes
 * on it. A thread id alone is never enough to read or delete anything — the
 * WHERE clause always carries the owner, so guessing an id gets you nothing.
 */

const MAX_THREADS_LISTED = 20;
const MAX_MESSAGES_REPLAYED = 40;
/** Older threads are pruned per user so the list stays a list, not an archive. */
const MAX_THREADS_KEPT = 40;
const MAX_TITLE_CHARS = 70;

/** A thread's title is its first question, trimmed to something scannable. */
export function titleFromQuestion(question) {
	const clean = String(question ?? "").replace(/\s+/g, " ").trim();
	if (!clean) return "New conversation";
	return clean.length > MAX_TITLE_CHARS ? `${clean.slice(0, MAX_TITLE_CHARS - 1)}…` : clean;
}

export async function listThreads(env, userId, limit = MAX_THREADS_LISTED) {
	const { results } = await env.DB.prepare(
		`SELECT id, title, message_count, created_at, updated_at
		 FROM huba_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
	).bind(userId, Math.min(MAX_THREADS_LISTED, Math.max(1, Number(limit) || MAX_THREADS_LISTED))).all();
	return results ?? [];
}

/** One thread's messages, oldest first — what the panel replays on select. */
export async function readThread(env, userId, threadId) {
	const thread = await env.DB.prepare(
		"SELECT id, title, message_count, created_at, updated_at FROM huba_threads WHERE id = ? AND user_id = ?",
	).bind(threadId, userId).first();
	if (!thread) return null;
	const { results } = await env.DB.prepare(
		`SELECT role, content, created_at FROM huba_messages
		 WHERE thread_id = ? AND user_id = ? ORDER BY created_at LIMIT ?`,
	).bind(threadId, userId, MAX_MESSAGES_REPLAYED).all();
	return { ...thread, messages: results ?? [] };
}

/**
 * Append one exchange, creating the thread when there isn't one yet. Returns
 * the thread id so the caller can hand it back to the client.
 *
 * A supplied threadId that does not belong to this user is ignored rather
 * than trusted — the insert simply starts a new thread instead.
 */
export async function appendExchange(env, userId, { threadId, question, answer }) {
	const now = Date.now();
	let id = null;
	if (threadId) {
		const owned = await env.DB.prepare(
			"SELECT id FROM huba_threads WHERE id = ? AND user_id = ?",
		).bind(threadId, userId).first();
		id = owned?.id ?? null;
	}
	const statements = [];
	if (!id) {
		id = `hthr_${crypto.randomUUID()}`;
		statements.push(env.DB.prepare(
			`INSERT INTO huba_threads (id, user_id, title, message_count, created_at, updated_at)
			 VALUES (?, ?, ?, 0, ?, ?)`,
		).bind(id, userId, titleFromQuestion(question), now, now));
	}
	statements.push(env.DB.prepare(
		`INSERT INTO huba_messages (id, thread_id, user_id, role, content, created_at)
		 VALUES (?, ?, ?, 'user', ?, ?)`,
	).bind(`hmsg_${crypto.randomUUID()}`, id, userId, String(question).slice(0, 4000), now));
	statements.push(env.DB.prepare(
		`INSERT INTO huba_messages (id, thread_id, user_id, role, content, created_at)
		 VALUES (?, ?, ?, 'assistant', ?, ?)`,
	).bind(`hmsg_${crypto.randomUUID()}`, id, userId, String(answer).slice(0, 8000), now + 1));
	statements.push(env.DB.prepare(
		`UPDATE huba_threads SET message_count = message_count + 2, updated_at = ?
		 WHERE id = ? AND user_id = ?`,
	).bind(now, id, userId));
	await env.DB.batch(statements);
	return id;
}

export async function deleteThread(env, userId, threadId) {
	// Messages first: the FK cascade covers it, but D1 does not enforce
	// foreign keys by default, so the child rows are removed explicitly.
	const [, threads] = await env.DB.batch([
		env.DB.prepare("DELETE FROM huba_messages WHERE thread_id = ? AND user_id = ?").bind(threadId, userId),
		env.DB.prepare("DELETE FROM huba_threads WHERE id = ? AND user_id = ?").bind(threadId, userId),
	]);
	// Report what actually happened, not whether the row is absent: an id
	// belonging to someone else is absent FOR THIS USER either way, and
	// answering "deleted" to a no-op is a small lie that would also hand a
	// prober a way to distinguish "never existed" from "not yours". Row count
	// says the same thing to both.
	return { deleted: Number(threads?.meta?.changes ?? 0) > 0 };
}

/** Keep the list bounded; oldest threads fall off the end. Best-effort. */
export async function pruneThreads(env, userId) {
	try {
		await env.DB.prepare(
			`DELETE FROM huba_messages WHERE user_id = ? AND thread_id IN (
			   SELECT id FROM huba_threads WHERE user_id = ?
			   ORDER BY updated_at DESC LIMIT -1 OFFSET ?
			 )`,
		).bind(userId, userId, MAX_THREADS_KEPT).run();
		await env.DB.prepare(
			`DELETE FROM huba_threads WHERE user_id = ? AND id IN (
			   SELECT id FROM huba_threads WHERE user_id = ?
			   ORDER BY updated_at DESC LIMIT -1 OFFSET ?
			 )`,
		).bind(userId, userId, MAX_THREADS_KEPT).run();
	} catch (error) {
		console.warn("huba thread prune skipped:", error?.message ?? error);
	}
}
