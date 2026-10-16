# Bakımı Yapılan Özelleştirmeler ve Upstream Uyumluluğu

## Aynı sürüm kanıt sınırı

Bakım çalışması daima aynı vX.Y.Z sürümündeki upstream ile çalışma ağacı
karşılaştırılarak ölçülür. İki farklı maintained sürümü karşılaştırmak bizim
özelleştirmemizi değil portu ölçer. Doğrulanmış tarihsel seri şöyledir:

| Sürüm | Upstream commit | Değişen dosya | Eklenen | Silinen |
| --- | --- | ---: | ---: | ---: |
| 13.13.0 | `ce921328` | 48 | 2.522 | 955 |
| 13.13.1 | `f9e33019` | 71 | 4.537 | 795 |
| 13.14.0 | `de4930c0` | 78 | 6.311 | 952 |
| 13.23.1 | `89ca057a` | 93 | 8.271 | 1.046 |
| 13.24.0 terfisi | `1df66c2c` | 97 | 8.939 | 969 |
| 13.24.0 + bakım bilgi harness'i | `1df66c2c` | 104 | 9.491 | 969 |

Güncel satırı ve kesin yol listesini üretmek için:

```bash
node scripts/maintained-diff-report.cjs . > maintained-diff.json
```

Araç `package.json` sürümünü okur, aynı sürümün
`archive/upstream-v<same-version>` referansını çözer, tracked/staged/untracked
dosyaları kapsar ve etiketin paket sürümü farklıysa kapanarak hata verir. Bu
rakamlar tarihsel kanıttır, yayın onayı değildir. Ayrı olarak upstream 13.14.0
ile 13.24.0 arasında 285 dosya (+24.850/−2.951) değişmiştir; bu upstream
değişimini açıklar, bizim bakım delta'mızı değil.

## Bakımı yapılan yetenekler

| Yetenek | Ana uygulama | Sağladığı | Upstream 13.24 durumu |
| --- | --- | --- | --- |
| NVIDIA sağlayıcısı | `NvidiaProvider.ts`, provider dispatch, ayarlar/UI | Lightning modeli, sınırlı geçmiş, RPM planlama, sınıflı retry, `thinking=false` | Upstream karşılamıyor; korunacak |
| Kanıta dayalı gözlem onarımı | worker summarizer, `ResponseProcessor`, buffer'lar | XML evidence ID'leri, sınırlı onarım, desteksiz iddia yok | Observer yaşam döngüsü gelişti ama bu sözleşme yok |
| Kalıcı recovery işleri | `services/recovery/*`, `RecoveryRoutes` | Tarama, kuyruğa alma, lease, retry/cancel, dead letter, durum | Eşdeğer upstream özellik yok |
| Canonical Codex transcript recovery | `CodexTranscriptRecovery`, scanner | Kararlı turn fingerprint, lineage, idempotent replay | Codex başlangıcı hızlandı; recovery'nin yerini tutmuyor |
| Tarihsel fingerprint uzlaştırma | `HistoricalFingerprintReconciler` | Yinelenen/eksik tarihsel gösterimleri bulup onarır | Karşılanmıyor |
| Oturum bitiş boşluğu recovery | completion handler ve scheduler | Stop/session completion'ın kaçırdığı turn'leri kurtarır | Kota düzeltmeleri yeni boşluğu azaltır; tarihsel recovery hâlâ gerekir |
| Subagent-aware capture | Codex/Claude adapter'ları, summarize guard'ları, DB alanları | Parent/child lineage ayırır, çift subagent özetini önler | Upstream silence policy tamamlayıcıdır |
| Worktree adoption | `WorktreeAdoption.ts` | Tarihsel worktree kimliğini canonical projeye açık/dry-run birleştirir | Karşılanmıyor; yalnız açık işlem |
| ReleaseWindowV1 | release manager ve installer | Hook drain, generation fence, worker yetkisi, deterministik rollback | Süreç ağacı düzeltmeleri yardımcıdır; transaction sağlamaz |
| Release/store attestation | `attestation.ts`, doctor JSON | Bundle/manifest/build kimliği ve Claude/Codex ortak store UUID | Karşılanmıyor |
| Tek-writer Chroma disiplini | worker DB manager/sync ve installer | SQLite/Chroma yazımının tek root worker'da olması, kimlik bağlı teardown | Upstream kimliği güçlendirdi; lease yararlı kalır |
| Onarım/denetim araçları | `scripts/repair-*`, `audit-historical-*` | Legacy satır/index için backup-aware açık bakım | Otomatik migrasyon değildir; yalnız incelenmiş akışla çalışır |

Aynı sürüm delta'sının büyümesi yetenek sırasını gösterir: 13.13.0 provider ve
oturum temelini; 13.13.1 recovery servis ailesini; 13.14.0 release-window ve
attestation kontrollerini; 13.23.1 installer/audit/manifest/reconciliation
yüzeyini ekledi. 13.24.0 bunları yeni upstream Cursor/Grok ve host-observer
mimarisine taşır.

## 13.14.0'dan beri yararlı upstream değişiklikleri

### Şimdi doğrudan yararlı

- 13.15.2: daha açık observer hata sınıfları, retry edilmeyen kota hatası ve
  uygulanabilir SessionStart uyarısı.
- 13.16.1: tam süreç ağacı temizliği, PID kimlik doğrulaması, yabancı Python
  ortamı izolasyonu, daha güçlü platformlar arası build/doctor. Release
  harness'imiz bu temeli kullanır ancak daha sıkı writer/fence sahipliği sürer.
- 13.17.2: Codex SessionStart kalıcı worker ve sınırlı istek kullanır; başlangıç
  gecikmesini ve yinelenen başlatmayı azaltır.
- 13.18.1: observer oturumları sessizdir ve ajanlarla iletişim kuramaz; tek yönlü
  kaydedici güven sınırımızla uyumludur.
- 13.19.0: restart yalnız port değil farklı ve hazır successor ister. Olağan
  kesintide restart sayfası/CLI kullanılır; maintained release window'da değil.
- 13.20.0: sınırlı observer generation, kalıcı kota kesici, tek probe ve
  Anthropic fallback. Sağlayıcı tükenmesinde token israfını azaltıp işi korur.
- 13.22.0–13.23.1: model/faturalama telemetrisi ve doğru SDK
  `rate_limit_event` biçimi. NVIDIA Claude kotasına bağlı değildir; karma veya
  fallback kullanımında teşhis yine fayda görür.

### Var ama bilerek etkin değil

- 13.16.0 Cowork/CMEM Pro cloud eklentisi: ayrı güven ve dağıtım modeli.
- 13.24.0 bağımsız Cursor/Grok Bot eklentileri ve host observer: bu istemciler
  için yararlı, ancak onaylı etkin istemciler Claude ve Codex'tir.
- 13.15–13.21 CMEM Pro OAuth/trial installer değişiklikleri: yalnız kullanıcı
  cloud sync'i açıkça seçerse geçerlidir; yerel root store'un yerini tutmaz.

## Yüksek çatışmalı rebase yüzeyleri

Upstream ve maintained değişiklikleri provider dispatch, worker yaşam döngüsü,
oturum yönetimi, prompt'lar, installer/doctor, ayarlar, SQLite, Chroma sync,
üretilmiş bundle'lar ve testlerinde kesişir. Her etikette iki tarafın değiştirdiği
yolların kesişimini çıkar ve conflict/bundle çözümünden önce anlamsal incele.

## Ertelenen işler

- Immutable provenance ve kanıt terfi durum makinesi:
  `candidate -> proposed/provisional -> verified/retracted`.
- Recovery, lineage dead letter, fingerprint, subagent etiketi, outbox yaşı,
  context token/gecikme ve maliyet için sürümlü operasyon baseline'ları.
- Yedi tarihsel `lineage_mismatch` dead letter'ın deterministik incelemesi;
  transcript kanıtı olmadan toplu retry yok.
- Maddi değişen her aday için üç izole otomatik ve üç gerçek Codex/Claude
  çapraz-istemci çevrimi ile sabit 20 kayıtlık retrieval örneği.
- Proposal/bakım düzleminden önce NVIDIA salt-okunur değerlendirme/triage.
  Headroom, Graphify, gateway ve kalıcı wrapper ayrı pilot kalır.

## 13.40 aday uyumluluk notları

Upstream'in Codex app-server sağlayıcısı, generic OpenAI-compatible uç noktası,
spool/ingest yolu, exec-form launcher'ı, credential maskelemesi ve yeni SQLite
migrasyonları korunur. Bunlar maintained NVIDIA evidence/recovery sözleşmesinin
birebir karşılığı değildir. NVIDIA explicit selection ve fallback opt-in
korunur; özet kalitesi ölçülmeden sağlayıcı değişmez. Parser'ın kapalı type
enum normalizasyonu ve boş Markdown title etiketini null yapması bilinçli
maintained davranıştır; upstream'in serbest type koruma testleri bu sözleşmeye
uyarlanmıştır. Upstream logger gün rotasyonunu sağladığından eski yerel logger
delta'sı taşınmamıştır.
