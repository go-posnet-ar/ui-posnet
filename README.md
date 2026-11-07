# posnet-front

Simulador web del flujo de pago QR de [posnet](https://github.com/go-posnet-ar/go-posnet). Tiene dos páginas:

- **Cajero** ([`index.html`](index.html)): se ingresa el monto, se genera el QR y se espera el resultado.
- **Pago** ([`pay.html`](pay.html)): la abre el teléfono del cliente al escanear el QR, muestra el monto y paga.

Es HTML, CSS y JavaScript plano: no tiene build ni dependencias. Solo carga
[qrcodejs](https://github.com/davidshimjs/qrcodejs) desde cdnjs para dibujar el QR.

## Flujo

```
Cajero (index.html)                 API Gateway :8000                Teléfono (pay.html)
──────────────────                  ─────────────────                ───────────────────
POST /api/sessions/create  ───────► Terminal Gateway
  ◄── transaction_id, pay_token, qr_content
muestra el QR (qr_content) ··························· escanea ··► /pay/{id}#t=<token>
                                                                     GET  /api/sessions/{id}/status
                                                                     POST /api/sessions/{id}/pay
GET /api/sessions/{id}/status  (polling cada 1,5 s)                  GET  /api/sessions/{id}/status
  ◄── APPROVED / REJECTED / EXPIRED                                    (polling cada 1,2 s)
```

1. El cajero ingresa el monto y crea la sesión. La respuesta trae `qr_content`, la URL de la página de pago.
2. El cajero dibuja el QR y consulta el estado hasta tener un resultado, o hasta que vence la sesión (5 minutos).
3. El teléfono abre la URL, consulta la sesión, muestra el monto y, 1,5 s después, paga solo.
4. Las dos páginas muestran el resultado: aprobado con su código de autorización, rechazado con su motivo, o vencido. Si
   el rechazo trae `capture_card` (el emisor ordenó retener la tarjeta, o está en la blocklist), el cajero muestra
   **RETENER TARJETA**.

El cajero también tiene **SIMULAR PAGO**, para pagar sin un teléfono, y **CANCELAR**, para cerrar la sesión antes de que se
pague. Si la sesión ya se está procesando, Terminal Gateway no la cancela y vence sola; el motivo queda en la consola del
navegador.

## Endpoints que usa

Todos pasan por el API Gateway de posnet, en el puerto 8000, que los envía a Terminal Gateway.

| Página | Método y ruta | Encabezados |
|---|---|---|
| Cajero | `POST /api/sessions/create` | `Authorization`, si se cargó el token del terminal |
| Cajero y teléfono | `GET /api/sessions/{id}/status` | `X-Session-Token` |
| Cajero (SIMULAR PAGO) y teléfono | `POST /api/sessions/{id}/pay` | `X-Session-Token` |
| Cajero (CANCELAR) | `POST /sessions/{id}/cancel` | `Authorization`, si se cargó el token del terminal, y `X-Terminal-ID` |

Sin tokens de terminal configurados, Terminal Gateway identifica al terminal por `X-Terminal-ID`, que el cajero envía con el
terminal de prueba de posnet (`TRM-0001`). Con tokens, lo ignora y usa el del token.

Los datos de tarjeta son fijos: `VISA` con `0000` desde el teléfono y `1234` desde el cajero.

## Token de la sesión

Terminal Gateway exige un token por sesión en `/pay` y `/status`, para que un ID de sesión solo no alcance para pagarla ni
ver su estado:

- **Cajero:** guarda el `pay_token` que devuelve `create`.
- **Teléfono:** lo recibe en el **fragmento** de la URL del QR (`/pay/{id}#t=<token>`). El navegador no envía el fragmento al
  servidor web, así que no queda en sus logs ni en el `Referer`. Al cargar, la página lo saca de la barra de direcciones,
  para que no se comparta al copiar la URL.
- **Las dos:** lo envían en `X-Session-Token`.

Si Terminal Gateway no devuelve `pay_token` (una versión anterior), las páginas siguen funcionando sin él. Terminal Gateway
lo exige con `PAY_TOKEN_REQUIRED=true`, el valor por defecto fuera de desarrollo.

## Cómo levantarlo

### Requisitos

- **El backend de posnet levantado con Docker Compose**, incluido el API Gateway en el puerto 8000.
- **Un servidor web que haga dos cosas,** además de servir los archivos estáticos:
  - Entregar `pay.html` para cualquier `/pay/{id}`: el QR apunta a esa ruta, que no existe como archivo.
  - Enviar `/api/` al API Gateway: la página de pago llama a la API **en su mismo origen**.
- **El puerto 5173:** `qr_content` apunta a `http://<POSNET_HOST>:5173/pay/{id}`, y el API Gateway acepta por CORS los
  orígenes `http://localhost:5173` y `http://192.168.0.2:5173`. Para usar otro host o puerto, hay que cambiar
  `POSNET_HOST` en Terminal Gateway y `GATEWAY_CORS_ALLOWED_ORIGINS` en el API Gateway.
- **Para escanear con un teléfono,** que esté en la misma red que el host de `POSNET_HOST`.

### Con nginx

Guardar esta configuración como `nginx.conf` en la raíz del repo:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    # Cajero
    location = / {
        try_files /index.html =404;
    }

    # Página de pago: el QR apunta a /pay/{id}
    location /pay/ {
        try_files /pay.html =404;
    }

    # La página de pago llama a la API en su mismo origen
    location /api/ {
        proxy_pass http://gateway:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        try_files $uri =404;
    }
}
```

Y levantar nginx en la red `edge` de Docker Compose de posnet, con la IP fija `172.30.0.20`. Así llega al API Gateway por su
nombre, y el API Gateway, que confía en esa IP (`GATEWAY_TRUSTED_PROXIES`), aplica su límite por IP de `/pay` y `/status` a
cada teléfono, y no a nginx:

```bash
docker run -d --name posnet-front --network posnet_edge --ip 172.30.0.20 -p 5173:80 \
  -v "$PWD/index.html:/usr/share/nginx/html/index.html:ro" \
  -v "$PWD/pay.html:/usr/share/nginx/html/pay.html:ro" \
  -v "$PWD/css:/usr/share/nginx/html/css:ro" \
  -v "$PWD/js:/usr/share/nginx/html/js:ro" \
  -v "$PWD/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine
```

Se montan solo los archivos de la aplicación: con el directorio entero, nginx también serviría `.git/` y `nginx.conf`.

### Configurar el cajero

Abrir `http://<host>:5173/` y revisar los dos campos de arriba:

| Campo | Qué cargar | Dónde se guarda |
|---|---|---|
| **API** | La URL del API Gateway. Por defecto, `http://192.168.0.2:8000` | `localStorage`. Si tenía el valor anterior, `:9091`, se reemplaza por el nuevo |
| **TOKEN** | El token del terminal, si Terminal Gateway tiene `TERMINAL_TOKENS_FILE`. Vacío, no se envía | `sessionStorage`: se borra al cerrar la pestaña |

Los dos se guardan al crear una venta.

### Verificar

```bash
# Crear una sesión y abrir la página de pago a través de nginx
ID=$(curl -s localhost:8000/api/sessions/create -H 'Content-Type: application/json' \
  -d '{"amount_cents":100}' | jq -r .transaction_id)
curl -s -o /dev/null -w '%{http_code}\n' localhost:5173/pay/$ID                   # 200
curl -s localhost:5173/api/sessions/$ID/status | jq .state                     # "AWAITING_PAYMENT"
```

Si Terminal Gateway exige el token, la última consulta responde `401`: hay que agregar
`-H "X-Session-Token: <pay_token>"`, con el valor que devuelve `create`.

## Estructura

| Archivo | Contenido |
|---|---|
| [`index.html`](index.html), [`js/posnet.js`](js/posnet.js) | Cajero: teclado, QR, cuenta regresiva, polling y resultado |
| [`pay.html`](pay.html), [`js/pay.js`](js/pay.js) | Página de pago del teléfono |
| [`css/style.css`](css/style.css) | Estilos de las dos páginas |

## Problemas conocidos

| Problema | Consecuencia |
|---|---|
| El token del terminal se guarda en el navegador | Mientras la pestaña esté abierta, cualquier script de la página puede leerlo. Sirve para el simulador; un terminal real necesita otro almacenamiento |
| El pie del cajero muestra `TRM-0001` fijo | Es el terminal de prueba de posnet. Con el token de otro terminal, el pie no cambia |
| Sin tests | Los cambios se prueban a mano, con el [flujo completo](#verificar) |
