import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdkPath = process.argv[2];
if (!sdkPath) throw new Error("installed SDK path argument is required");
const sdk = await import(pathToFileURL(resolve(sdkPath)).href);

// Assert AGREEMENT with the packed metadata, never a literal. A version pinned
// in one file and forgotten in another is exactly how a release ships lying
// about which version it is.
const installedPkg = JSON.parse(
	readFileSync(new URL("./package.json", pathToFileURL(process.argv[2])), "utf8"),
);
if (sdk.VERSION !== installedPkg.version) {
	throw new Error(`installed VERSION ${sdk.VERSION} does not match packed package.json ${installedPkg.version}`);
}
if (sdk.default !== sdk.MemoryClient || sdk.Memory !== sdk.MemoryClient) {
	throw new Error("exports mismatch");
}

let seen;
globalThis.fetch = async (url, init) => {
	seen = { url: String(url), auth: init.headers.authorization };
	return new Response(
		JSON.stringify({ ok: true, status: "completed", source_packet_id: "src_tar" }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
};

const client = new sdk.MemoryClient({
	apiKey: "install_test_key",
	baseUrl: "https://api.example",
	userId: "default",
});
const done = await client.waitFor("src_tar", { timeoutMs: 0, userId: "tar-user" });

if (done.status !== "completed") throw new Error("completed was not terminal");
if (new URL(seen.url).searchParams.get("userId") !== "tar-user") {
	throw new Error("per-call scope lost");
}
if (seen.auth !== "Bearer install_test_key") throw new Error("auth header lost");

console.log("TARBALL_IMPORT_OK", sdk.VERSION, done.status);
