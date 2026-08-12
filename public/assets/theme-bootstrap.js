/* Apply appearance before CSS paints so Dark/System never flashes light. */
(() => {
	const key = "itsuki_theme";
	const allowed = new Set(["light", "dark", "system"]);
	let preference = "system";
	try {
		const stored = localStorage.getItem(key);
		if (allowed.has(stored)) preference = stored;
	} catch {}
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
	document.documentElement.dataset.themePreference = preference;
	document.documentElement.dataset.theme = resolved;
})();
