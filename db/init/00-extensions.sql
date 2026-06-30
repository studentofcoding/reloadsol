-- Mirror Supabase extensions schema layout (vanilla Postgres)
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;

-- gen_random_uuid() lives in extensions; app SQL uses public schema tables
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET search_path TO public, extensions',
    current_database()
  );
END
$$;
