# Cambios v2026.10.05-cleanup (base: v2026.09.23-no-reload)

## Errores corregidos (fallaban en tiempo de ejecución)
- `engine/modules/target.ts`, `walmart.ts`: faltaba `import { API_BASE }` (ReferenceError en todas las llamadas a la API).
- `engine/modules/base.ts`: faltaba importar el tipo `EngineTaskConfig`.
- `components/TasksView.tsx`: mensaje usaba variable inexistente `key` → ahora `store`.
- `engine/modules/walmart.ts`: `productId` usado antes de declararse y referencia a `tcin` (variable de Target) en el monitor de Walmart.

## Tipos corregidos
- `StockResult` (target/walmart): campos `blocked`, `rateLimited`, `retryAfterMs`, `finalUrl` que ya se usaban.
- `getProxyGroupStats`: tipo de retorno incluye `available` y `nextAvailableMs`.
- `BotSettings.ispRotateEveryN` y `PersistedSession.accountEmail` declarados.
- `proxyIntelligence.ts`: spread tipado correctamente.

## Proyecto
- `.gitignore` nuevo: excluye `node_modules`, `.env`, `.sessions/`, `.cookie-bank.json`, `.redsky-key.json`, logs.
- `npm test`: el patrón `scripts/**/*.test.mjs` no funciona en Node 20 → `scripts/*.test.mjs`.

## Pendiente (no tocado)
- Quedan ~230 avisos de TypeScript, casi todos `data` de tipo `unknown` tras `res.json()`; conviene definir interfaces de respuesta.
- 8 tests fallan (brand-check, check-auth-invariant, with-app-env, write-atomic): son de la plantilla de Grok Build, no del bot.

## Monitores (Walmart / Pokémon Center / Bandai)
- Nuevo `scripts/monitor-common.mjs`: un solo `proxyUrl`/`fetchText` en vez de 4 copias.
- `ProxyAgent` reutilizado por proxy (antes se creaba uno nuevo por request → fuga de conexiones).
- Pokémon y Bandai leen primero el JSON-LD del producto (precio, nombre, disponibilidad). Antes el precio era el primer `$` de la página y textos como "sold out"/"pre-order" en otras partes de la página daban falsos negativos/positivos.
- HTTP 429 ahora se reporta como `RATE_LIMITED` con `retryAfterMs` (cabecera Retry-After) para esperar en vez de reintentar a ciegas.
- Nuevo campo `proxyIgnored`: avisa si se pidió proxy pero no se pudo usar (ver nota: `undici` no está en `package.json`).
- `createChangeTracker()`: utilidad para alertar solo en cambios (restock / cambio de precio) con cooldown, sin spam.
- Tests: `scripts/monitor-common.test.mjs` (9 tests).

## Dashboard: Monitor Health
- Nuevo panel `MonitorHealthPanel` en el Dashboard: contadores **Rate limited** y **Proxy ignored**, tabla por tienda/producto con estado, cuenta atrás de Retry-After, nº de 429 y última actualización.
- Aviso rojo cuando un proxy se ignora (falta `undici`).
- `lib/monitorHealth.ts`: almacén en memoria alimentado por los módulos Walmart, Pokémon Center y Bandai.

## Alertas Discord/Slack sin repeticiones
- `engine/alertDedupe.ts` conectado en `sendAlert()`: todas las alertas de stock, precio y cola de Target, Walmart, Pokémon Center y Bandai pasan por el filtro.
- Una sola alerta por producto aunque lo vigilen varias tareas; sin re-alertar si el stock parpadea dentro del cooldown; alertas de precio solo si el precio cambia.
- Éxitos, declines, bans e info nunca se filtran.
- Ajuste nuevo en Settings → Discord Webhooks: **Alert cooldown (seconds)**, por defecto 300, 0 = desactivado.
- Contador "Duplicate alerts blocked" en el panel Monitor Health.
- Tests: `engine/alertDedupe.test.ts` (5 tests).

## Tests antiguos arreglados (8)
- Restaurado `.grok/app-env.json` (`VITE_AUTH_ENABLED: "false"`), que se perdió al empaquetar el ZIP → arregla 4 tests (with-app-env ×3, check-auth-invariant ×1).
- 4 tests que validan la documentación interna de Grok Build (`.grok/skills/og`, no incluida en el repo) ahora se omiten si esa carpeta no existe.
- CI: la suite completa (`npm test`) pasa a ser bloqueante.

## Estabilización de módulos (1 + 2 + 4)
- `engine/apiTypes.ts`: `StockResult` único para Target/Walmart/Pokémon/Bandai (antes 4 copias distintas) y esquemas `zod` para las respuestas de `/api/monitor/*` y `/api/checkout/*`.
- `parseApi()` nunca lanza: JSON inválido o forma incorrecta → `{ ok:false, error }`; solo descarta el campo inválido y conserva el resto. Convierte precios numéricos a `"$12.34"`.
- Bug corregido: `res.json().catch(...)` en Target (keepalive y task-bind) — `json()` es síncrono, así que el `.catch` lanzaba TypeError siempre.
- Bug corregido: el checkout de Target emitía la respuesta cruda del servidor → el Dashboard mostraba "Unknown" en tienda/producto.
- Bug corregido: los dry-runs contaban como checkouts reales y sumaban al gasto total del Dashboard. Ahora se muestran como "(dry run)" sin contar.
- Pausa por rate limit: si el monitor recibe 429, la tarea espera lo que indica Retry-After (30 s por defecto, mínimo el intervalo de la tarea, máximo 10 min) en lugar de reintentar enseguida. `rateLimited`/`retryAfterMs`/`proxyIgnored` ahora llegan desde el servidor hasta la tarea.
- Errores de TypeScript: 230 → 23 (los módulos quedan a 0).
- Tests: `engine/apiTypes.test.ts` (6 tests).

## TypeScript: 23 → 6
- Pantallas: Dashboard (`loadDashboardStats`), Profiles (ZIP opcional), Settings (`managingStore` puede ser null, `captchaProvider`, estados de harvesters), Tasks (ramas muertas del color de estado, título del log usaba `task.name` inexistente → `task.product`).
- `proxy.ts`: `getProxyGroupStats` siempre devuelve `available`.
- `cryptoSessions.ts`: tipos `Uint8Array<ArrayBuffer>` para WebCrypto.
- `storage.ts`: `maxProxyLatencyMs` declarado en `BotSettings`.
- Quedan 6 en `antiDetect.ts` (5) y `captchaDetect.ts` (1, `pickSitekey` no existe), sin tocar.
