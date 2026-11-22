// Foto realista. GET /api/foto?q=<descripción>&s=<semilla>&t=<tipo>
// t=plato (por defecto): el plato servido · t=paso: la olla/sartén en ese paso · t=mise: todos los ingredientes listos
// t=ing: un ingrediente en un bol · t=cut: un ingrediente solo, sobre fondo blanco (la app lo recorta) · t=fill: el contenido de la olla visto desde arriba
// Fuentes: 1) Pollinations (gratis, sin clave; limita ~1 imagen cada 15 s)
//          2) t=cut, si la IA falla: foto recortada de TheMealDB cuando el nombre coincide exacto (solo verduras, frutas y especias:
//             carnes, lácteos, salsas y aceites ahí suelen ser paquetes con marca)
//          3) Pexels (solo platos, si existe PEXELS_API_KEY)
// La respuesta se guarda en la CDN de Vercel, así la misma foto no se vuelve a generar.
// Diagnóstico: &info=1 (tamaño y fuente) · &info=b64 (además la imagen en base64)

const BASE = "soft natural window light, photorealistic, ultra detailed, sharp focus, no text, no watermark, no people, no hands";
const STYLES = {
  plato: "professional food photography, served on a matte ceramic plate on a rustic wooden table, 45 degree angle, shallow depth of field, appetizing, editorial magazine style, " + BASE,
  paso: "realistic home cooking photo taken from above while cooking, inside the cookware on a home kitchen stove or counter, natural colors and textures, steam if hot, " + BASE,
  mise: "all the ingredients for the recipe measured and laid out in small white ceramic bowls, mise en place, top-down view on a light wooden kitchen counter, neat arrangement, " + BASE,
  ing: "raw ingredient measured in a small white ceramic prep bowl, mise en place, top-down view on a light wooden kitchen counter, clean, " + BASE,
  cut: "studio product photo of the raw ingredient alone, isolated on a pure white seamless background, centered, whole subject fully visible with empty white margin around it, three-quarter top view, even soft light, no shadow, no table, no plate (liquids, sauces and powders in a small clear glass bowl), photorealistic, ultra detailed, sharp focus, no text, no watermark, no hands",
  fill: "overhead close-up photo looking straight down at the food while it cooks, the food completely fills the frame from edge to edge, no pot rim, no plate, no utensils, rich realistic texture and natural colors, glossy where wet, " + BASE
};
const SIZE = { paso:[768,576], ing:[512,512], cut:[512,512], fill:[640,640] };

// TheMealDB: fotos reales de ingredientes con fondo transparente (lista de ~600 ingredientes comunes)
let mealList = null, mealAt = 0;
async function mealNames(){
  if(mealList && Date.now() - mealAt < 6 * 3600e3) return mealList;
  const r = await fetch("https://www.themealdb.com/api/json/v1/1/list.php?i=list", { signal: AbortSignal.timeout(6000) }).catch(() => null);
  const d = r?.ok ? await r.json().catch(() => null) : null;
  const names = (d?.meals || []).map(m => String(m.strIngredient || "").trim()).filter(Boolean);
  if(names.length){ mealList = names; mealAt = Date.now(); }
  return mealList || [];
}
const words = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean)
  .map(w => w.length > 3 ? w.replace(/(oes|ies)$/, m => m === "ies" ? "y" : "o").replace(/s$/, "") : w);
const PACKAGED = /chicken|beef|pork|lamb|turkey|duck|mince|bacon|sausage|ham|steak|fillet|breast|thigh|wing|fish|salmon|tuna|prawn|shrimp|cream|milk|cheese|butter|yogurt|yoghurt|tofu|stock|broth|sauce|ketchup|mayo|mustard|paste|oil|vinegar|pasta|noodle|spaghetti|penne|bread|tortilla|wine|beer|juice|chocolate|biscuit|cereal|flour|sugar|rice|bean|lentil|can|tin/;
function bestMeal(q, list){
  const key = words(q).join(" ");
  if(!key || PACKAGED.test(key)) return null;
  return list.find(n => words(n).join(" ") === key) || null;        // solo si coincide exacto (ej. "garlic", "red onion")
}
async function mealdb(q){
  const name = bestMeal(q, await mealNames());
  if(!name) return null;
  for(const u of ["https://www.themealdb.com/images/ingredients/" + encodeURIComponent(name) + "-medium.png",
                  "https://www.themealdb.com/images/ingredients/" + encodeURIComponent(name) + ".png"]){
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if(r?.ok && /^image\//.test(r.headers.get("content-type") || "")){
      const buf = Buffer.from(await r.arrayBuffer());
      if(buf.length > 2000) return { buf, type: r.headers.get("content-type"), url: u, src: "mealdb:" + name, cut: true };
    }
  }
  return null;
}

async function pollinations(q, seed, deadline, style, t, diag, model = "flux"){
  const [w, h] = SIZE[t] || [1024, 768];
  const prompt = encodeURIComponent((q + ", " + style).slice(0, 700));
  const url = "https://image.pollinations.ai/prompt/" + prompt + "?width=" + w + "&height=" + h + "&nologo=true&private=true&enhance=false" + (model ? "&model=" + model : "") + "&seed=" + seed;
  for(let i = 0; i < 3; i++){
    const left = deadline - Date.now(); if(left < 8000) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(left - 2000) }).catch(e => ({ status: "err:" + (e?.name || "") }));
    const type = r.headers?.get("content-type") || "";
    diag.push("pollinations " + r.status + " " + type.slice(0, 20) + (r.ok || !r.text ? "" : " " + (await r.text().catch(() => "")).slice(0, 300)) + " " + [...(r.headers?.entries?.() || [])].filter(([k]) => /model|x-/.test(k)).map(([k, v]) => k + "=" + String(v).slice(0, 60)).join(" "));
    if(r.ok && /^image\//.test(type)){
      const buf = Buffer.from(await r.arrayBuffer());
      if(buf.length > 8000) return { buf, type, url, src: "pollinations" };
    }
    if(![429, 500, 502, 503, 504].includes(r.status) && !String(r.status).startsWith("err")) return null;
    await new Promise(res => setTimeout(res, i ? 16000 : 9000));   // límite gratis: ~1 imagen cada 15 s
  }
  return null;
}

// Gemini (con la GEMINI_API_KEY que ya usa la app): busca los modelos que generan imágenes
let gemModels = null;
async function geminiModels(key, diag){
  if(gemModels) return gemModels;
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers:{ "x-goog-api-key":key }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  const d = r?.ok ? await r.json().catch(() => ({})) : {};
  const all = (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
  const list = all.filter(n => /image/.test(n) && !/imagen/.test(n)).sort((a, b) => (/flash/.test(b) - /flash/.test(a)) || (/preview/.test(a) - /preview/.test(b)));
  diag.push("gemini list " + (r?.status || "err") + ": " + list.join(","));
  if(r?.ok) gemModels = list;
  return list;
}
async function gemini(q, t, style, deadline, diag){
  const key = process.env.GEMINI_API_KEY; if(!key) return null;
  const models = process.env.GEMINI_IMAGE_MODEL ? [process.env.GEMINI_IMAGE_MODEL] : (await geminiModels(key, diag)).filter(m => !/pro/.test(m)).slice(0, 4);
  for(const m of models){
    const left = deadline - Date.now(); if(left < 12000) break;
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(m) + ":generateContent", { method:"POST",
      headers:{ "content-type":"application/json", "x-goog-api-key":key }, signal: AbortSignal.timeout(left - 3000),
      body: JSON.stringify({ contents:[{ role:"user", parts:[{ text:"Photo of " + q + ". " + style }] }],
        generationConfig:{ responseModalities:["IMAGE"], imageConfig:{ aspectRatio: /^(cut|fill|ing)$/.test(t) ? "1:1" : "4:3" } } }) }).catch(e => ({ ok:false, status:"err:" + (e?.name || "") }));
    const d = r.json ? await r.json().catch(() => ({})) : {};
    const part = (d?.candidates?.[0]?.content?.parts || []).find(x => x.inlineData?.data);
    diag.push("gemini " + m + " " + r.status + " " + (part ? part.inlineData.mimeType : String(d?.error?.message || d?.candidates?.[0]?.finishReason || "").slice(0, 220)));
    if(part) return { buf: Buffer.from(part.inlineData.data, "base64"), type: part.inlineData.mimeType || "image/png", src: "gemini:" + m };
    if(r.status === 403) break;
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
  return { buf: Buffer.from(await img.arrayBuffer()), type: img.headers.get("content-type") || "image/jpeg", url: src, src: "pexels" };
}

module.exports = async function handler(req, res){
  const deadline = Date.now() + 55000;
  const q = String(req.query?.q || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const seed = Math.abs(parseInt(req.query?.s, 10) || 7) % 1000000;
  const t = String(req.query?.t || "");
  if(req.method !== "GET" || q.length < 2) return res.status(400).end();
  const diag = [];
  try{
    const style = STYLES[t] || STYLES.plato;
    const only = String(req.query?.p || "");                       // diagnóstico: forzar una fuente
    let img = null;
    if(only === "gemini") img = await gemini(q, t, style, deadline, diag);
    else if(!only || only === "pol") img = await pollinations(q, seed, deadline, req.query?.st ? String(req.query.st).slice(0, 300) : style, t, diag, req.query?.m != null ? String(req.query.m).replace(/[^a-z0-9-]/gi, "") : "flux");
    if(!img && t === "cut" && process.env.MEALDB !== "0" && (!only || only === "mealdb")) img = await mealdb(q).catch(e => { diag.push("mealdb " + (e?.name || "error")); return null; });
    if(!img && process.env.PEXELS_API_KEY && !t) img = await pexels(q, process.env.PEXELS_API_KEY);
    const info = req.query?.info;
    if(!img){
      res.setHeader("Cache-Control", "no-store");
      return info ? res.status(404).json({ error:"no_image", diag }) : res.status(404).end();
    }
    if(info) return res.status(200).json({ src: img.src, type: img.type, bytes: img.buf.length, ...dims(img.buf), diag, ...(info === "b64" ? { b64: img.buf.toString("base64") } : {}) });
    if(img.buf.length > 4.3 * 1024 * 1024 && img.url){            // Vercel no envía respuestas de más de 4.5 MB: se redirige a la imagen
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=31536000");
      return res.redirect(302, img.url);
    }
    res.setHeader("Content-Type", img.type);
    res.setHeader("X-Foto-Fuente", img.src);
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    return res.status(200).send(img.buf);
  }catch(e){
    res.setHeader("Cache-Control", "no-store");
    return req.query?.info ? res.status(502).json({ error: String(e?.message || e), diag }) : res.status(502).end();
  }
};
