"""API key authentication with per-role scopes."""

from __future__ import annotations

import hmac
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyHeader

from expertloop.config import get_settings

ROLES = ("expert", "reviewer", "admin")
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


@dataclass(frozen=True)
class Principal:
    name: str
    role: str


def authenticate(request: Request, key: str | None = Depends(api_key_header)) -> Principal:
    if not key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing X-API-Key header")
    keys = getattr(request.app.state, "api_keys", None) or get_settings().parsed_api_keys()
    for entry in keys:
        if hmac.compare_digest(entry.key, key):
            if entry.role not in ROLES:
                raise HTTPException(status.HTTP_403_FORBIDDEN, f"unknown role {entry.role}")
            return Principal(name=entry.name, role=entry.role)
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid API key")


def require_role(*roles: str) -> Callable[..., Principal]:
    allowed = set(roles) | {"admin"}

    def dependency(principal: Principal = Depends(authenticate)) -> Principal:
        if principal.role not in allowed:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"role {principal.role} may not perform this action (needs {sorted(allowed)})",
            )
        return principal

    return dependency
