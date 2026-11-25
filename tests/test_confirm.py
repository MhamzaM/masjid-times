import json, datetime
from playwright.sync_api import sync_playwright
APP = "file:///home/claude/masjid/app/src/main/assets/app/index.html"
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
T = lambda p, m, n=3: {"prayer": p, "kind": "fixed", "minutes": m, "confirmed_by": n, "verified_at": now, "updated_at": now}
P = lambda i, p, m, a=1, mine=False, vote=None: {"id": i, "prayer": p, "kind": "fixed", "minutes": m, "agree_count": a, "disagree_count": 0, "created_at": now, "mine": mine, "my_vote": vote}
M = {"id": "m1", "name": "Masjid Mahabat Khan", "lat": 34.0089, "lon": 71.5790, "status": "active", "confirmations": 0, "distance": 40,
     "timings": [T("fajr", 345), T("dhuhr", 810)],
     "pending": [P("pI", "isha", 1170), P("pA1", "asr", 930, 2), P("pA2", "asr", 945, 1), P("pM", "maghrib", 1030, 1, mine=True)]}
calls = []
def handle(route, req):
    body = json.loads(req.post_data or "{}"); fn = req.url.split("/")[-1]; calls.append((fn, body))
    if "signup" in req.url: return route.fulfill(json={"access_token": "tok", "refresh_token": "r", "expires_in": 3600})
    if fn in ("mosques_by_id", "nearby_mosques"): return route.fulfill(json=[M])
    if fn == "vote_proposal": return route.fulfill(json={"status": "open"})
    if fn == "reconfirm_timing": return route.fulfill(json={"status": "reconfirmed"})
    if fn == "submit_timing": return route.fulfill(json={"status": "open"})
    route.fulfill(json=[])
ok = True
def check(n, c):
    global ok; print(("PASS " if c else "FAIL ") + n); ok &= bool(c)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 412, "height": 915}, geolocation={"latitude": 34.0089, "longitude": 71.5785}, permissions=["geolocation"], device_scale_factor=2)
    pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("https://fdrysyukstjeeudtfhld.supabase.co/**", handle)
    pg.goto(APP); pg.click("text=Find masjids near me"); pg.wait_for_selector(".m-item"); pg.click("[data-open=m1]"); pg.click("[data-mine=m1]"); pg.wait_for_timeout(300)
    check("isha one-tap Correct", pg.locator(".board [data-vote=pI]").inner_text().strip() == "✓ Correct")
    check("asr competing chips with counts", pg.locator(".board [data-vote=pA1]").count() == 1 and "· 2" in pg.locator(".board [data-vote=pA1]").inner_text())
    check("own report not votable", pg.locator(".board [data-vote=pM]").count() == 0 and "Your report" in pg.inner_text(".board"))
    check("confirm-all button", pg.locator(".board [data-confirm-all]").count() == 1)
    pg.screenshot(path="shot_confirm.png", full_page=True)
    # confirm all
    calls.clear(); pg.click(".board [data-confirm-all]"); pg.wait_for_timeout(800)
    rec = sorted(c[1]["p_prayer"] for c in calls if c[0] == "reconfirm_timing"); votes = [c[1]["p_proposal"] for c in calls if c[0] == "vote_proposal"]
    check("reconfirms live fajr+dhuhr %s" % rec, rec == ["dhuhr", "fajr"])
    check("agrees only with single isha report %s" % votes, votes == ["pI"])
    check("thanks toast", "3 times confirmed" in pg.inner_text("#toast"))
    # one-tap single
    calls.clear(); pg.click(".board [data-vote=pA2]"); pg.wait_for_timeout(600)
    v = [c[1] for c in calls if c[0] == "vote_proposal"]
    check("one tap votes agree on 3:45", v and v[0]["p_proposal"] == "pA2" and v[0]["p_agree"] is True)
    # tap a confirmed row -> update sheet prefilled
    pg.click(".board .row[data-uprayer=dhuhr]"); pg.wait_for_timeout(200)
    check("tap row opens sheet for that prayer", pg.input_value("#updPrayer") == "dhuhr" and pg.input_value("#updTime") == "13:30")
    pg.click("[data-step='5']"); pg.click("[data-step='5']")
    check("+5 twice", pg.input_value("#updTime") == "13:40")
    pg.click("[data-step='-5']"); check("-5", pg.input_value("#updTime") == "13:35")
    pg.select_option("#updPrayer", "isha"); check("switching prayer prefills reported time", pg.input_value("#updTime") == "19:30")
    pg.select_option("#updPrayer", "jumuah"); check("no time yet -> empty", pg.input_value("#updTime") == "")
    pg.click("[data-step='5']"); check("+5 on empty starts from now", pg.input_value("#updTime") != "")
    pg.screenshot(path="shot_update_stepper.png")
    pg.evaluate("window.onAndroidBack()")
    # "Different" chip opens the sheet for that prayer
    pg.click(".board .row[data-uprayer=isha] .chip.ghost"); pg.wait_for_timeout(200)
    check("Different opens isha", pg.input_value("#updPrayer") == "isha")
    pg.evaluate("window.onAndroidBack()")
    # Urdu
    pg.click("[data-tab=settings]"); pg.click("[data-lang=ur]"); pg.click("[data-tab=home]")
    check("urdu confirm-all", "تمام اوقات بورڈ سے ملتے ہیں" in pg.inner_text(".board"))
    pg.screenshot(path="shot_confirm_ur.png", full_page=True)
    check("no js errors", not errs); print(errs) if errs else None
    b.close()
print("ALL PASS" if ok else "SOME FAILED")
