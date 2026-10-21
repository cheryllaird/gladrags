-- Private image buckets (spec: "Storage buckets are private and images are
-- served through short-lived signed URLs").
--
-- Object keys are '<user id>/<uuid>.<ext>'. Only the server writes images:
-- it checks them and strips EXIF first, then uploads with the Supabase
-- secret key (the service_role database role), which bypasses these
-- policies. So it must build keys from the session's user ID (see
-- imageKeyBelongsTo in src/contracts/item.ts).
--
-- Signed-in users may only read and delete objects in their own top-level
-- folder. There are deliberately no INSERT or UPDATE policies: a user
-- uploading straight to storage would skip the EXIF stripping and checks.
--
-- Size limits match MAX_ORIGINAL_BYTES (1.5 MB) and MAX_CUTOUT_BYTES
-- (2.5 MB) in src/contracts/item.ts. Cut-outs are made on the phone and
-- are always PNG, to keep their transparent background.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('originals', 'originals', false, 1572864, array['image/jpeg', 'image/png', 'image/webp']),
  ('cutouts', 'cutouts', false, 2621440, array['image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "images: read own" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('originals', 'cutouts')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "images: delete own" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('originals', 'cutouts')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
