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
