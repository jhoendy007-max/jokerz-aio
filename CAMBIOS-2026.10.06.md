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

## Resumen diario por Discord
- Un mensaje al día (hora configurable, por defecto 21:00) con lo de las últimas 24 h:
  - **Restocks**: hora, producto, tienda, precio y cuánto duró en stock (o "still in stock").
  - **Cambios de precio**: antes → después y % (primero las mayores bajadas).
  - **Checkouts**: completados (con nº de pedido, unidades y total gastado), fallidos con motivo, y dry runs aparte.
  - Totales arriba y productos monitorizados.
- Settings → Webhooks → "Daily summary": activar, hora, webhook propio opcional, omitir días vacíos, "Preview" y "Send now".
- Se envía con la app abierta; si estaba cerrada a esa hora, se envía al abrirla (una sola vez por día).
- Nuevo registro de checkouts (`jokerz_aio_checkout_log`, 14 días) alimentado desde el Engine, independiente de qué pantalla esté abierta.
- Arreglo: el Engine ya no cuenta los dry runs como checkouts en las estadísticas.
- `lib/dailySummary.ts` (lógica pura) + `lib/dailySummaryRunner.ts` + `components/DailySummarySettings.tsx`; 5 tests.

## Monitores y logins (9 mejoras)

1. **Revisar producto al crear la tarea**: botón "Check product" en el formulario (Target / Walmart / Pokémon Center / Bandai). Muestra foto, título, precio y estado. Endpoint `POST /api/monitor/probe`.
2. **Polling adaptativo**: nunca más rápido que tu delay; ×1.5 tras 10 min sin cambios, ×2 tras 30 min, ×3 tras 2 h (máx. 2 min); vuelve a tu delay 30 min antes de un drop programado. Ajuste en Settings → Webhooks → Monitors & sessions.
3. **Monitor atascado**: STALLED si no hay respuesta válida en 5 min o hay 10 errores seguidos (configurable). Alerta Discord una vez y aviso al recuperarse. Badge y columna "Why" en Monitor Health.
4. **Mismo formato en las 4 tiendas**: el servidor añade `state` y `reason` a cada respuesta de monitor.
5. **Test monitor**: botón en Monitor Health; ejecuta el monitor una vez y muestra la respuesta cruda.
6. **Login manual asistido**: Settings → Accounts → "Log in manually". Abre un navegador normal en el login de la tienda, entras tú y "Save session" guarda las cookies. No automatiza formularios.
7. **Panel de cuentas**: ACTIVE / EXPIRING / EXPIRED / NO SESSION, esperando 2FA, último login, tiempo restante.
8. **Aviso de sesión vencida**: alerta Discord cuando quedan < 1 h y cuando vence.
9. **Errores de login claros**: `errorCode` + `friendlyError` en las rutas de login; se ven en logs de tareas y en Live Login.

Tests: `scripts/monitor-status.test.mjs` (6) y `src/jokerz/lib/monitorPolicy.test.ts` (5).
