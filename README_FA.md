# Rubika Voice

کتابخانهٔ مستقل Node.js برای اتصال به Voice Chat روبیکا، مدیریت شرکت‌کنندگان، پخش موسیقی و ضبط تمام صدای ویس‌چت در یک فایل OGG/MP3 با استفاده از WebRTC.

[**مستندات کامل**](https://techcodeco.github.io/rubika-voice-chat/) · [**مخزن GitHub**](https://github.com/techcodeco/rubika-voice-chat) · [**صفحه npm**](https://www.npmjs.com/package/rubika-voice-chat)

[![npm version](https://img.shields.io/npm/v/rubika-voice-chat?logo=npm)](https://www.npmjs.com/package/rubika-voice-chat)
[![npm downloads](https://img.shields.io/npm/dm/rubika-voice-chat?logo=npm)](https://www.npmjs.com/package/rubika-voice-chat)
[![GitHub stars](https://img.shields.io/github/stars/techcodeco/rubika-voice-chat?style=social)](https://github.com/techcodeco/rubika-voice-chat)
[![GitHub issues](https://img.shields.io/github/issues/techcodeco/rubika-voice-chat)](https://github.com/techcodeco/rubika-voice-chat/issues)

**زبان:** فارسی | [English](README.md)

**سازنده و توسعه‌دهنده:** [محمد افروزه (TechCode)](https://github.com/techcodeco)

---

**نسخه: 1.5.3**

## اصلاح نسخهٔ 1.5.2

- وضعیت‌های مخصوص ورود مانند `SendPassKey` و `InvalidPassKey` از `data.status` خوانده می‌شوند و با وضعیت بیرونی `OK` اشتباه گرفته نمی‌شوند.
- تا قبل از موفقیت تأیید دومرحله‌ای، نبودن `phone_code_hash` خطا تلقی نمی‌شود.
- خطاهای `CodeIsInvalid` و `CodeIsUsed` در صورت قرار داشتن داخل `data.status` نیز درست مدیریت می‌شوند.

## احراز هویت و سشن

در اولین اجرای `new VoiceClient('my-session')`، اگر سشن وجود نداشته باشد، شماره تلفن و کد ورود از CLI دریافت می‌شود. اگر روبیکا وضعیت `SendPassKey` برگرداند، راهنمای `data.hint_pass_key` داخل پرانتز کنار درخواست گذرواژه نمایش داده می‌شود؛ گذرواژه‌ای که وارد می‌کنید بدون تغییر به‌عنوان `pass_key` در درخواست بعدی `sendCode` ارسال خواهد شد. در صورت `InvalidPassKey`، درخواست گذرواژه دوباره نمایش داده می‌شود. وضعیت‌هایی مثل `SendPassKey`، `InvalidPassKey`، `CodeIsInvalid` و `CodeIsUsed` از `data.status` خوانده می‌شوند؛ بنابراین وجود `phone_code_hash` فقط پس از عبور موفق از مرحله تأیید دومرحله‌ای بررسی می‌شود.

اگر `signIn` وضعیت `CodeIsInvalid` برگرداند، کد ورود مجدداً درخواست می‌شود. اگر وضعیت `CodeIsUsed` برگردد، ابتدا `sendCode` برای دریافت کد تازه اجرا و سپس کد جدید از CLI دریافت می‌شود.

`registerDevice` فقط پس از ساخت موفق یک سشن جدید اجرا می‌شود. سشن ذخیره‌شده در اجراهای بعدی دوباره ثبت دستگاه نمی‌شود؛ حتی اگر `RUBIKA_APP_VERSION` تغییر کند. اگر سشن به‌علت `NOT_REGISTERED` نامعتبر تشخیص داده شود و سشن تازه ساخته شود، ثبت دستگاه برای همان سشن جدید انجام می‌شود.

برای دریافت شناسهٔ حساب در زمان ورود به ویس‌چت، اگر `selfObjectGuid` از قبل تنظیم نشده باشد، کتابخانه از `getUserInfo` با ورودی `{ user_guid: undefined }` استفاده می‌کند و مقدار `data.user.user_guid` را به‌عنوان شناسهٔ خود کاربر ذخیره می‌کند.

## نصب

```bash
npm install rubika-voice-chat
```

نیازمندی‌ها: Node.js `>=22.5`، FFmpeg با encoderهای `libopus` و `libmp3lame`، و وابستگی WebRTC نصب‌شده توسط npm.

## اتصال

```js
const { VoiceClient } = require("rubika-voice-chat");

async function main() {
  const client = new VoiceClient("my-session", {
    logging: false,
  });

  client.on("error", (error) => console.error(error));

  await client.start();
  await client.joinVoiceChat("GROUP_GUID");

  const participants = await client.getAllParticipants();
  console.log(participants);

  await client.play("./music.mp3");

  // در پایان، ضبط فعال finalize و اتصال بسته می‌شود.
  await client.close();
}

main().catch(console.error);
```

## یک ویس‌چت در هر کلاینت

یک `VoiceClient` فقط یک Voice Chat فعال نگه می‌دارد. برای تغییر گروه، ابتدا از گروه فعلی خارج شوید:

```js
await client.joinVoiceChat("GROUP_GUID_1");
await client.play("./music-1.mp3");

await client.leaveVoiceChat();

await client.joinVoiceChat("GROUP_GUID_2");
await client.play("./music-2.mp3");
```

اگر پیش از `leaveVoiceChat()` بخواهید با همان کلاینت وارد گروه دیگری شوید، خطای مشخص دریافت می‌کنید.

## ضبط تمام صدای ویس‌چت

تمام ترک‌های صوتی Remote در یک میکسر PCM جمع می‌شوند و فقط یک فایل خروجی ساخته می‌شود. برای ضبط نیازی به شناسهٔ گروه یا ویس‌چت نیست.

### بدون صدای self

```js
await client.startRecording({
  output: "./recordings/voice-chat.ogg",
  format: "ogg",
  includeSelf: false,
  consentConfirmed: true,
});
```

### به‌همراه صدای self در همان فایل

```js
await client.startRecording({
  output: "./recordings/voice-chat-with-self.mp3",
  format: "mp3",
  includeSelf: true,
  consentConfirmed: true,
});
```

`self` به معنی صدای خروجی Player خود SDK است؛ صدای میکروفون فیزیکی کامپیوتر ضبط نمی‌شود. فایل جداگانه‌ای برای self ایجاد نمی‌شود.

### تغییر self در زمان ضبط

```js
// از این لحظه صدای Player نیز به همان فایل اضافه شود
client.setRecordingFilter({ includeSelf: true });

// از این لحظه صدای Player از میکس کنار گذاشته شود
client.setRecordingFilter({ includeSelf: false });

// توقف و finalize
await client.stopRecording();
```

تنها فیلتر معتبر `{ includeSelf: boolean }` است. `setRecordingFilter()` فقط هنگام ضبط فعال قابل استفاده است.

### گزینه‌های ضبط

| گزینه                   | نوع              | پیش‌فرض           | توضیح                           |
| ----------------------- | ---------------- | ----------------- | ------------------------------- |
| `output`                | `string`         | خودکار            | مسیر فایل خروجی                 |
| `format`                | `'ogg' \| 'mp3'` | از پسوند یا `ogg` | فرمت خروجی                      |
| `includeSelf`           | `boolean`        | `false`           | افزودن صدای Player در همان فایل |
| `consentConfirmed`      | `boolean`        | `false`           | باید صریحاً `true` باشد         |
| `finalizeOnProcessExit` | `boolean`        | `true`            | نهایی‌سازی هنگام SIGINT/SIGTERM |

`startAllParticipantsRecording(options)` نیز به‌عنوان نام جایگزین `startRecording(options)` باقی مانده و دقیقاً همان رفتار و پیش‌فرض را دارد.

گزینه‌های قدیمی `source`، `trackId`، `includeParticipants`، `excludeParticipants` و `participantObjectGuids` پشتیبانی نمی‌شوند؛ ارسال آن‌ها TypeError می‌دهد.

## پخش موسیقی

```js
await client.play("./music.mp3");
client.enqueue("./next.mp3");
client.enqueueMany(["./third.ogg", "./fourth.wav"]);

client.pause();
client.resume();
await client.seek(45);
await client.next();
await client.previous();
await client.setSpeed(1.25);
client.setVolume(70);
await client.stop();
```

هیچ متد پخش به `groupGuid` نیاز ندارد؛ عملیات روی ویس‌چت متصل فعلی اجرا می‌شود.

## رویدادهای مهم ضبط

```js
client.on("recording:file-created", (event) => console.log(event.output));
client.on("recording:progress", (event) =>
  console.log(event.framesCaptured, event.mixedFrames),
);
client.on("recording:filter-changed", (event) =>
  console.log(event.includeSelf),
);
client.on("recording:no-audio", (event) => console.warn(event));
client.on("recording:stopped", (event) => console.log(event.output));
```

## توقف ایمن

```js
await client.stopRecording();
await client.leaveVoiceChat();
await client.close();
```

`client.close()` برای آزادسازی منابع و finalize کردن ضبط فعال مناسب است. SIGINT و SIGTERM نیز پشتیبانی می‌شوند. در صورت SIGKILL، قطع برق، crash سیستم یا `process.exit()` اجباری، نهایی‌سازی فایل تضمین‌شدنی نیست. فایل OGG/MP3 ممکن است تا زمان finalize قابل‌پخش نباشد.

اگر هیچ فریم صوتی دریافت نشود، فایل placeholder حفظ و فایل `.json` با `status: no-audio` ایجاد می‌شود؛ رویداد `recording:no-audio` نیز ارسال می‌شود.

## API عمومی

- Session: `start`, `deleteSession`, `close`
- Voice Chat: `joinVoiceChat`, `connect`, `leaveVoiceChat`, `disconnect`, `discardVoiceChat`, `mute`, `unmute`, `requestSpeak`, `setVoiceChatSettings`
- Participants: `getParticipants`, `getAllParticipants`, `getVoiceChatParticipants`, `muteParticipant`, `unmuteParticipant`
- Updates: `getVoiceChatUpdates`, `startVoiceChatUpdates`, `stopVoiceChatUpdates`
- Playback: `play`, `enqueue`, `enqueueMany`, `next`, `previous`, `pause`, `resume`, `stop`, `seek`, `setSpeed`, `setPlaybackSpeed`, `increasePlaybackSpeed`, `decreasePlaybackSpeed`, `resetPlaybackSpeed`, `setVolume`, `setPlaybackVolume`, `getPlaybackStatus`, `getQueue`, `clearQueue`, `removeFromQueue`
- Recording: `startRecording`, `startAllParticipantsRecording`, `setRecordingFilter`, `stopRecording`, `getRecordingFiles`
- Status: `getStatus`

## مستندات کامل

سایت مستندات فارسی و نمونه‌کدهای قابل کپی در پوشهٔ `docs/` قرار دارد. برای GitHub Pages، Source را روی پوشهٔ `/docs` تنظیم کنید. فهرست کناری با مشاهدهٔ هر بخش فعال شده و به رنگ زرد درمی‌آید.

## حریم خصوصی

پیش از ضبط، رضایت روشن شرکت‌کنندگان را دریافت کنید و قوانین مرتبط با ضبط مکالمات را رعایت کنید. `consentConfirmed: true` فقط تأیید مسئولیت برنامه است و جایگزین رضایت واقعی نیست.
