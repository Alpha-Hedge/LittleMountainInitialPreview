"""Workers verify the exact stored object version against its ingest checksum."""
import hashlib
from celery import Celery
from urllib3.exceptions import HTTPError
from .config import redis_url
from .storage import read_source

worker = Celery("fabrication", broker=redis_url(0), backend=redis_url(1),
                include=["fabrication.blueprint_jobs","fabrication.sketch_jobs","packages.ai.rule_distiller"])
worker.conf.update(accept_content=["json"], task_serializer="json", result_serializer="json",
                   task_track_started=True, result_expires=86400,
                   worker_prefetch_multiplier=1, broker_connection_retry_on_startup=True)


@worker.task(acks_late=True, autoretry_for=(HTTPError,), retry_backoff=True, max_retries=3,
             soft_time_limit=90, time_limit=120)
def verify_original(key: str, version: str, expected: str):
    content = read_source(key, version)
    matches = hashlib.sha256(content).hexdigest() == expected
    return {"matches": matches, "bytes": len(content), "source_version": version}

