import os
from functools import lru_cache
from urllib.parse import quote

from sqlalchemy import URL
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def database_url() -> URL:
    return URL.create("postgresql+asyncpg", username=os.environ["NFIP_DB_USER"],
                      password=os.environ["NFIP_DB_PASSWORD"], host=os.getenv("NFIP_DB_HOST", "postgres"),
                      port=int(os.getenv("NFIP_DB_PORT", "5432")), database=os.getenv("NFIP_DB_NAME", "fabrication"))


@lru_cache
def sessions():
    return async_sessionmaker(create_async_engine(database_url(), pool_pre_ping=True), expire_on_commit=False)


def redis_url(db: int) -> str:
    password = quote(os.environ["NFIP_REDIS_PASSWORD"], safe="")
    return f"redis://:{password}@{os.getenv('NFIP_REDIS_HOST', 'redis')}:6379/{db}"

