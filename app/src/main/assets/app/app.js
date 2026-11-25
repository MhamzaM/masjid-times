/* Masjid Times — screens and actions. */
(function () {
  "use strict";
  const C = window.MasjidCore;
  const $ = (id) => document.getElementById(id);
  const native = C.native;

  // ------------------------------------------------------------ state

  const KEY = "masjid:state";
  const defaults = () => ({
    lang: (navigator.language || "").startsWith("ps") ? "ps" : (navigator.language || "").startsWith("ur") ? "ur" : "en",
    tab: "home",
    myId: null,
    follows: [],
    cache: {},            // id -> last masjid data from the server
    nearby: [],           // ids from the last nearby search
    nearbyView: "list",   // list | map
    loc: null,            // last location { lat, lon, at }
    settings: { remind: true, before: 10, prayers: { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true, jumuah: true }, changes: true },
  });
  let S = load();
  let detailId = null;    // masjid shown in detail view (from the nearby tab)
  let busy = false;

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d) {
        const b = defaults();
        return Object.assign(b, d, { settings: Object.assign(b.settings, d.settings || {}, { prayers: Object.assign(b.settings.prayers, (d.settings || {}).prayers || {}) }) });
      }
    } catch (e) {}
    return defaults();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  const t = () => window.I18N[S.lang];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------ formatting

  function fmtTime(min) {
    min = ((min % 1440) + 1440) % 1440;
    const h = Math.floor(min / 60), m = min % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const ap = S.lang === "en" ? (h < 12 ? " AM" : " PM") : "";
    return h12 + ":" + String(m).padStart(2, "0") + ap;
  }
  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000, L = t();
    if (s < 90) return L.agoNow;
    if (s < 3600) return L.agoMin(Math.round(s / 60));
    if (s < 86400) return L.agoHour(Math.round(s / 3600));
    return L.agoDay(Math.max(1, Math.round(s / 86400)));
  }
  function countdown(at) {
    const mins = Math.max(0, Math.round((at - Date.now()) / 60000));
    if (mins === 0) return t().now;
    return t().inTime(t().hm(Math.floor(mins / 60), mins % 60));
  }
  const prayerName = (p) => t().prayers[p];
  const prayerAr = (p) => window.I18N.ur.prayers[p];

  // ------------------------------------------------------------ feedback

  let toastTimer = 0;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3600);
  }
  function errorText(e) {
    const E = t().errors, code = e && e.code;
    if (code === "TOO_FAR") {
      const m = /([\d.]+)\s*m/.exec(e.hint || "");
      return E.TOO_FAR(m ? t().km(parseFloat(m[1])) : "");
    }
    if (code === "ALREADY_LISTED") return E.ALREADY_LISTED(e.hint || "");
    if (code === "LOCATION_DENIED") return t().locationDenied;
    const v = E[code];
    return typeof v === "string" ? v : E.generic;
  }

  // ------------------------------------------------------------ data

  function cacheMosques(list) {
    for (const m of list) S.cache[m.id] = Object.assign({}, S.cache[m.id], m, { fetched: Date.now() });
    save();
  }

  async function refreshMine() {
    const ids = [S.myId, ...S.follows].filter((x, i, a) => x && a.indexOf(x) === i);
    if (!ids.length) return;
    try {
      const list = await C.rpc("mosques_by_id", { p_ids: ids, p_lat: S.loc ? S.loc.lat : null, p_lon: S.loc ? S.loc.lon : null });
      cacheMosques(list);
      syncNative();
      render();
    } catch (e) {
      if (e.code === "network") toast(t().errors.network);
    }
  }

  async function findNearby() {
    let loc;
    try {
      loc = await C.locate(false);
    } catch (e) {
      throw e;
    }
    S.loc = { lat: loc.lat, lon: loc.lon, accuracy: loc.accuracy, at: Date.now() };
    const list = await C.rpc("nearby_mosques", { p_lat: loc.lat, p_lon: loc.lon, p_radius_m: 3000 });
    cacheMosques(list);
    S.nearby = list.map((m) => m.id);
    save();
    return list;
  }

  // ------------------------------------------------------------ board (the jamaat timing board)

  function boardHTML(m, opts) {
    const L = t();
    const shown = C.displayTimings(m);
    const nx = C.nextJamaat(m);
    const today = new Date();
    const friday = today.getDay() === 5;
    const rows = C.ORDER.map((p) => {
      const d = shown[p];
      let tm, st = "", unv = false;
      if (d.live) {
        const mins = C.jamaatMinutes(d.live, m, today);
        tm = fmtTime(mins);
        st = (d.live.kind === "after_sunset" ? L.sunsetPlus(d.live.minutes) + " · " : "") + L.confirmedBy(d.live.confirmed_by, ago(d.live.verified_at));
      } else if (d.pending.length) {
        const pd = d.pending[0];
        tm = fmtTime(C.jamaatMinutes(pd, m, today));
        st = L.unverified(pd.agree_count);
        unv = true;
      } else {
        tm = null;
      }
      const isNext = nx && nx.prayer === p;
      const hideRow = p === "jumuah" && !d.live && !d.pending.length && !friday;
      if (hideRow) return "";
      // unverified: one tap to agree with the time you see on the masjid's board
      let acts = "";
      if (!d.live && d.pending.length) {
        const chips = d.pending.map((pd) => {
          const t12 = fmtTime(C.jamaatMinutes(pd, m, today));
          if (pd.mine) return '<span class="chip done">' + esc(t12) + " · " + esc(L.yourReport) + "</span>";
          if (pd.my_vote === true) return '<span class="chip done">✓ ' + esc(t12) + "</span>";
          if (pd.my_vote === false) return '<span class="chip done">✗ ' + esc(t12) + "</span>";
          return '<button class="chip" data-vote="' + pd.id + '" data-agree="1">✓ ' + esc(d.pending.length > 1 ? t12 + " · " + pd.agree_count : L.agree) + "</button>";
        }).join("");
        acts = '<span class="row-acts">' + chips + '<button class="chip ghost" data-update="' + m.id + '" data-uprayer="' + p + '">' + esc(L.differentTime) + "</button></span>";
      }
      return '<li class="row' + (isNext ? " is-next" : "") + '" data-update="' + m.id + '" data-uprayer="' + p + '" role="button" tabindex="0" aria-label="' + esc(L.fixTime(prayerName(p))) + '">' +
        '<span class="pn">' + esc(prayerName(p)) + (S.lang === "en" ? ' <span class="ar" lang="ur">' + prayerAr(p) + "</span>" : "") + "</span>" +
        (tm ? '<span class="tm">' + esc(tm) + "</span>" : '<span class="tm small">' + esc(L.notSet) + "</span>") +
        (st ? '<span class="st' + (unv ? " unv" : "") + '">' + esc(st) + "</span>" : "") + acts + "</li>";
    }).join("");

    const dist = m.distance != null ? L.km(m.distance) : "";
    const next = nx
      ? '<div class="next"><span><span class="lbl">' + esc(L.nextJamaat) + '</span><br><span class="what">' + esc(prayerName(nx.prayer)) + " · " + esc(countdown(nx.at)) +
        '</span></span><span class="when">' + esc(fmtTime(nx.minutes)) + "</span></div>"
      : "";
    return '<section class="board" aria-label="' + esc(m.name) + '">' +
      '<div class="board-head"><div><div class="board-name">' + esc(m.name) + (m.status === "pending" ? ' <span class="tag" style="color:#f0c779">· ' + esc(L.newMasjid) + "</span>" : "") +
      '</div><div class="board-meta">' + esc(dist) + "</div></div></div>" +
      next + '<ul class="rows">' + rows + "</ul>" + confirmAllHTML(m) + "</section>";
  }

  /** What "All times match the board" would confirm: live times, plus unverified ones with a single report. */
  function confirmPlan(m) {
    const shown = C.displayTimings(m), plan = [];
    for (const p of C.ORDER) {
      const d = shown[p];
      if (d.live) plan.push({ kind: "reconfirm", prayer: p });
      else if (d.pending.length === 1 && !d.pending[0].mine && d.pending[0].my_vote == null) plan.push({ kind: "vote", prayer: p, id: d.pending[0].id });
    }
    return plan;
  }

  function confirmAllHTML(m) {
    if (!confirmPlan(m).length) return "";
    return '<button class="board-confirm" data-confirm-all="' + m.id + '">✓ ' + esc(t().confirmAll) + '</button><p class="board-hint">' + esc(t().tapToFix) + "</p>";
  }

  function pendingHTML(m) {
    const L = t();
    const live = {};
    for (const x of m.timings || []) live[x.prayer] = x;
    // proposals that would change a live time (unverified first-time reports are already on the board)
    const items = (m.pending || []).filter((p) => live[p.prayer]);
    if (!items.length) return "";
    return '<section class="card pend"><h2>' + esc(L.pendingTitle) + '</h2><p class="muted">' + esc(L.pendingText) + "</p>" +
      items.map((p) => {
        const mine = p.mine, voted = p.my_vote;
        const acts = mine ? '<span class="muted">' + esc(L.yourReport) + "</span>"
          : voted === true ? '<span class="muted">' + esc(L.youAgreed) + "</span>"
          : voted === false ? '<span class="muted">' + esc(L.youDisagreed) + "</span>"
          : '<span class="acts"><button class="btn small" data-vote="' + p.id + '" data-agree="1">' + esc(L.agree) + '</button><button class="btn small ghost" data-vote="' + p.id + '" data-agree="0">' + esc(L.disagree) + "</button></span>";
        return '<div class="pend-item"><div class="what">' + esc(prayerName(p.prayer)) + ": <b>" + esc(fmtTime(C.jamaatMinutes(p, m, new Date()))) + "</b><br><span class=\"muted\">" +
          esc(L.reportedBy(p.agree_count)) + "</span></div>" + acts + "</div>";
      }).join("") + "</section>";
  }

  function atMasjidBanner(m) {
    if (!S.loc || m.distance == null || m.distance > 150 || Date.now() - S.loc.at > 10 * 60000) return "";
    const L = t();
    return '<div class="banner"><div>' + esc(L.atMasjid(m.name)) + '</div><div class="row2">' +
      (confirmPlan(m).length ? '<button class="btn small" data-confirm-all="' + m.id + '">' + esc(L.stillCorrect) + "</button>" : "") +
      '<button class="btn small" data-update="' + m.id + '">' + esc(L.updateTime) + "</button>" +
      (m.status === "pending" ? '<button class="btn small" data-confirm-mosque="' + m.id + '">' + esc(L.confirmExists) + "</button>" : "") +
      "</div></div>";
  }

  function masjidActions(m) {
    const L = t();
    const mine = S.myId === m.id, fol = S.follows.includes(m.id);
    return '<div class="board-actions">' +
      '<button class="btn primary" data-update="' + m.id + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8L20.7 7z"/></svg>' + esc(L.updateTime) + "</button>" +
      '<button class="btn" data-dir="' + m.id + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg>' + esc(L.directions) + "</button>" +
      (mine ? "" : '<button class="btn" data-mine="' + m.id + '">' + esc(L.setMine) + "</button>") +
      (mine ? "" : '<button class="btn ' + (fol ? "ghost" : "") + '" data-follow="' + m.id + '">' + (fol ? "✓ " + esc(L.following) : esc(L.follow)) + "</button>") +
      "</div>";
  }

  // ------------------------------------------------------------ views

  function render() {
    document.documentElement.lang = S.lang;
    document.documentElement.dir = S.lang === "en" ? "ltr" : "rtl";
    document.title = t().appName;
    document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t()[el.dataset.t]; });
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === S.tab ? "page" : "false"));
    const v = $("view");
    if (S.tab === "home") v.innerHTML = homeHTML();
    else if (S.tab === "nearby") v.innerHTML = detailId ? detailHTML(S.cache[detailId]) : nearbyHTML();
    else v.innerHTML = settingsHTML();
    if ($("mapHost")) attachMap();
  }

  // ------------------------------------------------------------ map (Leaflet + OpenStreetMap tiles)

  const PESHAWAR = [34.008, 71.53];
  let mapTileWarned = false;
  let map = null, mapEl = null, mosqueLayer = null, userLayer = null, mapTimer = 0, mapCentered = false;
  const pins = {}; // id -> { marker, cls }

  function distM(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(h));
  }

  function ensureMap() {
    if (map || !window.L) return !!map;
    const Lf = window.L;
    mapEl = document.createElement("div");
    mapEl.className = "map";
    mapEl.dir = "ltr";
    map = Lf.map(mapEl, { zoomControl: false, minZoom: 5, maxZoom: 19 }).setView(S.loc ? [S.loc.lat, S.loc.lon] : PESHAWAR, S.loc ? 16 : 13);
    Lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).on("tileerror", () => {
      // tell the person once per session; pins and "Open" keep working without the tiles
      if (!mapTileWarned) { mapTileWarned = true; toast(t().mapTilesFailed); }
    }).addTo(map);
    Lf.control.zoom({ position: "bottomright" }).addTo(map);
    map.attributionControl.setPrefix(false);
    mosqueLayer = Lf.layerGroup().addTo(map);
    userLayer = Lf.layerGroup().addTo(map);
    map.on("moveend", () => { clearTimeout(mapTimer); mapTimer = setTimeout(loadMapArea, 450); });
    return true;
  }

  function attachMap() {
    if (!ensureMap()) return;
    $("mapHost").appendChild(mapEl);
    map.invalidateSize(false);
    if (!mapCentered && S.loc) { map.setView([S.loc.lat, S.loc.lon], 16, { animate: false }); mapCentered = true; }
    drawUser();
    drawPins();
    loadMapArea();
  }

  function drawUser() {
    if (!map) return;
    userLayer.clearLayers();
    if (!S.loc) return;
    const Lf = window.L, ll = [S.loc.lat, S.loc.lon];
    if (S.loc.accuracy && S.loc.accuracy < 2000) {
      Lf.circle(ll, { radius: S.loc.accuracy, color: "#1a73e8", weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(userLayer);
    }
    Lf.marker(ll, { icon: Lf.divIcon({ className: "you-dot", iconSize: [20, 20] }), keyboard: false, zIndexOffset: 1000 })
      .bindTooltip(t().youAreHere).addTo(userLayer);
  }

  function pinClass(m) {
    return "pin" + (m.id === S.myId ? " mine" : S.follows.includes(m.id) ? " followed" : "") + (m.status === "pending" ? " new" : "") + (m.timings && m.timings.length ? " has-times" : "");
  }

  function popupHTML(m) {
    const L = t(), nx = C.nextJamaat(m);
    return '<div class="pop" dir="' + (S.lang === "en" ? "ltr" : "rtl") + '"><b>' + esc(m.name) + "</b>" +
      (m.status === "pending" ? ' <span class="tag">' + esc(L.newMasjid) + "</span>" : "") +
      '<div class="pop-meta">' + (m.distance != null ? esc(L.km(m.distance)) + " · " : "") +
      (nx ? esc(prayerName(nx.prayer)) + " <b class=\"pop-time\">" + esc(fmtTime(nx.minutes)) + "</b>" : esc(L.notSet)) + "</div>" +
      '<button class="btn small primary" data-open="' + m.id + '">' + esc(L.openMasjid) + "</button></div>";
  }

  function drawPins() {
    if (!map) return;
    const Lf = window.L;
    for (const m of Object.values(S.cache)) {
      if (m.lat == null || m.status === "hidden") continue;
      const cls = pinClass(m);
      const have = pins[m.id];
      if (have && have.cls === cls) { have.marker.setPopupContent(popupHTML(m)); continue; }
      if (have) mosqueLayer.removeLayer(have.marker);
      const marker = Lf.marker([m.lat, m.lon], {
        icon: Lf.divIcon({ className: cls, html: "<span></span>", iconSize: [30, 36], iconAnchor: [15, 34], popupAnchor: [0, -30] }),
        title: m.name, alt: m.name, zIndexOffset: m.id === S.myId ? 500 : 0,
      }).bindPopup(popupHTML(m), { closeButton: false, minWidth: 180 });
      marker.addTo(mosqueLayer);
      pins[m.id] = { marker, cls };
    }
  }

  async function loadMapArea() {
    if (!map || !mapEl.isConnected || map.getZoom() < 12) return;
    const c = map.getCenter();
    const radius = Math.min(20000, Math.round(map.distance(c, map.getBounds().getNorthEast())));
    try {
      const list = await C.rpc("nearby_mosques", { p_lat: c.lat, p_lon: c.lng, p_radius_m: radius });
      // distances from the person, not from the middle of the map
      for (const m of list) m.distance = S.loc ? Math.round(distM(S.loc, m)) : null;
      cacheMosques(list);
      drawPins();
    } catch (e) {
      if (e.code === "network") toast(t().errors.network);
    }
  }

  async function mapLocate() {
    try {
      const loc = await C.locate(false);
      S.loc = { lat: loc.lat, lon: loc.lon, accuracy: loc.accuracy, at: Date.now() };
      save();
      if (map) { map.setView([loc.lat, loc.lon], Math.max(map.getZoom(), 16)); drawUser(); }
    } catch (e) { toast(errorText(e)); }
  }

  function homeHTML() {
    const L = t();
    const m = S.myId && S.cache[S.myId];
    if (!m) {
      return '<div class="wrap"><div class="empty">' +
        '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="8" width="56" height="48" rx="6" fill="#0d3a2d" stroke="#3b2a18" stroke-width="4"/><path d="M14 22h16M14 32h16M14 42h16" stroke="#f3f1e8" stroke-width="3" stroke-linecap="round"/><path d="M38 22h12M38 32h12M38 42h12" stroke="#d9a441" stroke-width="3" stroke-linecap="round"/></svg>' +
        "<h1>" + esc(L.noMasjidTitle) + '</h1><p class="sub">' + esc(L.noMasjidText) + '</p><button class="btn primary" data-go="nearby">' + esc(L.findNearby) + "</button></div></div>";
    }
    const others = S.follows.filter((id) => id !== S.myId && S.cache[id]).map((id) => S.cache[id]);
    return '<div class="wrap">' + atMasjidBanner(m) + boardHTML(m) + masjidActions(m) + pendingHTML(m) +
      (m.status === "pending" ? '<button class="btn ghost" data-report="' + m.id + '">' + esc(L.reportWrong) + "</button>" : "") +
      (others.length ? "<h2>" + esc(L.followedTitle) + '</h2><ul class="list">' + others.map(itemHTML).join("") + "</ul>" : "") +
      '<button class="btn ghost" data-go="nearby">' + esc(L.changeMasjid) + "</button></div>";
  }

  function itemHTML(m) {
    const L = t();
    const nx = C.nextJamaat(m);
    const star = S.myId === m.id ? '<span class="star" aria-label="' + esc(L.isMine) + '">★</span>' : S.follows.includes(m.id) ? '<span class="star">☆</span>' : "";
    return '<li><button class="m-item" data-open="' + m.id + '"><span><span class="nm">' + esc(m.name) + "</span>" + star +
      (m.status === "pending" ? '<span class="tag">' + esc(L.newMasjid) + "</span>" : "") +
      '<br><span class="ds">' + (m.distance != null ? esc(L.km(m.distance)) : "") + "</span></span>" +
      '<span class="nx">' + (nx ? "<b>" + esc(fmtTime(nx.minutes)) + "</b><span>" + esc(prayerName(nx.prayer)) + "</span>" : '<span>' + esc(L.notSet) + "</span>") + "</span></button></li>";
  }

  let nearbyState = "idle"; // idle | loading | error
  let nearbyError = "";
  let searchResults = null;

  function nearbyHTML() {
    const L = t();
    let body;
    if (nearbyState === "loading") body = '<div class="empty"><div class="spinner"></div><p class="sub">' + esc(L.locating) + "</p></div>";
    else if (nearbyState === "error") body = '<div class="empty"><p class="sub">' + esc(nearbyError) + '</p><button class="btn primary" data-locate="1">' + esc(L.allowLocation) + "</button></div>";
    else if (S.nearbyView === "map" && !searchResults) {
      body = '<div class="map-host" id="mapHost"><button class="map-me" data-maplocate="1" aria-label="' + esc(L.myLocation) + '" title="' + esc(L.myLocation) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.07A7 7 0 0 0 13 5.07V3h-2v2.07A7 7 0 0 0 5.07 11H3v2h2.07A7 7 0 0 0 11 18.93V21h2v-2.07A7 7 0 0 0 18.93 13H21v-2zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg></button></div>';
    } else {
      const list = (searchResults || S.nearby.map((id) => S.cache[id]).filter(Boolean));
      body = list.length ? '<ul class="list">' + list.map(itemHTML).join("") + "</ul>"
        : '<div class="empty"><p class="sub">' + esc(S.loc ? L.nearbyEmpty : L.locationNeeded) + '</p>' + (S.loc ? "" : '<button class="btn primary" data-locate="1">' + esc(L.findNearby) + "</button>") + "</div>";
    }
    const views = '<div class="seg view-switch" role="group">' +
      [["list", L.viewList], ["map", L.viewMap]].map(([k, n]) => '<button data-view="' + k + '" aria-pressed="' + (S.nearbyView === k && !(k === "map" && searchResults)) + '">' + esc(n) + "</button>").join("") + "</div>";
    return '<div class="wrap"><div class="title-row"><h1>' + esc(L.tabNearby) + "</h1>" + views + "</div>" +
      '<form class="search" id="searchForm"><input id="searchInput" type="search" placeholder="' + esc(L.searchPlaceholder) + '" autocomplete="off" value="' + esc(lastQuery) + '"></form>' +
      body + '<button class="btn" data-add="1">＋ ' + esc(L.addMasjid) + "</button></div>";
  }
  let lastQuery = "";

  function detailHTML(m) {
    if (!m) { detailId = null; return nearbyHTML(); }
    const L = t();
    return '<div class="wrap"><button class="btn ghost small" data-back="1" style="justify-self:start">‹ ' + esc(L.tabNearby) + "</button>" +
      atMasjidBanner(m) + boardHTML(m) + masjidActions(m) + pendingHTML(m) +
      (m.status === "pending" ? '<button class="btn ghost" data-report="' + m.id + '">' + esc(L.reportWrong) + "</button>" : "") + "</div>";
  }

  let perms = null;
  function settingsHTML() {
    const L = t(), st = S.settings;
    const langs = [["en", "English"], ["ur", "اردو"], ["ps", "پښتو"]];
    const sw = (key, on) => '<button class="switch" role="switch" aria-checked="' + !!on + '" data-set="' + key + '"></button>';
    const reminders = native && native.setPlan
      ? '<div class="set-row"><span>' + esc(L.remindersOn) + "</span>" + sw("remind", st.remind) + "</div>" +
        '<div class="set-row" style="display:grid;gap:8px"><span>' + esc(L.remindBefore) + '</span><div class="seg">' +
          [5, 10, 15, 20, 30].map((m) => '<button data-before="' + m + '" aria-pressed="' + (st.before === m) + '">' + esc(L.minutes(m)) + "</button>").join("") + "</div></div>" +
        '<div class="set-row" style="display:grid;gap:8px"><span>' + esc(L.remindFor) + '</span><div class="seg">' +
          C.ORDER.map((p) => '<button data-prayer="' + p + '" aria-pressed="' + !!st.prayers[p] + '">' + esc(prayerName(p)) + "</button>").join("") + "</div></div>" +
        '<div class="set-row"><span>' + esc(L.changesAlerts) + "</span>" + sw("changes", st.changes) + "</div>"
      : '<p class="muted">' + esc(L.remindersWeb) + "</p>";
    const p = perms || {};
    const permRow = (k, label) => '<div class="set-row"><span>' + esc(label) + "</span>" + (p[k] ? '<span class="ok">✓ ' + esc(L.allowed) + "</span>" : '<button class="btn small" data-perm="' + k + '">' + esc(L.allow) + "</button>") + "</div>";
    const reliable = native && native.permissions
      ? '<section class="card"><h2>' + esc(L.reliableTitle) + '</h2><p class="muted">' + esc(L.reliableText) + '</p><div class="set-group">' +
        permRow("notifications", L.permNotif) + permRow("alarms", L.permAlarm) + permRow("battery", L.permBattery) + "</div></section>"
      : "";
    return '<div class="wrap"><h1>' + esc(L.settings) + '</h1><section class="card"><h2>' + esc(L.language) + '</h2><div class="seg" style="margin-top:10px">' +
      langs.map(([k, n]) => '<button data-lang="' + k + '" aria-pressed="' + (S.lang === k) + '">' + n + "</button>").join("") + "</div></section>" +
      '<section class="card"><h2>' + esc(L.remindersTitle) + '</h2><div class="set-group">' + reminders + "</div></section>" + reliable +
      '<section class="card"><h2>' + esc(L.privacyTitle) + '</h2><p class="muted">' + esc(L.privacyText) + "</p></section></div>";
  }

  // ------------------------------------------------------------ sheets

  function openSheet(html) {
    $("sheetBody").innerHTML = html;
    $("sheet").classList.remove("hidden");
  }
  function closeSheet() {
    const open = !$("sheet").classList.contains("hidden");
    $("sheet").classList.add("hidden");
    return open;
  }

  function updateSheet(m, prayer) {
    const L = t();
    const today = new Date();
    const pr = prayer || (C.nextJamaat(m) || {}).prayer || "fajr";
    const live = currentTiming(m, pr);
    const cur = live ? C.jamaatMinutes(live, m, today) : null;
    const hhmm = cur == null ? "" : toHHMM(cur);
    openSheet('<h2>' + esc(L.updateTitle) + '</h2><p class="muted">' + esc(m.name) + " · " + esc(L.updateText) + "</p>" +
      '<form id="updForm" class="sheet-form" data-mosque="' + m.id + '">' +
      '<div class="field"><label for="updPrayer">' + esc(L.prayer) + '</label><select id="updPrayer">' +
        C.ORDER.map((p) => '<option value="' + p + '"' + (p === pr ? " selected" : "") + ">" + esc(prayerName(p)) + "</option>").join("") + "</select></div>" +
      '<div class="field" id="mgMode"' + (pr === "maghrib" ? "" : ' hidden') + '><span class="lbl">' + esc(L.maghribMode) + '</span><div class="seg">' +
        '<button type="button" data-mode="fixed" aria-pressed="' + !(live && live.kind === "after_sunset") + '">' + esc(L.fixedTime) + '</button>' +
        '<button type="button" data-mode="after_sunset" aria-pressed="' + !!(live && live.kind === "after_sunset") + '">' + esc(L.afterSunset) + "</button></div></div>" +
      '<div class="field" id="fTime"><label for="updTime">' + esc(L.time) + '</label><div class="stepper"><button type="button" class="btn" data-step="-5" aria-label="−5">−5</button><input id="updTime" type="time" required value="' + hhmm + '"><button type="button" class="btn" data-step="5" aria-label="+5">+5</button></div></div>' +
      '<div class="field" id="fAfter" hidden><label for="updAfter">' + esc(L.minutesAfter) + '</label><input id="updAfter" type="number" inputmode="numeric" min="0" max="30" value="' + (live && live.kind === "after_sunset" ? live.minutes : 5) + '"></div>' +
      '<button class="btn primary" type="submit">' + esc(L.submit) + "</button></form>");
    syncMode();
  }
  const toHHMM = (min) => String(Math.floor(min / 60) % 24).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");

  /** The time to start from for a prayer: the confirmed one, else the most-reported one. */
  function currentTiming(m, prayer) {
    const d = C.displayTimings(m)[prayer];
    return d.live || d.pending[0] || null;
  }

  function stepTime(delta) {
    if (!$("fAfter").hidden) {
      const el = $("updAfter");
      el.value = Math.min(30, Math.max(0, (parseInt(el.value, 10) || 0) + delta));
      return;
    }
    const el = $("updTime");
    let [h, mm] = (el.value || "").split(":").map(Number);
    if (!el.value || isNaN(h) || isNaN(mm)) { const now = new Date(); h = now.getHours(); mm = Math.round(now.getMinutes() / 5) * 5; delta = 0; }
    el.value = toHHMM(((h * 60 + mm + delta) % 1440 + 1440) % 1440);
  }

  /** Switching prayer in the form starts from that prayer's current time. */
  function prefillPrayer() {
    const form = $("updForm");
    const m = form && S.cache[form.dataset.mosque];
    if (!m) return;
    const x = currentTiming(m, $("updPrayer").value);
    $("updTime").value = x && x.kind !== "after_sunset" ? toHHMM(C.jamaatMinutes(x, m, new Date())) : "";
    if (x && x.kind === "after_sunset") $("updAfter").value = x.minutes;
    form.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.mode === "after_sunset") === !!(x && x.kind === "after_sunset"))));
  }

  function syncMode() {
    const form = $("updForm");
    if (!form) return;
    const isMg = $("updPrayer").value === "maghrib";
    $("mgMode").hidden = !isMg;
    const after = isMg && form.querySelector('[data-mode="after_sunset"]').getAttribute("aria-pressed") === "true";
    $("fTime").hidden = after;
    $("fAfter").hidden = !after;
    $("updTime").required = !after;
  }

  function addSheet() {
    const L = t();
    openSheet('<h2>' + esc(L.addTitle) + '</h2><p class="muted">' + esc(L.addText) + "</p>" +
      '<form id="addForm" class="sheet-form"><div class="field"><label for="addName">' + esc(L.masjidName) + '</label><input id="addName" required maxlength="120" autocomplete="off"></div>' +
      '<button class="btn primary" type="submit">' + esc(L.add) + "</button></form>");
  }

  // ------------------------------------------------------------ actions

  async function withFreshLocation(fn) {
    if (busy) return;
    busy = true;
    toast(t().locating);
    try {
      const loc = await C.locate(true);
      S.loc = { lat: loc.lat, lon: loc.lon, accuracy: loc.accuracy, at: Date.now() };
      await fn(loc);
    } catch (e) {
      toast(errorText(e));
    } finally {
      busy = false;
    }
  }

  async function reloadMosque(id) {
    try {
      const [m] = await C.rpc("mosques_by_id", { p_ids: [id], p_lat: S.loc ? S.loc.lat : null, p_lon: S.loc ? S.loc.lon : null });
      if (m) cacheMosques([m]);
    } catch (e) {}
    syncNative();
    render();
  }

  function resultToast(r) {
    const L = t();
    toast(r.status === "accepted" ? L.accepted : r.status === "reconfirmed" ? L.reconfirmed : r.status === "rejected" ? L.rejected : L.submitted);
  }

  async function submitUpdate(form) {
    const m = S.cache[form.dataset.mosque];
    const prayer = $("updPrayer").value;
    const after = !$("fAfter").hidden;
    let kind = "fixed", minutes;
    if (after) { kind = "after_sunset"; minutes = parseInt($("updAfter").value, 10) || 0; }
    else {
      const [h, mm] = ($("updTime").value || "").split(":").map(Number);
      if (isNaN(h)) return;
      minutes = h * 60 + mm;
    }
    if (C.windowProblem(prayer, kind, minutes, m)) { toast(t().errors.IMPOSSIBLE_TIME); return; }
    await withFreshLocation(async (loc) => {
      const r = await C.rpc("submit_timing", { p_mosque: m.id, p_prayer: prayer, p_kind: kind, p_minutes: minutes, p_lat: loc.lat, p_lon: loc.lon, p_mock: !!loc.mock }, true);
      closeSheet();
      resultToast(r);
      await reloadMosque(m.id);
    });
  }

  async function submitAdd() {
    const name = $("addName").value.trim();
    if (name.length < 2) { toast(t().errors.NAME_REQUIRED); return; }
    await withFreshLocation(async (loc) => {
      const r = await C.rpc("add_mosque", { p_name: name, p_lat: loc.lat, p_lon: loc.lon, p_mock: !!loc.mock }, true);
      closeSheet();
      toast(t().addedPending);
      S.follows = [...new Set([...S.follows, r.mosque])];
      if (!S.myId) S.myId = r.mosque;
      save();
      await findNearby().catch(() => {});
      await reloadMosque(r.mosque);
    });
  }

  function setMine(id) {
    if (map && map.closePopup) map.closePopup();
    S.myId = id;
    S.follows = [...new Set([...S.follows, id])];
    save();
    S.tab = "home";
    detailId = null;
    syncNative();
    render();
  }

  function directions(m) {
    const url = "https://www.google.com/maps/dir/?api=1&destination=" + m.lat + "," + m.lon;
    if (native && native.openUrl) native.openUrl(url);
    else window.open(url, "_blank", "noopener");
  }

  // ------------------------------------------------------------ Android: reminders and change alerts

  function nativeStrings() {
    const L = t();
    return {
      prayers: L.prayers,
      reminderTitle: L.reminderTitle("{p}", "{m}"),
      reminderBody: L.reminderBody("{t}", 99).replace("99", "{n}"),
      reminderNow: L.reminderBody("{t}", 0),
      changeTitle: L.changeTitle("{m}"),
      changeBody: "{p}: {t}",
      ampm: S.lang === "en",
    };
  }

  function syncNative() {
    if (!native) return;
    const st = S.settings;
    const m = S.myId && S.cache[S.myId];
    try {
      if (native.setPlan) {
        native.setPlan(JSON.stringify({
          enabled: !!(st.remind && m), before: st.before, prayers: st.prayers, strings: nativeStrings(),
          mosque: m ? { id: m.id, name: m.name, lat: m.lat, lon: m.lon, timings: (m.timings || []).map((x) => ({ prayer: x.prayer, kind: x.kind, minutes: x.minutes })) } : null,
        }));
      }
      if (native.setFollowed) {
        const ids = [S.myId, ...S.follows].filter((x, i, a) => x && a.indexOf(x) === i && S.cache[x]);
        native.setFollowed(JSON.stringify({
          enabled: !!st.changes, url: C.SB_URL, key: C.SB_KEY, strings: nativeStrings(), myId: S.myId,
          mosques: ids.map((id) => ({ id, name: S.cache[id].name, lat: S.cache[id].lat, lon: S.cache[id].lon,
            timings: (S.cache[id].timings || []).map((x) => ({ prayer: x.prayer, kind: x.kind, minutes: x.minutes })) })),
        }));
      }
    } catch (e) {}
  }

  function refreshPerms() {
    if (!native || !native.permissions) return;
    try { perms = JSON.parse(native.permissions()); } catch (e) { perms = null; }
  }
  window.onPermissionsChanged = function () {
    refreshPerms();
    if (S.tab === "settings") render();
    syncNative();
  };

  // ------------------------------------------------------------ events

  async function locateAndShow() {
    nearbyState = "loading";
    render();
    try {
      await findNearby();
      nearbyState = "idle";
    } catch (e) {
      nearbyState = "error";
      nearbyError = errorText(e);
      if (e.code === "network") { nearbyState = "idle"; toast(t().errors.network); }
    }
    render();
  }

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button, [data-open], .row[data-update]");
    if (!b) {
      if (e.target === $("sheet")) closeSheet();
      return;
    }
    const d = b.dataset;
    if (d.tab) {
      S.tab = d.tab;
      detailId = null;
      save();
      if (S.tab === "settings") refreshPerms();
      render();
      if (S.tab === "nearby" && !S.nearby.length && nearbyState !== "loading") locateAndShow();
      return;
    }
    if (d.go) { S.tab = d.go; detailId = null; save(); render(); if (d.go === "nearby" && !S.nearby.length) locateAndShow(); return; }
    if (d.locate) { locateAndShow(); return; }
    if (d.view) { S.nearbyView = d.view; searchResults = null; lastQuery = ""; save(); render(); return; }
    if (d.maplocate) { mapLocate(); return; }
    if (d.open) { detailId = d.open; S.tab = d.open === S.myId ? "home" : "nearby"; if (S.tab === "home") detailId = null; render(); $("view").scrollTop = 0; return; }
    if (d.back) { detailId = null; render(); return; }
    if (d.mine) { setMine(d.mine); return; }
    if (d.follow) {
      S.follows = S.follows.includes(d.follow) ? S.follows.filter((x) => x !== d.follow) : [...S.follows, d.follow];
      save(); syncNative(); render(); return;
    }
    if (d.dir) { directions(S.cache[d.dir]); return; }
    if (d.update) { updateSheet(S.cache[d.update], d.uprayer); return; }
    if (d.step) { stepTime(+d.step); return; }
    if (d.add) { addSheet(); return; }
    if (d.mode) {
      b.parentElement.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      syncMode(); return;
    }
    if (d.vote) {
      const agree = d.agree === "1";
      const mid = Object.values(S.cache).find((m) => (m.pending || []).some((p) => p.id === d.vote));
      await withFreshLocation(async (loc) => {
        const r = await C.rpc("vote_proposal", { p_proposal: d.vote, p_agree: agree, p_lat: loc.lat, p_lon: loc.lon, p_mock: !!loc.mock }, true);
        resultToast(r);
        if (mid) await reloadMosque(mid.id);
      });
      return;
    }
    if (d.confirmAll) {
      const m = S.cache[d.confirmAll];
      await withFreshLocation(async (loc) => {
        const where = { p_lat: loc.lat, p_lon: loc.lon, p_mock: !!loc.mock };
        let n = 0;
        for (const step of confirmPlan(m)) {
          if (step.kind === "reconfirm") await C.rpc("reconfirm_timing", Object.assign({ p_mosque: m.id, p_prayer: step.prayer }, where), true);
          else await C.rpc("vote_proposal", Object.assign({ p_proposal: step.id, p_agree: true }, where), true);
          n++;
        }
        toast(t().confirmAllDone(n));
        await reloadMosque(m.id);
      });
      return;
    }
    if (d.reconfirm) {
      const m = S.cache[d.reconfirm];
      await withFreshLocation(async (loc) => {
        for (const x of m.timings || []) {
          await C.rpc("reconfirm_timing", { p_mosque: m.id, p_prayer: x.prayer, p_lat: loc.lat, p_lon: loc.lon, p_mock: !!loc.mock }, true);
        }
        toast(t().stillCorrectDone);
        await reloadMosque(m.id);
      });
      return;
    }
    if (d.confirmMosque) {
      await withFreshLocation(async (loc) => {
        await C.rpc("confirm_mosque", { p_mosque: d.confirmMosque, p_lat: loc.lat, p_lon: loc.lon, p_mock: !!loc.mock }, true);
        toast(t().confirmedExists);
        await reloadMosque(d.confirmMosque);
      });
      return;
    }
    if (d.report) {
      try { await C.rpc("report_mosque", { p_mosque: d.report }, true); toast(t().reported); } catch (err) { toast(errorText(err)); }
      return;
    }
    if (d.lang) { S.lang = d.lang; save(); syncNative(); render(); return; }
    if (d.set) { S.settings[d.set] = !S.settings[d.set]; save(); syncNative(); render(); return; }
    if (d.before) { S.settings.before = +d.before; save(); syncNative(); render(); return; }
    if (d.prayer) { S.settings.prayers[d.prayer] = !S.settings.prayers[d.prayer]; save(); syncNative(); render(); return; }
    if (d.perm) { if (native && native.requestPermission) native.requestPermission(d.perm); return; }
  });

  document.addEventListener("change", (e) => { if (e.target.id === "updPrayer") { prefillPrayer(); syncMode(); } });
  document.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest(".row[data-update]");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
  });
  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "updForm") await submitUpdate(e.target);
    else if (e.target.id === "addForm") await submitAdd();
    else if (e.target.id === "searchForm") {
      lastQuery = $("searchInput").value.trim();
      if (lastQuery.length < 2) { searchResults = null; render(); return; }
      try {
        const list = await C.rpc("search_mosques", { p_query: lastQuery, p_lat: S.loc ? S.loc.lat : null, p_lon: S.loc ? S.loc.lon : null });
        cacheMosques(list);
        searchResults = list;
      } catch (err) { toast(errorText(err)); }
      render();
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "searchInput" && !e.target.value) { lastQuery = ""; searchResults = null; render(); $("searchInput").focus(); }
  });

  window.onAndroidBack = function () {
    if (closeSheet()) return true;
    if (detailId) { detailId = null; render(); return true; }
    if (S.tab !== "home") { S.tab = "home"; render(); return true; }
    return false;
  };
  let nativeKeyboard = false;
  function setKeyboard(px) {
    const was = parseFloat(document.documentElement.style.getPropertyValue("--kb")) || 0;
    document.documentElement.style.setProperty("--kb", Math.max(0, Math.round(px)) + "px");
    // keep the field being typed in visible above the keyboard
    if (px > was) setTimeout(() => {
      const el = document.activeElement;
      if (el && el.closest && el.closest(".sheet")) el.scrollIntoView({ block: "nearest" });
    }, 60);
  }
  window.setInsets = function (top, bottom, keyboard) {
    document.documentElement.style.setProperty("--inset-top", top + "px");
    document.documentElement.style.setProperty("--inset-bottom", bottom + "px");
    if (keyboard != null) { nativeKeyboard = true; setKeyboard(keyboard); }
  };
  // phone browsers: the visual viewport shrinks when the keyboard opens
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVV = () => { if (!nativeKeyboard) setKeyboard(window.innerHeight - vv.height - vv.offsetTop); };
    vv.addEventListener("resize", onVV);
    vv.addEventListener("scroll", onVV);
  }
  window.onAndroidResume = function () { refreshPerms(); refreshMine(); };

  // keep the countdown fresh
  setInterval(() => { if (S.tab === "home" && $("sheet").classList.contains("hidden")) render(); }, 30000);

  window.__masjid = { get state() { return S; }, render, findNearby, setMine };

  render();
  refreshPerms();
  refreshMine();
  C.session().catch(() => {}); // get a private ID early so contributing is instant
})();
