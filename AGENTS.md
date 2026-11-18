# claude-mem Bakımı Yapılan Depo Kuralları

Şu belgeleri okuyup uygula:

- `docs/maintained/UPGRADE_RUNBOOK.md`
- `docs/maintained/UPGRADE_HISTORY.md`
- `docs/maintained/CUSTOMIZATIONS.md`
- `docs/maintained/UPSTREAM_13.14_TO_13.24.md`
- `docs/maintained/RETRIEVAL_BASELINE.md`
- `docs/maintained/GLOBAL_CODEX_AGENTS.md`

Mantıksal hafıza projesi `claude-mem`dir; sürüm worktree'leri ayrı hafıza
projeleri değil, tarihsel kaynak varyantlarıdır. Hafıza araması bir indekstir,
yayın otoritesi değildir: güncel dosyalar, Git diff'leri, resmî etiketler,
manifestler, attestation kayıtları ve kalıcı makbuzlar önceliklidir.

Güncellemede resmî etiketten birebir aday oluştur; aynı paket sürümündeki
upstream ve bakımı yapılan ağacı `scripts/maintained-diff-report.cjs` ile
karşılaştır; bu diff'i ve upstream sürümler arası diff ile kesişimini incele;
tam manifesti derleyip doğrula ve yalnız `maintained-upgrade.sh` üzerinden
terfi ettir. Tek root worker durdurulmadan önce hook'lar kalıcı biçimde
ayrılmış ve drain edilmiş olmalıdır. Yayın fence'ini asla atlama; kanıtlanmamış
lease'i silme; SQLite/Chroma'yı doğrudan değiştirme; ilgisiz legacy MCP
sürecini öldürme; güncelleme sırasında isteğe bağlı istemci/sağlayıcı açma.

Etkin istemciler Claude ve Codex'tir. Cursor, Grok Bot, Cowork, bulut eşitleme,
gateway ve pilotlar açık kullanıcı onayı gerektirir. NVIDIA girdileri sınırlı
olmalı; sır, kimlik bilgisi, PHI, ödeme verisi veya gereksiz ham transcript
içermemelidir.

Bakımı yapılan her değişiklikten sonra regresyon testi ekle, üretilen
artifact'leri yeniden derle, manifesti yenileyip doğrula, ilgili
sağlık/kimlik/veri kontrollerini çalıştır ve yeni olay ya da invariant'ı bakım
belgelerine ekle. Değişken PID, hash, sürüm veya canlı durum değerlerini bu
dosyaya yazma.
