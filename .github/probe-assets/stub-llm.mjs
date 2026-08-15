// Minimal OpenAI-compatible stub for deterministic probe turns. Loopback only.
import http from "node:http"
import { appendFileSync } from "node:fs"

const PORT = Number(process.env.STUB_PORT ?? 4141)
const LOG = process.env.PROBE_LOG_DIR ?? "/root/probe/logs"
const log = (x) => { try { appendFileSync(`${LOG}/llm.jsonl`, JSON.stringify({ t: Date.now(), ...x }) + "\n") } catch {} }

const readBody = (req) => new Promise((res) => {
  let d = ""
  req.on("data", (c) => (d += c))
  req.on("end", () => { try { res(JSON.parse(d || "{}")) } catch { res({}) } })
})

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

http.createServer(async (req, res) => {
  if (req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "probe-1", object: "model", owned_by: "stub" }] }))
    return
  }
  if (req.url?.startsWith("/v1/chat/completions")) {
    const body = await readBody(req)
    const msgs = body?.messages ?? []
    const flat = JSON.stringify(msgs)
    const last = msgs[msgs.length - 1]
    log({ kind: "completion", stream: !!body.stream, model: body.model, nMsgs: msgs.length,
          sawMarker: flat.includes("PROBE_MARKER_XYZZY"), lastRole: last?.role,
          lastText: String(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")).slice(0, 200) })
    const wantErr = flat.includes("PROBE_WANT_ERROR")
    const wantSlow = flat.includes("PROBE_WANT_SLOW")
    if (wantErr) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "stub-forced-error", type: "server_error" } })); return }
    const content = flat.includes("PROBE_MARKER_XYZZY")
      ? "PROBE_ANSWER: marker-seen. Fredville confirmed."
      : "PROBE_ANSWER: no-marker."
    const id = "chatcmpl-stub" + Date.now()
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      sse(res, { id, object: "chat.completion.chunk", created: 0, model: "probe-1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
      const words = content.split(" ")
      for (const w of words) {
        sse(res, { id, object: "chat.completion.chunk", created: 0, model: "probe-1", choices: [{ index: 0, delta: { content: w + " " }, finish_reason: null }] })
        if (wantSlow) await new Promise((r) => setTimeout(r, 1500))
      }
      sse(res, { id, object: "chat.completion.chunk", created: 0, model: "probe-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
      res.write("data: [DONE]\n\n")
      res.end()
    } else {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id, object: "chat.completion", created: 0, model: "probe-1",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
    }
    return
  }
  res.writeHead(404); res.end("{}")
}).listen(PORT, "127.0.0.1", () => log({ kind: "listen", port: PORT }))
