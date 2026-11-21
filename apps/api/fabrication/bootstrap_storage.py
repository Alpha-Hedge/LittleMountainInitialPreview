"""Provision a private, versioned source bucket and a restricted object account."""
import os
from minio import Minio
from minio.commonconfig import ENABLED
from minio.credentials import StaticProvider
from minio.minioadmin import MinioAdmin
from minio.versioningconfig import VersioningConfig
from .storage import BUCKET


def main():
    host = os.environ["NFIP_S3_ENDPOINT"]
    owner = os.environ["MINIO_ROOT_USER"]
    password = os.environ["MINIO_ROOT_PASSWORD"]
    user = os.environ["NFIP_S3_USER"]
    storage = Minio(host, access_key=owner, secret_key=password, secure=False)
    if not storage.bucket_exists(BUCKET):
        storage.make_bucket(BUCKET)
    storage.set_bucket_versioning(BUCKET, VersioningConfig(ENABLED))
    admin = MinioAdmin(endpoint=host, credentials=StaticProvider(owner, password), secure=False)
    admin.user_add(user, os.environ["NFIP_S3_PASSWORD"])
    arn = f"arn:aws:s3:::{BUCKET}"
    admin.policy_add("engineering-records", policy={"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["s3:GetBucketLocation", "s3:ListBucket"], "Resource": [arn]},
        {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
         "Resource": [f"{arn}/originals/*",f"{arn}/sketch-artifacts/*"]},
    ]})
    admin.policy_set("engineering-records", user=user)


if __name__ == "__main__":
    main()

