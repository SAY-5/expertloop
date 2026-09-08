# Contributing

## Setup

```
make setup          # uv sync with Python 3.12
make lint           # ruff check + format check
make test           # pytest against PostgreSQL (Testcontainers, or EXPERTLOOP_TEST_DATABASE_URL)
```

Tests start a `postgres:16-alpine` container through Testcontainers. To reuse an existing
database instead, export `EXPERTLOOP_TEST_DATABASE_URL`; the suite applies the Alembic
migrations to it and truncates tables between tests.

## Making changes

* Keep the compiler deterministic. New extraction rules belong in
  `expertloop/compiler/` with a test in `tests/test_compiler.py` that pins the output for
  one of the notes in `samples/`.
* Any change to the state machine goes through `expertloop/workflow/state.py` and needs a
  case in `tests/test_state_machine.py` for the legal and the illegal direction.
* Schema changes need an Alembic revision under `alembic/versions/`; the test suite runs
  `alembic upgrade head`, so a model change without a migration fails there.
* Run `make lint` and `make test` before opening a pull request. CI runs the same steps.

## Commits

Single-line conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `build:`, `chore:`).
