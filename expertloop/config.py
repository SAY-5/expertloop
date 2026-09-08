from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


@dataclass(frozen=True)
class ApiKey:
    name: str
    role: str
    key: str


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EXPERTLOOP_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://expertloop:expertloop@localhost:5432/expertloop"
    # name:role:key entries separated by commas
    api_keys: str = "dana:expert:ek-dana,ravi:reviewer:rk-ravi,mei:reviewer:rk-mei,ops:admin:ak-ops"
    webhook_url: str = "http://localhost:8081/webhook"
    webhook_secret: str = "change-me"
    jira_base_url: str = "http://localhost:8081/jira"
    jira_issue_key: str = "OPS-42"
    jira_token: str = "fake-token"
    default_required_approvals: int = Field(default=1, ge=1)
    # seconds between scheduled drift scans of every source; 0 disables the scheduler
    drift_check_interval_seconds: int = Field(default=0, ge=0)

    def parsed_api_keys(self) -> list[ApiKey]:
        out: list[ApiKey] = []
        for raw in self.api_keys.split(","):
            raw = raw.strip()
            if not raw:
                continue
            name, role, key = raw.split(":", 2)
            out.append(ApiKey(name=name, role=role, key=key))
        return out


@lru_cache
def get_settings() -> Settings:
    return Settings()
