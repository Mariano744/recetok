// Foto realista generada por IA. GET /api/foto?q=<descripción>&s=<semilla>&t=<tipo>
// Se piden en tamaño moderado para que salgan rápido (el servicio gratis no da más resolución de todas formas).
// 1) Genera una foto tipo estudio con Pollinations (gratis, sin clave).
// 2) Si falla y existe PEXELS_API_KEY (gratis en pexels.com/api), busca una foto real parecida.
// La respuesta se guarda en la CDN de Vercel, así el mismo plato no se vuelve a generar.

// t=plato (por defecto): el plato servido · t=paso: cómo se ve la olla/sartén/bol en ese paso · t=mise: todos los ingredientes listos
const BASE = "soft natural window light, photorealistic, ultra detailed, sharp focus, no text, no watermark, no people, no hands";
const STYLES = {
  plato: "professional food photography, served on a matte ceramic plate on a rustic wooden table, 45 degree angle, shallow depth of field, appetizing, editorial magazine style, " + BASE,
  paso: "realistic home cooking photo taken from above while cooking, inside the cookware on a home kitchen stove or counter, natural colors and textures, steam if hot, " + BASE,
  mise: "all the ingredients for the recipe measured and laid out in small white ceramic bowls, mise en place, top-down view on a light wooden kitchen counter, neat arrangement, " + BASE,
  ing: "raw ingredient measured in a small white ceramic prep bowl, mise en place, top-down view on a light wooden kitchen counter, clean, " + BASE
};

const SIZE = { paso:[768,576], ing:[512,512] };
async function pollinations(q, seed, deadline, style, t){
  const [w, h] = SIZE[t] || [1024, 768];
  const prompt = encodeURIComponent((q + ", " + style).slice(0, 700));
  const url = "https://image.pollinations.ai/prompt/" + prompt + "?width=" + w + "&height=" + h + "&nologo=true&private=true&enhance=false&model=flux&seed=" + seed;
  for(let i = 0; i < 2; i++){
    const left = deadline - Date.now(); if(left < 8000) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(left - 2000) }).catch(() => null);
    if(r?.ok && /^image\//.test(r.headers.get("content-type") || "")){
      const buf = Buffer.from(await r.arrayBuffer());
      if(buf.length > 8000) return { buf, type: r.headers.get("content-type"), url };
    }
    if(r?.status !== 429 && r?.status !== 502 && r?.status !== 503) return null;
    await new Promise(res => setTimeout(res, 16000));   // límite gratis: 1 imagen cada ~15 s
  }
  return null;
}

// Ancho y alto reales de un JPEG/PNG (para comprobar la resolución)
function dims(b){
  if(b[0] === 0x89 && b[1] === 0x50) return { w:b.readUInt32BE(16), h:b.readUInt32BE(20) };
  for(let i = 2; i < b.length - 9;){
    if(b[i] !== 0xFF){ i++; continue; }
    const m = b[i+1];
    if(m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w:b.readUInt16BE(i+7), h:b.readUInt16BE(i+5) };
    i += 2 + b.readUInt16BE(i+2);
  }
  return null;
}

async function pexels(q, key){
  const r = await fetch("https://api.pexels.com/v1/search?per_page=1&orientation=landscape&query=" + encodeURIComponent(q.split(",")[0].slice(0, 80) + " food"),
    { headers:{ Authorization:key }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  const src = r?.ok ? (await r.json().catch(() => ({}))).photos?.[0]?.src?.original : null;
  if(!src) return null;
  const img = await fetch(src, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if(!img?.ok) return null;
  return { buf: Buffer.from(await img.arrayBuffer()), type: img.headers.get("content-type") || "image/jpeg", url: src };
}

module.exports = async function handler(req, res){
  const deadline = Date.now() + 55000;
  const q = String(req.query?.q || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const seed = Math.abs(parseInt(req.query?.s, 10) || 7) % 1000000;
  if(req.method !== "GET" || q.length < 3) return res.status(400).end();
  try{
    const style = STYLES[req.query?.t] || STYLES.plato;
    let img = await pollinations(q, seed, deadline, style, req.query?.t);
    if(!img && process.env.PEXELS_API_KEY && !req.query?.t) img = await pexels(q, process.env.PEXELS_API_KEY);
    if(!img){ res.setHeader("Cache-Control", "no-store"); return res.status(404).end(); }
    if(req.query?.info) return res.status(200).json({ bytes: img.buf.length, ...dims(img.buf) });
    if(img.buf.length > 4.3 * 1024 * 1024 && img.url){            // Vercel no envía respuestas de más de 4.5 MB: se redirige a la imagen
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=31536000");
      return res.redirect(302, img.url);
    }
    res.setHeader("Content-Type", img.type);
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    return res.status(200).send(img.buf);
  }catch{
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).end();
  }
};
