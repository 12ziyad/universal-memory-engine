import { appendFileSync, mkdirSync } from "node:fs"

const LOG = process.env.PROBE_LOG_DIR ?? "/root/probe/logs"
try { mkdirSync(LOG, { recursive: true }) } catch {}

const log = (name: string, data: unknown) => {
  try {
    appendFileSync(`${LOG}/hooks.jsonl`, JSON.stringify({ t: Date.now(), name, data }) + "\n")
  } catch {}
}

const trimPart = (p: any) => ({
  id: p?.id,
  type: p?.type,
  synthetic: p?.synthetic,
  ignored: p?.ignored,
  messageID: p?.messageID,
  sessionID: p?.sessionID,
  text: p?.type === "text" ? String(p.text ?? "").slice(0, 120) : undefined,
})

const ProbePlugin = async (ctx: any) => {
  log("init", {
    directory: ctx?.directory,
    worktree: ctx?.worktree,
    hasBunShell: typeof ctx?.$ !== "undefined",
    serverUrl: String(ctx?.serverUrl ?? ""),
  })
  return {
    "chat.message": async (input: any, output: any) => {
      log("chat.message", {
        input,
        messageID: output?.message?.id,
        msgSessionID: output?.message?.sessionID,
        msgTimeCreated: output?.message?.time?.created,
        partsBefore: (output?.parts ?? []).map(trimPart),
      })
      const sessionID = input?.sessionID ?? output?.message?.sessionID
      const messageID = input?.messageID ?? output?.message?.id
      const part = {
        id: "prt_probe" + Math.random().toString(36).slice(2, 12),
        sessionID,
        messageID,
        type: "text",
        text: "[PROBE-MEMORY-BEGIN] PROBE_MARKER_XYZZY: the capital of Freedonia is Fredville. [PROBE-MEMORY-END]",
        synthetic: true,
      }
      try {
        output.parts.push(part)
        log("chat.message.injected", { id: part.id, sessionID, messageID })
      } catch (e: any) {
        log("chat.message.inject_error", { error: String(e?.message ?? e) })
      }
    },
    event: async ({ event }: any) => {
      const type = event?.type ?? "unknown"
      const props = event?.properties ?? {}
      if (type === "message.part.updated") {
        log("event", { type, part: trimPart(props?.part), delta: props?.delta ? String(props.delta).slice(0, 40) : undefined })
      } else if (type === "message.updated") {
        const info = props?.info ?? {}
        log("event", {
          type,
          info: {
            id: info?.id, role: info?.role, sessionID: info?.sessionID,
            finish: info?.finish, error: info?.error ? String(JSON.stringify(info.error)).slice(0, 200) : undefined,
            timeCreated: info?.time?.created, timeCompleted: info?.time?.completed,
          },
        })
      } else {
        log("event", { type, properties: props })
      }
    },
    "experimental.session.compacting": async (input: any, _output: any) => {
      log("compacting", { input })
    },
    dispose: async () => {
      log("dispose", { t2: Date.now() })
    },
  }
}

export default { id: "probe", server: ProbePlugin }
