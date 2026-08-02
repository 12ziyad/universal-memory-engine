/**
 * The webhook creation form.
 *
 * The bug this pins: createWebhookNow() re-rendered the view BEFORE reading
 * the inputs, so it read a freshly-rebuilt (empty) form. A valid pasted URL
 * arrived at the server as "", the server correctly called that invalid, and
 * the person saw "That doesn't look like a valid URL" with their typing gone.
 *
 * The stubbed renderView() below CLEARS the DOM stub exactly as the real one
 * does, so re-introducing that ordering makes these tests fail rather than
 * silently shipping the same bug again.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import html from "../public/index.html?raw";

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

function fnSource(name) {
	let start = script.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no function ${name} in the page`);
	// Keep the `async` prefix — without it the extracted body has bare awaits.
	if (script.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
	let depth = 0;
	let seenBody = false;
	for (let i = start; i < script.length; i++) {
		if (script[i] === "{") { depth++; seenBody = true; }
		else if (script[i] === "}") {
			depth--;
			if (seenBody && depth === 0) return script.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${name}`);
}

const WH_EVENTS = ["memory.added", "memory.updated", "memory.deleted", "memory.categorized"];

/** A DOM stub whose fields are wiped by renderView(), like the real page. */
function harness({ apiImpl } = {}) {
	const calls = [];
	const fields = { whName: { value: "" }, whUrl: { value: "" }, whMetaOnly: { checked: false } };
	let eventBoxes = WH_EVENTS.map((value) => ({ value, checked: true }));
	const errorBox = { hidden: true };
	let renders = 0;

	const WH = {
		rows: [], loading: false, creating: false, error: "", openLog: null, deliveries: [],
		events: WH_EVENTS,
		form: { name: "", url: "", events: [...WH_EVENTS], metadataOnly: false },
	};

	const $ = (sel) => {
		if (sel === "#whName") return fields.whName;
		if (sel === "#whUrl") return { ...fields.whUrl, focus() {}, get value() { return fields.whUrl.value; } };
		if (sel === "#whMetaOnly") return fields.whMetaOnly;
		if (sel === "#whError") return errorBox;
		return null;
	};
	const documentStub = {
		querySelectorAll: (sel) => (sel === ".wh-event:checked" ? eventBoxes.filter((b) => b.checked) : []),
	};
	// The real renderView() rebuilds the form from state — inputs the person
	// typed into are gone, replaced by fresh ones bound to WH.form.
	const renderView = () => {
		renders++;
		fields.whName.value = WH.form.name;
		fields.whUrl.value = WH.form.url;
		fields.whMetaOnly.checked = WH.form.metadataOnly;
		eventBoxes = WH_EVENTS.map((value) => ({ value, checked: WH.form.events.includes(value) }));
		// The template renders the error box hidden unless WH.error is set.
		errorBox.hidden = !WH.error;
	};

	const api = apiImpl ?? (async (path, init) => {
		calls.push({ path, body: JSON.parse(init.body) });
		return { webhook: { id: "wh_1", name: "x", url: "https://example.com", events: WH_EVENTS, metadata_only: false }, secret: "whsec_abc" };
	});

	const source = ["whFormReset", "whField", "whToggleEvent", "whUrlComplaint", "createWebhookNow"].map(fnSource).join("\n");
	const built = new Function(
		"WH", "WH_EVENTS", "$", "document", "api", "renderView", "renderWebhooksTable", "showWebhookSecret",
		`${source}\nreturn { createWebhookNow, whUrlComplaint, whField, whToggleEvent, whFormReset };`,
	)(WH, WH_EVENTS, $, documentStub, api, renderView, () => {}, () => {});

	/** Simulate typing: sets the input AND fires the oninput binding. */
	const type = (id, value) => {
		fields[id].value = value;
		built.whField(id === "whName" ? "name" : "url", value);
	};
	const untick = (name) => {
		const box = eventBoxes.find((b) => b.value === name);
		box.checked = false;
		built.whToggleEvent(name, false);
	};

	return { ...built, WH, fields, calls, type, untick, errorBox, get renders() { return renders; } };
}

describe("creating a webhook", () => {
	it("accepts a valid https URL with a name — and actually sends what was typed", async () => {
		const h = harness();
		h.type("whName", "CRM sync");
		h.type("whUrl", "https://webhook.site/6f1c2a9e-0b77-4c31-9a4e-2f9f1c0d5b3a");

		await h.createWebhookNow();

		expect(h.calls).toHaveLength(1);
		// The exact URL reached the server — this is the whole bug.
		expect(h.calls[0].body.url).toBe("https://webhook.site/6f1c2a9e-0b77-4c31-9a4e-2f9f1c0d5b3a");
		expect(h.calls[0].body.name).toBe("CRM sync");
		expect(h.calls[0].body.events).toEqual(WH_EVENTS);
		expect(h.WH.error).toBe("");
		// A SUCCESSFUL create is the only thing that clears the form.
		expect(h.WH.form.url).toBe("");
	});

	it("a name is optional — the URL alone is enough", async () => {
		const h = harness();
		h.type("whUrl", "https://example.com/hooks/itsuki");
		await h.createWebhookNow();
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].body.name).toBe("");
	});

	it("respects unticked events instead of silently sending all four", async () => {
		const h = harness();
		h.type("whUrl", "https://example.com/hooks/itsuki");
		h.untick("memory.deleted");
		h.untick("memory.categorized");
		await h.createWebhookNow();
		expect(h.calls[0].body.events).toEqual(["memory.added", "memory.updated"]);
	});

	it("reads the DOM before rendering — a value state never saw still gets sent", async () => {
		// Autofill and some paste paths set an input's value WITHOUT firing
		// oninput, so state has not seen it. This is the case that isolates the
		// original bug: if anything re-renders before the read, the re-render
		// repopulates the field from empty state and the value is lost.
		const h = harness();
		h.fields.whUrl.value = "https://webhook.site/pasted-without-an-input-event";
		h.fields.whName.value = "Pasted";

		await h.createWebhookNow();

		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].body.url).toBe("https://webhook.site/pasted-without-an-input-event");
		expect(h.calls[0].body.name).toBe("Pasted");
	});

	it("a failed submit preserves every field the person filled in", async () => {
		const h = harness({ apiImpl: async () => { throw new Error("Endpoint rejected the test delivery."); } });
		h.type("whName", "CRM sync");
		h.type("whUrl", "https://example.com/hooks/itsuki");
		h.fields.whMetaOnly.checked = true;
		h.whField("metadataOnly", true);
		h.untick("memory.deleted");

		await h.createWebhookNow();

		expect(h.WH.error).toBe("Endpoint rejected the test delivery.");
		// Nothing was lost — state AND the re-rendered inputs still hold it.
		expect(h.WH.form.name).toBe("CRM sync");
		expect(h.WH.form.url).toBe("https://example.com/hooks/itsuki");
		expect(h.WH.form.metadataOnly).toBe(true);
		expect(h.WH.form.events).toEqual(["memory.added", "memory.updated", "memory.categorized"]);
		expect(h.fields.whUrl.value).toBe("https://example.com/hooks/itsuki");
		expect(h.fields.whName.value).toBe("CRM sync");
	});

	it("the error clears the moment the input is corrected", async () => {
		const h = harness();
		await h.createWebhookNow(); // empty URL → complaint
		expect(h.WH.error).toBeTruthy();
		expect(h.errorBox.hidden).toBe(false);

		h.type("whUrl", "https://example.com/hooks/itsuki");
		// Cleared on the keystroke, not on the next submit.
		expect(h.WH.error).toBe("");
		expect(h.errorBox.hidden).toBe(true);

		await h.createWebhookNow();
		expect(h.calls).toHaveLength(1);
	});

	it("blames the right thing, specifically, without a round trip", () => {
		const h = harness();
		expect(h.whUrlComplaint("")).toContain("Add the URL");
		expect(h.whUrlComplaint("example.com/hooks")).toContain("Add https://");
		expect(h.whUrlComplaint("ftp://example.com")).toContain("must start with https://");
		expect(h.whUrlComplaint("https://localhost")).toContain("full domain name");
		expect(h.whUrlComplaint("not a url at all")).toContain("valid URL");
		expect(h.whUrlComplaint("https://webhook.site/abc-123")).toBeNull();
		expect(h.whUrlComplaint("  https://example.com/hooks/itsuki  ")).toBeNull();
	});
});

describe("the server side of the same submit", () => {
	it("accepts a valid https URL with a name", async () => {
		const signup = new Request("http://example.com/auth/signup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: `wh-form-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: "WH", acceptTerms: true }),
		});
		let ctx = createExecutionContext();
		const authed = await worker.fetch(signup, env, ctx);
		await waitOnExecutionContext(ctx);
		const cookie = authed.headers.get("set-cookie").split(";")[0];

		const req = new Request("http://example.com/v1/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({
				name: "CRM sync",
				url: "https://webhook.site/6f1c2a9e-0b77-4c31-9a4e-2f9f1c0d5b3a",
				events: ["memory.added", "memory.updated", "memory.deleted", "memory.categorized"],
			}),
		});
		ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.webhook.name).toBe("CRM sync");
		expect(body.webhook.url).toBe("https://webhook.site/6f1c2a9e-0b77-4c31-9a4e-2f9f1c0d5b3a");
		expect(body.webhook.events).toHaveLength(4);
		expect(body.secret.startsWith("whsec_")).toBe(true);
	});

	it("an empty URL is what actually produced the old error — and still does", async () => {
		const signup = new Request("http://example.com/auth/signup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: `wh-empty-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: "WH", acceptTerms: true }),
		});
		let ctx = createExecutionContext();
		const authed = await worker.fetch(signup, env, ctx);
		await waitOnExecutionContext(ctx);
		const cookie = authed.headers.get("set-cookie").split(";")[0];

		const req = new Request("http://example.com/v1/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ name: "CRM sync", url: "", events: ["memory.added"] }),
		});
		ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
		expect((await res.json()).message).toContain("valid URL");
	});
});
