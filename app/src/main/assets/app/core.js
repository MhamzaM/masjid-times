/* Masjid Times — non-UI core: sun times, timing logic, Supabase client, location. */
(function () {
  "use strict";

  // ------------------------------------------------------------ sun times (same formulas as the database)

  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;

  /** Minutes after local midnight for fajr(18°), sunrise, noon, asr (Shafi'i/Hanafi), sunset, isha(18°). */
  function sunTimes(lat, lon, date, tz) {
    const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000; // days since 1970
    const jd = day + 2440587.5 - lon / 360;
    const d = jd - 2451545.0 + 0.5;
    const g = rad(((357.529 + 0.98560028 * d) % 360 + 360) % 360);
    const q = ((280.459 + 0.98564736 * d) % 360 + 360) % 360;
    const l = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
    const e = rad(23.439 - 0.00000036 * d);
    let ra = deg(Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l))) / 15;
    ra -= 24 * Math.floor(ra / 24);
    const decl = Math.asin(Math.sin(e) * Math.sin(l));
    let eqt = q / 15 - ra;
    eqt -= 24 * Math.round(eqt / 24);
    const n = 12 + tz - lon / 15 - eqt;
    const la = rad(lat);
    const clamp = (x) => Math.min(1, Math.max(-1, x));
    const T = (alt) => deg(Math.acos(clamp((-Math.sin(rad(alt)) - Math.sin(decl) * Math.sin(la)) / (Math.cos(decl) * Math.cos(la))))) / 15;
    const A = (f) => deg(Math.acos(clamp((Math.sin(Math.atan(1 / (f + Math.tan(Math.abs(la - decl))))) - Math.sin(decl) * Math.sin(la)) / (Math.cos(decl) * Math.cos(la))))) / 15;
    const m = (h) => Math.round(h * 60);
    return {
      fajr: m(n - T(18)), sunrise: m(n - T(0.833)), noon: m(n), asrShafii: m(n + A(1)), asrHanafi: m(n + A(2)),
      sunset: m(n + T(0.833)), isha: m(n + T(18)),
    };
  }

  const tzHours = () => -new Date().getTimezoneOffset() / 60;

  /** Actual jamaat minute-of-day for a timing on a date (Maghrib may be "sunset + n"). */
  function jamaatMinutes(t, mosque, date) {
    if (t.kind === "after_sunset") return sunTimes(mosque.lat, mosque.lon, date, tzHours()).sunset + t.minutes;
    return t.minutes;
  }

  /** Same rule as the database's check_window, for instant feedback before sending. */
  function windowProblem(prayer, kind, minutes, mosque) {
    const s = sunTimes(mosque.lat, mosque.lon, new Date(), tzHours());
    if (kind === "after_sunset") return prayer !== "maghrib" || minutes < 0 || minutes > 30;
    const m = minutes;
    switch (prayer) {
      case "fajr": return m < s.fajr - 10 || m > s.sunrise - 5;
      case "dhuhr": case "jumuah": return m < s.noon || m > s.asrHanafi;
      case "asr": return m < s.asrShafii - 5 || m > s.sunset - 10;
      case "maghrib": return m < s.sunset - 2 || m > s.sunset + 30;
      case "isha": return m < s.sunset + 55;
    }
    return true;
  }

  const ORDER = ["fajr", "dhuhr", "asr", "maghrib", "isha", "jumuah"];

  /** The timing to show for each prayer: the live one, else the best unverified report. */
  function displayTimings(mosque) {
    const out = {};
    for (const p of ORDER) {
      const live = (mosque.timings || []).find((t) => t.prayer === p);
      const pend = (mosque.pending || []).filter((x) => x.prayer === p).sort((a, b) => b.agree_count - a.agree_count);
      out[p] = { live: live || null, pending: pend };
    }
    return out;
  }

  /** Next upcoming jamaat (today or tomorrow) for a mosque. Jumuah replaces Dhuhr on Fridays. */
  function nextJamaat(mosque, from) {
    const now = from || new Date();
    for (let dayOff = 0; dayOff < 2; dayOff++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOff);
      const friday = d.getDay() === 5;
      const list = [];
      for (const t of mosque.timings || []) {
        if (t.prayer === "jumuah" && !friday) continue;
        if (t.prayer === "dhuhr" && friday && (mosque.timings || []).some((x) => x.prayer === "jumuah")) continue;
        const min = jamaatMinutes(t, mosque, d);
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, min);
        if (at > now) list.push({ prayer: t.prayer, at, minutes: min });
      }
      list.sort((a, b) => a.at - b.at);
      if (list.length) return list[0];
    }
    return null;
  }

  // ------------------------------------------------------------ Supabase (minimal REST client, no library)

  const SB_URL = "https://fdrysyukstjeeudtfhld.supabase.co";
  const SB_KEY = "sb_publishable_yHQUAhcBjT80breQFE8A8g_xZhWqGdP";
  const SESSION_KEY = "masjid:session";

  class ApiError extends Error {
    constructor(code, hint, status) { super(code); this.code = code; this.hint = hint; this.status = status; }
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  }

  async function authFetch(path, body) {
    let res;
    try {
      res = await fetch(SB_URL + path, {
        method: "POST",
        headers: { apikey: SB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError("network");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError("SIGN_IN_REQUIRED", data.msg || data.error_description, res.status);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    };
  }

  /** A private, anonymous ID for this phone (no email, no phone number). */
  async function session() {
    let s = loadSession();
    if (s && s.expires_at - 60 > Date.now() / 1000) return s;
    if (s && s.refresh_token) {
      try {
        s = await authFetch("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
        saveSession(s);
        return s;
      } catch (e) {
        if (e.code === "network") throw e;
      }
    }
    s = await authFetch("/auth/v1/signup", {});
    saveSession(s);
    return s;
  }

  async function rpc(fn, args, needAuth) {
    const headers = { apikey: SB_KEY, "Content-Type": "application/json" };
    if (needAuth) headers.Authorization = "Bearer " + (await session()).access_token;
    else {
      const s = loadSession();
      if (s && s.expires_at - 60 > Date.now() / 1000) headers.Authorization = "Bearer " + s.access_token;
    }
    let res;
    try {
      res = await fetch(SB_URL + "/rest/v1/rpc/" + fn, { method: "POST", headers, body: JSON.stringify(args || {}) });
    } catch (e) {
      throw new ApiError("network");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // our functions raise short codes like TOO_FAR with a human hint
      const msg = (data && data.message) || "";
      const code = /^[A-Z_]+$/.test(msg) ? msg : res.status === 401 ? "SIGN_IN_REQUIRED" : "generic";
      if (res.status === 401 && needAuth) saveSession(null);
      throw new ApiError(code, data && data.hint, res.status);
    }
    return data;
  }

  // ------------------------------------------------------------ location (native in the app, browser otherwise)

  const native = window.MasjidNative || null;
  let locSeq = 0;
  const locWaiters = {};
  window.__onLocation = function (id, json) {
    const w = locWaiters[id];
    if (!w) return;
    delete locWaiters[id];
    const r = typeof json === "string" ? JSON.parse(json) : json;
    if (r.error) w.reject(new ApiError(r.error));
    else w.resolve(r);
  };

  /** Resolves { lat, lon, accuracy, mock }. Errors: LOCATION_DENIED, LOCATION_REQUIRED. */
  function locate(fresh) {
    if (native && native.getLocation) {
      return new Promise((resolve, reject) => {
        const id = ++locSeq;
        locWaiters[id] = { resolve, reject };
        native.getLocation(id, !!fresh);
        setTimeout(() => {
          if (locWaiters[id]) { delete locWaiters[id]; reject(new ApiError("LOCATION_REQUIRED")); }
        }, 25000);
      });
    }
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new ApiError("LOCATION_REQUIRED"));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, mock: false }),
        (err) => reject(new ApiError(err.code === 1 ? "LOCATION_DENIED" : "LOCATION_REQUIRED")),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: fresh ? 0 : 120000 }
      );
    });
  }

  window.MasjidCore = { sunTimes, tzHours, jamaatMinutes, windowProblem, displayTimings, nextJamaat, ORDER, rpc, session, locate, ApiError, native, SB_URL, SB_KEY };
})();
