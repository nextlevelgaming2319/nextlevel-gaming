# NextLevel Gaming News — Integración REAL de PayPal

## Qué hace esta versión

El sitio utiliza el SDK oficial de PayPal y el servidor llama directamente a **PayPal Orders v2** (no usa una simulación durante las compras). Cuando el comprador acepta el pago, el servidor lo captura, verifica el identificador del pedido, que el importe es exactamente el esperado en USD y que el destinatario es el vendedor configurado; **solo después** acredita los artículos en la base de datos. Si se pierde la conexión, el botón «Comprobar pago en PayPal», los webhooks y una comprobación periódica permiten recuperar pedidos confirmados.

Productos: marco normal USD 0,75; marco GODLIKE USD 3,00; fondo USD 1,25; fondo GODLIKE USD 3,00; cinco marcos distintos a elección USD 2,00; Premium por **30 días** USD 2,99 en **pago único, NO suscripción renovable**. No prometer renovaciones automáticas.

**Esta entrega NO contiene claves privadas reales ni ha cobrado dinero.** Sin configurar las credenciales privadas de la cuenta PayPal del vendedor, los botones de cobro permanecen deshabilitados para proteger a los clientes. Las pruebas automatizadas incluidas utilizan un proveedor simulado SOLO durante `npm test`, no en el servidor de producción.

## Pasos para que funcionen con dinero real

1. El titular de la cuenta vendedora accede a https://developer.paypal.com/dashboard/applications y crea o selecciona una **REST App** de tipo Merchant. En **Live**, obtiene el **Client ID** y el **Secret**. No poner el `Secret` en HTML, ChatGPT, GitHub ni archivos públicos.
2. Subir este ZIP a un alojamiento que ejecute **Node.js 22+ con HTTPS y almacenamiento persistente** (por ejemplo, una máquina/servicio con disco persistente). Un sandbox estático no sirve para entregar compras. Ejecutar `npm start` con las variables privadas del alojamiento:

```
NODE_ENV=production
PUBLIC_BASE_URL=https://TU-DOMINIO-PUBLICO
PORT=3000
PAYPAL_ENV=live
PAYPAL_CLIENT_ID=TU_CLIENT_ID_LIVE
PAYPAL_CLIENT_SECRET=TU_SECRET_LIVE
PAYPAL_MERCHANT_ID=ID_REAL_DEL_VENDEDOR
PAYPAL_WEBHOOK_ID=ID_DEL_WEBHOOK_LIVE
NLG_PERSISTENT_DIR=/directorio-con-disco-persistente
NLG_COMMERCE_ENABLED=YES
PAYPAL_LIVE_ENABLED=YES
```

**Los IDs en mayúsculas son marcadores, no valores válidos.** Se introducen como secretos/variables en el panel privado del alojamiento. Un servidor desplegado detrás de HTTPS puede usar el puerto interno 3000.

3. En el panel **Live** del mismo comercio PayPal crear un webhook en `https://TU-DOMINIO-PUBLICO/api/store/webhook` y suscribir: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`. Copiar su Webhook ID al secreto `PAYPAL_WEBHOOK_ID`.
4. En el servidor ejecutar `npm run paypal:verificar`; debe responder **CONEXIÓN REAL A PAYPAL: OK** y entorno LIVE. Luego abrir `https://TU-DOMINIO-PUBLICO/api/store/connection`; debe responder `connectedToPayPal:true` y `checkoutEnabled:true`. *Esto verifica credenciales y configuración, todavía no una transacción.*
5. **Antes de permitir compras de clientes**, hacer las mismas pruebas con un segundo despliegue en `PAYPAL_ENV=sandbox` y credenciales Sandbox. Probar cada precio/producto, selección de 5 marcos, recarga, pérdida de conexión, segundo dispositivo, reembolsos, webhooks, compras duplicadas e inventario. Consultar el historial de PayPal y verificar el resultado en la base de datos.
6. Hacer una compra LIVE real de importe pequeño, con un comprador autorizado por ustedes, verificar en el panel vendedor el pago y comprobar la entrega, la persistencia y la capacidad de reversión. **Sin esta compra real no se puede afirmar que la tienda esté verificada de extremo a extremo.**

## Seguridad y soporte

- El comprador recibe un código privado de recuperación de sus compras, equivalente a una contraseña. Debe guardarlo en privado. Sin él, no hay garantía de recuperación automática entre dispositivos.
- Hacer **copias de seguridad diarias** del directorio persistente con la base de datos SQLite; protegerlo contra acceso público y no borrarlo al actualizar el proyecto.
- Cualquier problema de entrega o reclamación debe gestionarse por un contacto real de soporte; hay que añadir datos comerciales, política de privacidad, condiciones de venta y mecanismo de reembolso/arrepentimiento aplicables antes del lanzamiento público.
- Las compras que hayan ocurrido antes mediante Hosted Buttons no se migran solas. Deben revisarse en el historial PayPal de su cuenta vendedora.
- Ninguna prueba en local, sin credenciales, puede probar la captura de dinero real ni la identidad/permiso de la cuenta vendedora.

Fuentes oficiales: https://developer.paypal.com/checkout/integrate , https://developer.paypal.com/api/rest/production/ , https://developer.paypal.com/api/rest/webhooks/rest/.
