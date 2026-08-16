"""Two people must never share a memory space.

A single Hermes install can serve a Telegram group or a Discord channel: one
process, one API key, many humans. The rule these tests defend is that the
authenticated sender always partitions, and a configured `user_id` can only
namespace that partition -- never replace it.
"""

from __future__ import annotations

from hermes_itsuki.identity import Tenancy, authority_id, digest


def gateway(**kwargs):
    base = {"platform": "telegram"}
    base.update(kwargs)
    return base


def test_length_prefixing_prevents_boundary_collisions():
    """("ab","c") and ("a","bc") are different inputs and must stay different."""
    assert digest("t", "ab", "c") != digest("t", "a", "bc")


def test_tags_separate_derivations():
    assert digest("tag-one", "x") != digest("tag-two", "x")


def test_two_gateway_senders_never_share_a_space():
    tenancy = Tenancy()
    tenancy.observe_host_kwargs(gateway())
    first, _ = tenancy.effective_user_id(gateway(user_id="alice"))
    second, _ = tenancy.effective_user_id(gateway(user_id="bob"))
    assert first and second and first != second


def test_same_sender_id_on_two_platforms_never_collides():
    """Sender ids are channel-scoped; without the platform, 12345 == 12345."""
    tenancy = Tenancy()
    tenancy.observe_host_kwargs(gateway())
    telegram, _ = tenancy.effective_user_id(gateway(platform="telegram", user_id="12345"))
    discord, _ = tenancy.effective_user_id(gateway(platform="discord", user_id="12345"))
    assert telegram != discord


def test_configured_user_id_namespaces_but_never_replaces_the_sender():
    """The regression that matters: a static id must not merge two humans."""
    tenancy = Tenancy("team-account")
    tenancy.observe_host_kwargs(gateway())
    alice, _ = tenancy.effective_user_id(gateway(user_id="alice"))
    bob, _ = tenancy.effective_user_id(gateway(user_id="bob"))
    assert alice != bob
    assert alice != "team-account" and bob != "team-account"


def test_namespace_changes_the_derived_space():
    plain = Tenancy()
    plain.observe_host_kwargs(gateway())
    namespaced = Tenancy("workspace-7")
    namespaced.observe_host_kwargs(gateway())
    a, _ = plain.effective_user_id(gateway(user_id="alice"))
    b, _ = namespaced.effective_user_id(gateway(user_id="alice"))
    assert a != b


def test_gateway_without_sender_identity_fails_closed():
    """No identity means no read and no write -- never a shared fallback."""
    tenancy = Tenancy("operator")
    tenancy.observe_host_kwargs(gateway())
    user_id, skip = tenancy.effective_user_id(gateway())
    assert user_id is None and skip == "no_identity"


def test_local_cli_install_uses_the_configured_space():
    tenancy = Tenancy("ada")
    tenancy.observe_host_kwargs({"platform": "cli"})
    user_id, skip = tenancy.effective_user_id({"platform": "cli"})
    assert user_id == "ada" and skip is None


def test_local_cli_without_config_uses_the_keys_default_space():
    tenancy = Tenancy()
    tenancy.observe_host_kwargs({"platform": "cli"})
    user_id, skip = tenancy.effective_user_id({"platform": "cli"})
    assert user_id is None and skip is None


def test_echo_scope_is_session_independent():
    """Recall happens before the host says which session we are in."""
    tenancy = Tenancy("ada")
    assert tenancy.echo_scope_key("ada") == tenancy.echo_scope_key("ada")
    assert tenancy.echo_scope_key("ada") != tenancy.echo_scope_key("bob")


def test_authority_id_changes_with_key_and_host():
    a = authority_id("https://itsuki.app", "itsuki_live_aaa")
    b = authority_id("https://itsuki.app", "itsuki_live_bbb")
    c = authority_id("https://other.example", "itsuki_live_aaa")
    assert a != b and a != c


def test_authority_id_never_contains_the_key():
    key = "itsuki_live_supersecretvalue"
    value = authority_id("https://itsuki.app", key)
    assert key not in value and "supersecret" not in value
