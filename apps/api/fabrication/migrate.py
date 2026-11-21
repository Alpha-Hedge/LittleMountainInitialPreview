"""Run the frozen migrations then grant runtime's minimum read/append privileges."""
import asyncio
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from packages.ai.quote_rag import LOCAL_MODEL, backfill
from .config import database_url


async def grant():
    engine = create_async_engine(database_url())
    async with engine.begin() as conn:
        await conn.execute(text("""GRANT SELECT, INSERT ON work_centers, materials, customers,
                                  drawings, quotes, quote_line_items, nick_rules, quote_search_lines TO nfip_runtime"""))
        await conn.execute(text("GRANT SELECT, INSERT, UPDATE ON blueprint_quote_jobs TO nfip_runtime"))
        await conn.execute(text("GRANT SELECT, INSERT, UPDATE ON sketch_revisions TO nfip_runtime"))
        await conn.execute(text("GRANT SELECT, INSERT, UPDATE ON sketch_visual_previews TO nfip_runtime"))
        await conn.execute(text("GRANT SELECT, INSERT, UPDATE ON preference_jobs TO nfip_runtime"))
        await conn.execute(text("GRANT SELECT, INSERT ON preference_samples, blueprint_shop_files TO nfip_runtime"))
        await conn.execute(text("GRANT SELECT ON alembic_version TO nfip_runtime"))
    try:
        count = await backfill(async_sessionmaker(engine, expire_on_commit=False), LOCAL_MODEL)
        if count:
            print(f"Indexed {count} previously approved quote lines.")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    command.upgrade(Config("alembic.ini"), "head")
    asyncio.run(grant())

