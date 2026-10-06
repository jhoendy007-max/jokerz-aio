# Cambios 2026-10-06

## Alertas con foto del producto
- Los monitores de Walmart, Pokémon Center y Bandai devuelven `imageUrl` (JSON-LD `image` → `og:image` → `twitter:image`; en Walmart también `imageInfo` de __NEXT_DATA__).
- Nuevo endpoint `GET /api/product-image?store=&product=` (`scripts/product-image.mjs`): lee la página del producto una vez y guarda la foto 24 h (fallos 30 min); peticiones simultáneas se agrupan. Cubre Target y las alertas de checkout.
- Caché en el navegador (`lib/productImages.ts`, máx. 300 productos) alimentada por Monitor Health y por las propias alertas.
- `sendAlert` añade la foto si falta (espera como máximo 4 s; si no llega, se envía sin foto). Discord: foto grande en stock / success / price / info y miniatura en el resto. Slack: `image_url` / `thumb_url`. No se usa en alertas de ban.
- Ajuste nuevo en Settings → Discord Webhooks: "Product photo in alerts" (grande / miniatura / sin foto). Por defecto: grande.
- Fotos también en el Dashboard: historial de precio y Upcoming Drops.
- Solo se aceptan URLs https (sin comillas ni espacios; `//` y `http://` se pasan a https).
- Tests: `scripts/product-image.test.mjs` (5), `src/jokerz/lib/alertImage.test.ts` (3).
