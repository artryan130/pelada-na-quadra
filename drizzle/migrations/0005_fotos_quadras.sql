-- Fotos das quadras no Storage do Supabase.
-- Bucket público "quadras": qualquer um vê a foto pela URL; só o gestor do local
-- envia, troca ou apaga. Caminho dos arquivos: <venue_id>/<court_id>/<arquivo>.
-- Idempotente: pode rodar de novo sem erro.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quadras', 'quadras', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- A primeira pasta do caminho é o local; compara como texto para não quebrar com nomes inválidos.
create or replace function public.gerencia_pasta_local(_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.venue_managers m
    where m.user_id = auth.uid() and m.venue_id::text = split_part(_path, '/', 1))
$$;

drop policy if exists "quadras fotos select" on storage.objects;
drop policy if exists "quadras fotos insert" on storage.objects;
drop policy if exists "quadras fotos update" on storage.objects;
drop policy if exists "quadras fotos delete" on storage.objects;

create policy "quadras fotos select" on storage.objects for select to authenticated
  using (bucket_id = 'quadras' and public.gerencia_pasta_local(name));
create policy "quadras fotos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'quadras' and public.gerencia_pasta_local(name));
create policy "quadras fotos update" on storage.objects for update to authenticated
  using (bucket_id = 'quadras' and public.gerencia_pasta_local(name))
  with check (bucket_id = 'quadras' and public.gerencia_pasta_local(name));
create policy "quadras fotos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'quadras' and public.gerencia_pasta_local(name));

revoke execute on all functions in schema public from anon;
grant execute on function public.cnpj_in_use(text) to anon, authenticated;
