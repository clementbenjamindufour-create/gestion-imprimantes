import shutil
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.database import create_database_engine
from app.library import router as library_router


class HealthResponse(BaseModel):
    status: Literal["ok", "unavailable"]
    database: Literal["ok", "unavailable"]


class StorageResponse(BaseModel):
    total_bytes: int
    used_bytes: int
    free_bytes: int


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.files_dir.mkdir(parents=True, exist_ok=True)
        engine = create_database_engine(settings)
        app.state.engine = engine
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.include_router(library_router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
        expose_headers=["Content-Disposition"],
    )

    @app.get("/api/v1/storage", response_model=StorageResponse, tags=["storage"])
    def storage():
        try:
            usage = shutil.disk_usage(settings.files_dir)
        except OSError:
            raise HTTPException(
                status_code=503, detail="Informations de stockage indisponibles."
            ) from None
        return StorageResponse(
            total_bytes=usage.total, used_bytes=usage.used, free_bytes=usage.free
        )

    @app.get("/api/v1/health", response_model=HealthResponse, tags=["health"])
    def health(request: Request):
        try:
            with request.app.state.engine.connect() as connection:
                connection.execute(text("SELECT 1"))
        except SQLAlchemyError:
            return JSONResponse(
                status_code=503,
                content={"status": "unavailable", "database": "unavailable"},
            )
        return HealthResponse(status="ok", database="ok")

    return app


app = create_app()
