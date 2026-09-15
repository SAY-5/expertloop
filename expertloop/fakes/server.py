"""In-memory stand-ins for the business systems ExpertLoop publishes to.

``/webhook`` verifies the HMAC signature and stores the payload; ``/jira/rest/api/3/...``
takes comments and attachments the way Jira Cloud's REST v3 endpoints do, which means the
comment body has to be an Atlassian Document Format document and a plain string is rejected
with 400. ``/_received`` exposes everything for demos and assertions; ``/_reset`` clears it.

This is a stand-in, not a Jira tenant: it checks the shape of a request, not the whole of
Atlassian's behaviour.
"""

from __future__ import annotations

import os
from itertools import count
from typing import Any

from fastapi import FastAPI, File, Header, Request, UploadFile
from fastapi.responses import JSONResponse

from expertloop.targets.webhook import SIGNATURE_HEADER, TIMESTAMP_HEADER, verify_signature


def is_adf(body: Any) -> bool:
    """Whether ``body`` is shaped like an Atlassian Document Format document."""
    if not isinstance(body, dict):
        return False
    if body.get("type") != "doc" or body.get("version") != 1:
        return False
    content = body.get("content")
    return isinstance(content, list) and len(content) > 0


def adf_text(body: dict[str, Any]) -> str:
    """The text nodes of an ADF document, joined, for assertions and demo output."""
    chunks: list[str] = []
    for node in body.get("content", []):
        for child in node.get("content", []):
            if child.get("type") == "text":
                chunks.append(str(child.get("text", "")))
    return "\n\n".join(chunks)


def build_fake_app(webhook_secret: str) -> FastAPI:
    app = FastAPI(title="ExpertLoop fake business systems", docs_url=None, redoc_url=None)
    state: dict[str, Any] = {"webhook": [], "jira_comments": [], "jira_attachments": []}
    counter = count(1)

    @app.post("/webhook")
    async def webhook(
        request: Request,
        signature: str = Header(default="", alias=SIGNATURE_HEADER),
        timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
    ) -> JSONResponse:
        body = await request.body()
        if not verify_signature(webhook_secret, timestamp, body, signature):
            return JSONResponse({"error": "invalid signature"}, status_code=401)
        receipt_id = f"whr-{next(counter)}"
        payload = await request.json()
        state["webhook"].append({"receipt_id": receipt_id, "payload": payload})
        return JSONResponse({"receipt_id": receipt_id, "signature_valid": True})

    @app.post("/jira/rest/api/3/issue/{issue_key}/comment")
    async def jira_comment(issue_key: str, request: Request) -> JSONResponse:
        payload = await request.json()
        body = payload.get("body")
        if not is_adf(body):
            return JSONResponse(
                {"errorMessages": ["comment body must be an Atlassian Document Format document"]},
                status_code=400,
            )
        comment_id = str(10000 + next(counter))
        state["jira_comments"].append(
            {"id": comment_id, "issue": issue_key, "body": body, "text": adf_text(body)}
        )
        return JSONResponse(
            {
                "id": comment_id,
                "self": f"/jira/rest/api/3/issue/{issue_key}/comment/{comment_id}",
            }
        )

    @app.post("/jira/rest/api/3/issue/{issue_key}/attachments")
    async def jira_attachment(issue_key: str, file: UploadFile = File(...)) -> list[dict[str, Any]]:
        content = await file.read()
        attachment_id = str(20000 + next(counter))
        state["jira_attachments"].append(
            {
                "id": attachment_id,
                "issue": issue_key,
                "filename": file.filename,
                "size": len(content),
            }
        )
        return [{"id": attachment_id, "filename": file.filename, "size": len(content)}]

    @app.get("/_received")
    async def received() -> dict[str, Any]:
        return state

    @app.post("/_reset")
    async def reset() -> dict[str, str]:
        for key in state:
            state[key].clear()
        return {"status": "reset"}

    return app


app = build_fake_app(os.environ.get("EXPERTLOOP_WEBHOOK_SECRET", "change-me"))
