package io.github.mhamzam.masjidtimes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Reminder alarms, plus re-arming after a reboot, an app update, a clock change or exact-alarm permission change. */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        Reminders.channels(context);
        if (Reminders.ACTION_REMIND.equals(a)) {
            Reminders.fire(context, intent);
        } else {
            Reminders.schedule(context);
            SyncJob.ensure(context);
        }
    }
}
