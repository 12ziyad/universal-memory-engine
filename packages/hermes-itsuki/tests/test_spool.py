"""The spool's two jobs: never lose a settled turn, never cross an account.

The second one is the reason this file is long. A spool that survives a key
change is a machine for delivering one project's conversations under another
project's credential, and no amount of care elsewhere fixes that.
"""

from __future__ import annotations

import json
import os

import pytest

from hermes_itsuki.identity import authority_id
from hermes_itsuki.spool import MAX_ENVELOPES, SCHEMA, Spool


def body(text: str = "hello"):
    return {"messages": [{"role": "user", "content": text}], "conversation_id": "c1"}


def make(tmp_path, key="itsuki_live_alpha", base="https://itsuki.app"):
    return Spool(tmp_path / "itsuki", authority_id(base, key))


def test_staged_envelope_is_readable_and_scoped(tmp_path):
    spool = make(tmp_path)
    path = spool.stage("idem_a", body())
    assert path is not None
    envelope = spool.read(path)
    assert envelope["schema"] == SCHEMA
    assert envelope["authorityId"] == spool.authority
    assert envelope["idempotencyKey"] == "idem_a"


def test_a_different_key_cannot_see_or_drain_the_previous_spool(tmp_path):
    """The regression that matters: re-keying must not ship old content."""
    old = make(tmp_path, key="itsuki_live_old")
    old.stage("idem_old", body("secret from the old account"))
    assert len(old.pending()) == 1

    new = make(tmp_path, key="itsuki_live_new")
    assert new.pending() == [], "a new authority must start empty"
    assert old.authority in new.foreign_partitions()


def test_changing_the_service_host_also_changes_the_authority(tmp_path):
    a = make(tmp_path, base="https://itsuki.app")
    b = make(tmp_path, base="https://staging.example")
    a.stage("idem_a", body())
    assert b.pending() == []


def test_envelope_disagreeing_with_its_partition_is_never_delivered(tmp_path):
    spool = make(tmp_path)
    path = spool.stage("idem_a", body())
    envelope = json.loads(path.read_text(encoding="utf-8"))
    envelope["authorityId"] = "auth1_someone_else"
    path.write_text(json.dumps(envelope), encoding="utf-8")

    assert spool.read(path) is None
    assert spool.stats.quarantined_foreign == 1


def test_completion_leaves_a_body_free_tombstone(tmp_path):
    spool = make(tmp_path)
    path = spool.stage("idem_a", body("private content"))
    spool.complete(path)

    assert not path.exists()
    tombstone = json.loads(path.with_suffix(".done").read_text(encoding="utf-8"))
    assert tombstone["tombstone"] is True
    assert "body" not in tombstone
    assert "private content" not in json.dumps(tombstone)


def test_quarantine_preserves_the_envelope_for_a_human(tmp_path):
    spool = make(tmp_path)
    path = spool.stage("idem_a", body())
    spool.quarantine(path, "idempotency_conflict")
    assert not path.exists()
    kept = json.loads(path.with_suffix(".quarantine").read_text(encoding="utf-8"))
    assert kept["quarantine"] == "idempotency_conflict"


def test_overflow_drops_the_oldest_and_counts_the_loss(tmp_path):
    """Bounded, and honest about it: the loss is counted, never hidden."""
    spool = make(tmp_path)
    for index in range(MAX_ENVELOPES + 10):
        spool.stage(f"idem_{index:03d}", body(f"turn {index}"))

    assert spool.depth() <= MAX_ENVELOPES
    assert spool.stats.dropped_overflow >= 10


def test_claiming_is_exclusive_across_processes(tmp_path):
    spool = make(tmp_path)
    path = spool.stage("idem_a", body())
    claimed = spool.claim(path)
    assert claimed is not None
    assert spool.claim(path) is None, "a claimed envelope must not be claimable twice"
    spool.release(claimed, path)
    assert spool.claim(path) is not None


def test_stale_claims_are_returned_to_the_pool(tmp_path):
    clock = {"now": 1000.0}
    spool = Spool(tmp_path / "itsuki", "auth1_x", clock=lambda: clock["now"])
    path = spool.stage("idem_a", body())
    claimed = spool.claim(path)
    assert claimed is not None
    os.utime(claimed, (0, 0))  # pretend the owning process died long ago
    assert spool.reclaim_stale() == 1


def test_corrupt_envelopes_are_counted_not_crashed_and_not_deleted(tmp_path):
    spool = make(tmp_path)
    spool.ensure()
    bad = spool.partition / "garbage.json"
    bad.write_text("{not json", encoding="utf-8")
    assert spool.read(bad) is None
    assert spool.stats.corrupt == 1
    assert bad.exists(), "we never silently delete something we could not parse"


def test_a_symlinked_state_directory_is_refused(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "itsuki"
    try:
        link.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted on this host")
    spool = Spool(link, "auth1_x")
    with pytest.raises(OSError):
        spool.ensure()


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits")
def test_state_directory_is_owner_only(tmp_path):
    spool = make(tmp_path)
    spool.ensure()
    assert (spool.partition.stat().st_mode & 0o077) == 0


def test_filename_never_contains_raw_key_material(tmp_path):
    spool = make(tmp_path)
    path = spool.stage("idem_../../escape", body())
    assert path is not None
    assert ".." not in path.name and "/" not in path.name
