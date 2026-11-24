package io.github.mhamzam.masjidtimes;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;

/**
 * Every few hours (when online), fetch the current timings of the masjids the user follows.
 * If a jamaat time changed, update the reminders and, if the user wants, post a notification.
 * Uses only the public read API: no account, no location sent.
 */
public class SyncJob extends JobService {
    static final int JOB_ID = 7;
    private volatile Thread worker;

    /** Schedule the periodic sync if there is anything to follow; cancel it otherwise. */
    static void ensure(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        JSONObject f = Reminders.read(c, Reminders.KEY_FOLLOWED);
        JSONArray ms = f == null ? null : f.optJSONArray("mosques");
        if (ms == null || ms.length() == 0) {
            js.cancel(JOB_ID);
            return;
        }
        if (js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(6 * 3600_000L, 2 * 3600_000L)
                .setPersisted(true)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        worker = new Thread(() -> {
            boolean retry = false;
            try {
                sync(getApplicationContext());
            } catch (Exception e) {
                retry = true;
            }
            jobFinished(params, retry);
        }, "masjid-sync");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Thread t = worker;
        if (t != null) t.interrupt();
        return true;
    }

    static void sync(Context c) throws Exception {
        JSONObject followed = Reminders.read(c, Reminders.KEY_FOLLOWED);
        if (followed == null) return;
        JSONArray old = followed.optJSONArray("mosques");
        if (old == null || old.length() == 0) return;
        String base = followed.optString("url"), key = followed.optString("key");
        if (base.isEmpty() || key.isEmpty()) return;

        JSONArray ids = new JSONArray();
        for (int i = 0; i < old.length(); i++) ids.put(old.getJSONObject(i).getString("id"));
        JSONObject args = new JSONObject().put("p_ids", ids).put("p_lat", JSONObject.NULL).put("p_lon", JSONObject.NULL);
        JSONArray fresh = new JSONArray(post(base + "/rest/v1/rpc/mosques_by_id", key, args.toString()));

        JSONObject strings = followed.optJSONObject("strings");
        boolean ampm = strings == null || strings.optBoolean("ampm", true);
        boolean alerts = followed.optBoolean("enabled", true);
        String myId = followed.optString("myId", "");
        JSONArray updated = new JSONArray();
        int nid = 200;

        for (int i = 0; i < old.length(); i++) {
            JSONObject o = old.getJSONObject(i);
            JSONObject n = find(fresh, o.getString("id"));
            if (n == null) { updated.put(o); continue; }
            JSONArray nt = slim(n.optJSONArray("timings"));
            StringBuilder changes = new StringBuilder();
            for (int k = 0; k < nt.length(); k++) {
                JSONObject t = nt.getJSONObject(k);
                JSONObject before = find(o.optJSONArray("timings"), t.getString("prayer"), "prayer");
                boolean changed = before == null
                        ? o.optJSONArray("timings") != null && o.optJSONArray("timings").length() > 0 // a newly set time at a masjid that had times
                        : before.optInt("minutes") != t.optInt("minutes") || !before.optString("kind").equals(t.optString("kind"));
                if (!changed) continue;
                int m = Reminders.jamaatMinutes(t, n.optDouble("lat"), n.optDouble("lon"), Calendar.getInstance());
                if (changes.length() > 0) changes.append("\n");
                String line = strings == null ? "{p}: {t}" : strings.optString("changeBody", "{p}: {t}");
                changes.append(line.replace("{p}", Reminders.prayerName(strings, t.getString("prayer"))).replace("{t}", Reminders.fmt(m, ampm)));
            }
            JSONObject u = new JSONObject().put("id", o.getString("id")).put("name", n.optString("name", o.optString("name")))
                    .put("lat", n.optDouble("lat")).put("lon", n.optDouble("lon")).put("timings", nt);
            updated.put(u);
            if (changes.length() > 0 && alerts) {
                String title = strings == null ? "Jamaat time changed: {m}" : strings.optString("changeTitle", "{m}");
                Reminders.notify(c, nid++, Reminders.CH_CHANGE, title.replace("{m}", u.optString("name")), changes.toString());
            }
            if (u.getString("id").equals(myId)) {
                JSONObject plan = Reminders.read(c, Reminders.KEY_PLAN);
                if (plan != null && plan.optJSONObject("mosque") != null) {
                    plan.getJSONObject("mosque").put("timings", nt).put("name", u.optString("name"));
                    Reminders.prefs(c).edit().putString(Reminders.KEY_PLAN, plan.toString()).apply();
                }
            }
        }
        followed.put("mosques", updated);
        Reminders.prefs(c).edit().putString(Reminders.KEY_FOLLOWED, followed.toString()).apply();
        Reminders.schedule(c);
    }

    private static JSONArray slim(JSONArray timings) throws Exception {
        JSONArray out = new JSONArray();
        if (timings == null) return out;
        for (int i = 0; i < timings.length(); i++) {
            JSONObject t = timings.getJSONObject(i);
            out.put(new JSONObject().put("prayer", t.getString("prayer")).put("kind", t.optString("kind", "fixed")).put("minutes", t.optInt("minutes")));
        }
        return out;
    }

    private static JSONObject find(JSONArray arr, String id) {
        return find(arr, id, "id");
    }

    private static JSONObject find(JSONArray arr, String value, String field) {
        if (arr == null) return null;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null && value.equals(o.optString(field))) return o;
        }
        return null;
    }

    private static String post(String url, String key, String body) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(15000);
        h.setReadTimeout(20000);
        h.setRequestMethod("POST");
        h.setDoOutput(true);
        h.setRequestProperty("apikey", key);
        h.setRequestProperty("Content-Type", "application/json");
        try (OutputStream os = h.getOutputStream()) {
            os.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int code = h.getResponseCode();
        if (code / 100 != 2) throw new IllegalStateException("HTTP " + code);
        try (InputStream in = h.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            return out.toString("UTF-8");
        } finally {
            h.disconnect();
        }
    }
}
