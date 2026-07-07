/**
 * The trigger: cheap, pure backend rules (NO LLM) that decide what to do with an
 * incoming message and when a held chunk should fire.
 *
 *   classifyMessage(text) -> "noise" | "utility" | "signal" | "meaningful"
 *   decide(message, chunk, opts) -> { action: IGNORE | HOLD | FIRE, reason, cls }
 *   shouldFire(chunk, opts) -> { fire: bool, reason }
 *
 * Holding ALWAYS ends: one of the fire conditions (signal · count · chars · idle
 * · topic switch · flush) will always trigger, so a meaningful chunk can never
 * sit forever (anti-stall).
 */

import { DIALS } from "../config.js";
import { jaccard, tokens } from "../lib/text.js";
import { isStrongDurableSignal } from "./candidate_rules.js";

export const ACTION = { IGNORE: "IGNORE", HOLD: "HOLD", FIRE: "FIRE" };

// Pure noise: filler that is never worth holding.
const NOISE_RE =
	/^(ok|okay|k|kk|kay|yo|hey|hi|hello|thanks|thank you|thx|ty|np|lol|lmao|lmfao|haha+|hehe|nice|cool|great|awesome|amazing|sweet|sure|yep|yup|yes|no|nope|nah|fine|alright|aight|word|right|true|fr|facts|got it|gotcha|same|ok bro|ok then|sounds good|makes sense|good|bet)[\s,!.?]*((bro|man|dude|bruh|thanks|cool|then|good|nice|sounds good|makes sense)[\s,!.?]*)*$/i;

// Pure utility / lookups: questions and commands with no personal signal.
const UTILITY_PREFIX_RE =
	/^\s*(what is|what are|what's|whats|whats the|who is|who's|when is|when's|where is|where's|why is|how do i|how do you|how to|how can i|can you|could you|please|translate|calculate|compute|define|explain|convert|summarize|summarise|spell|give me|write me|generate)\b/i;

// Strong lifecycle / life-event cues — fire immediately, even mid-chat.
const SIGNAL_RE = new RegExp(
	[
		"\\bstarted\\b",
		"\\bstart(ing)? (building|to build|a|my|the)\\b",
		"\\bbuilding\\b",
		"\\bstopped\\b",
		"\\bpaused\\b",
		"\\bresumed\\b",
		"\\blaunched\\b",
		"\\bcompleted\\b",
		"\\bfinished\\b",
		"\\bfixed\\b",
		"\\bremoved\\b",
		"\\bquit\\b",
		"\\bquitting\\b",
		"\\bchanged (my |the )?plan\\b",
		"\\bdecided\\b",
		"\\bdiagnosed\\b",
		"\\bdiagnosis\\b",
		"\\bdied\\b",
		"\\bpassed away\\b",
		"\\bmoved (to|out|in|back)\\b",
		"\\bgot a (new )?job\\b",
		"\\bnew job\\b",
		"\\bbroke up\\b",
		"\\bdivorced?\\b",
		"\\binjur(y|ed|ies)\\b",
		"\\bi have\\b",
		"\\bi was diagnosed\\b",
		"\\bi am building\\b",
		"\\bi'm building\\b",
		// explicit relationship / capability statements ("X uses Y")
		"\\buses\\b",
		"\\busing\\b",
		"\\bsupports?\\b",
		"\\bintegrat(es|ed|ing) with\\b",
		"\\bdepends on\\b",
		"\\bpowered by\\b",
		"\\bbuilt (with|on)\\b",
		"\\bconnects? to\\b",
		"\\bruns on\\b",
	].join("|"),
	"i",
);

const EMOJI_ONLY_RE =
	/^[\s\p{Extended_Pictographic}‍️☀-➿]+$/u;

/**
 * Classify a single message body. Order matters: noise → signal → utility →
 * meaningful. Signal is checked before utility so "did you know I started X?"
 * counts as a signal rather than a question.
 */
export function classifyMessage(content) {
	const text = String(content ?? "").trim();
	if (text.length === 0) return "noise";
	if (EMOJI_ONLY_RE.test(text)) return "noise";
	if (text.length <= 3) return "noise";
	if (NOISE_RE.test(text)) return "noise";
	if (isStrongDurableSignal(text)) return "signal";
	if (SIGNAL_RE.test(text)) return "signal";
	if (UTILITY_PREFIX_RE.test(text)) return "utility";
	// A bare question with no first-person statement is utility, not memory.
	if (text.endsWith("?") && !/\bi\b|\bmy\b|\bi'm\b|\bi am\b/i.test(text)) {
		return "utility";
	}
	return "meaningful";
}

/** Only meaningful/signal messages are held; this counts them ("five lols = 0"). */
export function meaningfulCount(chunk) {
	return chunk.filter((m) => m._cls === "meaningful" || m._cls === "signal").length;
}

function totalChars(chunk) {
	return chunk.reduce((n, m) => n + String(m.content ?? "").length, 0);
}

/**
 * Topic-switch detection (basic, conservative): if the chunk already holds a
 * coherent topic and the two most recent held messages share almost no
 * vocabulary with the earlier ones, the older topic should fire. Only considered
 * once a chunk has enough messages that a "switch that sticks" is meaningful.
 */
export function isTopicSwitch(chunk) {
	if (chunk.length < 3) return false;
	const recent = chunk.slice(-2);
	const earlier = chunk.slice(0, -2);
	const earlierTokens = earlier.flatMap((m) => tokens(m.content));
	const recentTokens = recent.flatMap((m) => tokens(m.content));
	return jaccard(earlierTokens, recentTokens) < 0.05;
}

/**
 * Given the current held chunk, decide whether it should fire now.
 * `opts`: { flush, now, lastSignal } — lastSignal=true means the message that
 * was just held was a strong signal.
 */
export function shouldFire(chunk, opts = {}) {
	const { flush = false, now = Date.now(), lastSignal = false, dials = DIALS } = opts;
	if (chunk.length === 0) return { fire: false, reason: "empty" };

	if (flush) return { fire: true, reason: "flush" };
	if (lastSignal) return { fire: true, reason: "strong_signal" };

	const count = meaningfulCount(chunk);
	if (count >= dials.chunkMsgs) return { fire: true, reason: "chunk_msgs" };
	if (totalChars(chunk) >= dials.chunkChars) return { fire: true, reason: "chunk_chars" };

	const lastTs = chunk[chunk.length - 1]?.ts ?? now;
	if (now - lastTs >= dials.idleMs) return { fire: true, reason: "idle_gap" };

	if (isTopicSwitch(chunk)) return { fire: true, reason: "topic_switch" };

	return { fire: false, reason: "hold" };
}
