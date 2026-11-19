# Estado de la integración de pagos — 17/11/2026

**Implementación:** PayPal Orders v2, SDK oficial PayPal + REST API desde Node. Los cobros no usan respuestas simuladas en el servidor normal.

**Verificado localmente:** sintaxis de Node/JS, catálogo, importes, 5 artículos diferentes, recuperación por código, idempotencia de captura, rechazo sin credenciales, estado de órdenes y conciliación. Las pruebas automáticas están separadas en `/tests` y usan un mock solamente para desarrollo.

**NO verificado (requiere al titular de la cuenta PayPal):** autenticación con credenciales reales, aprobación de un comprador real, captura monetaria efectiva, entrega en el dominio público, webhooks Live y reembolsos en la cuenta comerciante.

**Estado de esta copia:** no incluye Client Secret ni configuración de cuenta vendedora; por seguridad los botones se bloquean. Activar `PAYPAL_ENV=live` sin credenciales no genera pagos.

**Antes del primer cobro a terceros:** seguir `PAGOS_REALES_LEER_PRIMERO.md`, realizar pruebas Sandbox y una compra Live de importe pequeño, verificar desde PayPal el importe y la entrega, asegurar base de datos persistente y atención al cliente.
