-- The runner supplies a SCRAM verifier through a session setting, never a source password.
DO $roles$
DECLARE
  app_role record;
  verifier text := current_setting('regi.app_scram', true);
BEGIN
  SELECT * INTO app_role FROM pg_roles WHERE rolname = 'regi_app';
  IF FOUND THEN
    IF NOT app_role.rolcanlogin OR app_role.rolsuper OR app_role.rolbypassrls
       OR app_role.rolcreatedb OR app_role.rolcreaterole OR app_role.rolreplication THEN
      RAISE EXCEPTION 'REGI_APP_ROLE_UNSAFE';
    END IF;
  ELSE
    IF verifier IS NULL OR verifier NOT LIKE 'SCRAM-SHA-256$%' THEN
      RAISE EXCEPTION 'REGI_APP_ROLE_PASSWORD_REQUIRED';
    END IF;
    EXECUTE format('CREATE ROLE regi_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', verifier);
  END IF;
END
$roles$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
