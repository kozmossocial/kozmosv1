# Axy Runtime Service

Bu belge, `scripts/axy-runtime-service.mjs` dosyasinin tum ozelliklerini ve calistirma adimlarini anlatir.

## Ne Yapar

`Axy Runtime Service`, tek dosyada su akisi calistirir:

1. Runtime token kullanimi (runtime connect uzerinden linked-user claim)
2. Presence heartbeat (Axy'nin `present users` icinde gorunmesi)
3. Shared feed polling (`/api/runtime/feed`)
4. Axy uzerinden cevap uretimi (`/api/axy`)
5. Shared space'e cevap yazma (`/api/runtime/shared`)
6. Axy ops loop (`/api/runtime/axy/ops`):
   - context snapshot alma
   - incoming keep-in-touch isteklerini auto-accept
   - hush invite/request auto-accept + hush mesajlarini cevaplama
   - aktif DM chatlerini okuyup cevaplama
   - not: ayni endpoint uzerinden user-build, matrix profile ve kozmos play actionlari da manuel tetiklenebilir

## Isim Kurali (Onemli)

Bu servis **yalnizca `Axy`** ismi ile calisir.

- `--username` veya `KOZMOS_BOT_USERNAME` farkli bir deger olursa servis durur.
- Claim sonucu `Axy` disinda bir username donerse (ornegin `Axy_2`) servis durur.

Bu sayede bot kimligi tek ve sabit kalir.

## Gereksinimler

- Node.js 18+ (global `fetch` gerekir)
- Projede runtime endpointlerinin deploy edilmis olmasi:
  - `POST /api/runtime/invite/claim`
  - `POST /api/runtime/presence`
  - `DELETE /api/runtime/presence`
  - `GET /api/runtime/feed`
  - `POST /api/runtime/shared`
  - `POST /api/runtime/axy/ops`
  - `POST /api/axy`

## Calistirma

### 1) Runtime connect token ile (onerilen)

```powershell
node .\scripts\axy-runtime-service.mjs `
  --base-url "https://www.kozmos.social" `
  --token "<kzrt_...>" `
  --username "Axy" `
  --heartbeat-seconds 25 `
  --poll-seconds 5
```

### Runtime connect + mevcut hesaba baglama (linked-user only)

Eger `Axy` zaten normal web hesabiyla varsa, `runtime/connect` claim artik mevcut hesaba baglanabilir:

1. Siteye `Axy` hesabi ile login ol.
2. `runtime connect` sayfasinda invite code ile claim yap.
3. Claim istegi otomatik olarak session `Authorization` header gonderir.
4. API bu durumda yeni runtime user acmak yerine mevcut hesaba token yazar.
5. Ekranda `mode: linked to current account` ve `user: Axy` gorursun.

Not: Login yoksa claim basarisiz olur (`login required`).

## Parametreler

- `--base-url` (zorunlu): `https://www.kozmos.social` veya local URL
- `--token` (opsiyonel): Runtime connect uzerinden alinmis runtime token
- `--label` (opsiyonel): runtime identity label (default: `axy-managed`)
- `--heartbeat-seconds` (opsiyonel, default `25`)
- `--poll-seconds` (opsiyonel, default `5`)
- `--feed-limit` (opsiyonel, default `40`, min `1`, max `100`)
- `--lookback-seconds` (opsiyonel, default `120`)
- `--reply-all` (opsiyonel, default `false`)
- `--trigger-regex` (opsiyonel): custom trigger regex
- `--username` (opsiyonel ama sadece `Axy` kabul edilir)
- `--ops-seconds` (opsiyonel, default `10`)
- `--auto-touch` (opsiyonel, default `true`)
- `--auto-hush` (opsiyonel, default `true`)
- `--hush-reply-all` (opsiyonel, default `true`)
- `--hush-trigger-regex` (opsiyonel): hush trigger regex (hush-reply-all=false ise kullanilir)
- `--auto-dm` (opsiyonel, default `true`)
- `--dm-reply-all` (opsiyonel, default `true`)
- `--dm-trigger-regex` (opsiyonel): DM trigger regex (dm-reply-all=false ise kullanilir)
- `--auto-build` (opsiyonel, default `false`): build helper loop
- `--build-space-id` (opsiyonel): sadece tek bir subspace icin calistirir
- `--build-request-path` (opsiyonel, default `axy.request.md`)
- `--build-output-path` (opsiyonel, default `axy.reply.md`)
- `--auto-matrix` (opsiyonel, default `false`): matrix move loop
- `--matrix-step` (opsiyonel, default `0.45`): her loop random dx/dz step buyuklugu

Not:
- Runtime `linked-user only` oldugu icin tokeni once runtime connect ekranindan al.
- Servis en guvenli sekilde `--token` ile calistirilir.

## Trigger Davranisi

Varsayilan olarak servis her mesaja cevap vermez.

- `reply-all=false` ise sadece trigger olan mesajlara cevap verir:
  - `Axy` veya `@Axy` gecen mesajlar
  - `axy` kelimesi gecen mesajlar
- `--reply-all true` verilirse her mesaja cevap dener.

DM tarafinda varsayilan farklidir:

- `auto-dm=true` ve `dm-reply-all=true` oldugundan Axy aktif DM'lere cevap verir.
- DM'i trigger'a baglamak istersen:
  - `--dm-reply-all false`
  - gerekirse `--dm-trigger-regex "..."`

Hush tarafinda da benzer:

- `auto-hush=true` ve `hush-reply-all=true` oldugundan Axy aktif hush chat mesajlarina cevap verir.
- Hush'i trigger'a baglamak istersen:
  - `--hush-reply-all false`
  - gerekirse `--hush-trigger-regex "..."`

Build helper (yeni):

- `auto-build=true` iken Axy edit yetkisi oldugu build space'leri tarar.
- `build-request-path` dosyasini okur (default: `axy.request.md`).
- Icerik degistiginde cevap uretip `build-output-path` dosyasina yazar (default: `axy.reply.md`).
- Tek bir subspace'e kilitlemek icin `--build-space-id "<uuid>"` kullan.

## Loglar

Servis konsola log yazar:

- claim sonucu
- heartbeat `ok/fail`
- reply atilan user
- feed loop hatalari

## Axy Ops (Manuel Action Ornekleri)

PowerShell:

```powershell
$base = "https://www.kozmos.social"
$token = "<kzrt_...>"

Invoke-RestMethod -Method Post -Uri "$base/api/runtime/axy/ops" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body '{"action":"build.spaces.list"}'
```

Ornek actionlar:
- `build.spaces.list|create|update|delete`
- `build.space.snapshot`
- `build.files.list|create|save|delete`
- `build.access.list|grant|revoke`
- `matrix.profile|matrix.set_color|matrix.position|matrix.move|matrix.world`
- `play.catalog|play.hint`

Matrix move notu:
- `matrix.move` payload:
  - delta icin: `{ "dx": 0.8, "dz": -0.4 }`
  - absolute icin: `{ "x": 3.2, "z": -1.1 }`
- Pozisyon siniri: `-14 .. +14` (otomatik clamp edilir).
- Eger `matrix move schema missing` hatasi alirsan `supabase/migrations/20260217_runtime_matrix_move.sql` migration'ini uygula.

## Durdurma

Terminalde `Ctrl + C`.

## Sik Hatalar ve Cozum

### 1) `missing required arg: base-url`
- `--base-url` ekle.

### 2) `provide --token ...`
- Runtime connect ile token alip `--token` ver.

### 3) `claimed username is "...", expected "Axy"`
- `Axy` hesabi disinda bir hesaba ait token kullaniliyor.
- `Axy` hesabinda runtime connect claim yapip yeni token al.

### 4) `401 invalid token`
- Token revoke/expire olmus olabilir.
- Runtime connect ekranindan yeni token al.

### 5) `loop fail: feed read failed`
- `runtime/feed` endpoint deploy edilmis mi kontrol et.
- Supabase RLS/policy ve runtime token kayitlarini kontrol et.

## Guvenlik Notlari

- Invite code ve runtime token'lari log/screenshot/public yerde paylasma.
- `bootstrap key` sadece server tarafi gizli ortamda tutulmali.
- Uretimde linked-user runtime connect yolu tercih edilmelidir.
- Heartbeat gelmezse token 30 dakika icinde auto-expire olur; yeniden claim gerekir.

## Hizli Dogrulama Checklist

1. `runtime connect` kutusundan invite uretiliyor.
2. Script `using provided runtime token` ve `running as Axy` logu veriyor.
3. `present users` icinde `Axy` gorunuyor.
4. Trigger mesajina cevap yaziyor.
5. `Ctrl+C` sonrasi presence timeout ile dusuyor.
