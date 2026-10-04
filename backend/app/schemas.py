from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator


class ResourceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def utc_timestamp(cls, value: datetime) -> datetime:
        # SQLite restitue les dates sans information de fuseau.
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value


class FileResponse(ResourceResponse):
    filename: str
    size_bytes: int
    extension: str
    kind: Literal["model", "sliced", "slicer_project", "other"]
    is_print_related: bool
    state: str | None


class ProjectCreate(BaseModel):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]


class ProjectResponse(ResourceResponse):
    name: str


class NoteCreate(BaseModel):
    content: str

    @field_validator("content")
    @classmethod
    def nonempty_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("La note ne peut pas être vide")
        return value


class NoteResponse(ResourceResponse):
    project_id: str
    content: str


class FileStateUpdate(BaseModel):
    state: str | None


class TodoCreate(NoteCreate):
    pass


class TodoUpdate(BaseModel):
    content: str | None = None
    completed: bool | None = None

    @field_validator("content", "completed")
    @classmethod
    def validate_value(cls, value):
        if value is None or (isinstance(value, str) and not value.strip()):
            raise ValueError("La valeur ne peut pas être vide ou null")
        return value


class TodoResponse(NoteResponse):
    completed: bool


class ProjectDetail(ProjectResponse):
    files: list[FileResponse]
    notes: list[NoteResponse]
    todos: list[TodoResponse]
