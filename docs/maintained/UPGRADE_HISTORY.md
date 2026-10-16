# Bakımı Yapılan Güncelleme Geçmişi

Bu belge root yönetimli claude-mem kurulumu için canonical olay ve karar
geçmişidir. Git, manifestler, release makbuzları ve güncel dosyalar otoritedir;
claude-mem gözlemleri yalnız destekleyici kanıttır.

## Sürüm soy ağacı

| Aşama | Upstream taban | Amaç | Arşiv otoritesi |
| --- | --- | --- | --- |
| İlk maintained hat | 13.13.0 | NVIDIA observer ve recovery başlangıcı | `archive/upstream-v13.13.0` |
| Recovery sağlamlaştırma | 13.13.1 | Retry, lineage ve onarım düzeltmeleri | `archive/upstream-v13.13.1` |
| Attestation tasarım hattı | 13.14.0 | ReleaseWindowV1, recovery, topology identity | `archive/upstream-v13.14.0` |
| Rebase adayı | 13.23.1 | Maintained delta'yı güncel upstream'e taşıma | `archive/upstream-v13.23.1` |
| Etkin maintained release | 13.24.0 | Güncel Claude/Codex artifact'i | `archive/upstream-v13.24.0` |

Worktree adları yayın otoritesi veya hafıza proje kimliği değil, tarihsel
konumlardır. Mantıksal hafıza projesi `claude-mem` olarak kalır.

## Güncelleme harness'i neden var?

Sıradan eklenti değişimi etkin hook'lar, worker, SQLite WAL veya Chroma süreç
ağacıyla yarışabilir. Bu nedenle generation fence ve şu sabit sıra kullanılır:

1. `ReleaseWindowV1` başlat;
2. hook'ları mantıksal olarak ayır ve zamanı kalıcılaştır;
3. devam eden hook lease'lerini drain et;
4. tek managed worker ve writer lease kimliğini doğrulayıp durdur;
5. transaction makbuzunu yaz ve doğrulanmış backup al;
6. onaylı ağacı atomik kur;
7. yeni worker'ı başlat ve attest et;
8. eşleşen hook'ları bağla, pencereyi kapat ve canonical transcript'leri kurtar;
9. yalnız `recovery_reconciled` ve transaction `complete` ile bitir.

## Olaylar ve kalıcı çözümler

### İlk 13.14 uygulaması ve incelemesi

- Git sahiplik kontrolü root worktree'lerini reddediyordu. Harness yalnız
  root-owned yollar ile açıkça güvenilen root/`agentroot` modlarını kabul eder;
  sahiplik kontrolünü küresel olarak gevşetmez.
- Eşzamanlı yayınlar çakışabiliyordu. Kalıcı tek-installer lock, generation,
  mutation lock ve generation'a bağlı tek kullanımlık worker başlatma yetkisi eklendi.
- Backup, hedefin yokluğu ile başarısız kopyayı ayırmıyordu. Artık presence
  receipt, UUID namespace'li backup, canonical yol ve restore öncesi doğrulama var.
- Kesinti pencere ve transaction'ı farklı phase'lerde bırakabiliyordu.
  Receipt-first sıralama ve yeni süreçte `reconcile`, yalnız idempotent snapshot
  resume ya da simetrik rollback seçer.
- Eski hook süreçleri logical detach sonrasında yaşayabiliyordu. Hook handler'ları
  PID/start-token lease tutar; drain etkin lease bitince onaylanır, ölü lease
  yalnız deterministik süreç kanıtıyla temizlenir.
- Worker başlangıcı ikinci launcher ile yarışabiliyordu. Başlatma release-window
  yetkisi ve mevcut spawn lock gerektirir.

### 13.14.0'dan 13.23.1'e rebase

- Aday başlangıçta source, generated bundle ve manifest durumlarını karıştırdı.
  Resmî tag commit, kesin dependency tree, bundle ve tam approval manifest
  eşleşene kadar aktivasyon engellendi.
- Paralel testler ortak process state'i kirletti; zorunlu suite
  `--max-concurrency=1` ile çalıştırılır.
- 121 eski hook lease drain'i engelledi; detached-only güvenli dead-lease
  reconciliation eklendi.
- Worker HTTP endpoint'i `uvx -> python -> chroma-mcp` alt süreçleri ve writer
  lease'ten önce kapanıyordu. Shutdown artık PID, start token ve özel PGID'yi
  yakalayıp yalnız bu grubu drain eder. İlgisiz legacy MCP öldürülmez.
- Tamamlanmış eski transaction yeni generation'ı engelliyordu; terminal
  makbuzlar `begin` öncesi sürümlü history'ye taşınır.
- Receipt/window sapmasında rollback bozuluyordu; yalnız açıkça uyumlu phase
  ilişkileri kabul edilir, aksi durumda fence korunur.
- Root harness dosyaları güvenilir root-group write kullanabiliyor. Güvenli yol
  kontrolü root sahipliği, world-write yokluğu ve güvenilir group-write kabul eder.
- Bir helper metadata dosyasına directory-only kontrol uyguluyordu; dosya ve
  dizin güvenlik kontrolleri ayrıldı.
- mtime fixture nondeterministic idi; açık ve kararlı zaman ilişkisi kuruldu.
- Generation 10, 13.24.0'ı kurdu fakat generation-2 canonical recovery kanıtı
  buldu ve 13.23.1'e rollback yaptı. `prepare_recovery`, eski plan/receipt
  çiftlerini kapanıştan önce `canonical-recovery-history-v1` içine arşivler.

### Başarılı 13.24.0 terfisi — generation 18

Snapshot öncesi bazı denemeler güvenli biçimde kapandı ve eski worker'ı geri
getirdi. Bunlar dört ek installer kusurunu ortaya çıkardı:

- Boş `ps -g` sonucu status 1 verir; `set -e` altında drain edilmiş grup bile
  installer'ı durduruyordu. Artık boş grup başarı sayılır ve tüm kullanımlar
  regresyon testiyle korunur.
- Chroma lease, grup drain ile explicit cleanup arasında kaybolabiliyordu.
  Installer kimlik bağlı stale lease'i doğrulayıp silmeden önce serbest kalmış
  durumu yeniden kontrol eder.
- Root-group-writable lease shell politikasında kabul edilip inline Node
  kontrolünde reddediliyordu; iki kontrol aynı trusted-root-group kuralını uygular.
- Son bağlantı kapandıktan sonra SQLite WAL/SHM kalabilir; dosya varlığı etkin
  writer kanıtı değildir. Installer hiçbir sürecin DB/WAL/SHM tutmadığını
  kanıtlar, sonra committed WAL durumunu `VACUUM INTO` ile tek doğrulanmış
  rollback DB'ye katlar. Eski sidecar'lar asla restore edilmez.

Generation 17, `worker_quiesced` durumundan yeni süreç recovery'sini kanıtladı:
snapshot, doğrulama, rollback, eski-worker attestation ve terminal receipt
tamamlandı. Generation 18 tam terfi, canonical recovery ve hook yeniden bağlama
akışını tamamladı.

## Yayından sonra saklanan kanıtlar

- `~/.claude-mem/release-window-v1.json`
- `~/.claude-mem/release-transaction-v1.json`
- `~/.claude-mem/release-transaction-history-v1/`
- `~/.claude-mem/canonical-recovery-plan-v1.json`
- `~/.claude-mem/canonical-recovery-receipt-v1.json`
- `~/.claude-mem/canonical-recovery-history-v1/`
- `~/.claude-mem/build-attestation-v1.json`
- `~/.claude-mem/store-installation-v1.json`
- `~/.claude-mem/backups/maintained-upgrade-*`

Bu gerçekleri düzyazıyla değiştirme; değişken PID/hash/sürüm değerlerini
`AGENTS.md` içine hiçbir zaman kopyalama.

### 13.40.0 aday hazırlığı — terfi edilmedi

Resmî 13.40.0 release 2026-10-16 tarihinde yayımlandı. Annotated tag
`e5b1a1ef8cc3cb7d57d596700d45cfa85ba04642`, peeled commit
`46e2f759e95a1a21b942c1e116f7f12f902705a3`; archive etiketi aynı commit'e
çözülür. Eski clean maintained adayın fork commit'i
`1ca6dc3a8bb76e099d9558818cd7457930c8e369` idi. Upstream 13.24→13.40
1.922 yolu değiştirdi; eski 108 bakım yolunun 58'i kesişti. Bu sayılar port
başlangıcıdır, yeni aynı-sürüm bakım envanteri değildir.

- Upstream'in schema_versions 50–53 alanları maintained recovery damgalarıyla
  çakışıyordu. Recovery kendi tablo/kolon invariant'larını denetler; upstream
  sayısal migrasyon ledger'ını sahiplenir. Eski 13.24 store'un in-memory açılışı
  FK/integrity ve lineage/fingerprint alanlarını koruma testinden geçti.
- Yeni exec-form launcher ve disk spool eski hook wrapper'ını atlayabiliyordu.
  Lease gerçek hook-command girişine taşındı. Doğrudan daemon/restart yolları
  fence'e bağlandı; tek kullanımlık başlangıç yetkisini launcher değil store'u
  açacak daemon tüketir.
- Installer yeni worker sağlıklı olmadan hook bağlayabiliyordu. Başlangıç ve
  readiness artık artifact_installed aşamasında; attestation ve hook bağlantısı
  sonra gelir. Kapanan generation canonical recovery endpoint'iyle uzlaştırılır.
  Claude/Codex ayarları, hook tanımları ve PATH launcher'ı rollback snapshot'ına
  dahildir. Eksik snapshot kanıtı hiçbir zaman varsayımla tamamlanmaz.
- Upstream Settings GET secret maskelemesi NVIDIA anahtarına genişletildi.
  NVIDIA fallback seçilmemişse Claude aboneliğine sessiz geçiş engellendi;
  viewer read/save çevrimi de etkin `off` değerini korur. Anahtar eksikliği
  başka sağlayıcı seçimine yetki vermez. Codex `--model` desteği korunur.
- Node 24 `MainThread` process adı legacy null-token Chroma writer lease'ini
  yanlış stale saydırıyordu. Canlı sahip fail-closed tanınır; süreç öldürme
  yetkisi genişletilmez.
- Canlı 13.24 Chroma import hatası (`eval_type_backport`) upstream #4593'teki
  `pydantic<2.14` constraint'iyle ele alınmış; yeni aday ayrıca chromadb1.5.9'u
  pinler. İzole cache prewarm kanıtı canlı cache/store onarımı değildir.
- Bağımlılıklar adaya ayrı kuruldu, upstream package.json aralıkları korundu,
  ilk kurulum `--ignore-scripts` ile yapıldı. İncelenen tree-sitter-cli
  install.js yalnız adayın root/plugin bağımlılık dizinlerinde resmî GitHub
  sürüm binary'sini indirmek için çalıştırılır; diğer lifecycle script'leri
  kapalıdır. Build yalnız `build` hedefini kullanır;
  `build-and-sync` çalıştırılmadı. Bun lock ve exact dependency içeriği tam
  manifest girdisidir.

Bu hazırlık sağlayıcı/özet kalitesi karşılaştırması değildir. NVIDIA Lightning
modelinin katalogda bulunması doğrulandı; Codex abonelik sağlayıcısı upstream'de
mevcuttur. Kullanıcı özetleyici kararını güncelleme sonrasına bıraktı; aday
hazırlığı yeni sağlayıcı, cloud veya isteğe bağlı istemci etkinleştirmez.

### 13.40 aday son doğrulamasındaki ek bulgular

- NVIDIA recovery onarımında çok baytlı bozuk yanıtı geçmişe yeniden eklemek
  bütçeyi doldurup canonical kanıtı düşürebiliyordu. Onarım artık aynı canonical
  prompt'a sınırlı onarım talimatı ekler. CJK/emoji fixture'ı ilk istek ve iki
  onarımda E1/E2, completion metadata ve byte bütçesini gerçek mock HTTP body'de
  denetler. Secret/private/email redaksiyonu zorunludur; bu pattern testleri
  evrensel PHI/kişisel veri tanıma veya özetin olgusal doğruluğu garantisi değildir.
  Doğrulama gerçek transcript veya sağlayıcı değerlendirme trafiği göndermez.
- Yeni no-loss malformed-output sözleşmesine eski provider test double'ları
  uyarlandı. İşlenmiş kayıt sayısı ve retry sonrası korunmuş mesajlar açıkça
  doğrulanır; başarısız çıktıda sessiz veri kaybı bekleyen fixture korunmaz.
- Node/Bun pipe ve process readiness farklılıkları test harness'inde giderildi:
  Node native pipe orchestration, gerçek child-ready sinyali ve raw TCP yarım
  HTTP yanıtı kullanılır. Chunk sınırları, tam UTF-8 çıktı ve transport fallback
  beklentileri gevşetilmedi. TOML fixture'ları parser öncesi/sonrası anlamı ve
  çok satırlı içeriğin birebir byte'larını birlikte doğrular.
- Eski cache giriş noktalarını tutan açık Claude/Codex oturumları sağlıklı yeni
  worker'a capture gönderebilir; ancak worker kaybı sonrası eski başlangıç yolu
  eski worker'ı başlatabilir. Terfi sonrası iki istemci de yeniden açılmalıdır;
  release fence bu istemci yenilemesinin yerine geçmez.
