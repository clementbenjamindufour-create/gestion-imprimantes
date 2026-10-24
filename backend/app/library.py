from collections import deque
from pathlib import Path
from typing import Annotated
from uuid import UUID
from zipfile import ZIP_STORED, ZipFile

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse as DownloadResponse
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from app.database import get_session
from app.models import LibraryFile, Note, Project, Todo, new_id, project_files
from app.schemas import (
    FileResponse,
    FileStateUpdate,
    NoteCreate,
    NoteResponse,
    ProjectCreate,
    ProjectDetail,
    ProjectResponse,
    TodoCreate,
    TodoResponse,
    TodoUpdate,
)

router = APIRouter(prefix="/api/v1", tags=["library"])
DatabaseSession = Annotated[Session, Depends(get_session)]

# Détection indicative par extension : aucune validation du contenu binaire.
PRINT_EXTENSIONS = {
    "model": {".stl", ".obj", ".3mf", ".amf", ".step", ".stp"},
    "sliced": {
        ".gcode",
        ".gco",
        ".g",
        ".goo",
        ".ctb",
        ".cbddlp",
        ".photon",
        ".pwmo",
        ".pwmx",
        ".pws",
        ".pwsx",
    },
    "slicer_project": {".curaprofile", ".curaproject", ".lychee", ".lys"},
}


def classify(extension: str) -> str:
    return next(
        (
            kind
            for kind, extensions in PRINT_EXTENSIONS.items()
            if extension in extensions
        ),
        "other",
    )


def require_resource(session: Session, model, resource_id: UUID):
    resource = session.get(model, str(resource_id))
    if resource is None:
        raise HTTPException(status_code=404, detail="Ressource introuvable")
    return resource


def serialize_file(resource: LibraryFile) -> FileResponse:
    return FileResponse(
        id=resource.id,
        filename=resource.filename,
        size_bytes=resource.size_bytes,
        extension=resource.extension,
        kind=resource.kind,
        is_print_related=resource.kind != "other",
        state=resource.state,
        created_at=resource.created_at,
    )


@router.get("/files", response_model=list[FileResponse])
def list_files(session: DatabaseSession):
    files = session.scalars(
        select(LibraryFile).order_by(LibraryFile.created_at.desc(), LibraryFile.id)
    )
    return [serialize_file(file) for file in files]


@router.get("/projects", response_model=list[ProjectResponse])
def list_projects(session: DatabaseSession):
    return session.scalars(
        select(Project).order_by(Project.created_at.desc(), Project.id)
    ).all()


@router.get("/projects/{project_id}", response_model=ProjectDetail)
def get_project(project_id: UUID, session: DatabaseSession):
    project = require_resource(session, Project, project_id)
    files = session.scalars(
        select(LibraryFile)
        .join(project_files, project_files.c.file_id == LibraryFile.id)
        .where(project_files.c.project_id == project.id)
        .order_by(LibraryFile.created_at.desc(), LibraryFile.id)
    )
    notes = session.scalars(
        select(Note)
        .where(Note.project_id == project.id)
        .order_by(Note.created_at.desc(), Note.id)
    ).all()
    return ProjectDetail(
        id=project.id,
        name=project.name,
        created_at=project.created_at,
        files=[serialize_file(file) for file in files],
        notes=[NoteResponse.model_validate(note) for note in notes],
        todos=[
            TodoResponse.model_validate(todo)
            for todo in session.scalars(
                select(Todo)
                .where(Todo.project_id == project.id)
                .order_by(Todo.created_at, Todo.id)
            )
        ],
    )


@router.patch("/files/{file_id}", response_model=FileResponse)
def update_file_state(
    file_id: UUID, payload: FileStateUpdate, session: DatabaseSession
):
    resource = require_resource(session, LibraryFile, file_id)
    resource.state = payload.state
    session.commit()
    session.refresh(resource)
    return serialize_file(resource)


@router.delete("/files/{file_id}", status_code=204)
def delete_file(file_id: UUID, request: Request, session: DatabaseSession):
    resource = require_resource(session, LibraryFile, file_id)
    path = request.app.state.settings.files_dir / resource.id
    # Mettre de côté le contenu pour pouvoir le restaurer si le commit échoue.
    staged = path.with_suffix(".deleting")
    moved = path.is_file()
    if moved:
        path.rename(staged)
    try:
        session.delete(resource)
        session.commit()
    except Exception:
        session.rollback()
        if moved:
            staged.rename(path)
        raise
    if moved:
        staged.unlink(missing_ok=True)
    return Response(status_code=204)


def require_project_resource(
    session: Session, model, project_id: UUID, resource_id: UUID
):
    require_resource(session, Project, project_id)
    resource = require_resource(session, model, resource_id)
    if resource.project_id != str(project_id):
        raise HTTPException(
            status_code=404, detail="Ressource introuvable dans ce projet"
        )
    return resource


@router.patch("/projects/{project_id}/notes/{note_id}", response_model=NoteResponse)
def update_note(
    project_id: UUID, note_id: UUID, payload: NoteCreate, session: DatabaseSession
):
    note = require_project_resource(session, Note, project_id, note_id)
    note.content = payload.content
    session.commit()
    session.refresh(note)
    return note


@router.delete("/projects/{project_id}/notes/{note_id}", status_code=204)
def delete_note(project_id: UUID, note_id: UUID, session: DatabaseSession):
    session.delete(require_project_resource(session, Note, project_id, note_id))
    session.commit()
    return Response(status_code=204)


@router.post(
    "/projects/{project_id}/todos", response_model=TodoResponse, status_code=201
)
def create_todo(project_id: UUID, payload: TodoCreate, session: DatabaseSession):
    require_resource(session, Project, project_id)
    todo = Todo(project_id=str(project_id), content=payload.content)
    session.add(todo)
    session.commit()
    session.refresh(todo)
    return todo


@router.patch("/projects/{project_id}/todos/{todo_id}", response_model=TodoResponse)
def update_todo(
    project_id: UUID, todo_id: UUID, payload: TodoUpdate, session: DatabaseSession
):
    todo = require_project_resource(session, Todo, project_id, todo_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(todo, key, value)
    session.commit()
    session.refresh(todo)
    return todo


@router.delete("/projects/{project_id}/todos/{todo_id}", status_code=204)
def delete_todo(project_id: UUID, todo_id: UUID, session: DatabaseSession):
    session.delete(require_project_resource(session, Todo, project_id, todo_id))
    session.commit()
    return Response(status_code=204)


@router.post("/files", response_model=FileResponse, status_code=201)
def import_file(
    request: Request,
    session: DatabaseSession,
    file: Annotated[UploadFile, File()],
    state: Annotated[str | None, Form()] = None,
):
    filename = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not filename or filename in {".", ".."} or any(ord(c) < 32 for c in filename):
        raise HTTPException(status_code=422, detail="Nom de fichier invalide")
    extension = Path(filename).suffix.lower()
    file_id = new_id()
    # Le nom fourni n'est jamais utilisé comme chemin de stockage.
    destination = request.app.state.settings.files_dir / file_id
    size = 0
    created = False
    try:
        with destination.open("xb") as output:
            created = True
            while chunk := file.file.read(1024 * 1024):
                output.write(chunk)
                size += len(chunk)
        resource = LibraryFile(
            id=file_id,
            filename=filename,
            size_bytes=size,
            extension=extension,
            kind=classify(extension),
            state=state,
        )
        session.add(resource)
        session.commit()
    except Exception:
        session.rollback()
        if created:
            destination.unlink(missing_ok=True)
        raise
    session.refresh(resource)
    return serialize_file(resource)


@router.get("/files/{file_id}/download", response_class=DownloadResponse)
def download_file(file_id: UUID, request: Request, session: DatabaseSession):
    resource = require_resource(session, LibraryFile, file_id)
    path = request.app.state.settings.files_dir / resource.id
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Fichier stocké introuvable")
    return DownloadResponse(
        path, filename=resource.filename, media_type="application/octet-stream"
    )


class ArchiveRequest(BaseModel):
    file_ids: list[UUID] = Field(min_length=1, max_length=10000)


class ArchiveBuffer:
    """Sortie ZIP non seekable, videe apres chaque morceau de fichier."""

    def __init__(self):
        self.chunks = deque()
        self.position = 0

    def write(self, data):
        self.position += len(data)
        if data:
            self.chunks.append(data)
        return len(data)

    def tell(self):
        return self.position

    def flush(self):
        pass

    def drain(self):
        while self.chunks:
            yield self.chunks.popleft()


@router.post("/files/archive", response_class=StreamingResponse)
def download_archive(
    payload: ArchiveRequest, request: Request, session: DatabaseSession
):
    entries = []
    names = set()
    for file_id in dict.fromkeys(payload.file_ids):
        resource = require_resource(session, LibraryFile, file_id)
        path = request.app.state.settings.files_dir / resource.id
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Fichier stocké introuvable")
        base = Path(resource.filename.replace("\\", "/")).name
        if base in {"", ".", ".."}:
            base = resource.id
        name, suffix = base, 2
        while name.casefold() in names:
            name = f"{Path(base).stem}_{suffix}{Path(base).suffix}"
            suffix += 1
        names.add(name.casefold())
        entries.append((path, name))

    def stream():
        output = ArchiveBuffer()
        # Sans compression : faible charge CPU et aucun fichier temporaire.
        with ZipFile(output, "w", compression=ZIP_STORED, allowZip64=True) as archive:
            for path, name in entries:
                with path.open("rb") as source:
                    with archive.open(name, "w", force_zip64=True) as target:
                        while chunk := source.read(64 * 1024):
                            target.write(chunk)
                            yield from output.drain()
                    yield from output.drain()
        yield from output.drain()

    return StreamingResponse(
        stream(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="selection.zip"'},
    )


@router.post("/projects", response_model=ProjectResponse, status_code=201)
def create_project(payload: ProjectCreate, session: DatabaseSession):
    project = Project(name=payload.name)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@router.put("/projects/{project_id}/files/{file_id}", status_code=204)
def link_file(project_id: UUID, file_id: UUID, session: DatabaseSession):
    require_resource(session, Project, project_id)
    require_resource(session, LibraryFile, file_id)
    session.execute(
        insert(project_files)
        .values(project_id=str(project_id), file_id=str(file_id))
        .on_conflict_do_nothing()
    )
    session.commit()
    return Response(status_code=204)


@router.delete("/projects/{project_id}/files/{file_id}", status_code=204)
def unlink_file(project_id: UUID, file_id: UUID, session: DatabaseSession):
    require_resource(session, Project, project_id)
    require_resource(session, LibraryFile, file_id)
    session.execute(
        delete(project_files).where(
            project_files.c.project_id == str(project_id),
            project_files.c.file_id == str(file_id),
        )
    )
    session.commit()
    return Response(status_code=204)


@router.post(
    "/projects/{project_id}/notes", response_model=NoteResponse, status_code=201
)
def create_note(project_id: UUID, payload: NoteCreate, session: DatabaseSession):
    require_resource(session, Project, project_id)
    note = Note(project_id=str(project_id), content=payload.content)
    session.add(note)
    session.commit()
    session.refresh(note)
    return note
