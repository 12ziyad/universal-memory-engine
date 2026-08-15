# Upstream-ready patch: a built-in `type: itsuki` memory store for ChatDev 2.0

This is the patch that would make Itsuki a first-class ChatDev memory backend,
alongside `simple`, `file`, `blackboard` and `mem0`. It is **prepared, not
submitted** — opening the PR needs separate explicit approval.

Verified against ChatDev `main` at commit `4fb2db0ea90375ce1059f44fe03ffbd191a7a169`
(cloned 2026-08-15). The store, config and full `MemoryManager` lifecycle are
exercised against these exact host types in `tests/test_store.py` (the
`requires_chatdev` lane, 20 passing).

## What the operator-wired package already proves

The pip package `chatdev-itsuki` implements the real contract today:

- `chatdev_itsuki/config.py` → `ItsukiMemoryConfig(BaseConfig)` with the real
  `from_dict` + `FIELD_SPECS` shape, mirroring `Mem0MemoryConfig`.
- `chatdev_itsuki/store.py` → `ItsukiMemoryStore(MemoryBase)` with the real
  `__init__(store: MemoryStoreConfig)`, `retrieve(agent_role, query, top_k,
  similarity_threshold) -> List[MemoryItem]`, `update(payload:
  MemoryWritePayload)`, `load`/`save`/`clear`.
- `chatdev_itsuki/register.py` → calls `register_memory_store("itsuki", …)`.

## The three upstream edits

To make it built-in (no operator import required), move the same code into the
ChatDev tree:

1. **`entity/configs/node/memory.py`** — add `ItsukiMemoryConfig` next to
   `Mem0MemoryConfig`. Body is identical to `chatdev_itsuki/config.py`, minus
   the standalone module docstring; it already uses `require_str`, `optional_str`,
   `require_mapping`, `ConfigFieldSpec` from `entity.configs.base`.

2. **`runtime/node/agent/memory/itsuki_memory.py`** (new) — the contents of
   `chatdev_itsuki/store.py`, with the vendored `_kernel` helpers either inlined
   or added as `runtime/node/agent/memory/_itsuki_kernel.py`. It already imports
   `MemoryBase`, `MemoryItem`, `MemoryContentSnapshot`, `MemoryWritePayload` from
   `runtime.node.agent.memory.memory_base` and `MemoryStoreConfig` from
   `entity.configs`.

3. **`runtime/node/agent/memory/builtin_stores.py`** — register it beside mem0:

   ```python
   def _create_itsuki_memory(store):
       from runtime.node.agent.memory.itsuki_memory import ItsukiMemoryStore
       return ItsukiMemoryStore(store)

   register_memory_store(
       "itsuki",
       config_cls=ItsukiMemoryConfig,
       factory=_create_itsuki_memory,
       summary="Itsuki durable cross-session memory with semantic recall",
   )
   ```

Add `itsukiai` (`itsuki>=0.3,<0.4`) to ChatDev's `pyproject.toml` optional
`storage` extra, matching how `mem0ai` is declared.

## Dependency note

The store's only runtime dependency is the `itsuki` SDK (`pip install itsuki`),
which is dependency-light (httpx). No Mem0 code is copied; the behaviours that
match the built-in mem0 store (user-input-only capture, header stripping, the
user_id/agent_id/agent_role scoping ladder) are reimplemented from the observable
contract, not lifted.

## Outstanding proof before "built-in" can be claimed

A full multi-agent workflow run driven by a live LLM. Everything up to and
including the real `MemoryManager.retrieve`/`update` cycle is proven; the
LLM-driven end-to-end run is the remaining gate.
