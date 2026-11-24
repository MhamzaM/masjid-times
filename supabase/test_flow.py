import subprocess, json, uuid
DB=["psql","-h","/tmp","-p","54329","-U","postgres","-d","masjid","-tAq","-v","ON_ERROR_STOP=1"]
def sql(q, user=None, role="authenticated"):
    pre = "begin; set local role %s; select set_config('request.jwt.claim.sub','%s',true);\n" % (role, user or "")
    r = subprocess.run(DB+["-c", pre + q + ";\ncommit;"], capture_output=True, text=True)
    out=(r.stdout.strip().splitlines() or [""])[-1]
    err=r.stderr.strip()
    return out if not err else "ERROR " + err.split("ERROR:")[-1].split("\n")[0].strip() + ((" | " + err.split("HINT:")[-1].strip()) if "HINT" in err else "")
def admin(q):
    r=subprocess.run(DB+["-c",q],capture_output=True,text=True); return r.stdout.strip()
ok=lambda name,c: print(("PASS " if c else "FAIL ")+name)
admin("truncate mosques, timings, profiles, proposals, votes, reconfirmations, mosque_votes, action_log cascade")
# a masjid in Peshawar (Mahabat Khan area) imported from OSM
mid=admin("insert into mosques(name,lat,lon,osm_id) values ('Masjid Mahabat Khan',34.0099,71.5662,'way/1') returning id").splitlines()[0]
LAT,LON=34.0100,71.5663     # ~15 m away: standing at the masjid
FAR=(34.0300,71.5663)       # ~2 km away
U=[str(uuid.uuid4()) for _ in range(8)]
A,B,C,D,E,F,G,H=U
isha = 19*60+30   # 7:30 PM — valid in November (sunset ~17:06)
# --- basic permissions
ok("anonymous visitor can read nearby masjids", 'Mahabat' in sql(f"select nearby_mosques({LAT},{LON},3000)", role="anon"))
ok("anonymous visitor cannot propose", "permission denied" in sql(f"select submit_timing('{mid}','isha','fixed',{isha},{LAT},{LON})", role="anon"))
_r=sql(f"insert into timings(mosque_id,prayer,minutes) values ('{mid}','isha',1)", A); ok("signed-in user cannot write timings directly -> "+_r[:70], "permission denied" in _r)
ok("signed-in user cannot read votes table", "permission denied" in sql("select * from votes", A))
ok("who added a masjid is private", "permission denied" in sql("select added_by from mosques", role="anon"))
# --- presence and sanity checks
r=sql(f"select submit_timing('{mid}','isha','fixed',{isha},{FAR[0]},{FAR[1]})", A); ok("must be at the masjid (2 km away refused) -> "+r, "TOO_FAR" in r)
r=sql(f"select submit_timing('{mid}','isha','fixed',{isha},{LAT},{LON},true)", A); ok("fake GPS refused", "MOCK_LOCATION" in r)
r=sql(f"select submit_timing('{mid}','fajr','fixed',{8*60},{LAT},{LON})", A); ok("Fajr at 8:00 AM (after sunrise) refused -> "+r, "IMPOSSIBLE_TIME" in r)
r=sql(f"select submit_timing('{mid}','maghrib','fixed',{14*60},{LAT},{LON})", A); ok("Maghrib at 2 PM refused", "IMPOSSIBLE_TIME" in r)
# --- first report for a prayer: needs 2 independent people
r=json.loads(sql(f"select submit_timing('{mid}','isha','fixed',{isha},{LAT},{LON})", A)); ok("A reports Isha 7:30 -> open (unverified)", r["status"]=="open")
pid=r["proposal"]
det=json.loads(sql(f"select mosques_by_id(array['{mid}']::uuid[])", B))[0]
ok("shows as pending/unverified to others", det["timings"]==[] and det["pending"][0]["minutes"]==isha)
r=json.loads(sql(f"select vote_proposal('{pid}',true,{LAT},{LON})", B)); ok("B agrees -> live", r["status"]=="accepted")
t=admin(f"select minutes, confirmed_by from timings where mosque_id='{mid}' and prayer='isha'"); ok("timing stored: "+t, t==f"{isha}|2")
# --- someone tries to change it alone: stays a proposal
r=json.loads(sql(f"select submit_timing('{mid}','isha','fixed',{21*60},{LAT},{LON})", H)); ok("H alone proposes Isha 9:00 PM -> stays open", r["status"]=="open")
bad=r["proposal"]
ok("live time unchanged", admin(f"select minutes from timings where mosque_id='{mid}' and prayer='isha'")==str(isha))
# others at the masjid disagree -> rejected, H loses trust
for u in (C,D,E): r=json.loads(sql(f"select vote_proposal('{bad}',false,{LAT},{LON})", u))
ok("3 people disagree -> rejected", r["status"]=="rejected")
ok("H's track record now has a rejection", admin(f"select rejected from profiles where user_id='{H}'")=="1")
ok("H's votes now count less", float(admin(f"select user_weight('{H}','{mid}')"))<0.8)
# --- a real change (masjid moved Isha to 8:00 PM): needs 3 people
new=20*60
r=json.loads(sql(f"select submit_timing('{mid}','isha','fixed',{new},{LAT},{LON})", C)); ok("C reports new Isha 8:00 -> open", r["status"]=="open")
r=json.loads(sql(f"select submit_timing('{mid}','isha','fixed',{new},{LAT},{LON})", D)); ok("D reports the same time -> counted as agreement, still open", r["status"]=="open")
r=json.loads(sql(f"select submit_timing('{mid}','isha','fixed',{new},{LAT},{LON})", E)); ok("E agrees -> accepted (3 people)", r["status"]=="accepted")
row=admin(f"select minutes, confirmed_by, updated_at > verified_at - interval '1 second' from timings where mosque_id='{mid}' and prayer='isha'")
ok("Isha now 8:00 PM: "+row, row.startswith(f"{new}|3|t"))
# --- same person can't vote twice to tip the balance
r=json.loads(sql(f"select submit_timing('{mid}','asr','fixed',{15*60+45},{LAT},{LON})", F))
pa=r["proposal"]
r=json.loads(sql(f"select vote_proposal('{pa}',true,{LAT},{LON})", F)); ok("F voting again on own proposal doesn't count twice", r["status"]=="open")
ok("still one agree", admin(f"select agree_count from proposals where id='{pa}'")=="1")
# --- reconfirm keeps it fresh, once per day
sql(f"select reconfirm_timing('{mid}','isha',{LAT},{LON})", G); sql(f"select reconfirm_timing('{mid}','isha',{LAT},{LON})", G)
ok("reconfirm counted once per day", admin(f"select confirmed_by from timings where mosque_id='{mid}' and prayer='isha'")=="4")
# --- Maghrib relative to sunset
r=json.loads(sql(f"select submit_timing('{mid}','maghrib','after_sunset',5,{LAT},{LON})", A)); sql(f"select vote_proposal('{r['proposal']}',true,{LAT},{LON})", B)
ok("Maghrib = sunset + 5 min accepted", admin(f"select kind||':'||minutes from timings where mosque_id='{mid}' and prayer='maghrib'")=="after_sunset:5")
# --- adding a missing masjid
r=sql(f"select add_mosque('Duplicate', {LAT}, {LON})", A); ok("can't add a masjid on top of an existing one -> "+r, "ALREADY_LISTED" in r)
r=json.loads(sql("select add_mosque('Masjid Bilal, Hayatabad', 33.9900, 71.4400)", A)); nm=r["mosque"]; ok("new masjid starts pending", r["status"]=="pending")
r=json.loads(sql(f"select confirm_mosque('{nm}', 33.9901, 71.4401)", B)); ok("2 confirmations -> still pending", r["status"]=="pending")
r=json.loads(sql(f"select confirm_mosque('{nm}', 33.9901, 71.4401)", C)); ok("3rd confirmation -> active", r["status"]=="active")
r=sql(f"select confirm_mosque('{nm}', 34.05, 71.44)", D); ok("confirming from far away refused", "TOO_FAR" in r)
# --- fake masjid gets hidden by reports
r=json.loads(sql("select add_mosque('Fake listing', 33.95, 71.50)", H)); fake=r["mosque"]
for u in (B,C,D,E): sql(f"select report_mosque('{fake}')", u)
ok("fake listing hidden after reports", admin(f"select status from mosques where id='{fake}'")=="hidden")
ok("hidden masjid not shown nearby", 'Fake listing' not in sql("select nearby_mosques(33.95,71.50,1000)", role="anon"))
# --- spam limit
x=str(uuid.uuid4()); last=""
for i in range(14): last=sql(f"select submit_timing('{mid}','fajr','fixed',{6*60+i},{LAT},{LON})", x)
ok("rate limit after 12 proposals a day -> "+last[:60], "RATE_LIMIT" in last)
ok("no user ids in public output", all(u not in sql(f"select mosques_by_id(array['{mid}']::uuid[])", A) for u in U))
