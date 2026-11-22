#!/usr/bin/env python3
"""Genera la versión de Recetok para publicar como Artifact de claude.ai.
En un Artifact la IA corre con la cuenta de claude.ai de quien lo abre (window.claude / sample), sin clave de API ni servidor.
Uso: python3 scripts/make-artifact.py [salida.html]   (por defecto: recetok-artifact.html junto a index.html)"""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "index.html").read_text(encoding="utf-8")
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "recetok-artifact.html"

head = src[src.index("<head>") + 6: src.index("</head>")]
body = src[src.index("<body>") + 6: src.index("</body>")]

# 1) head: solo título, fuentes y estilos (el Artifact pone su propio esqueleto, íconos y manifiesto)
SKEL = ":root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.4 system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}"
keep = []
for m in re.finditer(r"<style>[\s\S]*?</style>|<title>[\s\S]*?</title>|<link rel=\"stylesheet\"[^>]*>", head):
    t = m.group(0)
    if t.startswith("<style>"): t = t.replace(SKEL, "", 1)
    keep.append(t)
if not any(k.startswith("<title>") for k in keep): sys.exit("sin <title>")
keep.sort(key=lambda t: 0 if t.startswith("<title>") else 1 if t.startswith("<link") else 2)   # el título va primero (se lee en los primeros 8 KB)
frag = "\n".join(keep)

# 2) body: sin standalone.js (la IA es la del Artifact) y con textos que no prometen ver videos
body = body.replace('<script src="/standalone.js"></script>', "")
def sub(a, b):
    global body
    if a not in body: sys.exit("no se encontró: " + a[:60])
    body = body.replace(a, b, 1)
sub("Pega el link de un video de YouTube o TikTok y la IA lo ve por ti. Con otras redes o blogs, acompaña el link con el texto o sube una captura del plato.",
    "Pega el link del video junto con su descripción o la transcripción, o sube una captura del plato. Claude lee el texto y las imágenes (no puede ver videos).")
i = body.index('Con una captura del plato terminado se recorta la foto de la comida.'); j = body.index("</p>", i)
body = body[:i] + "Con una captura del plato terminado se recorta la foto de la comida. En esta versión Claude trabaja con tu cuenta de claude.ai: copia la descripción o el texto del video junto al link." + body[j:]

res = frag + "\n" + body
out.write_text(res, encoding="utf-8")
print(out, len(res) // 1024, "KB")
