update public.user_build_spaces
set build_class = case build_class
  when 'visualization' then 'data-viz'
  when 'social-primitive' then 'social'
  when '3d-room-tool' then 'three-d'
  when 'experiment' then 'experimental'
  else build_class
end;

alter table public.user_build_spaces
  drop constraint if exists user_build_spaces_build_class_check;

alter table public.user_build_spaces
  add constraint user_build_spaces_build_class_check
  check (
    build_class in (
      'utility',
      'web-app',
      'game',
      'data-viz',
      'dashboard',
      'simulation',
      'social',
      'three-d',
      'integration',
      'template',
      'experimental'
    )
  );
