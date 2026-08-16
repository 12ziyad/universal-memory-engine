"""Whose memory this is, in a framework that never asks.

ADK's `app_name` and `user_id` are plain strings with no validation: whatever
the embedding application passes becomes the identity. So two things matter
here. They are hashed with length prefixes before they become a tenancy key, so
that ("ab","c") and ("a","bc") cannot collide and neither can be smuggled
through a delimiter. And the README says plainly what hashing cannot do -- it
prevents encoding attacks, not impersonation. Binding `user_id` to an
authenticated principal is the application's job, and no library can do it for
them.
"""

from __future__ import annotations

import hashlib
from typing import Dict, Optional

USER_TAG = "adk-itsuki:user:v1"
_LENGTH = 32


def digest(tag: str, *parts: Optional[str], length: int = _LENGTH) -> str:
    hasher = hashlib.sha256()
    hasher.update(tag.encode("utf-8"))
    for part in parts:
        raw = (part or "").encode("utf-8")
        hasher.update(len(raw).to_bytes(8, "big"))
        hasher.update(raw)
    return hasher.hexdigest()[:length]


def derive_user_id(app_name: str, user_id: str, namespace: Optional[str] = None) -> str:
    """The isolated memory space for one (app, user) pair."""
    return "adk1_" + digest(USER_TAG, namespace or "", app_name or "", user_id or "")


def scope_metadata(app_name: str) -> Dict[str, str]:
    """Attribution only. Nothing here selects a tenant."""
    scope: Dict[str, str] = {"agentId": "google-adk"}
    if app_name:
        # appId is the real SDK field; there is no appName.
        scope["appId"] = app_name if len(app_name) <= 128 else digest(USER_TAG, app_name)
    return scope
