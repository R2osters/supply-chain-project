"""Service configuration, read once from the environment at import time."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "scip-ai"
    version: str = "0.1.0"

    #: Shared secret the NestJS API presents. The AI service is not internet-facing, but an
    #: unauthenticated optimiser inside the cluster is still an unauthenticated optimiser.
    ai_service_token: str = "dev_only_ai_shared_token_replace_me"

    #: When false, the token check is skipped entirely — local development only.
    require_auth: bool = True

    #: Where fitted models and their metadata are persisted.
    models_store: Path = Path("models_store")

    database_url: str | None = None

    #: Hard ceiling on any single solve, so one pathological request cannot hold a worker.
    solver_time_limit_seconds: int = 30

    #: Monte-Carlo iterations for scenario simulation when the caller does not specify.
    default_scenario_iterations: int = 2000


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.models_store.mkdir(parents=True, exist_ok=True)
    return settings
