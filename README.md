# APEX Scalp

- `cloudflare-worker/` — Gate.io Futures ile konuşan backend (Cloudflare Worker)
- `frontend/` — mobil trading arayüzü (bir sonraki adımda modüler hale getirilecek)

## Worker v16.2 — bu sürümde düzeltilen buglar

1. **fillPrice eksikliği (kritik):** `/order` ve `/close` yanıtları artık
   gerçek işlem fiyatını `fillPrice` alanında dönüyor. Öncesinde frontend
   bu alanı okuyordu ama worker hiç göndermiyordu — pozisyon giriş/çıkış
   fiyatları sinyal anındaki tahmini fiyatta donmuş kalıyordu.
2. **`/gateio_tickers` eksikliği:** Frontend'deki "TOP VOLUME" butonu
   sürekli 404 alıyordu. Endpoint eklendi, Gate.io'nun `last` alanı
   frontend'in beklediği `last_price` ismiyle normalize edildi.

## Cloudflare'a deploy

```bash
cd cloudflare-worker
npm install
npx wrangler login          # tarayıcıda Cloudflare hesabınızla giriş
npx wrangler secret put GATE_API_KEY
npx wrangler secret put GATE_SECRET
npx wrangler deploy
```

Deploy sonrası worker URL'i değişmez (aynı `nexus-agent-backend` adına
deploy edilir), uygulamadaki WORKER URL ayarını değiştirmenize gerek yok.

## Doğrulama

Deploy sonrası hızlı kontrol:

```bash
curl https://nexus-agent-backend.<hesabınız>.workers.dev/ping
```

`version` alanının `16.2` olduğunu ve `features.gateioTickers: true`
döndüğünü görmelisiniz.
