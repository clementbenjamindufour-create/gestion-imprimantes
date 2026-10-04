from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PRINTERS_", env_file=BACKEND_DIR / ".env", extra="ignore"
    )

    app_name: str = "Gestion des imprimantes 3D"
    data_dir: Path = BACKEND_DIR / "data"
    cors_origins: list[str] = ["http://localhost:4200"]

    @property
    def resolved_data_dir(self) -> Path:
        path = self.data_dir.expanduser()
        return path if path.is_absolute() else BACKEND_DIR / path

    @property
    def files_dir(self) -> Path:
        return self.resolved_data_dir / "files"
