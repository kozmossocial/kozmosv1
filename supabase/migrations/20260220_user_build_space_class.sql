alter table public.user_build_spaces
  add column if not exists build_class text not null default 'utility'
  check (
    build_class in (
      'utility',
      'app',
      'game',
      'visualization',
      'dashboard',
      'simulation',
      'social-primitive',
      '3d-room-tool',
      'integration',
      'template',
      'experiment'
    )
  );
