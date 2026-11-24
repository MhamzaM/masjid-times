import json
from playwright.sync_api import sync_playwright
exec(open("test_ui.py").read().split("fails = []")[0])  # reuse mocks
INIT = """
window.__calls = [];
window.MasjidNative = {
  getLocation(id, fresh){ window.__calls.push(['loc', fresh]); setTimeout(()=>window.__onLocation(id, JSON.stringify({lat:34.0089,lon:71.5785,accuracy:8,mock:true})), 50); },
  setPlan(j){ window.__calls.push(['plan', JSON.parse(j)]); },
  setFollowed(j){ window.__calls.push(['followed', JSON.parse(j)]); },
  permissions(){ return JSON.stringify({notifications:true, alarms:false, battery:false}); },
  requestPermission(k){ window.__calls.push(['perm', k]); },
  openUrl(u){ window.__calls.push(['url', u]); },
};"""
ok = True
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 390, "height": 844})
    pg.add_init_script(INIT); pg.route("https://fdrysyukstjeeudtfhld.supabase.co/**", handle)
    pg.goto(APP); pg.click("text=Find masjids near me"); pg.wait_for_selector(".m-item")
    pg.click("[data-open=m1]"); pg.click("[data-mine=m1]")
    pg.click(".board-actions [data-dir]")
    pg.click(".board-actions [data-update]"); pg.select_option("#updPrayer", "isha"); pg.fill("#updTime", "19:45")
    pg.click("#updForm button[type=submit]"); pg.wait_for_timeout(400)
    pg.click("[data-tab=settings]"); pg.click("[data-perm=alarms]"); pg.click("[data-before='15']")
    pg.screenshot(path="shot_settings.png", full_page=True)
    ncalls = pg.evaluate("window.__calls")
    plan = [c[1] for c in ncalls if c[0] == "plan"][-1]
    fol = [c[1] for c in ncalls if c[0] == "followed"][-1]
    sub = [c for c in calls if c[0] == "submit_timing"][-1][1]
    checks = {
      "plan enabled w/ mosque": plan["enabled"] and plan["mosque"]["id"] == "m1" and len(plan["mosque"]["timings"]) == 5,
      "plan before=15": plan["before"] == 15,
      "plan strings templated": "{p}" in plan["strings"]["reminderTitle"] and "{n}" in plan["strings"]["reminderBody"],
      "followed has url/key": fol["url"].startswith("https://") and fol["key"].startswith("sb_publishable") and fol["myId"] == "m1",
      "fresh loc for submit": ["loc", True] in ncalls,
      "mock flag sent": sub["p_mock"] is True,
      "directions url": any(c[0] == "url" and "destination=34.0089,71.579" in c[1] for c in ncalls),
      "perm request": ["perm", "alarms"] in ncalls,
      "perm rows": pg.locator("[data-perm]").count() == 2 and pg.locator(".ok").count() >= 1,
    }
    for k, v in checks.items(): print(("PASS " if v else "FAIL ") + k); ok &= bool(v)
    b.close()
print("ALL PASS" if ok else "SOME FAILED")
