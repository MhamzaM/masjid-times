package io.github.mhamzam.masjidtimes;

import java.util.Calendar;
import java.util.TimeZone;

/** Sunset for "Maghrib = sunset + n minutes". Same formula as the app's core.js and the database's sun_times. */
final class Solar {
    private Solar() {}

    /** Minutes after local midnight of sunset on the given local date. */
    static int sunsetMinutes(double lat, double lon, int year, int month0, int day) {
        Calendar utc = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        utc.clear();
        utc.set(year, month0, day);
        double days = utc.getTimeInMillis() / 86400000.0;

        Calendar local = Calendar.getInstance();
        local.clear();
        local.set(year, month0, day, 12, 0);
        double tz = TimeZone.getDefault().getOffset(local.getTimeInMillis()) / 3600000.0;

        double jd = days + 2440587.5 - lon / 360.0;
        double d = jd - 2451545.0 + 0.5;
        double g = Math.toRadians(mod(357.529 + 0.98560028 * d, 360));
        double q = mod(280.459 + 0.98564736 * d, 360);
        double l = Math.toRadians(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
        double e = Math.toRadians(23.439 - 0.00000036 * d);
        double ra = Math.toDegrees(Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l))) / 15.0;
        ra -= 24 * Math.floor(ra / 24);
        double decl = Math.asin(Math.sin(e) * Math.sin(l));
        double eqt = q / 15.0 - ra;
        eqt -= 24 * Math.round(eqt / 24);
        double noon = 12 + tz - lon / 15.0 - eqt;
        double la = Math.toRadians(lat);
        double c = (-Math.sin(Math.toRadians(0.833)) - Math.sin(decl) * Math.sin(la)) / (Math.cos(decl) * Math.cos(la));
        double t = Math.toDegrees(Math.acos(Math.max(-1, Math.min(1, c)))) / 15.0;
        return (int) Math.round((noon + t) * 60);
    }

    private static double mod(double x, double m) {
        return ((x % m) + m) % m;
    }
}
