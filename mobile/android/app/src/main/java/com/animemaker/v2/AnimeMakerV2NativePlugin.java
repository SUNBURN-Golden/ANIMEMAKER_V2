package com.animemaker.v2;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 폰 앱 전용 기능 (웹 쪽 이름: AnimeMakerV2Native — src/native.js 의 registerPlugin 이름과 같아야 한다).
 *
 * 메서드
 *   getAppInfo()                          → { versionName, versionCode, sdkInt, webViewVersion }
 *   isInstalled({pkg})                    → { installed }
 *   shareTo({pkg, text, files[]})         → { direct }          AI 앱(또는 공유 창)으로 글과 파일 여러 개 보내기
 *   saveToGallery({path, name})           → { saved, uri, folder } | { saved:false, reason:'old-android' }
 *   keepAwake({on})                       화면 꺼짐 막기
 *   takeInbox()                           → { entries:[{ id, receivedAt, items:[{path,name,mime,size}], text, failed? }] }
 *   ackInbox({ids})                       → { removed }         웹이 가져간(앱 저장소에 넣은) 받은 함 항목 지우기
 *   startJobService({title, text})        → { started, notifications }
 *   updateJobService({text, progress})    progress 0~100, 생략하면 빙글빙글
 *   stopJobService()
 *   requestNotificationPermission()       → { granted }
 * 이벤트
 *   shared  — 공유로 새로 받으면 받은 함 항목 하나({ id, receivedAt, items, text }) 를 보낸다.
 *             웹이 아직 준비 전이어도 항목은 inbox.json 에 남아 있으니 시작할 때 takeInbox() 로 받아 가면 된다.
 */
@CapacitorPlugin(
        name = "AnimeMakerV2Native",
        permissions = {
                @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")
        }
)
public class AnimeMakerV2NativePlugin extends Plugin {

    /** 한 번에 받는 파일 수 상한 (이상한 앱이 수천 개를 보내도 버티게) */
    private static final int MAX_ITEMS = 64;
    private static final String GALLERY_NAME = "AnimeMaker V2";

    private ShareInbox inbox;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        inbox = new ShareInbox(getContext());
        io.execute(() -> {
            try {
                inbox.prune();
            } catch (RuntimeException ignored) {
                // 청소는 못 해도 괜찮다
            }
        });
        Intent intent = getActivity().getIntent();
        if (intent != null) handleShareIntent(intent);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleShareIntent(intent);
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdown(); // 하던 복사는 마저 끝낸다
        super.handleOnDestroy();
    }

    // ───────────────────────── 앱 정보 ─────────────────────────

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            ret.put("versionName", pi.versionName == null ? "" : pi.versionName);
            ret.put("versionCode", PackageInfoCompat.getLongVersionCode(pi));
        } catch (PackageManager.NameNotFoundException e) {
            ret.put("versionName", "");
            ret.put("versionCode", 0);
        }
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("webViewVersion", webViewVersion());
        call.resolve(ret);
    }

    private String webViewVersion() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PackageInfo wv = WebView.getCurrentWebViewPackage();
                if (wv != null && wv.versionName != null) return wv.versionName;
            }
        } catch (RuntimeException ignored) {
            // 모르면 빈 글. 웹 쪽이 UserAgent 에서 읽는다
        }
        return "";
    }

    @PluginMethod
    public void isInstalled(PluginCall call) {
        String pkg = call.getString("pkg", "");
        JSObject ret = new JSObject();
        ret.put("installed", installed(pkg));
        call.resolve(ret);
    }

    // ───────────────────────── 받은 함 (공유로 들어온 것) ─────────────────────────

    /** 다른 앱에서 공유로 들어온 내용을 (화면을 막지 않고) 캐시 폴더에 복사해 받은 함에 적고 웹 쪽에 알린다 */
    private void handleShareIntent(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        // 최근 앱 목록에서 앱을 다시 열면 처음 받았던 공유 intent 가 또 오는데, 이미 받은 것이니 무시한다
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;

        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (u != null) uris.add(u);
        } else {
            ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null) uris.addAll(list);
        }
        CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = cs == null ? "" : cs.toString();
        ClipData clip = intent.getClipData();
        if (clip != null) { // EXTRA_STREAM 없이 ClipData 로만 보내는 앱도 있다
            for (int i = 0; i < clip.getItemCount(); i++) {
                ClipData.Item item = clip.getItemAt(i);
                Uri u = item.getUri();
                if (u != null && !uris.contains(u)) uris.add(u);
                if (text.isEmpty() && item.getText() != null) text = item.getText().toString();
            }
        }
        final String finalText = text;
        // 같은 공유를 두 번 처리하지 않도록 비운다
        getActivity().setIntent(new Intent());
        if (uris.isEmpty() && finalText.isEmpty()) return;

        try {
            io.execute(() -> receive(uris, finalText));
        } catch (RuntimeException e) {
            // 앱이 닫히는 중이라 일꾼이 없다
        }
    }

    /** (일꾼 스레드) 파일을 복사해서 받은 함에 적는다 */
    private void receive(List<Uri> uris, String text) {
        ContentResolver cr = getContext().getContentResolver();
        JSONArray items = new JSONArray();
        int failed = 0;
        for (Uri u : uris) {
            if (items.length() >= MAX_ITEMS) {
                failed++;
                continue;
            }
            File out = null;
            try {
                String name = displayName(u);
                String mime = cr.getType(u);
                if (mime == null || mime.isEmpty()) mime = guessMime(name);
                out = inbox.newFile(name);
                try (InputStream in = cr.openInputStream(u); OutputStream os = new FileOutputStream(out)) {
                    if (in == null) throw new IOException("열 수 없는 파일");
                    copy(in, os);
                }
                items.put(new JSONObject()
                        .put("path", out.getAbsolutePath())
                        .put("name", name)
                        .put("mime", mime)
                        .put("size", out.length()));
            } catch (IOException | JSONException | RuntimeException e) {
                failed++; // 읽을 수 없는 항목은 건너뛰되, 웹 쪽이 알 수 있게 센다
                if (out != null) out.delete();
            }
        }
        if (items.length() == 0 && text.isEmpty() && failed == 0) return;
        try {
            JSONObject entry = new JSONObject()
                    .put("id", UUID.randomUUID().toString())
                    .put("receivedAt", System.currentTimeMillis())
                    .put("items", items)
                    .put("text", text);
            if (failed > 0) entry.put("failed", failed);
            inbox.add(entry);
            notifyListeners("shared", new JSObject(entry.toString()));
        } catch (IOException | JSONException e) {
            // 받은 함에 적지 못하면 지금 복사한 파일은 고아가 되니 지운다
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it != null) new File(it.optString("path")).delete();
            }
        }
    }

    /** 아직 웹이 확인하지 않은 받은 함 항목 전부 (앱이 꺼져 있다가 공유로 켜졌을 때도 여기서 받는다) */
    @PluginMethod
    public void takeInbox(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("entries", new JSArray(inbox.list().toString()));
            call.resolve(ret);
        } catch (JSONException e) {
            call.reject("받은 함을 읽지 못했어요", e);
        }
    }

    /** 웹이 앱 저장소에 넣은 항목을 받은 함에서 지운다 (캐시에 복사해 둔 파일도 함께) */
    @PluginMethod
    public void ackInbox(PluginCall call) {
        try {
            Set<String> ids = new HashSet<>();
            JSArray arr = call.getArray("ids", new JSArray());
            for (int i = 0; i < arr.length(); i++) ids.add(arr.getString(i));
            int removed = ids.isEmpty() ? 0 : inbox.remove(ids);
            JSObject ret = new JSObject();
            ret.put("removed", removed);
            call.resolve(ret);
        } catch (JSONException | IOException e) {
            call.reject("받은 함을 정리하지 못했어요", e);
        }
    }

    // ───────────────────────── 보내기 ─────────────────────────

    /** AI 앱으로 글(프롬프트)과 파일(참고 그림 등, 여러 개 가능)을 보낸다. 앱이 없으면 '공유' 창을 연다. */
    @PluginMethod
    public void shareTo(PluginCall call) {
        String pkg = call.getString("pkg", "");
        String text = call.getString("text", "");
        JSArray files = call.getArray("files", new JSArray());
        try {
            Context ctx = getContext();
            ArrayList<Uri> uris = new ArrayList<>();
            String type = null;
            for (int i = 0; i < files.length(); i++) {
                File f = new File(files.getString(i));
                if (!f.exists()) continue;
                uris.add(FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f));
                String m = guessMime(f.getName());
                type = type == null ? m : (type.equals(m) ? type : "*/*");
            }
            Intent send;
            if (uris.size() > 1) {
                send = new Intent(Intent.ACTION_SEND_MULTIPLE);
                send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            } else {
                send = new Intent(Intent.ACTION_SEND);
                if (uris.size() == 1) send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            }
            send.setType(type == null ? "text/plain" : type);
            if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
            if (!uris.isEmpty()) {
                ClipData clip = ClipData.newRawUri("", uris.get(0));
                for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                send.setClipData(clip);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            boolean direct = !pkg.isEmpty() && installed(pkg);
            JSObject ret = new JSObject();
            if (direct) {
                send.setPackage(pkg);
                try {
                    getActivity().startActivity(send);
                    ret.put("direct", true);
                    call.resolve(ret);
                    return;
                } catch (ActivityNotFoundException e) {
                    send.setPackage(null);
                }
            }
            getActivity().startActivity(Intent.createChooser(send, ctx.getString(R.string.chooser_title)));
            ret.put("direct", false);
            call.resolve(ret);
        } catch (JSONException e) {
            call.reject("파일 목록을 읽지 못했어요", e);
        } catch (IllegalArgumentException e) {
            call.reject("보낼 수 없는 위치의 파일이에요", e);
        } catch (RuntimeException e) {
            call.reject("다른 앱으로 보내지 못했어요: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /** 캐시에 있는 영상/그림 파일을 갤러리(동영상/AnimeMaker V2 또는 사진/AnimeMaker V2)에 저장 */
    @PluginMethod
    public void saveToGallery(PluginCall call) {
        String path = call.getString("path", "");
        String name = call.getString("name", "AnimeMaker-V2.mp4");
        File src = new File(path);
        if (!src.exists()) {
            call.reject("저장할 파일이 없어요");
            return;
        }
        String mime = guessMime(name);
        boolean video = mime.startsWith("video/");
        if (!video && !mime.startsWith("image/")) {
            call.reject("갤러리에는 영상이나 그림만 저장할 수 있어요");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // 안드로이드 9 이하는 '공유' 로 저장하도록 웹 쪽에서 안내한다
            JSObject ret = new JSObject();
            ret.put("saved", false);
            ret.put("reason", "old-android");
            call.resolve(ret);
            return;
        }
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, (video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/" + GALLERY_NAME);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri collection = video
                ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri item = null;
        try {
            item = cr.insert(collection, v);
            if (item == null) throw new IllegalStateException("insert failed");
            try (InputStream in = new FileInputStream(src); OutputStream os = cr.openOutputStream(item)) {
                if (os == null) throw new IOException("출력 열기 실패");
                copy(in, os);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(item, done, null, null);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("uri", item.toString());
            ret.put("folder", (video ? "동영상" : "사진") + "/" + GALLERY_NAME);
            call.resolve(ret);
        } catch (IOException | RuntimeException e) {
            if (item != null) {
                try {
                    cr.delete(item, null, null);
                } catch (RuntimeException ignored) {
                    // 정리 실패는 무시
                }
            }
            call.reject("갤러리에 저장하지 못했어요: " + e.getMessage(), e);
        }
    }

    // ───────────────────────── 오래 걸리는 일 (앞쪽 서비스) ─────────────────────────

    @PluginMethod
    public void startJobService(PluginCall call) {
        Context ctx = getContext();
        String title = call.getString("title", ctx.getString(R.string.job_default_title));
        String text = call.getString("text", ctx.getString(R.string.job_default_text));
        boolean started = JobService.start(ctx, title, text);
        JSObject ret = new JSObject();
        ret.put("started", started);
        ret.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        call.resolve(ret);
    }

    @PluginMethod
    public void updateJobService(PluginCall call) {
        Double p = call.getDouble("progress");
        int progress = p == null ? JobService.PROGRESS_UNKNOWN : (int) Math.round(Math.max(0, Math.min(100, p)));
        JobService.update(getContext(), call.getString("text", ""), progress);
        call.resolve();
    }

    @PluginMethod
    public void stopJobService(PluginCall call) {
        JobService.stop(getContext());
        call.resolve();
    }

    /** 안드로이드 13+ 에서 알림을 보여 줘도 되는지 묻는다 (이전 버전은 알림이 꺼져 있는지만 본다). 거절해도 서비스는 돈다. */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject ret = new JSObject();
            ret.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
            call.resolve(ret);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    // ───────────────────────── 도우미 ─────────────────────────

    private boolean installed(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private String displayName(Uri u) {
        String name = null;
        try (Cursor c = getContext().getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (RuntimeException ignored) {
            // 이름을 못 읽으면 주소 끝부분을 쓴다
        }
        if (name == null) name = u.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "shared";
        return name;
    }

    private static String guessMime(String name) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(name.replace(" ", "_"));
        String m = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase(Locale.ROOT));
        return m == null ? "application/octet-stream" : m;
    }

    private static void copy(InputStream in, OutputStream os) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
    }
}
