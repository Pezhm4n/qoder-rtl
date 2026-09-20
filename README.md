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
| `--diagnose` | فقط‌خواندنی: گزارش وضعیت واقعی هر پنجره (فونت محاسبه‌شده، CSP، مستطیل `.qrt-widget`) در `cdp-diagnose.log`؛ بدون تزریق |
| `--start` | راه‌اندازی Qoder با `--remote-debugging-port` (نیاز به بستن کامل Qoder) |
| `--launcher` | ساخت `Qoder-RTL.cmd` هم کنار `live.js` و هم در `%LOCALAPPDATA%\qoder-persian-rtl` (پوشه AppData در ویندوز مخفی است) |
| `--list` / `-v` | نمایش targetها / گفت‌وگوی تفصیلی |

خروجی `--check` دوازده سطر PASS/FAIL می‌دهد: دیدن پنجره‌ها، پاسخ پروب‌ها، تزریق `window.__QODER_RTL__`، نصب استایل inline، **ثبت فونت وزیرمتن از بایت‌های inline**، قابل استفاده شدن فونت، رسیدن `font-family` به خودِ پاراگراف‌های چت، **برابر بودن `line-height` محاسبه‌شده با مقدار پنل**، **تأثیر واقعی دو اسلایدر فاصلهٔ خطوط و اندازهٔ متن**، دیدن قلاب‌های چت (`[data-chat-*]`)، فعال بودن پچ روی ریشهٔ سند و **نمایش پنل تنظیمات در پایینِ راست** (فاصله‌اش از لبه‌ها و اینکه روی هیچ دکمهٔ fixed خودِ Qoder نیفتاده باشد). سطری که پروبش جواب ندهد `UNSURE` است نه FAIL؛ سطر پنل فقط روی پنجره‌ای داوری می‌شود که واقعاً چت دارد، تا یک پنجرهٔ خالیِ همزمان نتواند سبزش کند. برای هر سطر FAIL یک راهنمایی هم چاپ می‌شود.

سطر «تأثیر واقعی اسلایدرها» یک سنجش **کارکردی** است: پروب از بیرون، `lineHeight` و `chatSize` را موقتاً روی `2.15` و `6` می‌برد، ارتفاع خط و `zoom` محاسبه‌شدهٔ همان پاراگراف را دوباره می‌خواند، و بعد مقدارهای خودِ شما را برمی‌گرداند (همان `apply()` که پنل صدا می‌زند؛ نتیجه در خروجی با کلید `settled` است و اگر برنگشت، سطر عبارت `config NOT restored` را نشان می‌دهد). یعنی اگر اسلایدری فقط ظاهرش تغییر کند و به متن نرسد، این سطر قرمز می‌شود.

**چرا اسلایدرها اول کار نمی‌کردند؟** Qoder روی خودِ عنصرِ متن کلاس‌های utility می‌گذارد — نمونهٔ واقعی از `--diagnose`: `p.my-0.text-sm.leading-6.text-text` — و `font-family` را هم روی `.markdown-body` ست می‌کند. قانون فقط روی کانتینر ⇒ هیچ‌وقت به `<p>` نمی‌رسید. پس در `rtl.css` سه چیز روی خودِ عناصر متن تکرار شده‌اند: `font-family: var(--qrt-stack) !important` (نه `inherit`، چون inherit مقدار `.markdown-body` را می‌گرفت)، `line-height: var(--qrt-leading) !important` برای بدنهٔ متن، و برای اندازهٔ متن به‌جای دست‌زدن به `font-size` هر عنصر، `zoom: var(--qrt-zoom)` روی کانتینر (`1 + chatSize/16`) — این‌طور اندازه‌های نسبی (تیترها، ریزنوشته‌ها) حفظ می‌شوند و با `text-sm` می‌جنگند. تیترها از قانون `line-height` مستثنا هستند تا سلسله‌مراتبشان نشکند.

**دو نقص دیگر که فقط روی Qoder واقعی دیده می‌شدند.** اول: `--check` در اجرای اول همان stylesheet قدیمی (۱٫۱٫۰) را نشان می‌داد — پریامبل CSS وقتی `<style data-qoder-rtl>` را می‌دید از ساختن دوباره صرف‌نظر می‌کرد، پس اجرای مجدد injector روی سندِ باز، کد JS را بالا می‌آورد ولی CSS را نه. حالا اگر برگه موجود باشد `textContent` همان گره بازنویسی می‌شود (تست مرورگر این مسیر را با اجرای دومِ `--check` می‌سنجد: باید دقیقاً یک `<style>` بماند و همهٔ سطرها سبز). دوم: خود Qoder برای تنظیم «اندازهٔ متن چت» قانونی با `!important` و انتخابگرِ چهارطبقه دارد — `html[data-font-size="small"] … .markdown-body p { line-height:24px !important }` — که با هر stylesheet تزریق‌شده‌ای می‌برد. راه‌حلِ منطقی رقابتِ specificity نبود: runtime مقدار `line-height … !important` را روی خودِ عناصر متن می‌زند (inline برندهٔ author !important است، هر چند specificity چقدر باشد) و صفت `data-qrt-lead` نگهبان بی‌اثر شدن دوباره است؛ با `off` شدن RTL یا `dispose()` همهٔ مهرها پاک می‌شوند. این قانونِ Qoder در fixture هم کپی شده تا اگر مهر زدن حذف شد، تست هدلس قرمز شود.

**جای دکمهٔ «ا»:** گوشهٔ پایین-راهمِ پنجره از قبل اشغال بود — Qoder یک دکمهٔ کمک دایره‌ای ۲۸پیکسلی با `bottom-4.5 right-4.5` (۱۸px از هر لبه) دارد. چون z-index ما حداکثری است، تریگر روی آن می‌افتاد و کلیکِ دکمهٔ کمک را می‌بلید؛ حالا `right:52px` است. پروب به‌جای اعتماد به این عدد، مستقیماً تقاطع مستطیل تریگر را با هر عنصر fixed دیگرِ صفحه می‌شمارد (`cornerClash`) و اگر غیرصفر باشد همان سطر FAIL می‌شود — fixture هم یک دکمهٔ کمکِ ساختگی با همان هندسه دارد، پس برگرداندن آفست به ۱۴px در تست خودکار گرفته می‌شود.

**چرا در روش CDP فونت با `FontFace` ثبت می‌شود نه با `url(data:)`؟** هیچ فایلی روی دیسک گذاشته نمی‌شود، پس بایت‌های وزیرمتن (~۱۱۱KB) داخل خود payload می‌آیند. اگر آن را به‌صورت `@font-face{src:url(data:…)}` بگذاریم، یک `font-src` سخت‌گیرانه (بدون `data:`) آن را رد می‌کند — این را روی Chromium تست کردیم: با `font-src 'self'` نتیجه `NetworkError` و `status=error` شد. صورتِ ثبت‌شده با `new FontFace(family, Uint8Array)` و `document.fonts.add()` هیچ fetchی انجام نمی‌دهد، پس `font-src` اصلاً دخالت نمی‌کند؛ همان تست در همان صفحه با همان CSP سبز شد. کد `@font-face{src:url(data:…)}` فقط به‌عنوان fallback برای موتور بدون `FontFace` در زمان اجرا ساخته می‌شود. اسکریپت تزریق‌شده از CSP معاف است، ولی داخلش `eval`/`new Function` نیست تا با `script-src 'self'` هم سازگار بماند.

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
- **حالت ریشه روی `data-qrt-*`:** استایل‌های اپ روی `<html class="…">` می‌نویسند و احتمال بازنویسی آن توسط رندرر هست، پس برای اینکه پچ هرگز بی‌صدا خاموش نشود CSS کلیدِ انتخابگرهایش را با صفت‌های `data-qrt-mode|tables|reverse` می‌خواند (کلاس‌های `qrt-*` فقط برای دیباگ آینه می‌شوند) و payload در هر تغییر DOM و هر ۴ ثانیه drift را بررسی و درست می‌کند. صفحهٔ تست این سناریو را فرض می‌کند: هر ۵۰۰ms کلاس‌های `<html>` را پاک می‌کند و انتظار دارد پچ سبز بماند.
- **پنل شناور پایینِ راست:** دکمهٔ «ا» در گوشهٔ پایین-راهمِ پنجره (کنار کادر ورودی، زیر انگشت شست)، `52px` از لبهٔ راست تا روی دکمهٔ کمکِ خودِ Qoder نیفتد، و پنل به سمت بالا باز می‌شود تا روی پاسخِ در حال خواندن نیفتد؛ کلید **Alt+R** (جهت) و **Alt+Shift+R** (نمایش/پنهان‌کردن خود دکمه؛ حالت پنهان فقط در localStorage است و بدون این کلید راه بازگشت ندارد). گزینه‌ها: اندازهٔ متن چت (با `zoom`، پس تیترها نسبی می‌مانند)، اندازهٔ فونت کد، فاصلهٔ خطوط، راست‌چین کردن جدول‌ها و برعکس‌کردن ستون‌ها، فونت فارسی/لاتین/کد، و اصلاح کلید `@` روی کیبورد فارسی.
- تنظیمات در `localStorage` کلید `qoder_persian_rtl_config_v1` ذخیره می‌شود (در روش CDP داخل همان profile می‌ماند).

## تست‌ها

```bash
npm test                 # تزریق HTML + ساختار payload CDP + ممیزی archive پچ‌شده (هیچ‌کدام نصب را تغییر نمی‌دهند)
npm run test:browser     # End-to-end روش CDP روی یک Chromium واقعی (Edge/Chrome headless، پروفایل موقت)
```

تست مرورگر یک صفحهٔ نمونه (`test/fixtures/chat.html`) با DOM مشابه چت Qoder باز می‌کند و همان `live.js --check` را روی آن اجرا می‌کند؛ فقط مرزهای پروتکل و payload سنجیده می‌شود، نه خود Qoder. آن صفحه چهار چیز را عمداً سخت‌گیرانه کرده تا نقص‌های پیدا‌شده روی Qoder واقعی محکم بازتولید شوند: CSP با `font-src 'self'` (فونت `data:` رد می‌شود)، پاک‌کردن هر ۵۰۰ms کلاس‌های `<html>`، کلاس‌های واقعیِ خود Qoder روی پاراگراف (`my-0 text-sm leading-6 text-text` + فونت روی `.markdown-body`) به‌همراه همان قانون `line-height:24px !important` که «اندازهٔ متن چت» را قفل می‌کند، و یک دکمهٔ کمکِ ساختگی در گوشهٔ پایین-راهم با همان هندسهٔ دکمهٔ واقعی (۲۸px، ۱۸px از هر لبه) تا تداخلِ جای پنل گرفته شود.

**چه چیزی کجا تأیید شده:** روی Qoder واقعی با payload ۱٫۱٫۰ (۲۰۲۶-۰۹-۲۰): پورت دیباگ باز شد، پچ به هر دو پنجره رسید، متن راست‌چین شد، **فونت وزیرمتن اعمال شد و پنل باز شد**، و ۹/۱۰ سطر سبز بودند؛ سطر قرمز همان اجرا «chat prose computes to the Vazirmatn stack (system-ui)» بود — یعنی فونت ثبت شده بود ولی به خودِ `<p>` نمی‌رسید، و به همان دلیل دو اسلایدر فاصلهٔ خطوط و اندازهٔ متن بی‌اثر بودند.

**بازتأیید همان روز با payload ۱٫۲٫۲ روی Qoder واقعی: ۱۲/۱۲ سطر سبز** — `prose → "Vazirmatn QRT"`، `lineHeight 23.4px = 1.8` روی متن ۱۳پیکسلی (مقدار پنل)، پروب اسلایدرها `23.4→27.95px` و `zoom 1→1.375` و برگشت به مقدار کاربر، و پنل `14px` از پایین / `52px` از راست با `cornerClash n=0` (دکمهٔ کمکِ خودِ برنامه دیگر زیرش نیست). همان‌جا دو نقصِ دیگر هم رفع شد: بازنویسی inline stylesheet هنگام تزریق دوباره (قبلاً CSS قدیمی روی سندِ باز می‌ماند) و مهرِ inline روی `line-height` برای بردن قانون `!important` خودِ Qoder. چیزی که هنوز روی Qoder واقعی تأیید نشده: عمرِ پچ بعد از self-restart دیده‌شده (≈۸ ثانیه بعد از اتصال، پورت می‌میرد) و پنجرهٔ دومِ خالی که پروبش همیشه timeout می‌دهد.

## نصب و آپدیت Qoder

روش CDP چیزی در نصب نمی‌نویسد، پس **آپدیت خودکار Qoder پچ را پاک نمی‌کند** — فقط برای هر بار اجرای Qoder باید `Qoder-RTL.cmd` را اجرا کنید (یا `node live.js` را بعد از باز شدن برنامه). اگر خواستید حذفش کنید: همان `.cmd` را پاک کنید؛ هیچ اثری روی فایل‌های برنامه نیست.

**هر بار Qoder بدون `--remote-debugging-port` بالا بیاید، پچ از بین می‌رود.** این فقط دربارهٔ اجرای بعدی نیست: در تست ۲۰۲۶-۰۹-۲۰ حدود ۸ ثانیه بعد از اتصال، پورت ۹۲۲۲ دیگر گوش نمی‌داد و پروسه‌های جدید Qoder بدون آن پرچم در خط فرمان دیده شدند (هیچ فایل `DevToolsActivePort` هم ساخته نشده بود). این‌ها با هم نشانهٔ self-restart هستند و باید در اجرای بعدی دوباره تأیید شوند؛ اما نتیجهٔ عملی روشن است: روی این نصب پچ عمر کوتاه دارد و `node live.js` مقیم هم همان‌جا قطع می‌شود. تا وقتی علت قطعی معلوم شده، انتظار پچ دائمی نداشته باشید و در صورت تکرار، بعد از هر بالا آمدن Qoder دوباره `node live.js` را اجرا کنید.

## طرز کار فنی روش CDP

1. اتصال به `http://127.0.0.1:<port>/json/version` و باز کردن WebSocketِ مرورگر.
2. `Target.setAutoAttach` + `Target.getTargets` ⇒ هر target صفحه‌ای (پنجرهٔ Qoder) یک session می‌گیرد.
3. برای هر session: `Page.addScriptToEvaluateOnNewDocument` (قبل از اسکریپت‌های خود صفحه و معاف از CSP) و یک `Runtime.evaluate` فوری برای سندِ باز شده.
4. source تزریقى سه تکه است: پریامبل فونت (ثبت `FontFace` از بایت‌های base64ِ همان فایل، با fallback به `@font-face{src:url(data:…)}` که در زمان اجرا ساخته می‌شود) + پریامبل استایل inline (rtl.css بدون قاعدهٔ `@font-face`) + بدنهٔ `patches/rtl.js` (همان فایل روش asar). بایت‌های فونت فقط یک بار در source می‌آیند.
5. پروب `--check` از همان صفحه: نسخه، وجود `<style data-qoder-rtl>`، وضعیت `window.__QRT_FONT__`، `document.fonts.check("Vazirmatn QRT")`، و روی نخستین بلوک `.qrt-fa`: `fontFamily`/`fontSize`/`lineHeight`/نسبت خط و `zoom` کانتینر؛ به‌علاوهٔ صفت `data-qrt-mode` روی `<html>`، شمارش قلاب‌های چت و فاصلهٔ `.qrt-widget` از لبهٔ پایین و راست پنجره. یک پروب دوم (`controls`) موقتاً `lineHeight` و `chatSize` را عوض می‌کند تا تأثیر واقعی‌شان روی متن سنجیده شود و بعد برمی‌گرداند.

## مجوز فونت

وزیرمتن محصول پروژهٔ Vazirmatn است (rastikerdar) و تحت SIL OFL منتشر شده — `assets/vazirmatn-variable.woff2` و `assets/OFL.txt`.

---

# English

Two ways to add Persian/Arabic RTL, an **offline Vazirmatn** font and correct bidi handling to the Qoder desktop chat:

- **`live.js` (recommended)** — injects the patch into the running Electron renderer over the DevTools protocol. No install file is modified, nothing breaks on update, and Qoder 0.3.3 accepts it.
- **`index.js`** — rewrites `app.asar` (with backup and `--restore`). On this Qoder build the app then **refuses to start**, because `EnableEmbeddedAsarIntegrityValidation` is on and `Qoder.exe` carries an `ELECTRONASAR` resource pinning the SHA256 of the archive header. Kept only for builds without that fuse; the signed binary is never touched.

**Scope (both routes):** chat messages and composer only — app chrome stays LTR (`<html dir="ltr">` pinned). Code, editors, terminals and file paths stay LTR and bidi-isolated; direction is detected per block; `Alt+R` toggles direction and `Alt+Shift+R` shows or hides the «ا» button, which sits at the **bottom-right** of the window next to the composer and opens its panel upward; it is inset `52px` from the right edge because Qoder's own 28px help button occupies the last 46px of that corner and our maximal z-index would swallow its clicks. Root state is carried on `data-qrt-*` attributes rather than classes, because the app's own renderer owns `<html class>`. Qoder also puts Tailwind-style utilities on the prose elements themselves (`p.my-0.text-sm.leading-6.text-text`, plus a font on `.markdown-body`), so the three rules that must win — font stack, line-height and the text-size `zoom` — are repeated on those elements with `!important`; a container-only rule never reached the text, which is why two sliders looked dead. Its own chat font-size setting then pins `line-height:24px !important` with a four-class selector, which no injected sheet can out-specify honestly, so the runtime stamps the leading inline on the prose nodes (`data-qrt-lead` guards the work; `dispose()` and RTL `off` remove every stamp). In the CDP route nothing is written to disk, so the Vazirmatn bytes ride inside the payload and are registered with `new FontFace(family, Uint8Array)` — that path performs no font fetch, so no `font-src` policy can refuse it (a `data:` URL font does fail under `font-src 'self'`; the fixture CSP proves it). The injected script uses no `eval`, so it stays compatible with `script-src 'self'`.

**Use:** `node live.js --launcher` → quit Qoder completely → run `Qoder-RTL.cmd`. Audit with `node live.js --check` (twelve PASS/FAIL lines plus hints, logged to `%LOCALAPPDATA%\qoder-persian-rtl\cdp-test.log`) and `node live.js --diagnose` for a read-only look at what the live window actually computed. One of those lines is a functional probe: it briefly drives `lineHeight`/`chatSize` through the same `apply()` the panel uses, re-measures a real message, then restores your values. Keep the injector console open; closing it (or Qoder) removes the patch — and on this build the debug port has been observed to disappear seconds after attaching, so re-run the injector after every Qoder start.

**Security caveat:** running Qoder with `--remote-debugging-port` opens a loopback debugging endpoint that any local process can drive. It is closed with the app; don't leave it on shared machines.

**Tests:** `npm test` (offline: HTML injection, CDP payload shape, staged-archive audit) and `npm run test:browser` (end-to-end CDP injection against headless Edge/Chrome on a throwaway profile; the fixture copies Qoder's real `text-sm leading-6` utilities, its `line-height:24px !important` prose pin and the 28px corner help button, and wipes `<html class>` every 500 ms). The panel line is scored only on windows that actually carry chat — Qoder keeps a second, empty target where nothing would ever clash — and it fails if the trigger's rect intersects any fixed element, which is how a regression back to `right:14px` gets caught. Neither suite writes to the Qoder install. Verified on real Qoder 0.3.3 with payload 1.1.0 (2026-09-20): the port is honored, the payload reaches both windows, the chat goes RTL, `Alt+R` works, and both the Vazirmatn face and the settings panel now show up — that run's one red line was *prose computes to the Vazirmatn stack (`system-ui`)*, i.e. the font was registered but never reached the `<p>`, which is also why the line-height and text-size sliders did nothing. Re-verified the same day with payload 1.2.2 on that real window: **12/12 PASS**, prose → Vazirmatn, `lineHeight 23.4px = 1.8` matching the panel, the slider probe moving leading `23.4→27.95px` and zoom `1→1.375` before restoring the user's config, and the panel 14px from the bottom / 52px from the right with `cornerClash n=0`. Still unverified on the live app: how long the patch survives the observed self-restart (the debug port died ~8 s after attaching) and the second, empty window whose probe always times out.

MIT. Vazirmatn is under the SIL Open Font License (see `assets/OFL.txt`).
