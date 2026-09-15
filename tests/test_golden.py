"""Golden fixtures: what the Python compiler and executor actually produce.

The browser port under ``web/src/sim`` reads the files written here and has to reproduce
them, so "the same compiler, the same executor" is a test rather than a sentence. The
fixtures also pin the three notes the port inlines as string literals against the files in
``samples/``.

After a deliberate change to the compiler or the executor, refresh them with

    EXPERTLOOP_WRITE_GOLDEN=1 uv run pytest tests/test_golden.py

and commit the diff, which is then reviewable line by line.
"""

from __future__ import annotations

import json
import os
from typing import Any

import pytest

from expertloop.compiler import compile_note
from expertloop.demo import NOTES, TEST_CASES
from expertloop.executor import run_test_case
from tests.conftest import ROOT, sample

EXPECTED = ROOT / "samples" / "expected"
# the browser port compiles the sample notes with note id 1 as well
NOTE_ID = 1
GOLDEN_NOTES = (
    ("refund", "refund_handling_sop.md", "Refund handling for online orders"),
    ("onboarding", "onboarding_checklist.md", "New engineer onboarding checklist"),
    ("incident", "incident_triage_note.md", "Incident triage for production alerts"),
)


def compiled(filename: str, title: str) -> dict[str, Any]:
    return compile_note(sample(filename), note_id=NOTE_ID, name=title)


def check_fixture(name: str, produced: Any) -> None:
    """Compare ``produced`` with the committed fixture, writing it when asked to."""
    path = EXPECTED / name
    payload = json.dumps(produced, indent=2, sort_keys=True) + "\n"
    if os.environ.get("EXPERTLOOP_WRITE_GOLDEN") or not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload)
    stored = path.read_text()
    if stored == payload:
        return
    produced_lines, stored_lines = payload.splitlines(), stored.splitlines()
    first = next(
        (
            i
            for i, (left, right) in enumerate(zip(produced_lines, stored_lines, strict=False))
            if left != right
        ),
        min(len(produced_lines), len(stored_lines)),
    )
    committed = stored_lines[first] if first < len(stored_lines) else "<end of file>"
    produced_line = produced_lines[first] if first < len(produced_lines) else "<end of file>"
    pytest.fail(
        f"samples/expected/{name} is out of date at line {first + 1}:\n"
        f"  committed: {committed}\n"
        f"  produced:  {produced_line}\n"
        "Refresh with EXPERTLOOP_WRITE_GOLDEN=1 if the change was deliberate."
    )


PHRASINGS_NOTE = """# Warehouse dispatch phrasings

## Before you start
- The order is paid and the pick list is printed.

## Tools
- OrderDB
- ShipStation

## Steps
1. Wait for the warehouse scan and do not proceed until it is present.
2. Confirm the packing slip and must not proceed before the scan lands.
3. Answer the customer ticket and do not escalate to the risk team.
4. Issue the refund unless the order is flagged.
5. If the scan is present, ship the parcel, otherwise hold it.
6. Book the courier in ShipStation, expected: tracking number recorded in OrderDB.
   If the courier is unavailable, hand off to the dispatch desk.

## Never
- Never dispatch without a printed label.

## Done when
- The parcel is scanned out and the tracking number is in OrderDB.
"""


def test_compiled_phrasings_match_the_committed_fixture():
    """The phrasings R4 was about, pinned for the browser port as well as for Python."""
    document = compile_note(PHRASINGS_NOTE, note_id=NOTE_ID, name="Warehouse dispatch phrasings")
    check_fixture("compiled_phrasings.json", {"note": PHRASINGS_NOTE, "document": document})
    steps = document["steps"]
    assert len(steps) == 6
    assert steps[0]["action"] == "Wait for the warehouse scan"
    assert steps[0]["expected_outcome"] == "it is present"
    assert [step["halts"] for step in steps] == [False] * 6
    assert not any("proceed" in entry["text"] for entry in document["forbidden_actions"])


def test_golden_notes_are_the_notes_the_demo_ingests():
    assert [(filename, title) for title, filename, _ in NOTES] == [
        (filename, title) for _, filename, title in GOLDEN_NOTES
    ]


@pytest.mark.parametrize(("key", "filename", "title"), GOLDEN_NOTES)
def test_compiled_document_matches_the_committed_fixture(key: str, filename: str, title: str):
    check_fixture(f"compiled_{key}.json", compiled(filename, title))


def test_case_traces_match_the_committed_fixture():
    produced: dict[str, Any] = {}
    for key, filename, title in GOLDEN_NOTES:
        document = compiled(filename, title)
        produced[key] = [
            {"name": name, **run_test_case(document, scenario, expectations)}
            for name, scenario, expectations in TEST_CASES[filename]
        ]
    check_fixture("traces.json", produced)
    assert sum(len(cases) for cases in produced.values()) == 8


def test_browser_fixtures_quote_the_sample_notes_verbatim():
    """The port inlines the notes, so drift between them and ``samples/`` is a failure here."""
    fixtures = (ROOT / "web" / "src" / "sim" / "fixtures.ts").read_text()
    for _, filename, _ in GOLDEN_NOTES:
        assert f"`{sample(filename)}`" in fixtures, filename
