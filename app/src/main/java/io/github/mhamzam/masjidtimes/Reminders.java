package io.github.mhamzam.masjidtimes;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Jamaat reminders. The page hands over a "plan" (the user's masjid, its timings and settings);
 * we keep exactly one alarm set, for the next reminder, and set the following one when it fires.
 */
final class Reminders {
    private Reminders() {}

    static final String PREFS = "masjid";
    static final String KEY_PLAN = "plan";
    static final String KEY_FOLLOWED = "followed";
    static final String CH_REMIND = "jamaat";
    static final String CH_CHANGE = "changes";
    static final String ACTION_REMIND = "io.github.mhamzam.masjidtimes.REMIND";

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject read(Context c, String key) {
        try {
            String s = prefs(c).getString(key, null);
            return s == null ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    static void savePlan(Context c, String json) {
        prefs(c).edit().putString(KEY_PLAN, json).apply();
        schedule(c);
    }

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel r = new NotificationChannel(CH_REMIND, "Jamaat reminders", NotificationManager.IMPORTANCE_HIGH);
        r.setDescription("A reminder before each jamaat at your masjid");
        nm.createNotificationChannel(r);
        NotificationChannel ch = new NotificationChannel(CH_CHANGE, "Timing changes", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("When a jamaat time changes at a masjid you follow");
        nm.createNotificationChannel(ch);
    }

    /** One upcoming jamaat: the prayer key and when it starts. */
    static final class Next {
        final String prayer;
        final long jamaatAt;
        final int jamaatMinutes;
        Next(String prayer, long at, int minutes) { this.prayer = prayer; this.jamaatAt = at; this.jamaatMinutes = minutes; }
    }

    /** The jamaat time of a timing on a date, in minutes after midnight. */
    static int jamaatMinutes(JSONObject timing, double lat, double lon, Calendar day) {
        int m = timing.optInt("minutes");
        if ("after_sunset".equals(timing.optString("kind"))) {
            m += Solar.sunsetMinutes(lat, lon, day.get(Calendar.YEAR), day.get(Calendar.MONTH), day.get(Calendar.DAY_OF_MONTH));
        }
        return m;
    }

    /** Earliest reminder strictly after `after` (ms), honouring per-prayer switches and Jumuah on Fridays. */
    static Next nextReminder(JSONObject plan, long after) {
        if (plan == null || !plan.optBoolean("enabled")) return null;
        JSONObject mosque = plan.optJSONObject("mosque");
        if (mosque == null) return null;
        JSONArray timings = mosque.optJSONArray("timings");
        if (timings == null || timings.length() == 0) return null;
        JSONObject on = plan.optJSONObject("prayers");
        long before = plan.optInt("before", 10) * 60000L;
        double lat = mosque.optDouble("lat"), lon = mosque.optDouble("lon");

        boolean hasJumuah = false;
        for (int i = 0; i < timings.length(); i++) if ("jumuah".equals(timings.optJSONObject(i).optString("prayer"))) hasJumuah = true;

        Next best = null;
        for (int off = 0; off < 3; off++) {
            Calendar day = Calendar.getInstance();
            day.setTimeInMillis(after);
            day.add(Calendar.DAY_OF_MONTH, off);
            day.set(Calendar.HOUR_OF_DAY, 0);
            day.set(Calendar.MINUTE, 0);
            day.set(Calendar.SECOND, 0);
            day.set(Calendar.MILLISECOND, 0);
            boolean friday = day.get(Calendar.DAY_OF_WEEK) == Calendar.FRIDAY;
            for (int i = 0; i < timings.length(); i++) {
                JSONObject t = timings.optJSONObject(i);
                String p = t.optString("prayer");
                if (on != null && !on.optBoolean(p, true)) continue;
                if ("jumuah".equals(p) && !friday) continue;
                if ("dhuhr".equals(p) && friday && hasJumuah) continue;
                int m = jamaatMinutes(t, lat, lon, day);
                Calendar at = (Calendar) day.clone();
                at.add(Calendar.MINUTE, m);
                long remindAt = at.getTimeInMillis() - before;
                if (remindAt > after && (best == null || at.getTimeInMillis() < best.jamaatAt)) {
                    best = new Next(p, at.getTimeInMillis(), m);
                }
            }
            if (best != null) return best;
        }
        return best;
    }

    static boolean canExact(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        return am != null && am.canScheduleExactAlarms();
    }

    private static PendingIntent alarmIntent(Context c, String prayer, long jamaatAt) {
        Intent i = new Intent(c, AlarmReceiver.class).setAction(ACTION_REMIND);
        if (prayer != null) {
            i.putExtra("prayer", prayer);
            i.putExtra("at", jamaatAt);
        }
        return PendingIntent.getBroadcast(c, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** (Re)set the single alarm for the next reminder, or clear it. */
    static void schedule(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        JSONObject plan = read(c, KEY_PLAN);
        Next n = nextReminder(plan, System.currentTimeMillis() + 1000);
        if (n == null) {
            am.cancel(alarmIntent(c, null, 0));
            return;
        }
        long when = n.jamaatAt - plan.optInt("before", 10) * 60000L;
        PendingIntent pi = alarmIntent(c, n.prayer, n.jamaatAt);
        if (canExact(c)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi); // may be a few minutes late
    }

    // ------------------------------------------------------------ notifications

    static String fmt(int minutes, boolean ampm) {
        minutes = ((minutes % 1440) + 1440) % 1440;
        int h = minutes / 60, m = minutes % 60;
        int h12 = h % 12 == 0 ? 12 : h % 12;
        return h12 + ":" + (m < 10 ? "0" : "") + m + (ampm ? (h < 12 ? " AM" : " PM") : "");
    }

    static String prayerName(JSONObject strings, String p) {
        JSONObject names = strings == null ? null : strings.optJSONObject("prayers");
        String s = names == null ? null : names.optString(p, null);
        return s != null ? s : p.substring(0, 1).toUpperCase() + p.substring(1);
    }

    static void notify(Context c, int id, String channel, String title, String body) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return;
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(0xFF0F6B4F)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setCategory(CH_REMIND.equals(channel) ? Notification.CATEGORY_REMINDER : Notification.CATEGORY_STATUS)
                .build();
        nm.notify(id, n);
    }

    /** Alarm fired: show the reminder, then set the next one. */
    static void fire(Context c, Intent intent) {
        JSONObject plan = read(c, KEY_PLAN);
        String prayer = intent.getStringExtra("prayer");
        long at = intent.getLongExtra("at", 0);
        long now = System.currentTimeMillis();
        // Ignore a stale alarm (phone was off, or the plan changed since): only remind up to 5 min after the jamaat starts.
        if (plan != null && plan.optBoolean("enabled") && prayer != null && at > now - 5 * 60000L) {
            JSONObject s = plan.optJSONObject("strings");
            JSONObject mosque = plan.optJSONObject("mosque");
            Calendar cal = Calendar.getInstance();
            cal.setTimeInMillis(at);
            int minutes = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
            boolean ampm = s == null || s.optBoolean("ampm", true);
            String time = fmt(minutes, ampm);
            long left = Math.max(0, Math.round((at - now) / 60000.0));
            String name = prayerName(s, prayer);
            String mName = mosque == null ? "" : mosque.optString("name");
            String title = s == null ? name + " jamaat at " + mName : s.optString("reminderTitle", "{p} · {m}").replace("{p}", name).replace("{m}", mName);
            String body = left > 0
                    ? (s == null ? "Starts at {t} (in {n} min)" : s.optString("reminderBody", "{t} ({n})")).replace("{t}", time).replace("{n}", String.valueOf(left))
                    : (s == null ? "Starts now ({t})" : s.optString("reminderNow", "{t}")).replace("{t}", time);
            notify(c, 100, CH_REMIND, title, body);
        }
        schedule(c);
    }
}
