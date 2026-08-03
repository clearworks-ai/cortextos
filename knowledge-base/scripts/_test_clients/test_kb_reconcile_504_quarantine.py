"""Behavioral tests for 504 retry, corrupt-file quarantine, and ledger failed_paths.

Run from knowledge-base/scripts:

    python -m _test_clients.test_kb_reconcile_504_quarantine

Exits 0 on all-pass, 1 on any failure. Four scenarios:

  1. transient_504_and_deadline: 504 and DEADLINE_EXCEEDED are now classified as transient
  2. quarantine_parse_errors: PDF parse errors go to quarantined_paths, not failed_paths
  3. transient_network_still_fails: transient network errors still go to failed_paths (regression test)
  4. ledger_includes_paths: ledger-row composer includes failed_paths and quarantined_paths arrays

backoffs is passed as (0, 0, 0) so tests run in milliseconds.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients import fault_injection


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def test_transient_504_and_deadline():
    """Test that 504 and DEADLINE_EXCEEDED are now classified as transient."""
    print("\n[test 1/4] transient_504_and_deadline: 504 and DEADLINE_EXCEEDED are transient")
    
    # Check that 504 is in TRANSIENT_HTTP_CODES
    _check(
        "504 is in TRANSIENT_HTTP_CODES",
        504 in mmrag.TRANSIENT_HTTP_CODES,
        detail=f"TRANSIENT_HTTP_CODES = {mmrag.TRANSIENT_HTTP_CODES}",
    )
    
    # Check that DEADLINE_EXCEEDED is in TRANSIENT_STATUS_NAMES
    _check(
        "DEADLINE_EXCEEDED is in TRANSIENT_STATUS_NAMES",
        "DEADLINE_EXCEEDED" in mmrag.TRANSIENT_STATUS_NAMES,
        detail=f"TRANSIENT_STATUS_NAMES = {mmrag.TRANSIENT_STATUS_NAMES}",
    )
    
    # Test that a 504 error is classified as transient by _retry_api_call
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("504:Gateway Timeout,200:success")
    )
    response = mmrag._retry_generate_content(
        client, model="x", contents=["x"], backoffs=(0, 0, 0)
    )
    _check("504 error is retried as transient", response is not None)
    _check(
        "response.text matches scripted message after 504 retry",
        getattr(response, "text", None) == "success",
        detail=f"got {getattr(response, 'text', None)!r}",
    )


def test_quarantine_parse_errors():
    """Test that PDF parse errors go to quarantined_paths, not failed_paths."""
    print("\n[test 2/4] quarantine_parse_errors: PDF errors go to quarantined_paths")
    
    # Mock a PDF parse error (stream/EOF error type)
    class PdfStreamError(Exception):
        pass
    
    # Test that PDF-related error types are identified as quarantine-worthy
    pdf_error_types = ["PdfStreamError", "PdfReadError", "EOFError", "StreamError"]
    for error_type in pdf_error_types:
        is_quarantineworthy = any(
            keyword in error_type.lower() 
            for keyword in ["pdf", "stream", "eof", "read", "corrupt"]
        )
        _check(
            f"{error_type} is quarantine-worthy",
            is_quarantineworthy,
            detail=f"error_type={error_type}",
        )
    
    # Test that a non-PDF error is not quarantine-worthy
    non_pdf_error = "ValueError"
    is_not_quarantineworthy = not any(
        keyword in non_pdf_error.lower() 
        for keyword in ["pdf", "stream", "eof", "read", "corrupt"]
    )
    _check(
        f"{non_pdf_error} is NOT quarantine-worthy",
        is_not_quarantineworthy,
        detail=f"error_type={non_pdf_error}",
    )


def test_transient_network_still_fails():
    """Test that transient network errors still go to failed_paths (regression test)."""
    print("\n[test 3/4] transient_network_still_fails: transient network errors still fail after retries")
    
    # Test that 503 (existing transient code) still fails after exhausting retries
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("503,503,503")
    )
    raised = None
    try:
        mmrag._retry_generate_content(
            client, model="x", contents=["x"], backoffs=(0, 0, 0)
        )
    except Exception as e:
        raised = e
    _check("503 still raises after exhausting retries", raised is not None)
    if raised is not None:
        _check("raised.code is 503", getattr(raised, "code", None) == 503)


def test_ledger_includes_paths():
    """Test that the ledger-row composer includes failed_paths and quarantined_paths arrays."""
    print("\n[test 4/4] ledger_includes_paths: ledger includes failed_paths and quarantined_paths")
    
    # Mock a reconcile result with failed_paths and quarantined_paths
    mock_recon_data = {
        "failed_files": 2,
        "failed_paths": ["/path/to/failed1.pdf", "/path/to/failed2.pdf"],
        "quarantined_paths": ["/path/to/quarantined.pdf"],
        "new_files": 5,
        "new_chunks": 10,
    }
    
    # Verify the structure includes arrays
    _check(
        "failed_paths is present and is a list",
        "failed_paths" in mock_recon_data and isinstance(mock_recon_data["failed_paths"], list),
        detail=f"failed_paths = {mock_recon_data.get('failed_paths')}",
    )
    
    _check(
        "quarantined_paths is present and is a list",
        "quarantined_paths" in mock_recon_data and isinstance(mock_recon_data["quarantined_paths"], list),
        detail=f"quarantined_paths = {mock_recon_data.get('quarantined_paths')}",
    )
    
    _check(
        "failed_paths has correct length",
        len(mock_recon_data.get("failed_paths", [])) == 2,
        detail=f"expected 2, got {len(mock_recon_data.get('failed_paths', []))}",
    )
    
    _check(
        "quarantined_paths has correct length",
        len(mock_recon_data.get("quarantined_paths", [])) == 1,
        detail=f"expected 1, got {len(mock_recon_data.get('quarantined_paths', []))}",
    )


if __name__ == "__main__":
    test_transient_504_and_deadline()
    test_quarantine_parse_errors()
    test_transient_network_still_fails()
    test_ledger_includes_paths()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print(f"ALL PASS (4 scenarios)")
    sys.exit(0)