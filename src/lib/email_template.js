/**
 * The one Itsuki transactional email layout.
 *
 * Every sender (sign-in codes, invitations, whatever comes next) renders
 * through this module so the brand lives in exactly one place. Email clients
 * still demand table layout and inline styles, so those quirks are owned here
 * once. The output is deliberately self-contained: no images, no remote fonts,
 * no tracking parameters — a delivered message never phones home and renders
 * identically with remote content blocked.
 */

// Editorial palette, mirroring the product surfaces (app-editorial-v1.css).
const PAPER = "#f2ebdd";
const PORCELAIN = "#fbf8f1";
const INK = "#15130f";
const INK_SOFT = "#514b42";
const CLAY = "#c84f2a";
const BRASS = "#ae8741";
const HAIRLINE = "#d5c9b6";

// System stack for body copy; Georgia is the only near-universally installed
// serif, so it carries the editorial display heading without remote fonts.
const FONT_UI = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_SERIF = "Georgia,'Times New Roman',serif";
const FONT_MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function blockHtml(block) {
	switch (block?.type) {
		case "paragraph":
			return `<p style="margin:0 0 18px;color:${INK};font-family:${FONT_UI};font-size:15px;line-height:1.6">${escapeHtml(block.text)}</p>`;
		case "code":
			return `<div style="margin:0 0 18px;padding:18px;border:1px solid ${CLAY};background:#ffffff;color:${INK};font-family:${FONT_MONO};font-size:34px;font-weight:700;letter-spacing:.22em;text-align:center">${escapeHtml(block.value)}</div>`;
		case "button":
			// Bulletproof pattern: a table cell painted clay with a padded link on
			// top still reads as a button in clients that drop CSS on bare <a>. The
			// href is exactly the caller's URL — no tracking or query additions.
			return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr><td style="background:${CLAY};border-radius:2px"><a href="${escapeHtml(block.url)}" style="display:inline-block;padding:13px 22px;color:${PORCELAIN};font-family:${FONT_UI};font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(block.label)}</a></td></tr></table>`;
		case "note":
			return `<p style="margin:24px 0 0;color:${INK_SOFT};font-family:${FONT_UI};font-size:13px;line-height:1.5">${escapeHtml(block.text)}</p>`;
		// The three below exist for the longer transactional messages — a
		// completed deletion, a privacy-case response, an ownership handover.
		// Those need to say several things in order without becoming a wall of
		// paragraphs, which is how a careful message starts reading as spam.
		case "heading":
			return `<h2 style="margin:28px 0 12px;font-family:${FONT_SERIF};font-size:19px;font-weight:400;color:${INK}">${escapeHtml(block.text)}</h2>`;
		case "list":
			return `<ul style="margin:0 0 18px;padding-left:20px;color:${INK};font-family:${FONT_UI};font-size:15px;line-height:1.7">${
				(block.items ?? []).map((item) => `<li style="margin:0 0 6px">${escapeHtml(item)}</li>`).join("")
			}</ul>`;
		case "facts":
			// A key/value summary — "what exactly happened", in a form someone
			// can forward to their own compliance people without rewriting it.
			return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;border:1px solid ${HAIRLINE};background:#ffffff">${
				(block.rows ?? []).map(([label, value]) => `<tr>
					<td style="padding:9px 14px;border-bottom:1px solid ${HAIRLINE};color:${INK_SOFT};font-family:${FONT_UI};font-size:13px;white-space:nowrap">${escapeHtml(label)}</td>
					<td style="padding:9px 14px;border-bottom:1px solid ${HAIRLINE};color:${INK};font-family:${FONT_MONO};font-size:13px">${escapeHtml(value)}</td>
				</tr>`).join("")
			}</table>`;
		default:
			return "";
	}
}

function blockText(block) {
	switch (block?.type) {
		case "paragraph":
		case "note":
			return String(block.text ?? "");
		case "code":
			// The optional label keeps the code on one recognizable line in the
			// plain-text body ("Your verification code is: 123456") — people and
			// automation both key on label and code staying together.
			return block.label ? `${block.label} ${block.value}` : String(block.value ?? "");
		case "button":
			return `${block.label}:\n${block.url}`;
		case "heading":
			return `\n${String(block.text ?? "")}\n${"-".repeat(String(block.text ?? "").length)}`;
		case "list":
			return (block.items ?? []).map((item) => `  - ${item}`).join("\n");
		case "facts":
			return (block.rows ?? []).map(([label, value]) => `  ${label}: ${value}`).join("\n");
		default:
			return "";
	}
}

/**
 * Render one transactional email in the shared Itsuki layout.
 *
 * `blocks` is an ordered array of:
 *   { type: "paragraph", text }
 *   { type: "code", value, label? }  — large one-time code; `label` only
 *                                      prefixes the plain-text line
 *   { type: "button", label, url }   — href is the exact `url`, untouched
 *   { type: "note", text }           — small muted print inside the card
 * `footnote` renders as muted small print under the card. Every string is
 * HTML-escaped; the text variant carries the same content as plain text.
 */
export function renderEmail({ kicker, heading, intro, blocks = [], footnote } = {}) {
	const parts = Array.isArray(blocks) ? blocks : [];
	const html = `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:${FONT_UI}">
	<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${PAPER}"><tr><td align="center" style="padding:40px 16px">
	<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:${PORCELAIN};border:1px solid ${HAIRLINE}"><tr><td style="padding:36px">
	<div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${CLAY};font-family:${FONT_UI};font-weight:700">${escapeHtml(kicker)}</div>
	<h1 style="margin:18px 0 10px;font-family:${FONT_SERIF};font-size:30px;font-weight:400;color:${INK}">${escapeHtml(heading)}</h1>
	${intro ? `<p style="margin:0 0 22px;color:${INK_SOFT};font-family:${FONT_UI};font-size:15px;line-height:1.6">${escapeHtml(intro)}</p>` : ""}
	${parts.map(blockHtml).filter(Boolean).join("\n\t")}
	</td></tr></table>
	${footnote ? `<div style="max-width:520px;margin:14px auto 0;color:${BRASS};font-family:${FONT_UI};font-size:12px;line-height:1.5">${escapeHtml(footnote)}</div>` : ""}
	</td></tr></table></body></html>`;
	const text = [kicker, heading, intro, ...parts.map(blockText), footnote]
		.map((part) => String(part ?? "").trim())
		.filter(Boolean)
		.join("\n\n");
	return { html, text };
}
