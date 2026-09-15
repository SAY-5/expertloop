"""The demo, run in process, against the block quoted in the README.

``make demo`` prints a summary computed from the API's own records. This test drives the
same script through ``TestClient`` and the in-memory fake business systems and asserts the
printed block appears verbatim in README.md, so the README stops being a transcript and
becomes a regression test. It also pins the copy of that block the browser port carries.
"""

from __future__ import annotations

from expertloop.demo import Demo
from tests.conftest import KEYS, ROOT
from tests.test_golden import check_fixture

DEMO_KEYS = {key.name: key.key for key in KEYS.values()}


def printed_summary(printed: str) -> str:
    """The demo's own summary lines.

    The application logs every request as JSON to stdout, and ``capsys`` captures that
    alongside the demo's prints, so the structlog lines are dropped here.
    """
    lines = printed[printed.index("== Summary") :].splitlines()
    return "\n".join(line for line in lines if not line.startswith("{"))


def test_demo_prints_the_summary_block_quoted_in_the_readme(client, fakes, capsys):
    demo = Demo(api=client, fakes=fakes, keys=DEMO_KEYS)
    demo.run()
    printed = capsys.readouterr().out

    assert "== Summary" in printed, printed[-2000:]
    block = printed_summary(printed)
    check_fixture("demo_summary.json", {"summary_block": block})

    readme = (ROOT / "README.md").read_text()
    assert block in readme, f"README.md does not quote this block:\n{block}"

    # the browser port carries its own copy of the block; it has to be the same copy
    port = (ROOT / "web" / "src" / "sim" / "demo.ts").read_text()
    assert f"export const README_SUMMARY = `{block}`;" in port


def test_demo_blocks_one_publish_and_leaves_every_set_live(client, fakes, capsys):
    demo = Demo(api=client, fakes=fakes, keys=DEMO_KEYS)
    demo.run()
    printed = capsys.readouterr().out

    assert demo.blocked == 1
    assert "publish BLOCKED: publish blocked: failing test cases: high value refund" in printed

    received = fakes.get("/_received").json()
    assert len(received["webhook"]) == 5
    assert len(received["jira_comments"]) == 5
    assert len(received["jira_attachments"]) == 5
    assert [w["payload"]["action"] for w in received["webhook"]].count("rollback") == 1

    sets = [
        client.get(f"/instruction-sets/{set_id}", headers={"X-API-Key": DEMO_KEYS["ravi"]}).json()
        for set_id in demo.sets.values()
    ]
    assert [s["state"] for s in sets] == ["published", "published", "published"]
    assert sum(len(s["document"]["steps"]) for s in sets) == 18
