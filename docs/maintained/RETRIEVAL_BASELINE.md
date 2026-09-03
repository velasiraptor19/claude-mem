# Retrieval Kabul Baseline'ı V1

Bu baseline, `claude-mem` projesinden seçilmiş 20 sabit tarihsel gözlemin
anlamsal aramada ilk beş sonuç içinde bulunmasını ölçer. Tarih üst sınırı,
benchmark sorgularının kendi gözlemlerini sonuçlara karıştırmasını engeller.

Çalıştırma:

```bash
node scripts/verify-retrieval-acceptance.cjs \
  > /tmp/claude-mem-retrieval-acceptance-v1.json
```

Kabul kapısı: 20/20 Hit@5, HTTP/MCP hatası yok ve `meanReciprocalRank` önceki
onaylı baseline'a göre izlenir. Hit@5 yalnız retrieval erişimini kanıtlar;
NVIDIA özetlerinin olgusal doğruluğu ayrıca seçilmiş tam kayıtların güncel
dosya/Git kanıtıyla incelenmesini gerektirir.

Fixture: `tests/fixtures/maintained-retrieval-acceptance-v1.json`.
