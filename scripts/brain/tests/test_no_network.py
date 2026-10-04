"""External-write boundary proof (G-OPS-4): with shims/gws-trap,
shims/claude-trap, and shims/cortextos first on PATH, the focused
client-state/gmail/extract_email/single_flight test slice produces zero TRAP
lines - proving no test reaches a real transport. A separate positive-control
test deliberately invokes each shim once and proves a TRAP line DOES appear,
so a clean run above is non-vacuous (an always-broken trap would also read
'zero TRAP lines')."""
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SHIM_DIR = REPO_ROOT / "docs" / "pipeline" / "run-artifacts" / "client-state-gmail-v1" / "shims"


def test_no_shim_traps_during_focused_suite(tmp_path):
    shim_log = tmp_path / "shim.log"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "cortextos").symlink_to(SHIM_DIR / "cortextos")
    (bin_dir / "gws").symlink_to(SHIM_DIR / "gws-trap")
    (bin_dir / "claude").symlink_to(SHIM_DIR / "claude-trap")

    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["CLIENT_STATE_SHIM_LOG"] = str(shim_log)

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "scripts/brain/tests", "-q", "-p", "no:cacheprovider",
         "-k", "client_state or gmail or extract_email or single_flight"],
        cwd=str(REPO_ROOT), env=env, capture_output=True, text=True, timeout=600,
    )
    # G0A2-13: the BOUNDARY claim is asserted FIRST. Reading the shim log only
    # after `assert rc == 0` would mask the external-write evidence behind any
    # unrelated failure in the focused slice -- exactly the case where you most
    # want to know whether a real transport was reached.
    log_text = shim_log.read_text(encoding="utf-8") if shim_log.exists() else ""
    trap_lines = [line for line in log_text.splitlines() if "TRAP:" in line]
    assert trap_lines == [], f"unexpected TRAP lines reaching a real transport: {trap_lines}"
    assert result.returncode == 0, (
        f"focused slice failed (trap lines were: {trap_lines})\n" + result.stdout + result.stderr
    )


def test_shim_positive_control(tmp_path):
    """Proves the trap CAN fire (non-vacuous) - invoked separately from the
    focused-suite subprocess above so its deliberate TRAP lines never pollute
    that assertion."""
    shim_log = tmp_path / "shim.log"
    env = dict(os.environ)
    env["CLIENT_STATE_SHIM_LOG"] = str(shim_log)

    invocations = [
        ("cortextos", [str(SHIM_DIR / "cortextos"), "bus", "create-task", "x"]),
        ("gws-trap", [str(SHIM_DIR / "gws-trap"), "gmail", "+triage"]),
        ("claude-trap", [str(SHIM_DIR / "claude-trap"), "-p", "hi"]),
    ]
    for name, argv in invocations:
        result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=30)
        assert result.returncode == 1, f"{name} did not exit 1"
        assert "TRAP:" in result.stderr, f"{name} did not print a TRAP line"

    log_text = shim_log.read_text(encoding="utf-8")
    trap_lines = [line for line in log_text.splitlines() if "TRAP:" in line]
    assert len(trap_lines) == len(invocations) == 3
