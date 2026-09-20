# Qoder Persian RTL — راست‌چین‌سازی چت Qoder برای فارسی و عربی

دو روش برای اضافه کردن راست‌چینی، فونت **وزیرمتن** آفلاین و مدیریت صحیح متن دوجهته به محیط چت **Qoder** (اپ Electron مستقل، نه بر پایه VS Code):

| روش | چه می‌کند | وضعیت روی Qoder 0.3.3 |
|---|---|---|
| **`live.js` — تزریق زنده با CDP** (پیش‌فرض) | هیچ فایل نصب را تغییر نمی‌دهد؛ پچ فقط داخل پروسهٔ در حال اجرا تزریق می‌شود | ✅ کار می‌کند |
| `index.js` — پچ `app.asar` | سه فایل داخل آرشیو می‌نویسد (بکاپ + بازگردانی دارد) | ❌ روی این نصب Qoder بالا نمی‌آید (دلیلش پایین) |

## چرا «پچر» و نه «افزونه»؟

Qoder یک اپ Electron مستقل است؛ چت داخل همان renderer اصلی رندر می‌شود و سیستم پلاگین‌ها فقط `views` جدا و sandboxed می‌دهد که به DOM چت دسترسی ندارند. پس تزریق باید یا داخل خود renderer انجام شود (asar) یا از بیرون با پروتکل DevTools (CDP).

## روش ۱ — تزریق زنده (بدون دست‌زدن به نصب)

```bash
cd qoder-persian-rtl
npm install                      # فقط @electron/asar

node live.js --launcher          # فایل Qoder-RTL.cmd را همین‌جا کنار live.js می‌سازد
```

سپس **همهٔ پنجره‌های Qoder را کامل ببندید** (آیکون سینی هم) و آن `.cmd` را اجرا کنید: Qoder را با پورت دیباگ باز می‌کند و اینجکتور را در یک پنجرهٔ کنسول جدا بالا می‌آورد. چند ثانیه بعد چت راست‌چین است و دکمهٔ «ا» + **Alt+R** کار می‌کند. کنسول «Qoder RTL injector» باید باز بماند (Ctrl+C = قطع پچ).

بدون شورتکات، دستی:

```bash
node live.js --start --check     # Qoder بسته‌شده باشد: خودش با پورت باز می‌کند و نتیجه را می‌سنجد
node live.js                     # اتصال به Qoder در حال اجرا (پورت 9222) و پچ پنجره‌ها
node live.js --check             # فقط بررسی و نوشتن گزارش در cdp-test.log
node live.js --list              # پنجره‌هایی که CDP می‌بیند
```

| گزینه | معنا |
|---|---|
| `--port <n>` | پورت DevTools (پیش‌فرض `9222`) |
| `--wait <s>` | چند ثانیه منتظر باز شدن پورت بماند (پیش‌فرض ۳۰) |
| `--check` | تزریق + سنجش + خروج؛ نتیجه در `%LOCALAPPDATA%\qoder-persian-rtl\cdp-test.log` |
| `--start` | راه‌اندازی Qoder با `--remote-debugging-port` (نیاز به بستن کامل Qoder) |
| `--launcher` | ساخت `Qoder-RTL.cmd` هم کنار `live.js` و هم در `%LOCALAPPDATA%\qoder-persian-rtl` (پوشه AppData در ویندوز مخفی است) |
| `--list` / `-v` | نمایش targetها / گفت‌وگوی تفصیلی |

خروجی `--check` شش سطر PASS/FAIL می‌دهد: دیدن پنجره‌ها، تزریق `window.__QODER_RTL__`، نصب استایل inline، بارگذاری فونت، دیدن قلاب‌های چت (`[data-chat-*]`) و فعال بودن پچ روی ریشهٔ سند.

**چرا در روش CDP فونت به‌صورت `data:` است؟** CSP کیو‌در `font-src 'self' data:` است و هیچ فایلی روی دیسک گذاشته نمی‌شود، پس وزیرمتن داخل همان استایل inline می‌آید (~۱۵۰KB). اسکریپت تزریق‌شده از CSP معاف است، ولی کد داخلش `eval`/`new Function` ندارد تا با `script-src 'self'` هم سازگار بماند.

### نکتهٔ امنیتی

`--remote-debugging-port` یک endpoint محلی باز می‌کند که هر پروسهٔ در حال اجرای همان کاربر می‌تواند آن را کنترل کند. پورت فقط روی `127.0.0.1` است و با بستن Qoder بسته می‌شود، اما روی سیستم مشترک/سازمانی این را روشن نگذارید و در انتهای کار پرچم را بردارید (اجرای معمولی Qoder از شورتکات خود برنامه).

## روش ۲ — پچ `app.asar` (برای نصب‌هایی که asar-integrity ندارند)

```bash
node index.js --status           # مسیر نصب، نسخه، وضعیت پچ
node index.js --verify           # archive پچ‌شده را در Temp می‌سازد و اعتبارسنجی می‌کند؛ نصب دست‌نخورده
node index.js                    # اعمال پچ (UAC می‌خواهد)
node index.js --restore          # بازگردانی آخرین archive اصلی
```

روی Qoder 0.3.3 ویندوز این روش باعث می‌شود **Qoder اصلاً باز نشود** و باید `--restore` بزنید. دلیل (با شواهد تأیید شده):

- fuse مربوطه در `Qoder.exe` روشن است: `EnableEmbeddedAsarIntegrityValidation = 1`
- یک منبع PE با نوع `#1033` و نام `ELECTRONASAR` مقدار SHA256 هدرِ `app.asar` را پین کرده است؛ هر تغییر در هدر ⇒ الکترون در bootstrap رد می‌کند (بدون لاگ، بدون Event Log).
- هر ۴۴۹۸ عضو آرشیو هم `integrity`per-file دارند، پس جابه‌جایی بایت‌ها هم قابل تشخیص است.

نتیجه: تا وقتی امضا/هش پین‌شده در `Qoder.exe` دست نخورده باشد (که در این پروژه **انجام نمی‌شود**؛ امضای Authenticode را می‌شکند)، روش CDP تنها راه سالم است. کد asar برای نصب‌هایی که این fuse را ندارند نگه داشته شده و همچنان تست می‌شود.

## چه کاری انجام می‌دهد (هر دو روش)

- **فقط محتوای چت و کادر ورودی** راست‌چین می‌شود؛ نوار کناری، تب‌ها و پنل‌ها LTR می‌مانند (`<html dir="ltr">` قفل است).
- **جداسازی دوجهته:** `unicode-bidi: plaintext` برای متن؛ `pre/code`، Monaco/CodeMirror، ترمینال و مسیر فایل‌ها همیشه LTR و ایزوله.
- **تشخیص هوشمند:** شمارش نویسهٔ فارسی-عربی در برابر لاتین برای هر پاراگراف/لیست/تیتر → `.qrt-fa` یا `.qrt-en` (حالت `smart`؛ حالت `force` همه را راست‌چین می‌کند).
- **فونت وزیرمتن متغیر و آفلاین**؛ هیچ درخواست شبکه‌ای انجام نمی‌شود و CSP دست‌نخورده می‌ماند.
- **پنل شناور:** دکمهٔ «ا» و کلید **Alt+R**؛ اندازهٔ متن چت/کد، ارتفاع خط، راست‌چین کردن جدول‌ها و ستون‌ها، فونت لاتین، و اصلاح کلید `@` روی کیبورد فارسی.
- تنظیمات در `localStorage` کلید `qoder_persian_rtl_config_v1` ذخیره می‌شود (در روش CDP داخل همان profile می‌ماند).

## تست‌ها

```bash
npm test                 # تزریق HTML + ساختار payload CDP + ممیزی archive پچ‌شده (هیچ‌کدام نصب را تغییر نمی‌دهند)
npm run test:browser     # End-to-end روش CDP روی یک Chromium واقعی (Edge/Chrome headless، پروفایل موقت)
```

تست مرورگر یک صفحهٔ نمونه (`test/fixtures/chat.html`) با DOM مشابه چت Qoder باز می‌کند و همان `live.js --check` را روی آن اجرا می‌کند؛ فقط مرزهای پروتکل و payload سنجیده می‌شود، نه خود Qoder.

## نصب و آپدیت Qoder

روش CDP چیزی در نصب نمی‌نویسد، پس **آپدیت خودکار Qoder پچ را پاک نمی‌کند** — فقط برای هر بار اجرای Qoder باید `Qoder-RTL.cmd` را اجرا کنید (یا `node live.js` را بعد از باز شدن برنامه). اگر خواستید حذفش کنید: همان `.cmd` را پاک کنید؛ هیچ اثری روی فایل‌های برنامه نیست.

## طرز کار فنی روش CDP

1. اتصال به `http://127.0.0.1:<port>/json/version` و باز کردن WebSocketِ مرورگر.
2. `Target.setAutoAttach` + `Target.getTargets` ⇒ هر target صفحه‌ای (پنجرهٔ Qoder) یک session می‌گیرد.
3. برای هر session: `Page.addScriptToEvaluateOnNewDocument` (قبل از اسکریپت‌های خود صفحه و معاف از CSP) و یک `Runtime.evaluate` فوری برای سندِ باز شده.
4. source تزریقى = پریامبل استایل inline با فونت `data:` + بدنهٔ `patches/rtl.js` (همان فایل روش asar).
5. پروب `--check` از همان صفحه: نسخه، وجود `<style data-qoder-rtl>`، `document.fonts.check("Vazirmatn QRT")` و شمارش قلاب‌های چت.

## مجوز فونت

وزیرمتن محصول پروژهٔ Vazirmatn است (rastikerdar) و تحت SIL OFL منتشر شده — `assets/vazirmatn-variable.woff2` و `assets/OFL.txt`.

---

# English

Two ways to add Persian/Arabic RTL, an **offline Vazirmatn** font and correct bidi handling to the Qoder desktop chat:

- **`live.js` (recommended)** — injects the patch into the running Electron renderer over the DevTools protocol. No install file is modified, nothing breaks on update, and Qoder 0.3.3 accepts it.
- **`index.js`** — rewrites `app.asar` (with backup and `--restore`). On this Qoder build the app then **refuses to start**, because `EnableEmbeddedAsarIntegrityValidation` is on and `Qoder.exe` carries an `ELECTRONASAR` resource pinning the SHA256 of the archive header. Kept only for builds without that fuse; the signed binary is never touched.

**Scope (both routes):** chat messages and composer only — app chrome stays LTR (`<html dir="ltr">` pinned). Code, editors, terminals and file paths stay LTR and bidi-isolated; direction is detected per block; `Alt+R` toggles; the «ا» button opens a floating settings panel. In the CDP route the font is inlined as a `data:` URI because nothing is written to disk (CSP allows `font-src 'self' data:`), and the injected script uses no `eval`, so it stays compatible with `script-src 'self'`.

**Use:** `node live.js --launcher` → quit Qoder completely → run `Qoder-RTL.cmd`. Audit with `node live.js --check` (six PASS/FAIL lines, logged to `%LOCALAPPDATA%\qoder-persian-rtl\cdp-test.log`). Keep the injector console open; closing it (or Qoder) removes the patch.

**Security caveat:** running Qoder with `--remote-debugging-port` opens a loopback debugging endpoint that any local process can drive. It is closed with the app; don't leave it on shared machines.

**Tests:** `npm test` (offline: HTML injection, CDP payload shape, staged-archive audit) and `npm run test:browser` (end-to-end CDP injection against headless Edge/Chrome on a throwaway profile). Neither writes to the Qoder install.

MIT. Vazirmatn is under the SIL Open Font License (see `assets/OFL.txt`).
