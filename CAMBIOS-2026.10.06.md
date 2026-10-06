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

## Logins más seguros y monitores compartidos

- **Sesión manual primero**: si la cuenta tiene una sesión guardada con "Log in manually", los logins de Target y Walmart la usan hasta que vence (según las cookies de la tienda, máx. 3 días) sin abrir el login automático. La cuenta ya no necesita contraseña si tiene sesión manual. Etiqueta MANUAL en el panel.
- **Un login a la vez por cuenta**: varias tareas con la misma cuenta esperan el mismo login (`scripts/login-guard.mjs`).
- **Pausa tras fallos graves**: contraseña incorrecta (30 min), cuenta bloqueada (60), 2FA (10), bloqueo (15), límite de intentos (5). Durante la pausa no se reintenta; botón "Resume" en el panel.
- **Alerta de login fallido** por Discord, una vez por cuenta y motivo. Columna "Last automatic login" en el panel de cuentas.
- **Peticiones de monitor compartidas** (`scripts/monitor-coalesce.mjs`): si varias tareas vigilan el mismo producto con el mismo proxy al mismo tiempo, la tienda recibe una sola petición (reutilización máx. 1 s).
- **Monitor Health**: columnas OK % (respuestas válidas) y Avg ms.
- Arreglos: la clasificación de errores ya no confunde palabras como "bottom" con un bloqueo; las sesiones de distintas tiendas con el mismo correo se guardan por separado.
- Tests: `scripts/login-guard.test.mjs` (6).

## Ronda 4 — herramientas del programa (1, 3, 4, 5, 6, 7, 9, 11, 12, 13, 14)

- **Arranque con un clic (1):** `START-JOKERZ.bat` ahora usa `scripts/launcher.mjs`: revisa Node 20+, instala dependencias si faltan o cambiaron, instala Chromium si no hay navegador, arranca motor + interfaz en UNA ventana, los reinicia si se caen y abre el navegador. `CREATE-SHORTCUT.bat` crea el icono en el Escritorio.
- **Diagnóstico (3):** Dashboard → Diagnostics. Revisa Node, servidor, dependencias, navegador, disco, carpeta de datos, memoria, internet, Target/Walmart/Pokémon Center, webhooks, Telegram, tareas, proxies muertos, cuentas sin contraseña, monitores y espacio usado. Botón "Report" descarga un JSON sin contraseñas.
- **Logs en archivo (4):** `logs/jokerz-AAAA-MM-DD.log`, 14 días. Incluye los logs de las tareas y checkouts. Dashboard → Logs para buscar por texto, nivel y origen, y exportar ZIP. Contraseñas, tokens, webhooks y tarjetas se ocultan antes de escribir.
- **Actualizaciones (5):** Settings → General → Updates. Con un token de GitHub de solo lectura revisa si hay versión nueva, muestra los cambios y la instala sin tocar tus datos (tareas, perfiles, sesiones, `.env`, logs). Guarda copia de los archivos cambiados en `backups/` y corre `npm install` si hace falta. "Restart now" si abriste con START-JOKERZ.bat.
- **Prueba de proxies completa (6):** botón Test en cada grupo (hasta 200 líneas): velocidad, IP de salida, ciudad/país. Un proxy que falla 3 pruebas seguidas queda como "dead" y puedes quitarlo con "Remove dead". No rota nada solo.
- **Salud de cuentas (7):** Settings → Accounts → Account health: logins buenos/fallidos (90 días), último login bueno, checkouts por cuenta y avisos (contraseña probablemente vieja, bloqueada, 2FA, sin usar 30+ días, sin contraseña).
- **Resultados (9):** nueva pestaña Results: checkouts por día (gráfica), por tienda, top productos, % de éxito, total gastado, motivos de fallo. 7/30/90 días. El historial de checkouts ahora guarda 90 días.
- **Registro de órdenes (11):** Results → Orders. Cada checkout real se agrega solo. "Scan email" lee (solo lectura) tus correos de confirmación/envío/entrega/cancelación de Target, Walmart, Pokémon Center y Bandai con IMAP y App Password. Estado editable y exportar CSV.
- **Calendario de drops (12):** Import desde archivo o link (.ics, .csv, .json), sin duplicados. Cada drop puede arrancar tareas de MONITOR X minutos antes (nunca tareas de checkout).
- **Más canales de alertas (13):** Telegram (con "Find chat id"), notificación del navegador con sonido y email (SMTP con App Password). Cada canal elige qué tipos de alerta recibe. Mismas reglas anti-repetición que Discord.
- **Comandos por Telegram (14):** /status, /tasks, /start [tienda], /stop [tienda], /summary, /drops, /health, /help. Solo responde a tu chat. La ventana de la app tiene que estar abierta. (Discord no: necesitaría un bot con gateway aparte.)
- Backup ahora incluye Orders y el historial de resultados.
