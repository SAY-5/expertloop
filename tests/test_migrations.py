"""Every Alembic revision must apply and revert cleanly against PostgreSQL."""

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect

from alembic import command
from tests.conftest import ROOT


def _config() -> Config:
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    return config


def test_migrations_round_trip(engine):
    config = _config()
    revisions = [r.revision for r in ScriptDirectory.from_config(config).walk_revisions()]
    assert revisions[0] == ScriptDirectory.from_config(config).get_current_head()
    for revision in revisions[1:]:
        command.downgrade(config, revision)
    command.downgrade(config, "base")
    assert "instruction_sets" not in inspect(engine).get_table_names()
    command.upgrade(config, "head")
    tables = set(inspect(engine).get_table_names())
    assert {"instruction_sets", "drift_flags", "alembic_version"} <= tables
