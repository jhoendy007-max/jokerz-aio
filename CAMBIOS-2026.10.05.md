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
