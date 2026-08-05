import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdkPath = process.argv[2];
if (!sdkPath) throw new Error("installed SDK path argument is required");
const sdk = await import(pathToFileURL(resolve(sdkPath)).href);

if (sdk.VERSION !== "0.2.1") throw new Error("wrong installed version export");
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
