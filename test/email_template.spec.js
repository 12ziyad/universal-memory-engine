import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/lib/email_template.js";

// The shared layout is the only place transactional HTML is produced, so its
// contract — escaping, exact button hrefs, no remote loads — is pinned here
// once instead of per sender.
describe("shared transactional email template", () => {
	const url = "https://itsuki.app/app#invite=token-123";

	function renderSample(overrides = {}) {
		return renderEmail({
			kicker: "Itsuki · secure access",
			heading: "Your sign-in code",
			intro: "Enter this code in the browser where you started signing in.",
			blocks: [
				{ type: "code", value: "271828", label: "Your verification code is:" },
				{ type: "paragraph", text: "A plain paragraph." },
				{ type: "button", label: "Review invitation", url },
				{ type: "note", text: "Small muted print." },
			],
			footnote: "Sent by Itsuki.",
			...overrides,
		});
	}

	it("renders every block into both html and clean plain text", () => {
		const { html, text } = renderSample();
		for (const surface of [html, text]) {
			expect(surface).toContain("Itsuki · secure access");
			expect(surface).toContain("Your sign-in code");
			expect(surface).toContain("271828");
			expect(surface).toContain("A plain paragraph.");
			expect(surface).toContain("Review invitation");
			expect(surface).toContain(url);
			expect(surface).toContain("Small muted print.");
			expect(surface).toContain("Sent by Itsuki.");
		}
		expect(text).not.toContain("<");
		// The code stays on one recognizable line for people and tooling alike.
		expect(text).toMatch(/^Your verification code is: 271828$/m);
		expect(html).toContain('lang="en"');
		expect(html).toContain('role="presentation"');
	});

	it("keeps the button href byte-identical to the caller's URL with no additions", () => {
		const { html } = renderSample();
		expect(html).toContain(`href="${url}"`);
		// Exactly one link, and no tracking baggage appended anywhere.
		expect(html.match(/href=/g)).toHaveLength(1);
		expect(html).not.toMatch(/utm_|[?&]ref=|tracking/i);
	});

	it("loads nothing remote: no images, imports, external styles or fonts", () => {
		const { html } = renderSample();
		expect(html).not.toMatch(/<img|<link|<script|@import|url\(|src=/i);
		// Every http(s) occurrence must be the one href the caller passed.
		expect(html.match(/https?:/g)).toHaveLength(1);
	});

	it("escapes user-controlled strings in every slot, including attributes", () => {
		const { html } = renderEmail({
			kicker: "<kicker>",
			heading: "<script>alert(1)</script>",
			intro: 'Acme "& <Partners>',
			blocks: [
				{ type: "paragraph", text: "<b>bold</b>" },
				{ type: "button", label: "<Go>", url: 'https://itsuki.app/"><script>' },
				{ type: "note", text: "<note>" },
				{ type: "code", value: "<1234>" },
			],
			footnote: "<foot>",
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<b>bold</b>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("Acme &quot;&amp; &lt;Partners&gt;");
		expect(html).toContain('href="https://itsuki.app/&quot;&gt;&lt;script&gt;"');
	});

	it("omits absent intro and footnote and ignores unknown block types", () => {
		const { html, text } = renderEmail({
			kicker: "Itsuki",
			heading: "Heading only",
			blocks: [{ type: "surprise", text: "never rendered" }],
		});
		expect(html).toContain("Heading only");
		expect(html).not.toContain("never rendered");
		expect(text).toBe("Itsuki\n\nHeading only");
	});
});
