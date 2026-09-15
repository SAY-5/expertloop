COMPOSE := docker compose -f deploy/docker-compose.yml
API_URL ?= http://localhost:8090
FAKES_URL ?= http://localhost:8081

.PHONY: setup lint format test migrate up down demo demo-check

setup:
	uv sync --python 3.12

lint:
	uv run ruff check .
	uv run ruff format --check .

format:
	uv run ruff format .
	uv run ruff check --fix .

test:
	uv run pytest

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down -v

migrate:
	$(COMPOSE) run --rm api alembic upgrade head

demo: up migrate
	uv run python -m expertloop.demo --api $(API_URL) --fakes $(FAKES_URL)

# the same script in process against PostgreSQL, asserting the summary block in the README
demo-check:
	uv run pytest tests/test_demo_flow.py -q
