"""FR-002 single-flight lock: acquire/touch/release via the bus meeting-brief
claim primitives (src/bus/meeting-brief.ts claimEventLease/releaseEventLease
:336-353 claimAgeMs, wired through src/cli/bus.ts meeting-brief-claim /
meeting-brief-release)."""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import time
from pathlib import Path
from subprocess import CompletedProcess

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import single_flight as SF
from helpers_client_state import FakeRunner
from runner import SubprocessRunner

CLAIM_PREFIX = ["cortextos", "bus", "meeting-brief-claim"]


def test_acquire_returns_lease_on_won(tmp_path) -> None:
    runner = FakeRunner()
    runner.record(CLAIM_PREFIX, rc=0, stdout="Claimed x (won)\n")
    claims_dir = tmp_path / "claims"
    lease = SF.acquire(runner, claims_dir, "client-state-lock", ttl_min=60)
    assert lease is not None
    assert lease.name == "client-state-lock"
    assert lease.claims_dir == claims_dir
    assert len(runner.calls) == 1
    assert runner.calls[0] == [
        "cortextos",
        "bus",
        "meeting-brief-claim",
        "client-state-lock",
        "--claims-dir",
        str(claims_dir),
        "--ttl-min",
        "60",
    ]


def test_acquire_returns_none_on_nonzero_rc(tmp_path) -> None:
    runner = FakeRunner()
    runner.record(CLAIM_PREFIX, rc=1, stderr="Already claimed x (already-claimed)\n")
    claims_dir = tmp_path / "claims"
    lease = SF.acquire(runner, claims_dir, "client-state-lock", ttl_min=60)
    assert lease is None
    # G-LOCK-3: a plain (non-stale) refusal does NOT retry.
    assert len(runner.calls) == 1


def test_acquire_retries_once_on_stale_cleared_stderr_and_wins(tmp_path) -> None:
    # G-LOCK-4 / C11: a stale-cleared refusal is retried once, in-process, so
    # the caller wins the now-empty slot without waiting for the next tick.
    runner = FakeRunner(
        [
            (CLAIM_PREFIX, CompletedProcess([], returncode=1, stdout="", stderr="Already claimed x (stale-cleared)\n")),
            (CLAIM_PREFIX, CompletedProcess([], returncode=0, stdout="Claimed x (won)\n", stderr="")),
        ]
    )
    claims_dir = tmp_path / "claims"
    lease = SF.acquire(runner, claims_dir, "client-state-lock", ttl_min=60)
    assert lease is not None
    assert len(runner.calls) == 2


def test_lock_path_reproduces_claimLockPath_filename() -> None:
    # G-LOCK-1: must match src/bus/meeting-brief.ts claimLockPath exactly --
    # sha256(name) hex, first 32 chars, "<hash>.lock" under claims_dir.
    claims_dir = Path("/tmp/whatever-claims")
    name = "client-state-lock"
    expected_hash = hashlib.sha256(name.encode("utf-8")).hexdigest()[:32]
    got = SF.lock_path(claims_dir, name)
    assert got == claims_dir / f"{expected_hash}.lock"


def test_lease_touch_advances_lock_mtime(tmp_path) -> None:
    claims_dir = tmp_path / "claims"
    claims_dir.mkdir()
    name = "client-state-lock"
    path = SF.lock_path(claims_dir, name)
    path.write_text("old", encoding="utf-8")
    old_time = time.time() - 3600
    os.utime(path, (old_time, old_time))
    before = path.stat().st_mtime

    lease = SF.Lease(claims_dir=claims_dir, name=name, runner=FakeRunner())
    lease.touch()

    after = path.stat().st_mtime
    assert after > before


def test_lease_touch_missing_lock_file_marks_the_lease_lost(tmp_path) -> None:
    """G-LOCK-5 / G0B2-13: a concurrent stale-sweep can unlink our own live
    lock between heartbeats. touch() must not crash the run -- and must not
    silently pretend we still hold the lease either: it records `lost` so the
    caller can stop BEFORE any further effect, and release() then becomes a
    no-op (the lock under our name may already belong to someone else)."""
    claims_dir = tmp_path / "claims"
    claims_dir.mkdir()
    runner = FakeRunner()
    lease = SF.Lease(claims_dir=claims_dir, name="vanished-lock", runner=runner)
    assert lease.lost is False
    lease.touch()  # must not raise
    assert lease.lost is True
    assert not SF.lock_path(claims_dir, "vanished-lock").exists()
    lease.release()  # G-LOCK-6: never release a lease we no longer own
    assert runner.calls == []


def test_lease_release_runs_meeting_brief_release_with_claims_dir(tmp_path) -> None:
    claims_dir = tmp_path / "claims"
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "meeting-brief-release"), rc=0, stdout="released")
    lease = SF.Lease(claims_dir=claims_dir, name="client-state-lock", runner=runner)
    lease.release()
    assert len(runner.calls) == 1
    assert runner.calls[0] == [
        "cortextos",
        "bus",
        "meeting-brief-release",
        "client-state-lock",
        "--claims-dir",
        str(claims_dir),
    ]


@pytest.mark.skipif(
    not (shutil.which("cortextos") and os.environ.get("CLIENT_STATE_LIVE_BUS") == "1"),
    reason="requires cortextos on PATH and CLIENT_STATE_LIVE_BUS=1 for a live bus claim/release round-trip",
)
def test_acquire_live_bus_stale_lock_cleared_then_next_claim_wins(tmp_path) -> None:
    runner = SubprocessRunner()
    claims_dir = tmp_path / "claims"
    name = "client-state-single-flight-live-test"

    lease1 = SF.acquire(runner, claims_dir, name, ttl_min=60)
    assert lease1 is not None

    lease2 = SF.acquire(runner, claims_dir, name, ttl_min=60)
    assert lease2 is None

    # G-LOCK-3 / G0B-21: claimAgeMs (meeting-brief.ts:336-353) takes the
    # NEWER of the lock's mtime and its stored content millisecond
    # timestamp -- ageing only mtime leaves the freshly-written content
    # timestamp live and the lease never goes stale. Age BOTH.
    path = SF.lock_path(claims_dir, name)
    stale_ms = int((time.time() - 61 * 60) * 1000)
    path.write_text(str(stale_ms), encoding="utf-8")
    stale_s = stale_ms / 1000.0
    os.utime(path, (stale_s, stale_s))

    # Probe the raw CLI directly (bypassing acquire()'s own G-LOCK-4 retry)
    # to prove the lock is genuinely stale at the bus-CLI level: rc != 0,
    # reason stale-cleared, and the lock file is now gone.
    refusal = runner.run(
        [
            "cortextos",
            "bus",
            "meeting-brief-claim",
            name,
            "--claims-dir",
            str(claims_dir),
            "--ttl-min",
            "60",
        ]
    )
    assert refusal.returncode != 0
    assert "stale-cleared" in (refusal.stderr or "")
    assert not path.exists()

    # The SUBSEQUENT acquire() call -- now that the stale lock is cleared --
    # wins cleanly via the normal fast path.
    lease3 = SF.acquire(runner, claims_dir, name, ttl_min=60)
    assert lease3 is not None

    lease3.release()


def test_lease_release_nonzero_rc_raises_lease_release_error(tmp_path) -> None:
    """G0B3-11: a failed release leaves the lock live until its TTL expires, so
    every later poll refuses while this run would otherwise report success. It
    must not be swallowed."""
    claims_dir = tmp_path / "claims"
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "meeting-brief-release"), rc=1, stdout="", stderr="claims dir read-only")
    lease = SF.Lease(claims_dir=claims_dir, name="client-state-lock", runner=runner)
    try:
        lease.release()
        assert False, "expected LeaseReleaseError"
    except SF.LeaseReleaseError as exc:      # G-LOCK-7
        assert "read-only" in str(exc)


def test_lease_release_timeout_raises_lease_release_error(tmp_path) -> None:
    """A subprocess that never returns is a failed release too."""
    import subprocess as _sp

    class _TimingOutRunner:
        calls: list = []

        def run(self, argv, *, input=None, env=None, timeout=120):
            self.calls.append(list(argv))
            raise _sp.TimeoutExpired(cmd=argv, timeout=timeout)

    lease = SF.Lease(claims_dir=tmp_path / "claims", name="client-state-lock", runner=_TimingOutRunner())
    try:
        lease.release()
        assert False, "expected LeaseReleaseError"
    except SF.LeaseReleaseError as exc:      # G-LOCK-7
        assert "did not return" in str(exc)


def test_lost_lease_release_is_a_noop_and_never_raises(tmp_path) -> None:
    runner = FakeRunner()   # would return rc 127 for any call
    lease = SF.Lease(claims_dir=tmp_path / "claims", name="client-state-lock", runner=runner, lost=True)
    lease.release()
    assert runner.calls == []


# --- G2A-3: contention vs operational failure --------------------------------
# `acquire` returning None means "someone else holds a LIVE claim" and the
# caller turns that into exit 2 with an untouched success receipt. An unwritable
# claims dir, a missing `cortextos`, or a timed-out claim call is NOT contention
# — collapsing it to None hid a poller that could not run at all.

def test_acquire_raises_on_an_operational_claim_failure(tmp_path) -> None:
    runner = FakeRunner()
    runner.record(CLAIM_PREFIX, rc=1, stderr="EACCES: permission denied, mkdir '/claims'\n")
    with pytest.raises(SF.LeaseAcquireError) as exc:
        SF.acquire(runner, tmp_path / "claims", "client-state-lock", ttl_min=60)
    assert "permission denied" in str(exc.value)
    assert len(runner.calls) == 1          # G-LOCK-3: still no retry


def test_acquire_raises_when_the_claim_command_cannot_run(tmp_path) -> None:
    class _Missing(FakeRunner):
        def run(self, argv, **kw):
            self.calls.append(list(argv))
            raise FileNotFoundError(2, "No such file or directory: 'cortextos'")

    with pytest.raises(SF.LeaseAcquireError) as exc:
        SF.acquire(_Missing(), tmp_path / "claims", "client-state-lock", ttl_min=60)
    assert "cortextos" in str(exc.value)


def test_acquire_raises_when_the_stale_retry_fails_operationally(tmp_path) -> None:
    runner = FakeRunner()
    runner.record(CLAIM_PREFIX, rc=1, stderr="Already claimed x (stale-cleared)\n")
    runner.record(CLAIM_PREFIX, rc=1, stderr="EACCES: permission denied\n")
    with pytest.raises(SF.LeaseAcquireError):
        SF.acquire(runner, tmp_path / "claims", "client-state-lock", ttl_min=60)


def test_acquire_returns_none_when_the_stale_retry_finds_a_live_claim(tmp_path) -> None:
    runner = FakeRunner()
    runner.record(CLAIM_PREFIX, rc=1, stderr="Already claimed x (stale-cleared)\n")
    runner.record(CLAIM_PREFIX, rc=1, stderr="Already claimed x (already-claimed)\n")
    assert SF.acquire(runner, tmp_path / "claims", "client-state-lock", ttl_min=60) is None
