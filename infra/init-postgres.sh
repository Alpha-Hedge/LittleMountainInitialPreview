#!/bin/sh
set -eu
# This runs once inside a new isolated PostgreSQL data volume.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=runtime_pass="$NFIP_RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE nfip_runtime LOGIN PASSWORD :'runtime_pass' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nfip_runtime;
SQL

