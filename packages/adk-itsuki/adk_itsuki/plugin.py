"""Automatic capture, which ADK does not ship.

Nothing in the framework ever calls ``add_session_to_memory``; the documented
pattern is a callback the application writes. This plugin is that callback,
placed where it fires **once per invocation** rather than once per agent.

The ownership guard is the security-critical part. ``AgentTool`` builds a child
``Runner`` with an ``InMemoryMemoryService``, forwards the parent's plugins into
it when ``include_plugins`` is set, and turns the tool's *arguments* into a
``role='user'`` message. Without a guard, this plugin would fire inside that
child run and capture tool arguments as if a person had typed them. So every
callback acts only when the run it is in is wired to *our* service -- and there
is deliberately no fallback to a bound instance, because that fallback is
exactly the hole.
"""

from __future__ import annotations

from typing import Any, Optional

from google.adk.plugins.base_plugin import BasePlugin

from .capture import STATE_KEY, is_settled
from .context import Invocation
from .service import ItsukiMemoryService


class ItsukiMemoryPlugin(BasePlugin):
    """Installs invocation identity, then captures the settled turn."""

    def __init__(self, name: str = "itsuki_memory", *, service: Optional[ItsukiMemoryService] = None) -> None:
        super().__init__(name=name)
        self._service = service
        self._pending_root: dict[str, str] = {}
        self.foreign_runs = 0
        self.before_run_failures = 0

    # ------------------------------------------------------------------ guard
    def _service_for(self, invocation_context: Any) -> Optional[ItsukiMemoryService]:
        """Our service, or nothing at all.

        A child AgentTool run carries an InMemoryMemoryService, so it lands
        here as `None` and every hook becomes a counted no-op.
        """
        service = getattr(invocation_context, "memory_service", None)
        if not isinstance(service, ItsukiMemoryService):
            self.foreign_runs += 1
            return None
        if self._service is not None and service is not self._service:
            self.foreign_runs += 1
            return None
        return service

    @staticmethod
    def _invocation(invocation_context: Any) -> Invocation:
        session = getattr(invocation_context, "session", None)
        agent = getattr(invocation_context, "agent", None)
        return Invocation(
            invocation_id=getattr(invocation_context, "invocation_id", "") or "",
            app_name=getattr(session, "app_name", "") or "",
            user_id=getattr(session, "user_id", "") or "",
            session_id=getattr(session, "id", "") or "",
            root_agent=getattr(agent, "name", "") or "",
            root_branch=getattr(invocation_context, "branch", "") or "",
        )

    # ------------------------------------------------------------- lifecycle
    async def before_run_callback(self, *, invocation_context: Any, **kwargs: Any) -> None:
        """Guard, clear anything stale, record attribution, install identity.

        Ordering matters: identity goes in last, so a failure earlier leaves
        nothing half-installed. Any failure rolls back and returns quietly --
        a memory plugin must not be able to stop a run from starting.
        """
        service = self._service_for(invocation_context)
        if service is None:
            return None
        invocation = self._invocation(invocation_context)
        # before_agent_callback fires per agent and cannot tell which one is
        # the root, so the answer is recorded here, where it is unambiguous.
        self._pending_root[invocation.invocation_id] = invocation.root_agent
        try:
            service.tokens.enter(invocation)
        except Exception:  # noqa: BLE001
            self.before_run_failures += 1
            service.tokens.rollback(invocation.invocation_id)
        return None

    async def before_agent_callback(self, *, agent: Any, callback_context: Any, **kwargs: Any) -> None:
        """Record who the root agent is, through ADK's own durable channel.

        Author-name attribution has to survive a restart and a later import,
        but the root agent's name lives in the invocation context, not in the
        events. Writing it to `callback_context.state` records a state *delta*,
        which the session service persists; mutating `session.state` directly
        does not survive, because the service hands out copies.

        Only the first agent of an invocation writes the marker, so a
        sub-agent cannot overwrite the root's name with its own.
        """
        invocation = None
        try:
            state = getattr(callback_context, "state", None)
            if state is None:
                return None
            invocation_id = getattr(callback_context, "invocation_id", "") or ""
            if not invocation_id:
                return None
            markers = state.get(STATE_KEY)
            markers = dict(markers) if isinstance(markers, dict) else {}
            if invocation_id in markers:
                return None  # the root already claimed this invocation
            root_name = self._pending_root.get(invocation_id) or getattr(agent, "name", "") or ""
            markers[invocation_id] = {"root": root_name, "branch": ""}
            state[STATE_KEY] = markers
        except Exception:  # noqa: BLE001 - never let bookkeeping break a run
            self.before_run_failures += 1
        return None

    async def on_user_message_callback(self, *, invocation_context: Any, user_message: Any, **kwargs: Any) -> None:
        # Identity is already installed by before_run; nothing to add, and the
        # message is never modified.
        return None

    async def after_run_callback(self, *, invocation_context: Any, **kwargs: Any) -> None:
        """Capture, if the invocation actually settled.

        This callback also fires when a caller merely stops iterating the
        event stream, so "we got here" is not evidence of completion -- the
        predicate reads the persisted events instead.
        """
        service = self._service_for(invocation_context)
        if service is None:
            return None
        invocation = self._invocation(invocation_context)
        try:
            session = getattr(invocation_context, "session", None)
            if session is not None:
                await service.capture_invocation(session, invocation)
        except Exception:  # noqa: BLE001 - capture never breaks a run
            service.counters["capture_failed"] += 1
        finally:
            # Reset on the way out, whatever happened above, including a
            # cancellation raised through this callback.
            service.tokens.exit(invocation.invocation_id)
            service.forget_invocation(invocation.invocation_id)
            self._pending_root.pop(invocation.invocation_id, None)
        return None

    async def on_run_error_callback(self, *, invocation_context: Any, error: BaseException, **kwargs: Any) -> None:
        """The ordinary-error exit path. Present from ADK 2.5.0."""
        service = self._service_for(invocation_context)
        if service is None:
            return None
        invocation = self._invocation(invocation_context)
        service.tokens.exit(invocation.invocation_id)
        service.forget_invocation(invocation.invocation_id)
        self._pending_root.pop(invocation.invocation_id, None)
        return None

    async def close(self) -> None:
        if self._service is not None:
            await self._service.aclose()
        return None
