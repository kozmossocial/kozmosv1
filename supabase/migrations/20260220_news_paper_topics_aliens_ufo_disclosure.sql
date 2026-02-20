do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.news_paper_items'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%topic%'
  loop
    execute format(
      'alter table public.news_paper_items drop constraint if exists %I',
      c.conname
    );
  end loop;

  alter table public.news_paper_items
    add constraint news_paper_items_topic_check
    check (
      topic in (
        'science',
        'space',
        'technology',
        'cinema_movies',
        'music',
        'gaming',
        'global_wars',
        'aliens',
        'ufo',
        'disclosure'
      )
    );
end
$$;
