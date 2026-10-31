package app.repostremover;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * เบราว์เซอร์ WebView เต็มจอ: ล็อกอิน TikTok ในแอป แล้วฉีดสคริปต์หน้าลบรีโพสต์
 * (assets/repost-remover.js) เข้าไปในหน้า tiktok.com
 */
public class MainActivity extends Activity {
    private static final String HOME = "https://www.tiktok.com/";

    private WebView web;
    private String script = "";
    private boolean desktopMode = true; // เปิดโหมดคอมเป็นค่าเริ่มต้น
    private Button modeButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // ขณะลบ ต้องเปิดแอปค้างไว้ ไม่ให้จอดับ
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        script = readAsset("repost-remover.js");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(Color.parseColor("#1c1c1c"));
        bar.setGravity(Gravity.CENTER_VERTICAL);

        Button back = makeButton("◀", 1f);
        Button reload = makeButton("↻ รีเฟรช", 2f);
        modeButton = makeButton("โหมดคอม: เปิด", 3f);
        Button tools = makeButton("🧰 ลบรีโพสต์", 3f);
        bar.addView(back);
        bar.addView(reload);
        bar.addView(modeButton);
        bar.addView(tools);
        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        setupWebView();

        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (web.canGoBack()) web.goBack();
            }
        });
        reload.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { web.reload(); }
        });
        modeButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { setDesktopMode(!desktopMode); }
        });
        tools.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openTools(); }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(HOME);
        }
    }

    private Button makeButton(String text, float weight) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12f);
        b.setAllCaps(false);
        b.setPadding(4, 4, 4, 4);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, weight);
        b.setLayoutParams(lp);
        return b;
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        applyUserAgent();

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            /** บล็อกลิงก์ที่ไม่ใช่เว็บ (เช่น snssdk1180://, intent://) ที่ TikTok พยายามเปิดแอป TikTok -> อยู่ในหน้าเดิม */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return blockNonWeb(request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return blockNonWeb(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                if (isTikTok(url)) {
                    view.evaluateJavascript(script, null);
                }
            }
        });

        // ต้องมี WebChromeClient ไม่งั้น confirm()/alert() ของหน้าเว็บจะไม่ทำงาน
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("ตกลง", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface d, int w) { result.confirm(); }
                        })
                        .setNegativeButton("ยกเลิก", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface d, int w) { result.cancel(); }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override public void onCancel(android.content.DialogInterface d) { result.cancel(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("ตกลง", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface d, int w) { result.confirm(); }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override public void onCancel(android.content.DialogInterface d) { result.confirm(); }
                        })
                        .show();
                return true;
            }
        });
    }

    /** UA แบบเบราว์เซอร์ Chrome ปกติ (ตัด "; wv" และ "Version/4.0") ให้ล็อกอินได้ง่ายขึ้น */
    private void applyUserAgent() {
        String ua = WebSettings.getDefaultUserAgent(this)
                .replace("; wv", "")
                .replace("Version/4.0 ", "");
        if (desktopMode) {
            ua = ua.replaceAll("\\(Linux; Android[^)]*\\)", "(X11; Linux x86_64)")
                    .replace("Mobile Safari", "Safari");
        }
        WebSettings s = web.getSettings();
        s.setUserAgentString(ua);
        s.setLoadWithOverviewMode(desktopMode);
        s.setUseWideViewPort(true);
    }

    private void setDesktopMode(boolean on) {
        desktopMode = on;
        modeButton.setText(on ? "โหมดคอม: เปิด" : "โหมดคอม: ปิด");
        applyUserAgent();
        web.reload();
    }

    private void openTools() {
        String url = web.getUrl();
        if (!isTikTok(url)) {
            Toast.makeText(this, "เปิดหน้า TikTok ก่อน แล้วล็อกอิน", Toast.LENGTH_SHORT).show();
            web.loadUrl(HOME);
            return;
        }
        // เผื่อสคริปต์ยังไม่ถูกฉีด (เช่น หน้ายังโหลดไม่เสร็จ) -> ฉีดซ้ำได้ปลอดภัย แล้วค่อยสลับแผง
        web.evaluateJavascript(script, null);
        web.evaluateJavascript("window.__rrToggle && window.__rrToggle()", null);
    }

    private static boolean blockNonWeb(String url) {
        if (url == null) return true;
        String u = url.toLowerCase();
        return !(u.startsWith("http://") || u.startsWith("https://")
                || u.startsWith("about:") || u.startsWith("blob:") || u.startsWith("data:"));
    }

    private static boolean isTikTok(String url) {
        if (url == null) return false;
        try {
            String host = Uri.parse(url).getHost();
            return host != null && (host.equals("tiktok.com") || host.endsWith(".tiktok.com"));
        } catch (Exception e) {
            return false;
        }
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        CookieManager.getInstance().flush();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
