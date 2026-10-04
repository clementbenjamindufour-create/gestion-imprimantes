from collections.abc import Generator

from fastapi import Request
from sqlalchemy import URL, Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session

from app.config import Settings


class Base(DeclarativeBase):
    pass


def create_database_engine(settings: Settings) -> Engine:
    settings.resolved_data_dir.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        URL.create(
            "sqlite+pysqlite",
            database=str(settings.resolved_data_dir / "printers.db"),
        ),
        connect_args={"check_same_thread": False, "timeout": 15},
    )

    @event.listens_for(engine, "connect")
    def configure_sqlite(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


def get_session(request: Request) -> Generator[Session, None, None]:
    with Session(request.app.state.engine) as session:
        yield session
