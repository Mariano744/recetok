# Recetok — app instalable

Esta carpeta es la app completa: se instala en Android, iPhone o computadora desde el navegador y funciona sin internet para el recetario, la semana, la lista de compras y el modo cocina. La IA (analizar recetas, versión saludable, refri, sustituciones y preguntas) usa tu clave de Anthropic a través de un pequeño servidor en Vercel.

## 1. Publicar en Vercel (una sola vez)

Ya existe el proyecto **recetok** en tu equipo de Vercel ("Mariano's team"), con el código de acceso configurado.

**Opción A — con una computadora y Node.js instalado**
1. Descomprime esta carpeta.
2. Abre una terminal dentro de ella y escribe: `npx vercel@latest link` → elige *Mariano's team* y el proyecto existente **recetok**.
3. Luego: `npx vercel@latest deploy --prod`

**Opción B — sin terminal (con GitHub)**
1. Crea un repositorio nuevo en github.com y sube todos los archivos de esta carpeta (botón *Add file → Upload files*).
2. En vercel.com abre el proyecto **recetok** → *Settings → Git* → conecta ese repositorio. Cada vez que subas cambios, se publica sola.

## 2. Activar la IA

Lo más simple: abre la app, usa cualquier función de IA y te pide tu **clave de Claude** una vez (empieza con `sk-ant-`; la creas en https://console.anthropic.com → *API Keys* y cargas saldo). Se guarda solo en ese dispositivo y las consultas van directo a Claude (Sonnet 5.5 para recetas, Haiku 5.5 para lo rápido). Para cambiarla o quitarla: enlace **Clave de Claude** al final de la pantalla principal. No hay que configurar nada en Vercel.

Claude no ve videos: con un link de YouTube/TikTok, pega también la descripción o la transcripción, o sube una captura.

**Opcional, en Vercel** (solo si quieres el servidor): `GEMINI_API_KEY` (ver videos), `ANTHROPIC_API_KEY` y `APP_CODE` (la IA desde el servidor, con el código de acceso), `POLLINATIONS_API_KEY` (fotos de platos sin logo). Las fotos de ingredientes con búsqueda inteligente usan ese servidor.

## 3. Instalar en tu celular

- **Android (Chrome):** abre el link de tu app → botón **Instalar** arriba (o menú ⋮ → *Instalar aplicación*).
- **iPhone (Safari):** abre el link → **Compartir** → **Agregar a pantalla de inicio**.
- **Computadora (Chrome/Edge):** ícono de instalar en la barra de direcciones.

## Notas

- Tus recetas se guardan en cada dispositivo. Para pasarlas a otro, usa **Recetario → Exportar copia** e **Importar** en el otro.
- El código de acceso evita que otras personas gasten tu saldo si encuentran el link. No lo compartas con quien no quieras.
- Modo cocina: es un juego (estufa, ollas, ingredientes que se arrastran, minijuegos, estrellas y nivel de cocinero) que acompaña la receta real paso a paso. Las fotos de los ingredientes son reales: las verduras, frutas y especias comunes vienen recortadas de TheMealDB; el resto se busca en fotos de licencia libre (Openverse y Wikimedia Commons), tu clave de Gemini elige la mejor y marca dónde está el ingrediente, y la app la recorta. Los autores y licencias aparecen al final del modo cocina, en "Fotos de los ingredientes". Si no hay una buena foto, se dibuja el alimento con su color (los líquidos, en un bol).
- Archivos: `index.html` (la app), `standalone.js` (conexión con la IA e instalación), `sw.js` (modo sin conexión), `manifest.webmanifest` e `icons/` (ícono y nombre de la app), `api/claude.js` (servidor que guarda tu clave).
