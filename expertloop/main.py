"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

import httpx
import structlog
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from expertloop import __version__, metrics
from expertloop import reviews as review_policies
from expertloop.config import ApiKey, Settings, get_settings
from expertloop.db import get_session, session_factory
from expertloop.drift import DriftScheduler
from expertloop.routers import instruction_sets, notes, ops, reviews, sources
from expertloop.service import Conflict, Invalid, NotFound
from expertloop.targets import JiraTarget, Target, WebhookTarget
from expertloop.workflow import IllegalTransition

log = structlog.get_logger()


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    )


def default_targets(settings: Settings, client: httpx.Client | None = None) -> list[Target]:
    return [
        WebhookTarget(settings.webhook_url, settings.webhook_secret, client=client),
        JiraTarget(
            settings.jira_base_url, settings.jira_issue_key, settings.jira_token, client=client
        ),
    ]


def create_app(
    settings: Settings | None = None,
    targets: Sequence[Target] | None = None,
    api_keys: Sequence[ApiKey] | None = None,
) -> FastAPI:
    configure_logging()
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        scheduler = DriftScheduler(
            session_factory(),
            settings.drift_check_interval_seconds,
            jobs=[review_policies.escalate_overdue],
        )
        app.state.drift_scheduler = scheduler
        scheduler.start()
        try:
            yield
        finally:
            scheduler.stop()

    app = FastAPI(
        title="ExpertLoop",
        version=__version__,
        lifespan=lifespan,
        description=(
            "Turns expert task notes into agent instructions with linked sources, tracks edits "
            "and approval state in PostgreSQL, and gates approved workflows behind test cases "
            "before they reach business systems."
        ),
    )
    app.state.settings = settings
    app.state.targets = list(targets) if targets is not None else default_targets(settings)
    app.state.api_keys = list(api_keys) if api_keys is not None else settings.parsed_api_keys()

    app.include_router(sources.router)
    app.include_router(notes.router)
    app.include_router(instruction_sets.router)
    app.include_router(reviews.router)
    app.include_router(ops.router)

    @app.exception_handler(NotFound)
    async def not_found(_: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(_: Request, exc: Conflict) -> JSONResponse:
        return JSONResponse({"detail": exc.message, **exc.detail}, status_code=409)

    @app.exception_handler(IllegalTransition)
    async def illegal(_: Request, exc: IllegalTransition) -> JSONResponse:
        return JSONResponse(
            {"detail": str(exc), "action": exc.action, "state": exc.current.value}, status_code=409
        )

    @app.exception_handler(Invalid)
    async def invalid(_: Request, exc: Invalid) -> JSONResponse:
        return JSONResponse({"detail": exc.message, "problems": exc.problems}, status_code=422)

    @app.middleware("http")
    async def access_log(request: Request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        log.info(
            "request", method=request.method, path=request.url.path, status=response.status_code
        )
        return response

    @app.get("/healthz", tags=["ops"])
    def healthz(session: Session = Depends(get_session)) -> dict[str, str]:
        session.execute(text("select 1"))
        return {"status": "ok", "version": __version__}

    @app.get("/metrics", tags=["ops"])
    def prometheus(session: Session = Depends(get_session)) -> Response:
        return Response(metrics.render(session), media_type="text/plain; version=0.0.4")

    return app


app = create_app()
