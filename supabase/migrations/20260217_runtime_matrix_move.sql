alter table public.runtime_presence
  add column if not exists matrix_x double precision not null default 0,
  add column if not exists matrix_z double precision not null default 0,
  add column if not exists matrix_updated_at timestamptz;

create index if not exists runtime_presence_matrix_updated_idx
  on public.runtime_presence (matrix_updated_at desc);
