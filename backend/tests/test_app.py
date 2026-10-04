from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app.config import Settings
from app.main import create_app


def test_health_and_sqlite_configuration(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, _env_file=None))
    with TestClient(app) as client:
        response = client.get("/api/v1/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "database": "ok"}
        assert (tmp_path / "files").is_dir()
        with app.state.engine.connect() as connection:
            assert connection.scalar(text("PRAGMA foreign_keys")) == 1
            assert connection.scalar(text("PRAGMA journal_mode")) == "wal"


def test_health_database_failure(tmp_path, monkeypatch):
    app = create_app(Settings(data_dir=tmp_path, _env_file=None))
    with TestClient(app) as client:

        def fail():
            raise OperationalError("SELECT 1", {}, Exception("unavailable"))

        monkeypatch.setattr(app.state.engine, "connect", fail)
        assert client.get("/api/v1/health").status_code == 503


def test_angular_cors_and_openapi(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path, _env_file=None))) as client:
        response = client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://localhost:4200",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert (
            response.headers["access-control-allow-origin"] == "http://localhost:4200"
        )
        assert "/api/v1/health" in client.get("/openapi.json").json()["paths"]
