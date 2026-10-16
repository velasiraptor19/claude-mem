# Root Yönetimli Güncelleme Rehberi

## Değiştirilemez kurallar

- Codex/Claude işlemlerini root olarak ve `/root/.claude-mem` ile çalıştır.
- Otorite olarak resmî upstream etiketi ile arşivlenmiş peeled commit'i kullan.
- Kirli veya kaynak/bundle/manifest eşleşmesi bozuk adayı asla terfi ettirme.
- Hook'lar etkinken kurulum yapma. Installer kalıcı yayın fence'ini oluşturmalı,
  hook'ları ayırıp drain etmeli ve snapshot/kurulumdan önce worker'ı durdurmalıdır.
- Sırf claude-mem adı geçiyor diye ilgisiz legacy MCP sürecini öldürme. Yalnız
  kaydedilmiş worker PID/start-token/PGID kimliği ve writer lease kapatılabilir.
- SQLite veya Chroma'yı doğrudan düzenleme. Veri onarımı root writer ya da
  incelenmiş çevrimdışı backup/rollback akışından geçer.
- Güncellemenin yan etkisi olarak Cursor, Grok, Cowork, cloud sync, gateway
  veya deneysel sağlayıcıları etkinleştirme.

## Aday hazırlama

1. Etiketleri getir ve resmî release/tag commit'ini doğrula.
2. Tam bu commit'ten izole aday worktree oluştur.
3. `archive/upstream-vX.Y.Z` etiketinin bulunduğunu ve aynı commit'e çözüldüğünü doğrula.
4. Bakım değişikliklerini eski ağacın tamamını kopyalamadan yetenek gruplarıyla taşı.
5. Üç diff hesapla:
   - önceki upstream etiketi -> yeni upstream etiketi;
   - aynı sürümde yeni upstream vX.Y.Z -> bakımı yapılan çalışma ağacı
     (`node scripts/maintained-diff-report.cjs .`);
   - upstream'in ve bizim değiştirdiğimiz yolların kesişimi.
   Özelleştirme envanteri için eski-maintained -> yeni-maintained kullanma;
   bu karşılaştırma yalnız port incelemesine yarar.
6. `CUSTOMIZATIONS.md` içindeki her yeteneğin upstream karşılığını incele;
   yerel kodu ancak davranış ve testler gerçekten eşdeğerse kaldır.
7. Üretilen eklenti artifact'lerini kaynaktan derle.
8. Tam manifesti yalnız kaynak ve bundle değişimi bittikten sonra yenile; dosya
   sayısını, bağımlılık ağacını, bundle hash'ini, upstream sürümünü ve commit'i doğrula.

## Ön kontrol kapıları

En az şunları çalıştır:

```bash
bun run typecheck
bun test --max-concurrency=1 tests
git diff --check
node scripts/verify-approved-manifest.cjs \
  --manifest maintained-patches/<full-manifest>.json \
  --bundle plugin/scripts/worker-service.cjs \
  --repo . --mode full
```

Ayrıca canlı health/readiness, kesin worker yolu/hash'i, terminal
release/transaction durumu, store UUID, SQLite integrity/foreign key durumu,
Chroma readiness ve adayın canlı ayarları sessizce değiştirmediğini doğrula.

## Terfi

Dışarıda incelenmiş tam-manifest SHA-256 değerini sağla ve yalnız şunu çalıştır:

```bash
CLAUDE_MEM_APPROVED_MANIFEST_SHA256=<sha256> \
  bash scripts/maintained-upgrade.sh install
```

Yayın fence'i oluşmadan worker'ı elle durdurma. “Worker'dan önce hook'lar kapalı”
demek installer'ın önce `begin -> hooks_detached -> hooks_drained` durumlarını
kalıcılaştırması, ancak sonra `call shutdown` yapmasıdır. Böylece worker hook'lar
hâlâ istek gönderirken durdurulduğunda yaşanan hook çökmeleri önlenir.

## Kesintiye uğrayan yayın

1. Release window ve transaction makbuzunu oku; lock dosyası veya kapalı HTTP
   portundan durum tahmin etme.
2. Transaction varsa `bash scripts/maintained-upgrade.sh reconcile` çalıştır.
   Generation, phase, yol, backup, PID kimliği, hook lease, writer lease ve DB
   snapshot'ını doğrular; snapshot resume veya rollback seçer.
3. Pencere transaction öncesindeyse ve eski worker sağlıklı ve byte-identical
   ise yalnız denetlenmiş no-op reconciliation yolunu kullan.
4. Transaction makbuzu oluşmadan eski worker durmuşsa `rolling_back` durumuna
   gir, generation'a bağlı tek kullanımlık başlatma yetkisi ver, kaydedilmiş eski
   worker'ı başlat, health/path/hash doğrula ve sonra `failed` kaydet.
5. Sonraki çalıştırma ilerlesin diye fence, lease, PID dosyası veya makbuz silme.

## Terfi sonrası kanıt

- `/api/health`: beklenen sürüm/yol, initialized, MCP ready ve sağlıklı provider.
- `/api/readiness`: `ready`.
- `/api/admin/doctor`: worker ve Chroma süreçleri canlı, ölü PID yok.
- `doctor --json`: ReleaseIdentityV1, BuildAttestationV1 ve
  StoreTopologyIdentityV1; Claude/Codex aynı store UUID ile uyumlu.
- Claude marketplace/cache ile Codex cache worker bundle hash'leri eşleşir.
- Release window `recovery_reconciled`, transaction `complete` durumundadır.
- Canonical recovery plan/makbuzu güncel generation ile eşleşir; eskiler history'dedir.
- SQLite `integrity_check=ok`, foreign-key ihlali sıfırdır; retrieval örneği ve
  çapraz istemci kabulü geçer.
- NVIDIA ayarları sırrı yazdırmaz, onaylı Lightning modelini kullanır ve
  `chat_template_kwargs.enable_thinking=false` zorlar.

Yayın sonucunu ve her yeni hata biçimini `UPGRADE_HISTORY.md` içine kaydet;
regresyon testi ekle, yeniden derle, manifesti yenile ve ilgili kapıları yinele.

## 13.40 ve sonrası launcher/spool kapıları

- Claude exec-form `command`+`args` hook'ları PATH üzerindeki `claude-mem`
  launcher'ını gerektirir. Installer reviewed bundle'dan, dotenv/bunfig otomatik
  yüklemesi kapalı derler ve protokolü doğrular. Launcher da metadata backup ve
  rollback kapsamındadır; kullanıcıya ait yabancı executable sessizce ezilmez.
- Claude settings ve Codex config/hooks tanımları plugin payload'ıyla birlikte
  snapshot edilir. Snapshot kapsamı genişlemişse eski eksik makbuzla tahminî
  restore yapılmaz; o generation'ın arşivlenmiş installer'ı kullanılır.
- `artifact_installed` aşamasında yetkili daemon başlat, health/readiness doğrula,
  sonra attest et ve hook'ları bağla. `window_closed` sonrası aynı generation
  için `/api/recovery/reconcile-release` çağır; terminal recovery makbuzunu bekle.
- Başlatıcı yalnız yetkinin geçerliliğini okur; tek kullanımlık yetki gerçek
  daemon girişinde tüketilir ve alt süreç ortamından çıkarılır.
- Nihai manifest `bun.lock`, kaynak/test/build girdileri ve symlink'leri güvenli
  dereference eden dependency snapshot'ını bağlar. Kaynak/dependency değişince
  tekrar build, test ve tam manifest doğrulaması gerekir.

## Terfi sonrası açık istemci oturumları

Terfiden sonra Claude ve Codex oturumlarını yeniden aç; böylece hook giriş
noktaları yeni plugin cache'inden yüklenir. Eski 13.24 hook'ları sağlıklı 13.40
worker'a capture gönderebilir ve sürüm seçici sağlıklı worker'ı eski sürüme
indirmez. Ancak eski giriş noktasını bellekte tutan bir istemci, yeni worker
sonradan kaybolursa kendi `ensureWorkerStarted(__filename)` yoluyla eski
worker'ı başlatabilir. Bu yüzden eski oturumlar için worker kaybından sonra
kesintisiz sürüm koruması varsayma. Yayın fence'i stop/kurulum aralığını korur;
istemciyi yeniden açma gereğinin yerine geçmez.
