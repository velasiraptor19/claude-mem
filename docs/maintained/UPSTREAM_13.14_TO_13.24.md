# Upstream Değişiklikleri: 13.14.0 → 13.24.0

Kaynak: arşivlenmiş 13.14.0 ve 13.24.0 commit'leri arasındaki upstream Git
geçmişi ve `CHANGELOG.md`. Bu belge upstream özelliklerini bizim maintained
delta'mızdan ayırır.

| Sürüm | Upstream değişikliği | Kurulumumuza değeri | Kullanımımız |
| --- | --- | --- | --- |
| 13.15.0 | CMEM Pro deneme/device-code installer ve canlı fiyat | Yerel NVIDIA çalışmasına etkisi yok | Yalnız cloud sync açıkça seçilirse |
| 13.15.2 | Gateway hata zarfları, doğru kota sınıfı, tek uygulanabilir uyarı | Daha iyi teşhis, terminal kotada boşa retry yok | SessionStart uyarısını oku; olağan kesintide restart/doctor |
| 13.15.3 | Merkezi OpenRouter attribution header'ları | Fallback/OpenRouter attribution sapmasını önler | Sağlayıcı seçilince otomatik |
| 13.16.0 | Cowork eklentisi ve fail-soft uzak spool | Ayrı cloud-session entegrasyonu | Kapalı; açık onay ve cloud güven incelemesi gerekir |
| 13.16.1 | Platformlar arası process-tree kill, PID kimliği, Python izolasyonu, path/build/doctor düzeltmeleri | Worker/Chroma teardown temelimizi güçlendirir | Otomatik devralınır; maintained fence otoritedir |
| 13.17.0–13.17.1 | Kararlı trial ataması ve installer release hizası | Yerel hafızaya operasyonel etkisi yok | İşlem yok |
| 13.17.2 | Hızlı/sınırlı Codex SessionStart ve privacy-bounded telemetri | Daha hızlı context injection, daha az çift startup | Codex'te otomatik; hook başına worker başlatma yok |
| 13.18.0 | Birleşik 30 günlük CMEM Pro teklifi | Ticari UI | Cloud seçilmedikçe işlem yok |
| 13.18.1 | Observer sessiz kalmalı ve ajanlarla konuşmamalı | Tek yönlü kaydedici güven modelimize uyar | Mode'larda otomatik; custom mode kuralı korur |
| 13.19.0 | Güvenli tıklamalı restart ve successor readiness | Olağan kesintide daha güvenli kurtarma | Maintained release window dışında kullan |
| 13.20.0 | Kalıcı quota breaker, tek probe, sınırlı generation, context-seeded recycle, Anthropic fallback | Token/maliyet ve süreklilik iyileşir | Otomatik; tekrar tekrar restart yerine provider status izle |
| 13.21.0–13.21.2 | Açık yerel provider, cloud-outage toleransı ve daha güvenli installer varsayımları | Yerel kurulumun açık kalmasını sağlar | Sağlayıcıyı açık geçir; sessiz provider değişimi kabul etme |
| 13.22.0 | Model/faturalama telemetrisi, schema v50 | Sınırlı metadata ile teşhis | Onay/telemetri politikası geçerli; prompt/kaynak gönderilmez |
| 13.23.0 | `usage_limit_hit`, daha geniş kota metni, korunan batch'ler | Claude kotasında iş kaybını önler | Claude fallback/istemcide yararlı; NVIDIA bağımsız |
| 13.23.1 | Doğru SDK `rate_limit_event` ayrıştırması | Kota koruması gerçekten işler | Otomatik |
| 13.24.0 | Bağımsız Cursor/Grok Bot eklentileri, host observer, platform kimliği | İsteğe bağlı istemcileri ayırır | Claude+Codex profilinde onaysız kurma/açma |

## Pratik davranış değişiklikleri

### Codex ve Claude

- İkisi de kalıcı root worker'ı ve aynı store-installation UUID'sini kullanır.
- Codex başlangıç context'i sınırlıdır ve normalde başka MCP/worker başlatmaz.
- Claude quota koruması ile NVIDIA recovery birlikte çalışır; Claude observer
  kota sinyali NVIDIA işlerinde retry veya model değişimine yetki vermez.

### Olağan kesinti ve maintained release farkı

- Olağan provider/worker kesintisi: uyarıyı izle, restart et, sonra doctor çalıştır.
- Sürüm upgrade/rollback: olağan restart yolunu kullanma. Önce hook'ları ayırıp
  drain eden ve kapalı aralığı canonical recovery ile işleyen ReleaseWindowV1'i kullan.

### İsteğe bağlı entegrasyonlar

Cursor, Grok Bot, Cowork, CMEM Pro/cloud sync ve host observer yararlı upstream
yetenekleridir; fakat capture yolu veya güven sınırını değiştirir. Ayrı ayrı
istenip değerlendirilip kurulup attest edilene kadar kapalı kalırlar.

## Upstream'in hâlâ karşılamadığı alanlar

Upstream süreç temizliği, kota ve Codex gecikme iyileştirmeleri hata sıklığını
azaltır. NVIDIA provider, kanıta dayalı recovery, kalıcı recovery queue/dead
letter, tarihsel fingerprint uzlaştırma, subagent lineage, açık worktree
adoption, ReleaseWindowV1 transaction, kapalı-pencere canonical recovery,
ReleaseIdentityV1 veya ortak store kimliğimizin yerini tutmaz.

## Devam: 13.24.0 → 13.40.0

Canonical belge adı tarihsel olarak korunmuştur. Yeni upstream; Codex
app-server subscription sağlayıcısı, exec-form hook launcher, disk spool ve
yetkili ingest, generic OpenAI-compatible provider, settings credential
maskelemesi, güvenli process/spawn ve yeni SQLite read-model migrasyonları
getirir. Chroma MCP0.2.6 için pydantic<2.14 ve chromadb1.5.9 constraint'leri
mevcuttur. Bu akışlar bakım fence/recovery/lineage kurallarına taşınır; yeni
abonelik veya bulut kullanımı kullanıcı kararı olmadan etkinleştirilmez.


## Uzun dönem gelişim ve 15.21'e geçiş — 18 Kasım 2026

Belgenin ilk kısmı 13.14→13.24 tarihsel karşılaştırmasıdır. Aşağıdaki tablo
her patch sürümün listesi değil, Git/CHANGELOG ile doğrulanan ana kilometre
özetidir. İncelenen en eski Git release kaydı 6 Eylül 2025 tarihli v3.3.8'dir;
bundan önceki tüm geliştirmeler hakkında eksiksizlik iddiası yoktur.

| Dönüm noktası | Gelişim |
| --- | --- |
| v3.3.8, Eylül 2025 | Erken kalıcı oturum/SQLite belleği |
| v5, Kasım 2025 | Chroma ile SQLite FTS hibrit arama/fallback |
| v6–7, Kasım–Aralık 2025 | Transcript/session düzenlemesi, ince HTTP hook'ları ve merkezi worker |
| v8, Aralık 2025 | Modlar ve Türkçe dahil dil desteği; bu, her modelin dil kalitesi garantisi değildir |
| v9–10, Ocak–Şubat 2026 | Worktree/klasör bağlamı ve ek istemci entegrasyonları |
| v11–12, Nisan 2026 | Semantik bağlam, tier routing, read gate ve AST kod araması |
| v13, Mayıs 2026 | İsteğe bağlı server/Postgres/Redis, Apache-2.0 lisansı |
| v13.29–13.40 | Codex aboneliği/app-server, genel OpenAI uyumlu provider ve NVIDIA preset'i, smart code tools, launcher/spool ve work_state |
| v14–15, Ekim 2026 | My Work görev akışları; v15 ile MCP arama sözleşmesi değişti |
| v15.10–15.17 | Kaynağa göre provider seçimi, gözlemci aç/kapat, medya/backups, provenance/auto-update güvenilirliği, açık oturum capture düzeltmeleri |
| v15.19 | İsteğe bağlı import/entegrasyonlar; Codex fork matcher değişikliği yeni `/hooks` onayı gerektirebilir |
| v15.20 | Hatalı settings ile başlangıç, transcript polling ve tekrar capture engelleme düzeltmeleri |
| v15.21, 17 Kasım 2026 | CLI worker yolu çözümü, Codex dotted TOML plugin durumu, güvenli temp dosyası oluşturma, ilerleme özeti ve backup/import düzeltmeleri |

Resmî release: https://github.com/thedotmack/claude-mem/releases/tag/v15.21.0
Exact commit: `6e13f1f429fae1874bf38ae4d065b4d6179a2d63`.
Tag'deki `docs/CHANGELOG.md` 15.20'de bitiyor; 15.21 maddeleri exact tag Git
commit geçmişinden alındı, changelog'da olmayan bir bölüm varmış gibi sunulmadı.

### Güncel kullanım değerlendirmesi

- Tek root worker ve tek canonical proje korunuyor. Kayıt sayısını veya context
  hacmini sırf yeni özellik var diye artırmadık; 8 gözlem/3 oturum gibi mevcut
  bağlam tercihleri korundu. Yerel arama ve MCP readiness doğrulandı.
- v15'te eski MCP `mem_search` auto/guided ve `flash_search` kaldırıldı.
  Güncel skill ile `search → timeline → get_observations` kullan; tek çağrı
  isteyen deterministik akış `dumb_search`. Açık oturum eski tool kataloğunu
  gösterebilir; eklentiyi yeniden yükle/oturumu yeniden aç.
- NVIDIA custom provider yerine native `openai-compatible`/`nvidia-nim` var.
  Model `nvidia/nemotron-3.5-lightning-30b-a3b`; bu sürümün preset varsayılanı da
  bu. Tek yapay Türkçe testte proje adı/port korundu. Uzun sohbetlerde anlam
  kaybının çözüldüğü veya tüm model kataloğunun en yeni seçiminin bu olduğu
  sonucu çıkarılmaz; NVIDIA kataloğu ayrıca bu geçişte karşılaştırılmadı.
- Codex aboneliği kullanan provider sabit bir model zorlamaz:
  `CLAUDE_MEM_CODEX_MODEL` boşsa Codex CLI'nin etkin modelini kullanır.
  Bu makinedeki CLI ayarı `gpt-6.1-sol`; observer şu anda NVIDIA'dır.
  ChatGPT aboneliği ayrı ücretlendirilen OpenAI API anahtarıyla aynı şey değildir;
  abonelik yolu Codex app-server kimlik doğrulamasıdır. Sağlayıcı değiştirilmedi.
- Secret/generic credential redaction açık, kota fallback kapalı; fark edilmeden
  başka ücretli sağlayıcıya geçiş yapılmaz. Bu ayarlar tüm PII'nin çıkarıldığının
  veya özet kalitesinin kanıtı değildir.
- Fork kontrollü kaldığı için otomatik güncelleme kapalı; My Work otomatik AI
  refresh kapalı. Cloud, Team Brain, yeni istemciler ve transcript/subagent
  ingestion örtük açılmadı. Medya/otomatik yedek gibi yeni seçenekleri sırf
  “en gelişmiş” kullanım için etkinleştirmedik.
- Eski yedekler yaklaşık 67 GB yer kaplıyordu. Otomatik silme yapılmadı;
  yedek saklama politikasının ayrıca kararlaştırılması gerekiyor.
