"""FR-002 single-flight lock, reusing the existing bus meeting-brief claim
primitives (src/bus/meeting-brief.ts claimEventLease/releaseEventLease via
src/cli/bus.ts meeting-brief-claim/meeting-brief-release). Never re-implements
the claim logic -- the CLI round-trip through Runner IS the lock."""
from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from runner import Runner


def lock_path(claims_dir: Path, name: str) -> Path:
    # G-LOCK-1: must reproduce src/bus/meeting-brief.ts claimLockPath exactly
    # -- sha256(eventId) hex digest, first 32 chars, "<hash>.lock".
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:32]
    return Path(claims_dir) / f"{digest}.lock"


class LeaseReleaseError(Exception):
    """The `meeting-brief-release` CLI call failed (non-zero rc, or the
    subprocess never returned). The lock stays held until its TTL expires while
    the run would otherwise report success, so the caller must surface it
    instead of returning 0 (G0B3-11)."""


class LeaseAcquireError(Exception):
    """`meeting-brief-claim` failed for an OPERATIONAL reason rather than
    losing a race: an unwritable claims dir, a missing `cortextos`, a timeout,
    or any refusal whose stderr names no real claim verdict.

    That distinction is load-bearing (G2A-3). `acquire` returning None means
    "another LIVE run holds the claim", and the caller turns that into exit 2
    with the success receipt left BYTE-IDENTICAL. Collapsing an operational
    failure into the same None reported a poller that could not run at all as
    ordinary contention, and the stale receipt kept the digest calm."""


class LeaseLost(Exception):
    """Raised by the caller when `Lease.lost` is set: the lock file this run
    holds has disappeared (a concurrent stale-sweep, or another poller already
    reclaimed it). Single-flight is no longer guaranteed, so the run must STOP
    before any further effect rather than keep writing (G0B2-13)."""


@dataclass
class Lease:
    claims_dir: Path
    name: str
    runner: Runner
    lost: bool = False

    def touch(self) -> None:
        """Heartbeat. If our OWN lock file is gone (src/bus/meeting-brief.ts
        unlinkSync stale-sweep, or another holder reclaimed it) we no longer
        own the lease: mark it lost so the caller stops BEFORE further effects.
        Silently continuing here would let two runs write concurrently and
        would let this run release somebody else's lease (G0B2-13)."""
        path = lock_path(self.claims_dir, self.name)
        try:
            os.utime(path, None)  # G-LOCK-2: heartbeat -- mtime bump, claimAgeMs treats mtime as authoritative
        except FileNotFoundError:
            self.lost = True  # G-LOCK-5

    def release(self) -> None:
        """Releases the lease. Raises LeaseReleaseError when the CLI refuses or
        never returns: a failed release leaves the lock live for up to its TTL,
        so every later poll refuses while this run claims success (G0B3-11)."""
        if self.lost:
            # G-LOCK-6: never release a lease we no longer own -- the lock file
            # under our name may now belong to the run that reclaimed it.
            return
        argv = [
            "cortextos",
            "bus",
            "meeting-brief-release",
            self.name,
            "--claims-dir",
            str(self.claims_dir),
        ]
        try:
            proc = self.runner.run(argv)
        except Exception as exc:  # noqa: BLE001 -- a timeout is a failed release too
            raise LeaseReleaseError(f"meeting-brief-release did not return: {exc}") from exc
        if proc.returncode != 0:  # G-LOCK-7
            raise LeaseReleaseError(
                f"meeting-brief-release rc={proc.returncode}: {(proc.stderr or '').strip()}"
            )


# A2 (binding): the lease must be heartbeated at least every 10 minutes for the
# whole time it is held. 5 minutes gives a 2x margin against a 60-minute TTL.
HEARTBEAT_INTERVAL_S = 300.0


@dataclass
class Heartbeat:
    """G0B3-6: a time-bounded heartbeat for the WHOLE acquired interval.

    Touching once per message is not enough: `gmail_source.sweep` runs before the
    first message and can issue a full-window query plus up to 14 daily ones,
    each through a runner whose default timeout is 120s; and a single message's
    read + extraction + writes have no natural boundary either. Both can outlast
    the staleness window while the run is very much alive.

    `tick()` is cheap and idempotent — it touches only when at least
    `interval_s` has elapsed on a MONOTONIC clock (injectable, so a test can
    simulate a long sweep without sleeping). Losing the lock raises LeaseLost at
    the next tick, so the run stops before its next effect."""

    lease: "Lease"
    clock: Callable[[], float] = time.monotonic
    interval_s: float = HEARTBEAT_INTERVAL_S
    _last: float = field(default=0.0, init=False)
    touches: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self._last = self.clock()

    def tick(self) -> None:
        # Liveness is checked on EVERY tick (one stat — negligible next to a
        # subprocess), so loss stops the run immediately rather than up to
        # `interval_s` later. The mtime TOUCH is what is rate-limited.
        if not self.lease.lost and not lock_path(self.lease.claims_dir, self.lease.name).exists():
            self.lease.lost = True
        if self.lease.lost:
            raise LeaseLost(
                "client-state-gmail lease disappeared mid-run — stopping before further writes"
            )
        now = self.clock()
        if now - self._last < self.interval_s:
            return
        self._last = now
        self.lease.touch()          # G-LOCK-8
        self.touches += 1
        if self.lease.lost:
            raise LeaseLost(
                "client-state-gmail lease disappeared mid-run — stopping before further writes"
            )


class HeartbeatRunner:
    """Wraps a Runner so EVERY call boundary is a heartbeat opportunity — the
    sweep's per-day queries, each `gws +read`, the `claude` call, and every CRM
    or bus write all go through `Runner.run`, so this is the one place that
    covers them all without threading a callback through six modules."""

    def __init__(self, inner, heartbeat: "Heartbeat") -> None:
        self.inner = inner
        self.heartbeat = heartbeat

    @property
    def calls(self):
        return getattr(self.inner, "calls", [])

    def run(self, argv, *, input=None, env=None, timeout: int = 120):
        self.heartbeat.tick()       # G-LOCK-8: before the call, so a long one is bracketed
        result = self.inner.run(argv, input=input, env=env, timeout=timeout)
        self.heartbeat.tick()       # and after, so the NEXT call starts from a fresh touch
        return result


def _claim_argv(claims_dir: Path, name: str, ttl_min: int) -> list[str]:
    return [
        "cortextos",
        "bus",
        "meeting-brief-claim",
        name,
        "--claims-dir",
        str(claims_dir),
        "--ttl-min",
        str(ttl_min),
    ]


# src/cli/bus.ts meeting-brief-claim prints `Already claimed <id> (<reason>)` on
# stderr, where <reason> is one of src/bus/meeting-brief.ts's two refusal
# verdicts. A non-zero rc naming NEITHER is not a claim verdict at all.
_CLAIM_VERDICTS = ("already-claimed", "stale-cleared")


def _claim_once(runner: Runner, argv: list[str]):
    try:
        return runner.run(argv)
    except Exception as exc:  # noqa: BLE001 -- a timeout/missing binary is operational, not contention
        raise LeaseAcquireError(f"meeting-brief-claim did not return: {exc}") from exc  # G-LOCK-9


def _refusal_or_raise(result) -> str:
    """The claim verdict named by a non-zero result's stderr; anything else is
    an operational failure and must never look like contention (G2A-3)."""
    stderr = result.stderr or ""
    verdict = next((v for v in _CLAIM_VERDICTS if v in stderr), None)
    if verdict is None:  # G-LOCK-9: no claim verdict named -> operational, never contention
        raise LeaseAcquireError(
            f"meeting-brief-claim rc={result.returncode}: {stderr.strip() or '(no stderr)'}"
        )
    return verdict


def acquire(
    runner: Runner, claims_dir: Path, name: str, ttl_min: int = 60,
    *, refusal: dict | None = None,
) -> Lease | None:
    """A Lease, or None when another poller holds the slot (`refusal["reason"]`
    then names the CLI's verdict). An OPERATIONAL failure raises
    LeaseAcquireError instead (G-LOCK-9).

    There is NO in-band retry. meeting-brief.ts deliberately unlinks a dead
    holder's lock and reports `stale-cleared` WITHOUT reclaiming, precisely so
    the call that DISCOVERS staleness never wins off that path; retrying
    immediately re-introduced the race it exists to prevent -- two pollers
    overlapping on the same stale lock could both clear and both win, and
    Lease.touch's existence-only heartbeat cannot tell whose lock it is
    holding. This run refuses (exit 2, receipt untouched); the NEXT sweep
    O_EXCL-claims the now-empty slot cleanly (G2r3-1).
    """
    argv = _claim_argv(claims_dir, name, ttl_min)
    result = _claim_once(runner, argv)
    if result.returncode == 0:  # G-LOCK-3: ONLY an rc-0 claim ever produces a Lease
        return Lease(claims_dir=Path(claims_dir), name=name, runner=runner)
    verdict = _refusal_or_raise(result)
    if refusal is not None:
        refusal["reason"] = verdict
    return None  # G-LOCK-4: NEVER a retry -- neither verdict wins in band
