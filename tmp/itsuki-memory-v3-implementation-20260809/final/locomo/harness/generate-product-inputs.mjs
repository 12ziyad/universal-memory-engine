import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE = path.dirname(HERE);
const CAMPAIGN = path.dirname(path.dirname(STAGE));
const DATASET = path.join(CAMPAIGN, "phase3-d04", "vendor", "locomo10.json");
const OUTPUT = path.join(STAGE, "frozen", "product-inputs.json");

const CATEGORY_NAMES = Object.freeze({
	1: "multi-hop",
	2: "temporal-reasoning",
	3: "open-domain-knowledge",
	4: "single-hop",
});
const MONTHS = Object.freeze({
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function sha(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function sourceDay(raw) {
	const match = /^(\d{1,2}):(\d{2})\s+(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s+(\d{4})$/i.exec(String(raw));
	assert(match, `unrecognised LoCoMo session date shape: ${raw}`);
	const month = MONTHS[match[5].toLowerCase()];
	assert(month, `unrecognised LoCoMo month: ${match[5]}`);
	const day = Number(match[4]);
	const year = Number(match[6]);
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	assert(hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59, `invalid LoCoMo time: ${raw}`);
	const date = new Date(Date.UTC(year, month - 1, day));
	assert(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day,
		`invalid LoCoMo calendar day: ${raw}`);
	// The source has a local clock time but no timezone. The BF-1 contract must
	// not fabricate an offset, so the authoritative field deliberately carries
	// day precision. The original local time remains verbatim in message text.
	return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function renderTurn(turn, dateTime) {
	let text = `${turn.speaker} said, "${String(turn.text ?? "").trim()}"`;
	if (turn.blip_caption) text += ` and shared ${turn.blip_caption}.`;
	return `[${dateTime}] ${text}`;
}

function sessionsOf(conversation, sampleId) {
	return Object.keys(conversation)
		.filter((key) => /^session_\d+$/.test(key) && Array.isArray(conversation[key]))
		.map((key) => ({ key, index: Number(key.slice("session_".length)) }))
		.sort((a, b) => a.index - b.index)
		.map(({ key, index }) => {
			const dateTime = conversation[`${key}_date_time`];
			const sourceTime = sourceDay(dateTime);
			const messages = conversation[key].map((turn, messageIndex) => {
				const content = renderTurn(turn, dateTime);
				assert([...content].length <= 4_000, `${sampleId}/${key}/${messageIndex}: message exceeds wire cap`);
				return {
					id: `${sampleId}:${turn.dia_id ?? `s${index}m${messageIndex + 1}`}`,
					role: "user",
					content,
					sourceTime,
				};
			});
			return { index, dateTime, sourceTime, messages };
		});
}

function build() {
	const raw = fs.readFileSync(DATASET, "utf8");
	const source = JSON.parse(raw);
	const samples = source.map((sample) => ({
		sampleId: sample.sample_id,
		speakerA: sample.conversation.speaker_a,
		speakerB: sample.conversation.speaker_b,
		sessions: sessionsOf(sample.conversation, sample.sample_id),
		questions: sample.qa.map((qa, questionIndex) => ({ qa, questionIndex }))
			.filter(({ qa }) => [1, 2, 3, 4].includes(Number(qa.category)))
			.map(({ qa, questionIndex }) => ({
				questionId: `${sample.sample_id}#${questionIndex}`,
				questionIndex,
				category: Number(qa.category),
				categoryName: CATEGORY_NAMES[Number(qa.category)],
				question: String(qa.question),
			})),
	}));
	const totals = {
		samples: samples.length,
		sessions: samples.reduce((sum, sample) => sum + sample.sessions.length, 0),
		messages: samples.reduce((sum, sample) => sum
			+ sample.sessions.reduce((n, session) => n + session.messages.length, 0), 0),
		questions: samples.reduce((sum, sample) => sum + sample.questions.length, 0),
		byCategory: Object.fromEntries(Object.keys(CATEGORY_NAMES).map((key) => [key,
			samples.reduce((sum, sample) => sum
				+ sample.questions.filter((question) => question.category === Number(key)).length, 0)])),
	};
	assert(JSON.stringify(totals) === JSON.stringify({
		samples: 10, sessions: 272, messages: 5_882, questions: 1_540,
		byCategory: { 1: 282, 2: 321, 3: 96, 4: 841 },
	}), `LoCoMo accounting changed: ${JSON.stringify(totals)}`);
	for (const sample of samples) {
		const ids = sample.sessions.flatMap((session) => session.messages.map((message) => message.id));
		assert(new Set(ids).size === ids.length, `${sample.sampleId}: duplicate source message id`);
	}
	return {
		schema: "itsuki.v3-stage-e-product-inputs/v1",
		purpose: "Reference-blind product input. No answer, evidence label, judge verdict, or score is present.",
		source: {
			name: "LoCoMo",
			repository: "snap-research/locomo",
			commit: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
			datasetSha256: sha(raw),
			datasetCanonicalSha256: sha(canonicalJson(source)),
		},
		totals,
		samples,
	};
}

function verify(value) {
	assert(value?.schema === "itsuki.v3-stage-e-product-inputs/v1", "product input schema changed");
	assert(value?.totals?.questions === 1_540 && value?.totals?.messages === 5_882,
		"product input accounting changed");
	const serialized = JSON.stringify(value);
	for (const forbidden of ["reference", "answer", "adversarial_answer", "evidence", "judgment", "score"]) {
		assert(!new RegExp(`\\\"${forbidden}\\\"\\s*:`).test(serialized),
			`forbidden reference/scoring field in product input: ${forbidden}`);
	}
	return true;
}

const built = build();
verify(built);
if (fs.existsSync(OUTPUT)) {
	const existing = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
	verify(existing);
	assert(JSON.stringify(existing) === JSON.stringify(built), "frozen product input does not match deterministic rebuild");
	console.log(JSON.stringify({ verified: true, file: OUTPUT, sha256: sha(fs.readFileSync(OUTPUT)), totals: built.totals }));
} else {
	fs.writeFileSync(OUTPUT, `${JSON.stringify(built, null, 2)}\n`, { flag: "wx" });
	console.log(JSON.stringify({ generated: true, file: OUTPUT, sha256: sha(fs.readFileSync(OUTPUT)), totals: built.totals }));
}
