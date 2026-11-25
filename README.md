# Session Lab

Minijuego educativo sobre secuestro de sesión web. Incluye diez preguntas con
cuatro opciones (A-D), tres vidas, puntuación, temporizador de 25 segundos y
los comodines 50/50 y escudo (un uso por partida). El modo individual corre en
el navegador; el modo grupal permite crear una sala remota con código para
hasta ocho participantes y mantiene un marcador compartido en tiempo real.
Cada jugador responde desde su propio dispositivo y conserva sus puntos,
vidas y comodines. Las salas son temporales y se guardan en memoria mientras
el servicio está activo.

El 50/50 elimina dos opciones incorrectas y deja dos respuestas posibles. Si
se acaba el tiempo, se pierde una vida. El escudo activado antes de responder
protege de un error sin sumar puntos ni restar vidas. Si un participante se
queda sin vidas, puede seguir observando las explicaciones hasta que termine la
sala.

## Ejecutar localmente

1. Instala Node.js.
2. Ejecuta `npm ci`.
3. Ejecuta `npm start`.
4. Abre `http://localhost:3000`.

El modo individual también funciona al abrir `index.html` directamente. Para
probar salas grupales, usa el servidor local para que la conexión WebSocket
esté disponible.

## Publicar en Render

El archivo `render.yaml` configura el sitio estático y el servicio Node.js
gratuitos que sincroniza las salas por WebSocket. En Render, crea o sincroniza
un **Blueprint** conectado a este repositorio de GitHub. Al desplegarse, la
página se publica en `https://session-lab-sesiones-inseguras.onrender.com` y el
servicio de salas en `https://session-lab-salas.onrender.com`.

Render puede suspender los servicios gratuitos tras un periodo sin actividad;
la primera conexión posterior puede tardar en despertar. Las salas no son
persistentes y se eliminan al expirar o reiniciarse el servicio.

## Uso de IA generativa

Se utilizó IA generativa como apoyo para diseñar e implementar las mecánicas
del concurso y el modo grupal, y preparar la publicación en Render. El juego no
requiere servicios de IA externos.
