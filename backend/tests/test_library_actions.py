from test_library import library, upload  # noqa: F401


def test_library_actions(library):  # noqa: F811
    client, _, data_dir = library
    project = client.post("/api/v1/projects", json={"name": "Actions"}).json()["id"]
    other = client.post("/api/v1/projects", json={"name": "Autre"}).json()["id"]
    file = upload(client).json()["id"]
    client.put(f"/api/v1/projects/{project}/files/{file}")
    response = client.patch(f"/api/v1/files/{file}", json={"state": "Prêt"})
    assert response.status_code == 200 and response.json()["state"] == "Prêt"
    assert (
        client.patch(f"/api/v1/files/{file}", json={"state": None}).json()["state"]
        is None
    )
    note = client.post(
        f"/api/v1/projects/{project}/notes", json={"content": "Note"}
    ).json()["id"]
    url = f"/api/v1/projects/{project}/notes/{note}"
    assert (
        client.patch(url, json={"content": "Modifiée"}).json()["content"] == "Modifiée"
    )
    assert client.patch(url, json={"content": " "}).status_code == 422
    assert client.delete(f"/api/v1/projects/{other}/notes/{note}").status_code == 404
    assert client.delete(url).status_code == 204
    todo = client.post(
        f"/api/v1/projects/{project}/todos", json={"content": "Slicer"}
    ).json()
    assert todo["completed"] is False
    url = f"/api/v1/projects/{project}/todos/{todo['id']}"
    assert client.patch(url, json={"completed": True}).json()["completed"] is True
    assert (
        client.patch(url, json={"content": "Imprimer"}).json()["content"] == "Imprimer"
    )
    assert client.patch(url, json={"completed": None}).status_code == 422
    assert (
        client.delete(f"/api/v1/projects/{other}/todos/{todo['id']}").status_code == 404
    )
    assert (
        client.get(f"/api/v1/projects/{project}").json()["todos"][0]["completed"]
        is True
    )
    assert client.delete(url).status_code == 204
    assert client.delete(f"/api/v1/files/{file}").status_code == 204
    assert not (data_dir / "files" / file).exists()
    assert list((data_dir / "files").iterdir()) == []
    assert client.get(f"/api/v1/files/{file}/download").status_code == 404
    detail = client.get(f"/api/v1/projects/{project}").json()
    assert detail["files"] == detail["notes"] == detail["todos"] == []
