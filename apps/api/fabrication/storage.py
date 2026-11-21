import hashlib
import io
import os
from functools import lru_cache
from minio import Minio
from minio.error import S3Error

BUCKET = os.getenv("NFIP_BUCKET", "engineering-records")


@lru_cache
def storage():
    return Minio(os.getenv("NFIP_S3_ENDPOINT", "minio:9000"), access_key=os.environ["NFIP_S3_USER"],
                 secret_key=os.environ["NFIP_S3_PASSWORD"], secure=os.getenv("NFIP_S3_TLS", "false").lower() == "true")


def store_source(data: bytes, mime: str):
    digest = hashlib.sha256(data).hexdigest()
    key = f"originals/{digest[:2]}/{digest}"
    result = storage().put_object(BUCKET, key, io.BytesIO(data), len(data), content_type=mime)
    if not result.version_id or result.version_id == "null":
        raise RuntimeError("Original storage must have bucket versioning enabled.")
    return key, result.version_id


def read_source(key: str, version: str) -> bytes:
    response = storage().get_object(BUCKET, key, version_id=version)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()


def store_sketch_file(data: bytes, name: str, mime: str) -> dict:
    digest = hashlib.sha256(data).hexdigest()
    key = f"sketch-artifacts/{digest[:2]}/{digest}"
    # Staged objects are content-addressed. Publish their exact versions together in PostgreSQL.
    try:
        version = storage().stat_object(BUCKET, key).version_id
    except S3Error as exc:
        if exc.code not in ("NoSuchKey", "NoSuchObject", "NotFound"):
            raise
        version = storage().put_object(BUCKET,key,io.BytesIO(data),len(data),content_type=mime).version_id
    if not version or version == "null":
        raise RuntimeError("Sketch storage requires bucket versioning.")
    return {"key":key,"version":version,"name":name,"mime":mime,"sha256":digest,"size":len(data)}

