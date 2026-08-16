// Loopback Itsuki stand-in. Records every request so the harness can assert on
// exactly what the plugin sent. Never contacts production.
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.ITSUKI_STUB_PORT ?? 4242);
const LOG = process.env.PROBE_LOG_DIR ?? "/tmp";
const MODE = () => process.env.ITSUKI_STUB_MODE ?? "ok"; // ok | offline | slow | 429 | 500

writeFileSync(`${LOG}/itsuki.jsonl`, "");
const rec = (o) => { try { appendFileSync(`${LOG}/itsuki.jsonl`, JSON.stringify({ t: Date.now(), ...o }) + "\n"); } catch {} };

const body = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch { res({}); } }); });

http.createServer(async (req, res) => {
  const mode = MODE();
  const payload = await body(req);
  const url = req.url || "";

  if (url.startsWith("/v1/recall")) {
    rec({ kind: "recall", query: String(payload.query ?? "").slice(0, 200), userId: payload.userId ?? null, conversationId: payload.conversationId ?? null });
    if (mode === "offline") { res.destroy(); return; }
    if (mode === "slow") { await new Promise((r) => setTimeout(r, 30000)); }
    if (mode === "429") { res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }); res.end(JSON.stringify({ error: "rate_limited" })); return; }
    if (mode === "500") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "boom" })); return; }
    const ctx = process.env.ITSUKI_STUB_CONTEXT ?? "PROBE_RECALL_NEEDLE_OMEGA: the deploy branch is main.";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: 1, context: ctx }));
    return;
  }

  if (url.startsWith("/v1/save")) {
    rec({ kind: "save", idempotencyKey: payload.idempotencyKey ?? null, userId: payload.userId ?? null,
          conversationId: payload.conversationId ?? null, mode: payload.mode ?? null,
          messages: (payload.messages ?? []).map((m) => ({ role: m.role, content: String(m.content ?? "") })) });
    if (mode === "offline") { res.destroy(); return; }
    if (mode === "500") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "boom" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, receipt_id: "receipt_stub_" + Math.random().toString(36).slice(2, 10), source_packet_id: "sp_stub" }));
    return;
  }

  rec({ kind: "other", url });
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}).listen(PORT, "127.0.0.1", () => rec({ kind: "listen", port: PORT }));
