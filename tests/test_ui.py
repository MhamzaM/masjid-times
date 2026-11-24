"""UI test for Masjid Times against a mocked Supabase API."""
import json, sys, datetime
from playwright.sync_api import sync_playwright

APP = "file:///home/claude/masjid/app/src/main/assets/app/index.html"
LAT, LON = 34.0089, 71.5785  # Peshawar Saddar
now = datetime.datetime.now(datetime.timezone.utc).isoformat()

M1 = {"id": "m1", "name": "Masjid Mahabat Khan", "lat": 34.0089, "lon": 71.5790, "status": "active", "confirmations": 0, "distance": 46,
      "timings": [
          {"prayer": "fajr", "kind": "fixed", "minutes": 5*60+45, "confirmed_by": 4, "verified_at": now, "updated_at": now},
          {"prayer": "dhuhr", "kind": "fixed", "minutes": 13*60+30, "confirmed_by": 3, "verified_at": now, "updated_at": now},
          {"prayer": "asr", "kind": "fixed", "minutes": 15*60+30, "confirmed_by": 3, "verified_at": now, "updated_at": now},
          {"prayer": "maghrib", "kind": "after_sunset", "minutes": 5, "confirmed_by": 5, "verified_at": now, "updated_at": now},
          {"prayer": "isha", "kind": "fixed", "minutes": 19*60+30, "confirmed_by": 2, "verified_at": now, "updated_at": now}],
      "pending": [{"id": "p1", "prayer": "isha", "kind": "fixed", "minutes": 19*60+45, "agree_count": 1, "disagree_count": 0, "created_at": now, "mine": False, "my_vote": None}]}
M2 = {"id": "m2", "name": "Jamia Masjid Darvesh", "lat": 34.012, "lon": 71.58, "status": "pending", "confirmations": 1, "distance": 1200,
      "timings": [], "pending": [{"id": "p2", "prayer": "fajr", "kind": "fixed", "minutes": 5*60+50, "agree_count": 1, "disagree_count": 0, "created_at": now, "mine": False, "my_vote": None}]}
calls = []

def handle(route, req):
    url = req.url
    body = json.loads(req.post_data or "{}")
    calls.append((url.split("/")[-1], body, req.headers.get("authorization")))
    if "/auth/v1/signup" in url:
        return route.fulfill(json={"access_token": "tok", "refresh_token": "r", "expires_in": 3600})
    fn = url.split("/rpc/")[-1]
    if fn == "nearby_mosques": return route.fulfill(json=[M1, M2])
    if fn == "mosques_by_id": return route.fulfill(json=[m for m in (M1, M2) if m["id"] in body["p_ids"]])
    if fn == "search_mosques": return route.fulfill(json=[M2])
    if fn == "vote_proposal": return route.fulfill(json={"status": "pending"})
    if fn == "submit_timing":
        if body["p_prayer"] == "asr": return route.fulfill(status=400, json={"message": "TOO_FAR", "hint": "You are 420 m away"})
        return route.fulfill(json={"status": "pending", "proposal": "p9"})
    if fn == "add_mosque": return route.fulfill(status=400, json={"message": "ALREADY_LISTED", "hint": "Masjid Mahabat Khan"})
    route.fulfill(status=404, json={"message": "NOT_FOUND"})

fails = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, geolocation={"latitude": LAT, "longitude": LON}, permissions=["geolocation"], device_scale_factor=2)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("https://fdrysyukstjeeudtfhld.supabase.co/**", handle)
    pg.goto(APP)
    pg.wait_for_timeout(400)
    check("empty home", pg.locator("text=Choose your masjid").is_visible())
    pg.screenshot(path="/home/claude/masjid/shot_empty.png")
    pg.click("text=Find masjids near me")
    pg.wait_for_selector(".m-item")
    check("two nearby", pg.locator(".m-item").count() == 2)
    check("pending tag", pg.locator(".m-item .tag").count() == 1)
    pg.screenshot(path="/home/claude/masjid/shot_nearby.png")
    pg.click("[data-open=m1]")
    check("detail board", pg.locator(".board-name", has_text="Mahabat").is_visible())
    check("at-masjid banner", pg.locator(".banner").is_visible())
    check("pending vote shown", pg.locator("[data-vote=p1]").count() == 2)
    pg.click("[data-mine=m1]")
    pg.wait_for_timeout(200)
    check("home shows board", pg.locator(".board").is_visible() and pg.locator(".next").count() == 1)
    check("maghrib sunset rule", pg.locator("text=sunset + 5 min").count() == 1)
    pg.screenshot(path="/home/claude/masjid/shot_home.png", full_page=True)
    pg.click("[data-vote=p1][data-agree='1']")
    pg.wait_for_timeout(500)
    v = [c for c in calls if c[0] == "vote_proposal"]
    check("vote sent with auth", v and v[0][2] == "Bearer tok" and v[0][1]["p_agree"] is True)
    # update sheet
    pg.click(".board-actions [data-update]")
    pg.select_option("#updPrayer", "maghrib")
    check("maghrib mode visible", pg.locator("#mgMode").is_visible())
    pg.click("[data-mode=after_sunset]")
    check("after field shown", pg.locator("#updAfter").is_visible() and not pg.locator("#updTime").is_visible())
    pg.fill("#updAfter", "7")
    pg.screenshot(path="/home/claude/masjid/shot_update.png")
    pg.click("#updForm button[type=submit]")
    pg.wait_for_timeout(500)
    s = [c for c in calls if c[0] == "submit_timing"]
    check("submit after_sunset", s and s[-1][1]["p_kind"] == "after_sunset" and s[-1][1]["p_minutes"] == 7)
    check("sheet closed", pg.locator("#sheet").is_hidden())
    # impossible time is caught locally
    pg.click(".board-actions [data-update]")
    pg.select_option("#updPrayer", "fajr")
    pg.fill("#updTime", "10:00")
    n = len(calls)
    pg.click("#updForm button[type=submit]")
    pg.wait_for_timeout(200)
    check("impossible caught locally", len(calls) == n and "isn't possible" in pg.inner_text("#toast"))
    # too far from server
    pg.select_option("#updPrayer", "asr")
    pg.fill("#updTime", "15:45")
    pg.click("#updForm button[type=submit]")
    pg.wait_for_timeout(500)
    check("too far message", "420 m away" in pg.inner_text("#toast"))
    pg.evaluate("window.onAndroidBack()")
    # add masjid
    pg.click("[data-tab=nearby]")
    pg.click("[data-add]")
    pg.fill("#addName", "Mahabat")
    pg.click("#addForm button[type=submit]")
    pg.wait_for_timeout(500)
    check("already listed", "Already listed: Masjid Mahabat Khan" in pg.inner_text("#toast"))
    pg.evaluate("window.onAndroidBack()")
    # search
    pg.fill("#searchInput", "darv")
    pg.press("#searchInput", "Enter")
    pg.wait_for_timeout(300)
    check("search results", pg.locator(".m-item").count() == 1)
    # Urdu + Pashto
    pg.click("[data-tab=settings]")
    pg.click("[data-lang=ur]")
    check("rtl", pg.evaluate("document.documentElement.dir") == "rtl")
    pg.click("[data-tab=home]")
    check("urdu prayers", pg.locator("text=مغرب").count() >= 1)
    pg.screenshot(path="/home/claude/masjid/shot_home_ur.png", full_page=True)
    pg.click("[data-tab=settings]")
    pg.click("[data-lang=ps]")
    pg.click("[data-tab=home]")
    check("pashto prayers", pg.locator("text=ماښام").count() >= 1)
    pg.screenshot(path="/home/claude/masjid/shot_home_ps.png", full_page=True)
    # persistence
    pg.reload(); pg.wait_for_timeout(400)
    check("persisted masjid", pg.locator(".board").is_visible())
    check("no js errors", not errs)
    if errs: print(errs)
    b.close()
print("FAILED:", fails) if fails else print("ALL PASS")
sys.exit(1 if fails else 0)
