-- READ-ONLY catalog dump. Run in the SQL editor of EACH project (old, then new);
-- it returns one row with one JSON cell. Save each result to a file and diff
-- them to see every table / column / index / constraint / policy / function /
-- RLS-flag difference — the parts PostgREST does not expose.
--
-- Changes nothing. Contains no row data, no secrets.

select jsonb_pretty(jsonb_build_object(
  'tables', (
    select coalesce(jsonb_object_agg(c.relname, jsonb_build_object(
      'rls_enabled', c.relrowsecurity,
      'rls_forced',  c.relforcerowsecurity,
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attname)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'indexes', (
        select coalesce(jsonb_agg(regexp_replace(indexdef, ' ON public\.', ' ON ') order by indexname), '[]'::jsonb)
        from pg_indexes i where i.schemaname = 'public' and i.tablename = c.relname),
      'constraints', (
        select coalesce(jsonb_agg(pg_get_constraintdef(k.oid) order by pg_get_constraintdef(k.oid)), '[]'::jsonb)
        from pg_constraint k where k.conrelid = c.oid),
      'policies', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', p.policyname, 'cmd', p.cmd, 'roles', p.roles,
          'using', p.qual, 'check', p.with_check) order by p.policyname), '[]'::jsonb)
        from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname),
      'anon_privileges', (
        select coalesce(jsonb_agg(g.privilege_type order by g.privilege_type), '[]'::jsonb)
        from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'anon')
    )), '{}'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),
  'functions', (
    select coalesce(jsonb_object_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      jsonb_build_object(
        'security_definer', p.prosecdef,
        'md5_of_body', md5(p.prosrc),
        'acl', p.proacl::text)), '{}'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public')
)) as catalog;
