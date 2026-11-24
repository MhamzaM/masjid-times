# Masjid Times

Jamaat times of the masjids around you, kept accurate by the people who pray there.
Free, with no ads and no account. English, اردو, پښتو. Launching in Peshawar.

- **Nearby masjids** as a list or a map (your location plus every masjid around you), with search. Pick *your masjid* and follow others.
- **Jamaat board:** the next jamaat with a countdown, and each time shown as *confirmed by N* or *unverified*. Maghrib can be set as "sunset + N minutes" so it follows the sun every day.
- **Reminders** before each jamaat (per prayer, 5–30 minutes ahead). Jumuah replaces Dhuhr on Fridays.
- **Change alerts** when a jamaat time changes at a masjid you follow.
- **Add a missing masjid** while standing at it.

## How it stays accurate

Nobody edits a time directly. A change is a **proposal**, and it goes live only after other people **at the masjid** agree.

| Check | How |
|---|---|
| You must be there | GPS within 250 m to report or vote, and 150 m to confirm a new masjid |
| Fake GPS | Locations from fake-location apps are refused |
| Independent people | 2 agreements for a first time, 3 to replace a confirmed one |
| Track record | Votes are weighted: new phones count less, people whose reports were later confirmed count more |
| Impossible times | Rejected using the sun's position, e.g. Fajr after sunrise or Asr before its time |
| Spam | Daily limits per phone; unconfirmed proposals expire after 7 days |
| Fake masjids | Added masjids are marked *new* until 3 people confirm them, and hidden if reported |

Exact user locations are never stored, only the distance to the masjid.

## Project layout

```
app/src/main/assets/app/   the screens (HTML/CSS/JS, no libraries)
app/src/main/java/...      Android: location + fake-GPS check, reminders (AlarmManager), background sync (JobScheduler)
supabase/schema.sql        database, trust rules and API (run once in the Supabase SQL editor)
supabase/test_flow.py      35 scenario tests for the trust rules
```

The APK is about 200 KB plus fonts. Each push builds it with GitHub Actions; pushing a tag `v*` publishes a release with `MasjidTimes.apk`.

## Server setup

1. Create a Supabase project. In **Authentication → Sign In / Providers**, turn on **Allow anonymous sign-ins**.
2. In the **SQL Editor**, run `supabase/schema.sql`.
3. Put your project URL and **publishable** key in `app/src/main/assets/app/core.js`. Never put the secret or service-role key in the app.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · Maps by [Leaflet](https://leafletjs.com) (BSD-2-Clause)

Privacy: [PRIVACY.md](PRIVACY.md) · Part of [FreeApps by Hamza](https://mhamzam.github.io)
