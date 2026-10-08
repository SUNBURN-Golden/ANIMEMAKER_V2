package com.animemaker.v2;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * 영상 만들기 같은 오래 걸리는 일을 하는 동안 앱이 멈추거나 꺼지지 않게 붙들어 두는 앞쪽(foreground) 서비스.
 * 알림에 진행 막대를 보여 준다.
 *
 * 서비스 종류는 dataSync 로 정했다. 안드로이드 14(API 34)부터 종류를 매니페스트에 적어야 하는데,
 * mediaProcessing 은 안드로이드 15(API 35)에서 새로 생겨서 14 이하 폰에서는 모르는 값이다. dataSync 는 14·15 모두에서 쓸 수 있고
 * (15 부터는 24시간에 6시간까지) 몇 분짜리 일에는 넉넉하다.
 *
 * 쓰는 법: start() → (진행 중) update() → stop(). 알림 권한(안드로이드 13+)이 없어도 서비스는 돌지만 알림은 안 보인다.
 */
public class JobService extends Service {
    static final String CHANNEL_ID = "am_jobs";
    static final int NOTIFICATION_ID = 4201;
    /** update() 의 progress: 막대 없음 */
    static final int PROGRESS_NONE = -1;
    /** update() 의 progress: 얼마나 남았는지 모를 때 빙글빙글 */
    static final int PROGRESS_UNKNOWN = -2;

    private static final Object LOCK = new Object();
    private static boolean running = false;
    private static String curTitle = "";
    private static String curText = "";
    private static int curProgress = PROGRESS_UNKNOWN;

    /** 서비스를 켠다. 안드로이드 12+ 는 앱이 화면 뒤에 있으면 새로 켤 수 없어서 false 를 돌려줄 수 있다. */
    static boolean start(Context ctx, String title, String text) {
        synchronized (LOCK) {
            curTitle = title;
            curText = text;
            curProgress = PROGRESS_UNKNOWN;
        }
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, JobService.class));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** 알림 글과 진행(0~100) 을 바꾼다. 같은 알림 번호로 다시 내는 것이 알림을 고치는 정해진 방법이다. */
    static void update(Context ctx, String text, int progress) {
        boolean live;
        synchronized (LOCK) {
            if (text != null && !text.isEmpty()) curText = text;
            curProgress = progress;
            live = running;
        }
        if (!live) return; // 아직 안 켜졌으면 켜질 때 마지막 값으로 알림이 만들어진다
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(ctx));
    }

    static void stop(Context ctx) {
        synchronized (LOCK) {
            running = false;
        }
        ctx.stopService(new Intent(ctx, JobService.class));
    }

    static boolean isRunning() {
        synchronized (LOCK) {
            return running;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel(this);
        Notification n = buildNotification(this);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            synchronized (LOCK) {
                running = true;
            }
        } catch (RuntimeException e) {
            stopSelf(); // 앞쪽 서비스로 못 올라가면 그냥 끝낸다 (일은 계속하되 알림만 없다)
        }
        return START_NOT_STICKY; // 앱이 죽으면 서비스만 되살아나지 않게
    }

    /** 안드로이드 15+: dataSync 서비스가 시간 한도를 넘기면 시스템이 부른다. 바로 끝내야 앱이 강제 종료되지 않는다. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        synchronized (LOCK) {
            running = false;
        }
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, ctx.getString(R.string.job_channel_name), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(ctx.getString(R.string.job_channel_desc));
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    static Notification buildNotification(Context ctx) {
        String title;
        String text;
        int progress;
        synchronized (LOCK) {
            title = curTitle.isEmpty() ? ctx.getString(R.string.job_default_title) : curTitle;
            text = curText.isEmpty() ? ctx.getString(R.string.job_default_text) : curText;
            progress = curProgress;
        }
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_job)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (progress >= 0) b.setProgress(100, Math.min(100, progress), false);
        else if (progress == PROGRESS_UNKNOWN) b.setProgress(0, 0, true);
        return b.build();
    }
}
