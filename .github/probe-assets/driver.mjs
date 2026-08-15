// Phase-0 driver: drives the pinned OpenCode server via its own SDK so we can
// read back session/message shapes that `run` alone does not expose.
// P3 (injected part persistence), P4 (finish/success discrimination + the
// current-human-message boundary), P5 (subagent parentID), P13a (fork anchors).
// Loopback only. No credentials.
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk"
import { appendFileSync } from "node:fs"

const LOG = process.env.PROBE_LOG_DIR ?? "./logs"
const out = (o) => { const line = JSON.stringify(o); console.log(line); try { appendFileSync(`${LOG}/driver.jsonl`, line + "\n") } catch {} }
const PROJECT = process.env.PROBE_ROOT ? `${process.env.PROBE_ROOT}/project` : process.cwd()

const trimPart = (p) => ({
  id: p?.id, type: p?.type, synthetic: p?.synthetic, ignored: p?.ignored,
  messageID: p?.messageID, sessionID: p?.sessionID,
  text: p?.type === "text" ? String(p.text ?? "").slice(0, 100) : undefined,
})

let server
try {
  server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, config: { directory: PROJECT } })
  out({ probe: "server", url: server.url })
} catch (e) {
  out({ probe: "server", error: String(e?.message ?? e) })
  process.exit(0)
}

const client = createOpencodeClient({ baseUrl: server.url })

const messagesOf = async (id) => {
  const r = await client.session.messages({ path: { id }, query: { directory: PROJECT } })
  return r?.data ?? r ?? []
}

try {
  // ---- P3/P4: one real turn, then read the persisted transcript back.
  const created = await client.session.create({ body: { title: "probe-1" }, query: { directory: PROJECT } })
  const sid = (created?.data ?? created)?.id
  out({ probe: "session.create", sid })

  const before = await messagesOf(sid)
  out({ probe: "P4.boundary.before", count: before.length })

  const t0 = Date.now()
  const promptRes = await client.session.prompt({
    path: { id: sid },
    query: { directory: PROJECT },
    body: { parts: [{ type: "text", text: "PROBE_TURN_DRIVER: reply briefly." }] },
  })
  out({ probe: "P4.prompt.returned", ms: Date.now() - t0, keys: Object.keys(promptRes?.data ?? promptRes ?? {}) })

  const after = await messagesOf(sid)
  out({
    probe: "P3.persisted",
    messages: after.map((m) => ({
      id: m?.info?.id, role: m?.info?.role,
      finish: m?.info?.finish,
      error: m?.info?.error ? String(JSON.stringify(m.info.error)).slice(0, 160) : undefined,
      timeCreated: m?.info?.time?.created, timeCompleted: m?.info?.time?.completed,
      parts: (m?.parts ?? []).map(trimPart),
    })),
  })
  const injected = after.flatMap((m) => m.parts ?? []).filter((p) => String(p?.text ?? "").includes("PROBE_MARKER_XYZZY"))
  out({ probe: "P3.injected_survived", n: injected.length, parts: injected.map(trimPart) })

  // ---- P4(error): forced stub failure.
  const s2 = (await client.session.create({ body: { title: "probe-err" }, query: { directory: PROJECT } }))?.data
  const sid2 = s2?.id
  try {
    await client.session.prompt({ path: { id: sid2 }, query: { directory: PROJECT }, body: { parts: [{ type: "text", text: "PROBE_WANT_ERROR now" }] } })
  } catch (e) { out({ probe: "P4.error.threw", error: String(e?.message ?? e).slice(0, 200) }) }
  const errMsgs = await messagesOf(sid2)
  out({ probe: "P4.error.persisted", messages: errMsgs.map((m) => ({ role: m?.info?.role, finish: m?.info?.finish, error: m?.info?.error ? String(JSON.stringify(m.info.error)).slice(0, 200) : undefined, timeCompleted: m?.info?.time?.completed })) })

  // ---- P13a: fork and compare anchors.
  try {
    const forked = await client.session.fork({ path: { id: sid }, query: { directory: PROJECT } })
    const fid = (forked?.data ?? forked)?.id
    const fmsgs = await messagesOf(fid)
    const info = await client.session.get({ path: { id: fid }, query: { directory: PROJECT } })
    out({
      probe: "P13a.fork",
      forkedId: fid,
      parentID: (info?.data ?? info)?.parentID ?? null,
      originalIds: after.map((m) => m?.info?.id),
      forkedIds: fmsgs.map((m) => m?.info?.id),
      idsPreserved: JSON.stringify(after.map((m) => m?.info?.id)) === JSON.stringify(fmsgs.map((m) => m?.info?.id)),
      originalTimes: after.map((m) => m?.info?.time?.created),
      forkedTimes: fmsgs.map((m) => m?.info?.time?.created),
    })
  } catch (e) { out({ probe: "P13a.fork", error: String(e?.message ?? e).slice(0, 200) }) }

  // ---- P5: list children (subagent sessions) of the main session.
  try {
    const kids = await client.session.children({ path: { id: sid }, query: { directory: PROJECT } })
    out({ probe: "P5.children", n: ((kids?.data ?? kids) ?? []).length })
  } catch (e) { out({ probe: "P5.children", error: String(e?.message ?? e).slice(0, 160) }) }
} catch (e) {
  out({ probe: "driver.fatal", error: String(e?.stack ?? e).slice(0, 600) })
} finally {
  try { await server.close() } catch {}
  out({ probe: "done" })
}
