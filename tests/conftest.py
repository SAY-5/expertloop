"""Test fixtures: a real PostgreSQL (Testcontainers or EXPERTLOOP_TEST_DATABASE_URL),
the schema applied through Alembic, and the API wired to in-memory fake business systems."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from alembic import command
from expertloop import db
from expertloop.config import ApiKey, Settings
from expertloop.fakes import build_fake_app
from expertloop.main import create_app, default_targets

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "samples"
WEBHOOK_SECRET = "test-secret"

KEYS = {
    "expert": ApiKey("dana", "expert", "ek-test"),
    "expert2": ApiKey("lee", "expert", "ek-test-2"),
    "reviewer": ApiKey("ravi", "reviewer", "rk-test"),
    "reviewer2": ApiKey("mei", "reviewer", "rk-test-2"),
    "admin": ApiKey("ops", "admin", "ak-test"),
}

TABLES = (
    "publications",
    "test_runs",
    "test_cases",
    "audit_events",
    "review_decisions",
    "edits",
    "instruction_set_versions",
    "instruction_sets",
    "notes",
    "sources",
)


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    url = os.environ.get("EXPERTLOOP_TEST_DATABASE_URL")
    if url:
        yield url
        return
    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:16-alpine", driver="psycopg") as postgres:
        yield postgres.get_connection_url()


@pytest.fixture(scope="session")
def engine(database_url: str) -> Iterator[Engine]:
    os.environ["EXPERTLOOP_DATABASE_URL"] = database_url
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    command.upgrade(config, "head")
    engine = create_engine(database_url, future=True)
    db.configure_engine(engine)
    yield engine
    engine.dispose()


@pytest.fixture(autouse=True)
def clean_tables(engine: Engine) -> Iterator[None]:
    yield
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))


@pytest.fixture(scope="session")
def fakes() -> TestClient:
    return TestClient(build_fake_app(WEBHOOK_SECRET))


@pytest.fixture()
def client(engine: Engine, fakes: TestClient) -> Iterator[TestClient]:
    fakes.post("/_reset")
    settings = Settings(
        webhook_url="http://fakes/webhook",
        webhook_secret=WEBHOOK_SECRET,
        jira_base_url="http://fakes/jira",
        jira_issue_key="OPS-1",
        jira_token="t",
    )
    app = create_app(
        settings=settings,
        targets=default_targets(settings, client=fakes),
        api_keys=list(KEYS.values()),
    )
    with TestClient(app) as test_client:
        yield test_client


def headers(role: str) -> dict[str, str]:
    return {"X-API-Key": KEYS[role].key}


def sample(name: str) -> str:
    return (SAMPLES / name).read_text()
