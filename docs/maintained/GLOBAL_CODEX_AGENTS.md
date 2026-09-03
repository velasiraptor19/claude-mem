# Global Codex için claude-mem talimatı

Bu bölüm `/root/.codex/AGENTS.md` içindeki claude-mem politikasının Git ile
izlenen canonical şablonudur. Canlı global dosyaya kopyalanırken mevcut global
harness bağlantısı korunmalıdır.

```markdown
- claude-mem'in hook, MCP, eklenti ve skill bileşenleri kurulu kabul edilir;
  normal kayıt ve SessionStart bağlam enjeksiyonu otomatiktir. İkinci worker
  başlatma veya her istekte elle hafıza kaydetme.
- Önceki çalışma, karar veya düzeltme güncel işi etkiliyorsa
  `claude-mem:mem-search` ile yalnız ilgili geçmişi ara. Güncel dosya ve doğrudan
  kanıt yeterliyse geniş hafıza yükleme.
- İstek açıkça eşleşiyorsa en küçük claude-mem skill setini otomatik kullan:
  davranış/depolama için `how-it-works`, kod keşfi için `smart-explore`, plan için
  `make-plan`, hazır planın uygulanması için `do`. Kalıcı knowledge agent'ı
  yalnız açık istekle oluştur.
- Skill kullanımını kısaca duyur ve seçilen `SKILL.md` dosyasını eksiksiz uygula.
  İlgisiz veya `/root/.codex/config.toml` içinde kapalı yetenekleri açma.
```

Repo-local `AGENTS.md` bunun yerine geçmez. O dosya yalnız maintained kaynak
ağacında release, veri güvenliği, manifest ve doğrulama kurallarını uygular.
