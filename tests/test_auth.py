import pytest
from fastapi.testclient import TestClient

from expertloop.config import Settings, get_settings
from expertloop.main import create_app


def test_explicitly_configured_key_can_authenticate():
    settings = Settings(_env_file=None, api_keys="ops:admin:configured-test-key")
    with TestClient(create_app(settings=settings, targets=[])) as client:
        response = client.get("/sources", headers={"X-API-Key": "configured-test-key"})
    assert response.status_code == 200


@pytest.mark.parametrize("key", ["ek-dana", "rk-ravi", "rk-mei", "ak-ops"])
def test_unconfigured_app_rejects_public_demo_keys(monkeypatch, key):
    monkeypatch.delenv("EXPERTLOOP_API_KEYS", raising=False)
    settings = Settings(_env_file=None)
    with TestClient(create_app(settings=settings, targets=[])) as client:
        response = client.get("/sources", headers={"X-API-Key": key})
    assert response.status_code == 401


def test_empty_app_keys_do_not_fall_back_to_global_configuration(monkeypatch):
    monkeypatch.setenv("EXPERTLOOP_API_KEYS", "ops:admin:global-test-key")
    get_settings.cache_clear()
    try:
        settings = Settings(_env_file=None, api_keys="ops:admin:app-test-key")
        app = create_app(settings=settings, targets=[], api_keys=[])
        with TestClient(app) as client:
            for key in ("global-test-key", "app-test-key"):
                response = client.get("/sources", headers={"X-API-Key": key})
                assert response.status_code == 401
    finally:
        get_settings.cache_clear()
