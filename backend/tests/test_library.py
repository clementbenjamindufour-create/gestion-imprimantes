from io import BytesIO
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.main import create_app
from app.models import LibraryFile, Note, project_files


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setenv("PRINTERS_DATA_DIR", str(tmp_path))
    backend = Path(__file__).resolve().parents[1]
    command.upgrade(Config(str(backend / "alembic.ini")), "head")
    app = create_app(Settings(data_dir=tmp_path, _env_file=None))
    with TestClient(app) as client:
        yield client, app, tmp_path


def upload(client, filename="piece.STL", content=b"solid test", state=None):
    data = {} if state is None else {"state": state}
    return client.post("/api/v1/files", files={"file": (filename, content)}, data=data)


def test_archive_preserves_content_and_handles_duplicate_names(library):
    client, _, _ = library
    first = upload(client, "pièce.stl", b"abc" * 100000).json()
    second = upload(client, "pièce.stl", b"second").json()
    empty = upload(client, "vide.txt", b"").json()
    response = client.post(
        "/api/v1/files/archive",
        json={"file_ids": [first["id"], second["id"], first["id"], empty["id"]]},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "selection.zip" in response.headers["content-disposition"]
    with ZipFile(BytesIO(response.content)) as archive:
        assert archive.namelist() == ["pièce.stl", "pièce_2.stl", "vide.txt"]
        assert archive.read("pièce.stl") == b"abc" * 100000
        assert archive.read("pièce_2.stl") == b"second"
        assert archive.read("vide.txt") == b""
        assert archive.testzip() is None


def test_archive_missing_file_fails_before_sending_zip(library):
    client, _, data_dir = library
    resource = upload(client).json()
    (data_dir / "files" / resource["id"]).unlink()
    response = client.post("/api/v1/files/archive", json={"file_ids": [resource["id"]]})
    assert response.status_code == 404
    assert (
        client.post(
            "/api/v1/files/archive", json={"file_ids": [str(uuid4())]}
        ).status_code
        == 404
    )


@pytest.mark.parametrize("ids", [[], ["incorrect"], [str(uuid4())] * 10001])
def test_archive_validates_selection(library, ids):
    client, _, _ = library
    assert (
        client.post("/api/v1/files/archive", json={"file_ids": ids}).status_code == 422
    )


@pytest.mark.parametrize(
    ("filename", "kind"),
    [
        ("piece.STL", "model"),
        ("piece.3mf", "model"),
        ("piece.goo", "sliced"),
        ("piece.GCODE", "sliced"),
        ("piece.curaprofile", "slicer_project"),
        ("document.pdf", "other"),
        ("sans-extension", "other"),
    ],
)
def test_import_and_download(library, filename, kind):
    client, app, data_dir = library
    content = b"\x00\xff\x01" * 500_000
    response = upload(client, filename, content, "À slicer / vérifier les supports")
    assert response.status_code == 201
    resource = response.json()
    assert resource["filename"] == filename
    assert resource["kind"] == kind
    assert resource["is_print_related"] == (kind != "other")
    assert resource["size_bytes"] == len(content)
    assert resource["state"] == "À slicer / vérifier les supports"
    assert resource["created_at"].endswith("Z")
    assert (data_dir / "files" / resource["id"]).read_bytes() == content
    download = client.get(f"/api/v1/files/{resource['id']}/download")
    assert download.status_code == 200
    assert download.content == content
    assert download.headers["content-disposition"].startswith("attachment;")
    assert download.headers["content-type"] == "application/octet-stream"


def test_optional_state_and_safe_unique_storage(library):
    client, _, data_dir = library
    first = upload(client, "../../piece.stl").json()
    second = upload(client, "C:\\models\\piece.stl", b"different").json()
    assert first["state"] is None
    assert first["filename"] == second["filename"] == "piece.stl"
    assert first["id"] != second["id"]
    assert len(list((data_dir / "files").iterdir())) == 2
    assert not (data_dir / "piece.stl").exists()


def test_project_links_notes_and_persistence(library):
    client, app, data_dir = library
    file_id = upload(client).json()["id"]
    projects = []
    for name in [" Pièce mécanique ", "Autre projet"]:
        response = client.post("/api/v1/projects", json={"name": name})
        assert response.status_code == 201
        projects.append(response.json()["id"])
    for project_id in projects:
        url = f"/api/v1/projects/{project_id}/files/{file_id}"
        assert client.put(url).status_code == 204
        assert client.put(url).status_code == 204
    note_content = "Supports à revoir.\n\nConserver cette mise en page."
    note = client.post(
        f"/api/v1/projects/{projects[0]}/notes", json={"content": note_content}
    )
    assert note.status_code == 201
    assert note.json()["project_id"] == projects[0]
    assert note.json()["content"] == note_content
    url = f"/api/v1/projects/{projects[0]}/files/{file_id}"
    assert client.delete(url).status_code == 204
    assert client.delete(url).status_code == 204
    with Session(app.state.engine) as session:
        assert session.execute(select(project_files)).all() == [(projects[1], file_id)]
        assert session.get(Note, note.json()["id"]).content == note_content
        assert session.get(LibraryFile, file_id) is not None
    # Délier conserve le fichier, qui reste accessible après un redémarrage.
    with TestClient(
        create_app(Settings(data_dir=data_dir, _env_file=None))
    ) as reopened:
        assert (
            reopened.get(f"/api/v1/files/{file_id}/download").content == b"solid test"
        )


def test_missing_resources_and_validation(library):
    client, _, _ = library
    missing = str(uuid4())
    project_id = client.post("/api/v1/projects", json={"name": "Test"}).json()["id"]
    file_id = upload(client).json()["id"]
    for project, file in [(missing, file_id), (project_id, missing)]:
        url = f"/api/v1/projects/{project}/files/{file}"
        assert client.put(url).status_code == 404
        assert client.delete(url).status_code == 404
    assert client.get(f"/api/v1/files/{missing}/download").status_code == 404
    assert (
        client.post(
            f"/api/v1/projects/{missing}/notes", json={"content": "Test"}
        ).status_code
        == 404
    )
    assert client.post("/api/v1/projects", json={"name": "  "}).status_code == 422
    assert (
        client.post(
            f"/api/v1/projects/{project_id}/notes", json={"content": "\n "}
        ).status_code
        == 422
    )
    assert client.get("/api/v1/files/invalid/download").status_code == 422
    assert upload(client, "..").status_code == 422
    assert client.post("/api/v1/files").status_code == 422


def test_missing_blob(library):
    client, _, data_dir = library
    file_id = upload(client).json()["id"]
    (data_dir / "files" / file_id).unlink()
    assert client.get(f"/api/v1/files/{file_id}/download").status_code == 404


def test_lists_and_project_detail(library):
    client, _, _ = library
    assert client.get("/api/v1/files").json() == []
    assert client.get("/api/v1/projects").json() == []
    project = client.post("/api/v1/projects", json={"name": "Projet"}).json()
    other = client.post("/api/v1/projects", json={"name": "Autre"}).json()
    file = upload(client).json()
    client.put(f"/api/v1/projects/{project['id']}/files/{file['id']}")
    note = client.post(
        f"/api/v1/projects/{project['id']}/notes", json={"content": "Une note"}
    ).json()
    assert client.get("/api/v1/files").json() == [file]
    assert len(client.get("/api/v1/projects").json()) == 2
    detail = client.get(f"/api/v1/projects/{project['id']}").json()
    assert detail == {**project, "files": [file], "notes": [note], "todos": []}
    detail = client.get(f"/api/v1/projects/{other['id']}").json()
    assert detail["files"] == []
    assert detail["notes"] == []
    assert client.get(f"/api/v1/projects/{uuid4()}").status_code == 404


def test_failed_commit_cleans_up_file(library, monkeypatch):
    client, app, data_dir = library

    def fail(_session):
        raise RuntimeError("Simulated commit failure")

    monkeypatch.setattr(Session, "commit", fail)
    with pytest.raises(RuntimeError, match="Simulated commit failure"):
        upload(client)
    assert list((data_dir / "files").iterdir()) == []
    with Session(app.state.engine) as session:
        assert session.scalar(select(func.count()).select_from(LibraryFile)) == 0


def test_migration_round_trip(library):
    _, _, _ = library
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini"))
    command.check(config)
    command.downgrade(config, "0001")
    command.upgrade(config, "head")
    command.check(config)
