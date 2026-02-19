create table if not exists public.news_paper_items (
  id bigserial primary key,
  topic text not null check (
    topic in (
      'science',
      'space',
      'technology',
      'cinema_movies',
      'music',
      'gaming',
      'global_wars'
    )
  ),
  title text not null,
  summary text not null,
  source_name text not null,
  source_url text not null,
  created_by text not null default 'axy-auto',
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists news_paper_items_source_url_unique_idx
  on public.news_paper_items (source_url);

create index if not exists news_paper_items_created_idx
  on public.news_paper_items (created_at desc);

alter table public.news_paper_items enable row level security;

drop policy if exists "news_paper_items_select_authenticated"
  on public.news_paper_items;

create policy "news_paper_items_select_authenticated"
on public.news_paper_items
for select
to authenticated
using (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.news_paper_items;
  exception
    when duplicate_object then null;
  end;
end
$$;
