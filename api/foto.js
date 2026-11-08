// Foto realista del plato. GET /api/foto?q=<descripción del plato>&s=<semilla>
// 1) Genera una foto tipo estudio con Pollinations (gratis, sin clave).
// 2) Si falla y existe PEXELS_API_KEY (gratis en pexels.com/api), busca una foto real parecida.
// La respuesta se guarda en la CDN de Vercel, así el mismo plato no se vuelve a generar.

const STYLE = "professional food photography, served on a matte ceramic plate on a rustic wooden table, " +
  "45 degree angle, soft natural window light, shallow depth of field, photorealistic, ultra detailed, " +
  "appetizing, editorial magazine style, no text, no watermark, no people, no hands";

async function pollinations(q, seed, deadline){
  const prompt = encodeURIComponent((q + ", " + STYLE).slice(0, 700));
  const url = "https://image.pollinations.ai/prompt/" + prompt + "?width=1024&height=768&nologo=true&private=true&model=flux&seed=" + seed;
  for(let i = 0; i < 2; i++){
    const left = deadline - Date.now(); if(left < 8000) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(left - 2000) }).catch(() => null);
    if(r?.ok && /^image\//.test(r.headers.get("content-type") || "")){
      const buf = Buffer.from(await r.arrayBuffer());
      if(buf.length > 8000) return { buf, type: r.headers.get("content-type") };
    }
    if(r?.status !== 429 && r?.status !== 502 && r?.status !== 503) return null;
    await new Promise(res => setTimeout(res, 16000));   // límite gratis: 1 imagen cada ~15 s
  }
  return null;
}

async function pexels(q, key){
  const r = await fetch("https://api.pexels.com/v1/search?per_page=1&orientation=landscape&query=" + encodeURIComponent(q.split(",")[0].slice(0, 80) + " food"),
    { headers:{ Authorization:key }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  const src = r?.ok ? (await r.json().catch(() => ({}))).photos?.[0]?.src?.large : null;
  if(!src) return null;
  const img = await fetch(src, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if(!img?.ok) return null;
  return { buf: Buffer.from(await img.arrayBuffer()), type: img.headers.get("content-type") || "image/jpeg" };
}

module.exports = async function handler(req, res){
  const deadline = Date.now() + 55000;
  const q = String(req.query?.q || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const seed = Math.abs(parseInt(req.query?.s, 10) || 7) % 1000000;
  if(req.method !== "GET" || q.length < 3) return res.status(400).end();
  try{
    let img = await pollinations(q, seed, deadline);
    if(!img && process.env.PEXELS_API_KEY) img = await pexels(q, process.env.PEXELS_API_KEY);
    if(!img){ res.setHeader("Cache-Control", "no-store"); return res.status(404).end(); }
    res.setHeader("Content-Type", img.type);
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    return res.status(200).send(img.buf);
  }catch{
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).end();
  }
};
