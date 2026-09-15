"""The document shape: what counts as a citation and what a step may leave out."""

from expertloop.compiler import compile_note
from expertloop.compiler.compile import render_prompt, validate_document
from expertloop.document import NoteContext
from tests.conftest import sample


def refund_document() -> tuple[dict, NoteContext]:
    body = sample("refund_handling_sop.md")
    return compile_note(body, note_id=1, name="refunds"), NoteContext.of(1, body)


def test_compiled_sample_validates_against_the_note_it_came_from():
    doc, note = refund_document()
    assert validate_document(doc, note) == []
    assert note.line_count == 25


def test_empty_citation_object_is_not_provenance():
    doc, note = refund_document()
    doc["steps"][0]["citations"] = [{}]
    assert validate_document(doc, note) == [
        "step s1 citation 1 has neither a note line range nor a source reference"
    ]


def test_citation_past_the_end_of_the_note_is_rejected():
    doc, note = refund_document()
    doc["steps"][0]["citations"][0]["line_end"] = 9000
    assert validate_document(doc, note) == [
        "step s1 citation 1 cites note lines 13-9000, but note 1 has 25 lines"
    ]


def test_citation_of_a_different_note_is_rejected():
    doc, note = refund_document()
    doc["steps"][0]["citations"][0]["note_id"] = 42
    assert validate_document(doc, note) == [
        "step s1 citation 1 cites note 42, but the set was compiled from note 1"
    ]


def test_source_reference_needs_a_known_kind():
    doc, note = refund_document()
    doc["steps"][0]["citations"].append({"source_kind": "wiki", "source_ref": "team/handbook"})
    assert validate_document(doc, note) == [
        "steps.0.citations.1.source_kind: Input should be 'url', 'doc' or 'ticket'"
    ]


def test_decision_rule_without_a_condition_is_rejected():
    doc, note = refund_document()
    doc["decision_rules"].append({"then": "escalate to the risk team"})
    assert validate_document(doc, note) == ["decision_rules.0.condition: Field required"]


def test_step_may_omit_its_empty_rule_list_and_still_render():
    doc, note = refund_document()
    del doc["steps"][0]["decision_rules"]
    assert validate_document(doc, note) == []
    assert render_prompt(doc).splitlines()[0] == "# Refund handling for online orders"


def test_document_without_outcomes_renders_without_that_section():
    doc, note = refund_document()
    del doc["outcomes"]
    assert validate_document(doc, note) == []
    assert "Done when:" not in render_prompt(doc)


def test_misspelled_step_field_is_rejected_rather_than_ignored():
    doc, note = refund_document()
    doc["steps"][0]["actoin"] = "look up the order"
    assert validate_document(doc, note) == ["steps.0.actoin: Extra inputs are not permitted"]


def test_step_id_longer_than_the_column_is_rejected():
    doc, note = refund_document()
    doc["steps"][0]["id"] = "s" * 33
    problems = validate_document(doc, note)
    assert problems == ["steps.0.id: String should have at most 32 characters"]


def test_reversed_line_range_is_rejected_without_the_note():
    doc, _ = refund_document()
    doc["steps"][0]["citations"][0] = {"note_id": 1, "line_start": 9, "line_end": 4}
    assert validate_document(doc) == [
        "step s1 citation 1 cites note lines 9-4, which is not a range"
    ]
