-- Optional app role (BYPASSRLS = same effective access as former SUPABASE_SECRET_KEY).
-- Fresh dev: postgres superuser via bouncer is enough; this role is for hardening.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reloadsol_app') THEN
    CREATE ROLE reloadsol_app LOGIN PASSWORD 'reloadsol_app_dev' BYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE reloadsol_db TO reloadsol_app;
GRANT USAGE ON SCHEMA public TO reloadsol_app;
GRANT USAGE ON SCHEMA extensions TO reloadsol_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO reloadsol_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO reloadsol_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO reloadsol_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO reloadsol_app;
