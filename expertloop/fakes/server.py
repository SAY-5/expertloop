"""In-memory stand-ins for the business systems ExpertLoop publishes to.

``/webhook`` verifies the HMAC signature and stores the payload; ``/jira/rest/api/3/...``
accepts comments and attachments the way Jira Cloud does. ``/_received`` exposes
everything for demos and assertions; ``/_reset`` clears it.
"""

from __future__ import annotations

import os
from itertools import count
from typing import Any

from fastapi import FastAPI, File, Header, Request, UploadFile
from fastapi.responses import JSONResponse

from expertloop.targets.webhook import SIGNATURE_HEADER, TIMESTAMP_HEADER, verify_signature


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
    async def jira_comment(issue_key: str, request: Request) -> dict[str, Any]:
        body = await request.json()
        comment_id = str(10000 + next(counter))
        state["jira_comments"].append({"id": comment_id, "issue": issue_key, "body": body["body"]})
        return {
            "id": comment_id,
            "self": f"/jira/rest/api/3/issue/{issue_key}/comment/{comment_id}",
        }

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
