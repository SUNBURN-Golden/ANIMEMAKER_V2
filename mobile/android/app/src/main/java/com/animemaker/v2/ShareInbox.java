package com.animemaker.v2;

import android.content.Context;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * 다른 앱에서 '공유' 로 받은 것을 담아 두는 받은 함.
 * - 받은 파일은 cache/shared/&lt;시각&gt;_&lt;이름&gt; 에 복사하고, 목록은 filesDir/inbox.json 에 적어 둔다.
 * - 웹 쪽이 takeInbox 로 가져가 앱 저장소(IndexedDB)에 넣은 뒤 ackInbox 로 알려 줄 때까지 지우지 않는다.
 *   그래서 앱이 꺼진 사이에 공유로 켜져도, 여러 장을 연달아 받아도 잃지 않는다.
 * - 한 줄 = 공유 한 번: { id, receivedAt, items:[{path,name,mime,size}], text, failed? }
 */
final class ShareInbox {
    static final String LIST_FILE = "inbox.json";
    static final String DIR_NAME = "shared";
    /** 웹 쪽이 가져가지 않은 채 이만큼 지난 찌꺼기 파일은 청소한다 */
    private static final long STALE_MS = 24L * 60 * 60 * 1000;

    private final File dir;
    private final File cacheRoot;
    private final AtomicFile listFile;

    ShareInbox(Context ctx) {
        cacheRoot = ctx.getCacheDir();
        dir = new File(cacheRoot, DIR_NAME);
        listFile = new AtomicFile(new File(ctx.getFilesDir(), LIST_FILE));
    }

    /** 아직 웹 쪽이 확인(ack)하지 않은 항목들 */
    synchronized JSONArray list() {
        try {
            String s = new String(listFile.readFully(), StandardCharsets.UTF_8);
            JSONArray a = new JSONObject(s).optJSONArray("entries");
            return a == null ? new JSONArray() : a;
        } catch (IOException | JSONException e) {
            return new JSONArray(); // 파일이 없거나 깨졌으면 빈 함
        }
    }

    synchronized void add(JSONObject entry) throws IOException, JSONException {
        JSONArray all = list();
        all.put(entry);
        save(all);
    }

    /** ids 에 해당하는 항목과 그 캐시 복사본을 지운다. 지운 항목 수를 돌려준다. */
    synchronized int remove(Set<String> ids) throws IOException, JSONException {
        JSONArray all = list();
        JSONArray keep = new JSONArray();
        int removed = 0;
        for (int i = 0; i < all.length(); i++) {
            JSONObject e = all.optJSONObject(i);
            if (e == null) continue;
            if (ids.contains(e.optString("id"))) {
                deleteFilesOf(e);
                removed++;
            } else {
                keep.put(e);
            }
        }
        if (removed > 0) save(keep);
        return removed;
    }

    /** 웹이 가져간 적 없는 오래된 파일과 보내려고 만든 임시 파일을 지운다 (앱을 켤 때 한 번) */
    synchronized void prune() {
        long now = System.currentTimeMillis();
        Set<String> live = new HashSet<>();
        JSONArray all = list();
        for (int i = 0; i < all.length(); i++) {
            JSONObject e = all.optJSONObject(i);
            JSONArray items = e == null ? null : e.optJSONArray("items");
            if (items == null) continue;
            for (int k = 0; k < items.length(); k++) {
                JSONObject it = items.optJSONObject(k);
                if (it != null) live.add(it.optString("path"));
            }
        }
        File[] stale = dir.listFiles();
        if (stale != null) {
            for (File f : stale) {
                if (f.isFile() && !live.contains(f.getAbsolutePath()) && now - f.lastModified() > STALE_MS) f.delete();
            }
        }
        deleteOld(new File(cacheRoot, "am"), now);
    }

    private void deleteOld(File f, long now) {
        File[] kids = f.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory()) {
                deleteOld(k, now);
                String[] left = k.list();
                if (left != null && left.length == 0) k.delete();
            } else if (now - k.lastModified() > STALE_MS) {
                k.delete();
            }
        }
    }

    /** 받은 파일을 담을 새 파일 (같은 밀리초에 같은 이름이 와도 서로 덮어쓰지 않는다) */
    File newFile(String displayName) {
        dir.mkdirs();
        String safe = safeName(displayName);
        File f = new File(dir, System.currentTimeMillis() + "_" + safe);
        int n = 1;
        while (f.exists()) f = new File(dir, System.currentTimeMillis() + "_" + (n++) + "_" + safe);
        return f;
    }

    static String safeName(String name) {
        String s = name == null ? "" : name.replaceAll("[^\\w.\\-가-힣]", "_");
        if (s.length() > 60) { // 파일 이름 길이 한도 때문에 줄인다 (확장자는 남긴다)
            int dot = s.lastIndexOf('.');
            String ext = (dot > 0 && s.length() - dot <= 12) ? s.substring(dot) : "";
            s = s.substring(0, 60 - ext.length()) + ext;
        }
        return s.isEmpty() ? "shared" : s;
    }

    private void deleteFilesOf(JSONObject entry) {
        JSONArray items = entry.optJSONArray("items");
        if (items == null) return;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            File f = new File(it.optString("path"));
            // 받은 함 폴더 안의 파일만 지운다
            if (f.getParentFile() != null && f.getParentFile().equals(dir)) f.delete();
        }
    }

    private void save(JSONArray entries) throws IOException, JSONException {
        FileOutputStream out = listFile.startWrite();
        try {
            out.write(new JSONObject().put("v", 1).put("entries", entries).toString().getBytes(StandardCharsets.UTF_8));
            listFile.finishWrite(out);
        } catch (Throwable t) { // 쓰다 실패하면 반쯤 쓴 임시 파일을 버리고 원래 파일을 그대로 둔다 (그대로 다시 던진다)
            listFile.failWrite(out);
            throw t;
        }
    }
}
