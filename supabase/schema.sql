-- =====================================================================
-- Masjid Times — database for crowd-verified jamaat (congregation) times
-- Run once in Supabase: SQL Editor → paste → Run. Safe to re-run.
--
-- Trust model in one paragraph:
--   Nobody edits a timing directly. A change is a *proposal*. People who
--   are physically at the masjid (GPS within 250 m) agree or disagree.
--   Votes are weighted by each person's track record (new phones count
--   less, people whose reports were later confirmed count more). A
--   proposal goes live only when enough independent people agree, and
--   impossible times (e.g. Fajr after sunrise) are refused outright using
--   the sun's position for that masjid and date. Precise user locations
--   are never stored — only the distance to the masjid.
-- =====================================================================

-- ---------------------------------------------------------------- tables

create table if not exists public.mosques (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 2 and 120),
  lat           double precision not null check (lat between -90 and 90),
  lon           double precision not null check (lon between -180 and 180),
  osm_id        text unique,                       -- e.g. 'node/123' for imported mosques
  status        text not null default 'active' check (status in ('active', 'pending', 'hidden')),
  added_by      uuid,                              -- null for imported mosques
  confirmations int not null default 0,            -- people who confirmed it exists
  reports       numeric not null default 0,        -- weighted "doesn't exist / wrong place" reports
  created_at    timestamptz not null default now()
);
create index if not exists mosques_lat_lon on public.mosques (lat, lon);

create table if not exists public.timings (
  mosque_id    uuid not null references public.mosques on delete cascade,
  prayer       text not null check (prayer in ('fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah')),
  kind         text not null default 'fixed' check (kind in ('fixed', 'after_sunset')),
  minutes      int  not null,       -- fixed: minutes after local midnight; after_sunset: minutes after sunset
  confirmed_by int  not null default 0,
  verified_at  timestamptz not null default now(),   -- last accepted or re-confirmed
  updated_at   timestamptz not null default now(),   -- last time the time itself changed
  primary key (mosque_id, prayer)
);

create table if not exists public.profiles (
  user_id    uuid primary key,
  accepted   int not null default 0,      -- proposals by this person that went live
  rejected   int not null default 0,      -- proposals by this person the community rejected
  steward_of uuid[] not null default '{}',-- masjids this person is a verified steward of
  created_at timestamptz not null default now()
);

create table if not exists public.proposals (
  id          uuid primary key default gen_random_uuid(),
  mosque_id   uuid not null references public.mosques on delete cascade,
  prayer      text not null check (prayer in ('fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah')),
  kind        text not null check (kind in ('fixed', 'after_sunset')),
  minutes     int  not null,
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  status      text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'superseded', 'expired')),
  agree       numeric not null default 0,
  disagree    numeric not null default 0,
  agree_count int not null default 0,
  disagree_count int not null default 0,
  closed_at   timestamptz
);
create index if not exists proposals_open on public.proposals (mosque_id, prayer) where status = 'open';

create table if not exists public.votes (
  proposal_id uuid not null references public.proposals on delete cascade,
  user_id     uuid not null,
  agree       boolean not null,
  weight      numeric not null,
  distance_m  int not null,               -- distance to the masjid; the location itself is not kept
  created_at  timestamptz not null default now(),
  primary key (proposal_id, user_id)
);

create table if not exists public.reconfirmations (
  mosque_id uuid not null references public.mosques on delete cascade,
  prayer    text not null,
  user_id   uuid not null,
  day       date not null default current_date,
  primary key (mosque_id, prayer, user_id, day)
);

create table if not exists public.mosque_votes (
  mosque_id  uuid not null references public.mosques on delete cascade,
  user_id    uuid not null,
  kind       text not null check (kind in ('confirm', 'report')),
  created_at timestamptz not null default now(),
  primary key (mosque_id, user_id, kind)
);

create table if not exists public.action_log (
  user_id uuid not null,
  action  text not null,
  at      timestamptz not null default now()
);
create index if not exists action_log_user_at on public.action_log (user_id, at);

-- ---------------------------------------------------------------- security
-- Everyone may read masjids and timings. Nothing may be written directly:
-- all changes go through the functions below, which enforce the rules.

alter table public.mosques         enable row level security;
alter table public.timings         enable row level security;
alter table public.profiles        enable row level security;
alter table public.proposals       enable row level security;
alter table public.votes           enable row level security;
alter table public.reconfirmations enable row level security;
alter table public.mosque_votes    enable row level security;
alter table public.action_log      enable row level security;

drop policy if exists "read visible mosques" on public.mosques;
create policy "read visible mosques" on public.mosques for select using (status <> 'hidden');
drop policy if exists "read timings" on public.timings;
create policy "read timings" on public.timings for select using (true);

revoke all on all tables in schema public from anon, authenticated;
-- readable columns only (who added a masjid stays private)
grant select (id, name, lat, lon, osm_id, status, confirmations, created_at) on public.mosques to anon, authenticated;
grant select on public.timings to anon, authenticated;

-- ---------------------------------------------------------------- helpers

create or replace function public.distance_m(lat1 float8, lon1 float8, lat2 float8, lon2 float8)
returns float8 language sql immutable as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)));
$$;

-- Sun-based times for a place and date, in minutes after local midnight (Pakistan: UTC+5).
-- Standard astronomical formulas (as used by prayer-time calculators).
create or replace function public.sun_times(p_lat float8, p_lon float8, p_day date, p_tz float8 default 5)
returns table (fajr int, sunrise int, noon int, asr_shafii int, asr_hanafi int, sunset int, isha int)
language plpgsql immutable as $$
declare
  jd float8; d float8; g float8; q float8; l float8; e float8;
  ra float8; decl float8; eqt float8; n float8;
  la float8 := radians(p_lat);
begin
  jd := (p_day - date '2000-01-01') + 2451544.5 - p_lon / 360.0;   -- Julian day at local solar noon (approx.)
  d  := jd - 2451545.0 + 0.5;
  g  := radians(mod((357.529 + 0.98560028 * d)::numeric, 360)::float8);
  q  := mod((280.459 + 0.98564736 * d)::numeric, 360)::float8;
  l  := radians(q + 1.915 * sin(g) + 0.020 * sin(2 * g));
  e  := radians(23.439 - 0.00000036 * d);
  ra := degrees(atan2(cos(e) * sin(l), cos(l))) / 15.0;
  ra := ra - 24 * floor(ra / 24);
  decl := asin(sin(e) * sin(l));
  eqt := q / 15.0 - ra;
  eqt := eqt - 24 * round(eqt / 24);
  n := 12 + p_tz - p_lon / 15.0 - eqt;                             -- solar noon, hours

  noon    := round(n * 60);
  sunrise := round((n - degrees(acos(least(1, greatest(-1, (-sin(radians(0.833)) - sin(decl) * sin(la)) / (cos(decl) * cos(la)))))) / 15.0) * 60);
  sunset  := round((n + degrees(acos(least(1, greatest(-1, (-sin(radians(0.833)) - sin(decl) * sin(la)) / (cos(decl) * cos(la)))))) / 15.0) * 60);
  fajr    := round((n - degrees(acos(least(1, greatest(-1, (-sin(radians(18.0)) - sin(decl) * sin(la)) / (cos(decl) * cos(la)))))) / 15.0) * 60);
  isha    := round((n + degrees(acos(least(1, greatest(-1, (-sin(radians(18.0)) - sin(decl) * sin(la)) / (cos(decl) * cos(la)))))) / 15.0) * 60);
  asr_shafii := round((n + degrees(acos(least(1, greatest(-1,
      (sin(atan(1.0 / (1 + tan(abs(la - decl))))) - sin(decl) * sin(la)) / (cos(decl) * cos(la)))))) / 15.0) * 60);
  asr_hanafi := round((n + degrees(acos(least(1, greatest(-1,
      (sin(atan(1.0 / (2 + tan(abs(la - decl))))) - sin(decl) * sin(la)) / (cos(decl) * cos(la)))))) / 15.0) * 60);
  return next;
end $$;

-- Is a jamaat time possible for this prayer, at this place, today? Returns null if yes, else a reason.
create or replace function public.check_window(p_prayer text, p_kind text, p_minutes int, p_lat float8, p_lon float8, p_day date default (now() at time zone 'Asia/Karachi')::date)
returns text language plpgsql stable as $$
declare s record; m int;
begin
  select * into s from public.sun_times(p_lat, p_lon, p_day);
  if p_kind = 'after_sunset' then
    if p_prayer <> 'maghrib' then return 'only Maghrib can be set relative to sunset'; end if;
    if p_minutes < 0 or p_minutes > 30 then return 'Maghrib must be within 30 minutes of sunset'; end if;
    return null;
  end if;
  m := p_minutes;
  if m < 0 or m >= 1440 then return 'not a valid time of day'; end if;
  case p_prayer
    when 'fajr'    then if m < s.fajr - 10 or m > s.sunrise - 5   then return 'Fajr jamaat must be between dawn and sunrise'; end if;
    when 'dhuhr'   then if m < s.noon or m > s.asr_hanafi         then return 'Dhuhr jamaat must be between midday and Asr'; end if;
    when 'jumuah'  then if m < s.noon or m > s.asr_hanafi         then return 'Jumuah must be between midday and Asr'; end if;
    when 'asr'     then if m < s.asr_shafii - 5 or m > s.sunset - 10 then return 'Asr jamaat must be between the start of Asr and sunset'; end if;
    when 'maghrib' then if m < s.sunset - 2 or m > s.sunset + 30  then return 'Maghrib jamaat must be within 30 minutes of sunset'; end if;
    when 'isha'    then if m < s.sunset + 55                      then return 'Isha jamaat must be at least an hour after sunset'; end if;
    else return 'unknown prayer';
  end case;
  return null;
end $$;

-- How much one person's vote counts: new phones count less, a good track record counts more.
create or replace function public.user_weight(p_user uuid, p_mosque uuid)
returns numeric language plpgsql stable as $$
declare p record; w numeric;
begin
  select * into p from public.profiles where user_id = p_user;
  if not found then return 0.8; end if;
  if p_mosque = any (p.steward_of) then return 3; end if;
  w := case when p.created_at > now() - interval '2 days' and p.accepted = 0 then 0.8 else 1.0 end;
  w := w + 0.2 * least(p.accepted, 5) - 0.5 * p.rejected;
  return greatest(0.2, least(2.0, w));
end $$;

create or replace function public.require_user()
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'SIGN_IN_REQUIRED' using hint = 'Open the app once while online to get a private ID.'; end if;
  insert into public.profiles (user_id) values (u) on conflict do nothing;
  return u;
end $$;

create or replace function public.rate_limit(p_user uuid, p_action text, p_max int, p_window interval)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if (select count(*) from public.action_log where user_id = p_user and action = p_action and at > now() - p_window) >= p_max then
    raise exception 'RATE_LIMIT' using hint = 'Too many changes today. Please try again tomorrow.';
  end if;
  insert into public.action_log (user_id, action) values (p_user, p_action);
end $$;

create or replace function public.require_presence(p_mosque uuid, p_lat float8, p_lon float8, p_mock boolean, p_max_m int default 250)
returns int language plpgsql stable security definer set search_path = public as $$
declare m record; d float8;
begin
  if coalesce(p_mock, false) then raise exception 'MOCK_LOCATION' using hint = 'Turn off fake-location apps to contribute.'; end if;
  select * into m from public.mosques where id = p_mosque and status <> 'hidden';
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_lat is null or p_lon is null then raise exception 'LOCATION_REQUIRED'; end if;
  d := public.distance_m(p_lat, p_lon, m.lat, m.lon);
  if d > p_max_m then
    raise exception 'TOO_FAR' using hint = format('You need to be at the masjid to do this (you are %s m away).', round(d));
  end if;
  return round(d);
end $$;

-- ---------------------------------------------------------------- consensus

-- Recount a proposal and decide whether it goes live or is rejected.
create or replace function public.evaluate_proposal(p_id uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  p record; has_current boolean; steward_agrees boolean; net numeric;
begin
  update public.proposals pr set
    agree          = coalesce((select sum(weight) from public.votes v where v.proposal_id = pr.id and v.agree), 0),
    disagree       = coalesce((select sum(weight) from public.votes v where v.proposal_id = pr.id and not v.agree), 0),
    agree_count    = (select count(*) from public.votes v where v.proposal_id = pr.id and v.agree),
    disagree_count = (select count(*) from public.votes v where v.proposal_id = pr.id and not v.agree)
  where pr.id = p_id
  returning * into p;
  if p.status <> 'open' then return p.status; end if;

  if p.created_at < now() - interval '7 days' then
    update public.proposals set status = 'expired', closed_at = now() where id = p_id;
    return 'expired';
  end if;

  select exists (select 1 from public.timings t where t.mosque_id = p.mosque_id and t.prayer = p.prayer) into has_current;
  select exists (select 1 from public.votes v where v.proposal_id = p_id and v.agree and v.weight >= 3) into steward_agrees;
  net := p.agree - p.disagree;

  -- Rejected: clearly more weight against than for
  if p.disagree - p.agree >= 1.5 and p.disagree_count >= 2 then
    update public.proposals set status = 'rejected', closed_at = now() where id = p_id;
    update public.profiles set rejected = rejected + 1 where user_id = p.created_by;
    return 'rejected';
  end if;

  -- Accepted: enough independent agreement (stricter when it would replace an existing time)
  if (steward_agrees and p.disagree < 2)
     or (has_current and p.agree_count >= 3 and net >= 2.2)
     or (not has_current and p.agree_count >= 2 and net >= 1.5) then
    insert into public.timings (mosque_id, prayer, kind, minutes, confirmed_by, verified_at, updated_at)
    values (p.mosque_id, p.prayer, p.kind, p.minutes, p.agree_count, now(), now())
    on conflict (mosque_id, prayer) do update set
      kind = excluded.kind,
      minutes = excluded.minutes,
      confirmed_by = excluded.confirmed_by,
      verified_at = now(),
      updated_at = case when public.timings.kind = excluded.kind and public.timings.minutes = excluded.minutes
                        then public.timings.updated_at else now() end;
    update public.proposals set status = 'accepted', closed_at = now() where id = p_id;
    update public.proposals set status = 'superseded', closed_at = now()
      where mosque_id = p.mosque_id and prayer = p.prayer and status = 'open' and id <> p_id;
    update public.profiles set accepted = accepted + 1 where user_id = p.created_by;
    return 'accepted';
  end if;
  return 'open';
end $$;

-- ---------------------------------------------------------------- actions (called by the app)

create or replace function public.submit_timing(p_mosque uuid, p_prayer text, p_kind text, p_minutes int,
                                                p_lat float8, p_lon float8, p_mock boolean default false)
returns json language plpgsql volatile security definer set search_path = public as $$
declare u uuid; dist int; m record; reason text; cur record; existing uuid; pid uuid; result text;
begin
  u := public.require_user();
  dist := public.require_presence(p_mosque, p_lat, p_lon, p_mock);
  select * into m from public.mosques where id = p_mosque;
  reason := public.check_window(p_prayer, p_kind, p_minutes, m.lat, m.lon);
  if reason is not null then raise exception 'IMPOSSIBLE_TIME' using hint = reason; end if;

  -- Same as the current time: count it as a re-confirmation
  select * into cur from public.timings where mosque_id = p_mosque and prayer = p_prayer;
  if found and cur.kind = p_kind and cur.minutes = p_minutes then
    return public.reconfirm_timing(p_mosque, p_prayer, p_lat, p_lon, p_mock);
  end if;

  -- Someone already proposed exactly this: add an agreeing vote instead of a duplicate
  select id into existing from public.proposals
    where mosque_id = p_mosque and prayer = p_prayer and kind = p_kind and minutes = p_minutes and status = 'open'
    limit 1;
  if existing is not null then
    return public.vote_proposal(existing, true, p_lat, p_lon, p_mock);
  end if;

  perform public.rate_limit(u, 'propose', 12, interval '1 day');
  -- one open proposal per person per prayer: a newer one replaces the older
  update public.proposals set status = 'superseded', closed_at = now()
    where mosque_id = p_mosque and prayer = p_prayer and created_by = u and status = 'open';

  insert into public.proposals (mosque_id, prayer, kind, minutes, created_by)
  values (p_mosque, p_prayer, p_kind, p_minutes, u) returning id into pid;
  insert into public.votes (proposal_id, user_id, agree, weight, distance_m)
  values (pid, u, true, public.user_weight(u, p_mosque), dist);
  result := public.evaluate_proposal(pid);
  return json_build_object('proposal', pid, 'status', result);
end $$;

create or replace function public.vote_proposal(p_proposal uuid, p_agree boolean,
                                                p_lat float8, p_lon float8, p_mock boolean default false)
returns json language plpgsql volatile security definer set search_path = public as $$
declare u uuid; p record; dist int; result text;
begin
  u := public.require_user();
  select * into p from public.proposals where id = p_proposal;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p.status <> 'open' then return json_build_object('proposal', p.id, 'status', p.status); end if;
  dist := public.require_presence(p.mosque_id, p_lat, p_lon, p_mock);
  perform public.rate_limit(u, 'vote', 60, interval '1 day');
  insert into public.votes (proposal_id, user_id, agree, weight, distance_m)
  values (p_proposal, u, p_agree, public.user_weight(u, p.mosque_id), dist)
  on conflict (proposal_id, user_id) do update set agree = excluded.agree, created_at = now();
  result := public.evaluate_proposal(p_proposal);
  return json_build_object('proposal', p.id, 'status', result);
end $$;

-- "This time is still correct" — keeps a timing fresh. Once per person per prayer per day.
create or replace function public.reconfirm_timing(p_mosque uuid, p_prayer text,
                                                   p_lat float8, p_lon float8, p_mock boolean default false)
returns json language plpgsql volatile security definer set search_path = public as $$
declare u uuid; n int;
begin
  u := public.require_user();
  perform public.require_presence(p_mosque, p_lat, p_lon, p_mock);
  if not exists (select 1 from public.timings where mosque_id = p_mosque and prayer = p_prayer) then
    raise exception 'NOT_FOUND';
  end if;
  insert into public.reconfirmations (mosque_id, prayer, user_id) values (p_mosque, p_prayer, u)
  on conflict do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    update public.timings set confirmed_by = confirmed_by + 1, verified_at = now()
      where mosque_id = p_mosque and prayer = p_prayer;
  end if;
  return json_build_object('status', 'reconfirmed');
end $$;

-- Add a masjid that isn't listed. You must be standing at it; it starts as "pending"
-- and becomes active once two other people at the masjid confirm it.
create or replace function public.add_mosque(p_name text, p_lat float8, p_lon float8, p_mock boolean default false)
returns json language plpgsql volatile security definer set search_path = public as $$
declare u uuid; near record; mid uuid;
begin
  u := public.require_user();
  if coalesce(p_mock, false) then raise exception 'MOCK_LOCATION'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'NAME_REQUIRED'; end if;
  select id, name into near from public.mosques
    where status <> 'hidden' and lat between p_lat - 0.0005 and p_lat + 0.0005 and lon between p_lon - 0.0006 and p_lon + 0.0006
      and public.distance_m(p_lat, p_lon, lat, lon) < 40
    limit 1;
  if found then raise exception 'ALREADY_LISTED' using hint = near.name; end if;
  perform public.rate_limit(u, 'add_mosque', 3, interval '1 day');
  insert into public.mosques (name, lat, lon, status, added_by, confirmations)
  values (trim(p_name), p_lat, p_lon, 'pending', u, 1) returning id into mid;
  insert into public.mosque_votes (mosque_id, user_id, kind) values (mid, u, 'confirm');
  return json_build_object('mosque', mid, 'status', 'pending');
end $$;

create or replace function public.confirm_mosque(p_mosque uuid, p_lat float8, p_lon float8, p_mock boolean default false)
returns json language plpgsql volatile security definer set search_path = public as $$
declare u uuid; n int; m record;
begin
  u := public.require_user();
  perform public.require_presence(p_mosque, p_lat, p_lon, p_mock, 150);
  insert into public.mosque_votes (mosque_id, user_id, kind) values (p_mosque, u, 'confirm') on conflict do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    update public.mosques set confirmations = confirmations + 1,
      status = case when status = 'pending' and confirmations + 1 >= 3 then 'active' else status end
      where id = p_mosque;
  end if;
  select status into m from public.mosques where id = p_mosque;
  return json_build_object('status', m.status);
end $$;

-- Report a listing that doesn't exist or is in the wrong place. Hidden once reports outweigh confirmations.
create or replace function public.report_mosque(p_mosque uuid)
returns json language plpgsql volatile security definer set search_path = public as $$
declare u uuid; n int;
begin
  u := public.require_user();
  perform public.rate_limit(u, 'report', 10, interval '1 day');
  insert into public.mosque_votes (mosque_id, user_id, kind) values (p_mosque, u, 'report') on conflict do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    update public.mosques set reports = reports + public.user_weight(u, p_mosque),
      status = case when reports + public.user_weight(u, p_mosque) >= 3
                     and reports + public.user_weight(u, p_mosque) > confirmations then 'hidden' else status end
      where id = p_mosque;
  end if;
  return json_build_object('status', 'reported');
end $$;

-- ---------------------------------------------------------------- reading (no user ids are ever returned)

create or replace function public.mosque_json(m public.mosques, p_lat float8 default null, p_lon float8 default null)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', m.id, 'name', m.name, 'lat', m.lat, 'lon', m.lon, 'status', m.status,
    'confirmations', m.confirmations,
    'distance', case when p_lat is null then null else round(public.distance_m(p_lat, p_lon, m.lat, m.lon)) end,
    'timings', coalesce((select json_agg(json_build_object(
        'prayer', t.prayer, 'kind', t.kind, 'minutes', t.minutes, 'confirmed_by', t.confirmed_by,
        'verified_at', t.verified_at, 'updated_at', t.updated_at) order by t.prayer)
      from public.timings t where t.mosque_id = m.id), '[]'::json),
    -- unconfirmed reports for prayers that have no live time yet (shown as "unverified")
    'pending', coalesce((select json_agg(json_build_object(
        'id', pr.id, 'prayer', pr.prayer, 'kind', pr.kind, 'minutes', pr.minutes,
        'agree_count', pr.agree_count, 'disagree_count', pr.disagree_count, 'created_at', pr.created_at,
        'mine', pr.created_by = auth.uid(),
        'my_vote', (select v.agree from public.votes v where v.proposal_id = pr.id and v.user_id = auth.uid())))
      from public.proposals pr where pr.mosque_id = m.id and pr.status = 'open'
        and pr.created_at > now() - interval '7 days'), '[]'::json)
  );
$$;

create or replace function public.nearby_mosques(p_lat float8, p_lon float8, p_radius_m int default 3000)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(j order by (j->>'distance')::float8), '[]'::json) from (
    select public.mosque_json(m, p_lat, p_lon) j
    from public.mosques m
    where m.status <> 'hidden'
      and m.lat between p_lat - least(p_radius_m, 20000) / 111000.0 and p_lat + least(p_radius_m, 20000) / 111000.0
      and m.lon between p_lon - least(p_radius_m, 20000) / (111000.0 * cos(radians(p_lat)))
                    and p_lon + least(p_radius_m, 20000) / (111000.0 * cos(radians(p_lat)))
      and public.distance_m(p_lat, p_lon, m.lat, m.lon) <= least(p_radius_m, 20000)
    order by public.distance_m(p_lat, p_lon, m.lat, m.lon)
    limit 80
  ) s;
$$;

create or replace function public.mosques_by_id(p_ids uuid[], p_lat float8 default null, p_lon float8 default null)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(public.mosque_json(m, p_lat, p_lon)), '[]'::json)
  from public.mosques m where m.id = any (p_ids[1:50]) and m.status <> 'hidden';
$$;

create or replace function public.search_mosques(p_query text, p_lat float8 default null, p_lon float8 default null)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select public.mosque_json(m, p_lat, p_lon) j from public.mosques m
    where m.status <> 'hidden' and char_length(p_query) >= 2 and m.name ilike '%' || p_query || '%'
    order by case when p_lat is null then 0 else public.distance_m(p_lat, p_lon, m.lat, m.lon) end
    limit 40) s;
$$;

-- ---------------------------------------------------------------- permissions

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.nearby_mosques(float8, float8, int)            to anon, authenticated;
grant execute on function public.mosques_by_id(uuid[], float8, float8)          to anon, authenticated;
grant execute on function public.search_mosques(text, float8, float8)           to anon, authenticated;
grant execute on function public.sun_times(float8, float8, date, float8)        to anon, authenticated;
grant execute on function public.submit_timing(uuid, text, text, int, float8, float8, boolean) to authenticated;
grant execute on function public.vote_proposal(uuid, boolean, float8, float8, boolean)          to authenticated;
grant execute on function public.reconfirm_timing(uuid, text, float8, float8, boolean)          to authenticated;
grant execute on function public.add_mosque(text, float8, float8, boolean)                      to authenticated;
grant execute on function public.confirm_mosque(uuid, float8, float8, boolean)                  to authenticated;
grant execute on function public.report_mosque(uuid)                                            to authenticated;
