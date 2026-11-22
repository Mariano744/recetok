// Foto realista. GET /api/foto?q=<descripción>&s=<semilla>&t=<tipo>
// t=plato (por defecto): el plato servido · t=paso: la olla/sartén en ese paso · t=mise: todos los ingredientes listos
// t=ing: un ingrediente en un bol · t=cut: un ingrediente solo, sobre fondo blanco (la app lo recorta) · t=fill: la comida dentro de la olla, de cerca
// Fuentes:
//  1) t=cut: foto real recortada de TheMealDB si el nombre coincide exacto y es verdura, fruta, hierba o especia
//     (las carnes, lácteos y salsas ahí suelen ser paquetes con marca, por eso no se usan)
//  2) Pollinations. Con POLLINATIONS_API_KEY (gratis en https://enter.pollinations.ai) usa el modelo flux: fotos realistas, rápidas y sin logo.
//     Sin clave: modelo básico, con logo y 1 imagen cada 45 s por IP (en Vercel la IP es compartida).
//  3) t=cut: foto real de dominio público (Openverse / Wikimedia Commons) que Gemini elige y ubica; la app la recorta
//  4) Pexels (solo platos, si existe PEXELS_API_KEY)
// La respuesta se guarda en la CDN de Vercel, así la misma foto no se vuelve a generar.
// Diagnóstico: &info=1 (tamaño y fuente) · &info=b64 (además la imagen) · &info=list (ingredientes de TheMealDB)

const BASE = "soft natural window light, photorealistic, ultra detailed, sharp focus, no text, no watermark, no people, no hands";
const STYLES = {
  plato: "professional food photography, served on a matte ceramic plate on a rustic wooden table, 45 degree angle, shallow depth of field, appetizing, editorial magazine style, " + BASE,
  paso: "realistic home cooking photo taken from above while cooking, inside the cookware on a home kitchen stove or counter, natural colors and textures, steam if hot, " + BASE,
  mise: "all the ingredients for the recipe measured and laid out in small white ceramic bowls, mise en place, top-down view on a light wooden kitchen counter, neat arrangement, " + BASE,
  ing: "raw ingredient measured in a small white ceramic prep bowl, mise en place, top-down view on a light wooden kitchen counter, clean, " + BASE,
  cut: "raw, whole, alone, cut out and isolated on a pure white background, studio product photo, centered, seen from above, even soft light, photorealistic, ultra detailed",
  fill: "overhead close-up photo looking straight down at the food while it cooks, the food completely fills the frame from edge to edge, rich realistic texture and natural colors, glossy where wet, " + BASE
};
const SIZE = { paso:[768,576], ing:[512,512], cut:[512,512], fill:[640,640] };

/* ---------- TheMealDB: fotos reales de ingredientes con fondo transparente ---------- */
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
const PACKAGED = /chicken|beef|pork|lamb|turkey|duck|mince|bacon|sausage|ham|steak|fillet|breast|thigh|wing|fish|salmon|tuna|cod|prawn|shrimp|cream|milk|cheese|butter|yogurt|yoghurt|tofu|stock|broth|sauce|ketchup|mayo|mustard|paste|oil|vinegar|pasta|noodle|spaghetti|penne|macaroni|bread|tortilla|wine|beer|juice|chocolate|biscuit|cereal|flour|sugar|rice|bean|lentil|chickpea|can|tin|egg/;
const SYN = { scallion:"spring onion", "green onion":"spring onion", "bell pepper":"red pepper", "red bell pepper":"red pepper", "green bell pepper":"green pepper", "yellow bell pepper":"yellow pepper", "white onion":"onion", corn:"corn on the cob", "sweet corn":"corn on the cob", yam:"sweet potato", eggplant:"aubergine", "cassava root":"cassava", "lemon juice":"lemon", "lime juice":"lime", "fresh cilantro":"cilantro", "fresh parsley":"parsley", "fresh basil":"basil" };
// Revisadas una por una: estas sí son fotos naturales aunque su categoría suela venir empaquetada
const NATURAL = new Set(("beef," + (process.env.MEALDB_OK || "")).toLowerCase().split(",").map(x => words(x).join(" ")).filter(Boolean));
function bestMeal(q, list, any){
  let key = words(q).join(" "); key = words(SYN[key] || key).join(" ");
  if(!key || (PACKAGED.test(key) && !NATURAL.has(key) && !any)) return null;
  return list.find(n => words(n).join(" ") === key) || null;      // solo si coincide exacto (ej. "garlic", "red onion")
}
async function mealdb(q, diag, any){
  const name = bestMeal(q, await mealNames(), any);
  if(!name) return null;
  for(const u of ["https://www.themealdb.com/images/ingredients/" + encodeURIComponent(name) + "-medium.png",
                  "https://www.themealdb.com/images/ingredients/" + encodeURIComponent(name) + ".png"]){
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if(r?.ok && /^image\//.test(r.headers.get("content-type") || "")){
      const buf = Buffer.from(await r.arrayBuffer());
      if(buf.length > 2000) return { buf, type: r.headers.get("content-type"), url: u, src: "mealdb:" + name };
    }
  }
  diag.push("mealdb sin imagen: " + name);
  return null;
}

/* ---------- Pollinations ---------- */
async function pollinations(q, seed, deadline, style, t, diag){
  const [w, h] = SIZE[t] || [1024, 768], key = process.env.POLLINATIONS_API_KEY || "";
  const prompt = encodeURIComponent((q + ", " + style).slice(0, 700));
  const qs = "?width=" + w + "&height=" + h + "&nologo=true&private=true&enhance=false&model=flux&seed=" + seed;
  const urls = key ? ["https://gen.pollinations.ai/image/" + prompt + qs, "https://image.pollinations.ai/prompt/" + prompt + qs] : ["https://image.pollinations.ai/prompt/" + prompt + qs];
  const headers = key ? { Authorization: "Bearer " + key } : {};
  for(let i = 0; i < 4; i++){
    const url = urls[Math.min(i, urls.length - 1)], left = deadline - Date.now(); if(left < 8000) return null;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(left - 2000) }).catch(e => ({ ok:false, status:"err:" + (e?.name || ""), headers:new Headers() }));
    const type = r.headers?.get("content-type") || "";
    if(r.ok && /^image\//.test(type)){
      const buf = Buffer.from(await r.arrayBuffer());
      diag.push("pollinations " + r.status + " " + (r.headers.get("x-model-used") || "") + " " + (r.headers.get("x-auth-status") || ""));
      if(buf.length > 8000) return { buf, type, url, src: "pollinations:" + (r.headers.get("x-model-used") || "?") };
    }
    const txt = r.ok || !r.text ? "" : await r.text().catch(() => "");
    diag.push("pollinations " + r.status + " " + txt.slice(0, 220));
    let wait = 0;
    const after = txt.match(/retry after (\d+)\s*s/i);                       // límite gratis: espera lo que pide
    if(r.status === 402 && after) wait = (+after[1] + 1) * 1000;
    else if([429, 500, 502, 503, 504].includes(r.status) || String(r.status).startsWith("err")) wait = i ? 15000 : 8000;
    else if(urls.length > 1 && i === 0) wait = 1;                           // con clave: prueba el otro servidor
    if(!wait || deadline - Date.now() < wait + 12000) return null;
    await new Promise(res => setTimeout(res, wait));
  }
  return null;
}

/* ---------- Fotos reales de dominio público (Openverse y Wikimedia Commons) ---------- */
const UA = { "User-Agent": "RecetokApp/1.0 (personal cooking app)" };
async function openverse(q, diag){
  const r = await fetch("https://api.openverse.org/v1/images/?page_size=12&mature=false&license=cc0,pdm&q=" + encodeURIComponent(q), { headers:UA, signal: AbortSignal.timeout(8000) }).catch(e => ({ ok:false, status:"err:" + e?.name }));
  const d = r.ok ? await r.json().catch(() => ({})) : {};
  diag.push("openverse " + r.status + " " + (d.result_count ?? ""));
  return (d.results || []).filter(x => /jpe?g|png|webp/i.test(x.filetype || x.url || "")).map(x => ({ src:"openverse", title:x.title || "", thumb:x.thumbnail, url:x.url, lic:x.license, by:x.creator || "", w:x.width, h:x.height, from:x.source }));
}
async function commons(q, diag){
  const u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=560&gsrsearch=" + encodeURIComponent(q + " filetype:bitmap");
  const r = await fetch(u, { headers:UA, signal: AbortSignal.timeout(8000) }).catch(e => ({ ok:false, status:"err:" + e?.name }));
  const d = r.ok ? await r.json().catch(() => ({})) : {};
  const pages = Object.values(d?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  diag.push("commons " + r.status + " " + pages.length);
  return pages.map(p => { const ii = p.imageinfo?.[0] || {}, m = ii.extmetadata || {};
    return { src:"commons", title:p.title, thumb:ii.thumburl, url:ii.descriptionurl, lic:String(m.LicenseShortName?.value || ""), by:String(m.Artist?.value || "").replace(/<[^>]+>/g, "").slice(0, 80), mime:ii.mime }; })
    .filter(x => x.thumb && /jpeg|png/.test(x.mime || "") && /public domain|cc0|pd/i.test(x.lic));
}
const GEM_TEXT = () => [...new Set([process.env.GEMINI_MODEL, "gemini-3.6-flash", "gemini-3.8-flash", "gemini-3-flash-preview"].filter(Boolean))];
async function gemJSON(models, parts, diag, extra = {}){
  const key = process.env.GEMINI_API_KEY; if(!key) return null;
  for(const m of models){
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(m) + ":generateContent", { method:"POST",
      headers:{ "content-type":"application/json", "x-goog-api-key":key }, signal: AbortSignal.timeout(14000),
      body: JSON.stringify({ contents:[{ role:"user", parts }], generationConfig:{ responseMimeType:"application/json", ...extra } }) }).catch(e => ({ ok:false, status:"err:" + e?.name }));
    const d = r.json ? await r.json().catch(() => ({})) : {};
    const txt = (d?.candidates?.[0]?.content?.parts || []).filter(x => x.text).map(x => x.text).join("");
    diag.push("gemini " + m + " " + r.status + (r.ok ? "" : " " + String(d?.error?.message || "").slice(0, 120)));
    if(r.ok && txt){ try{ return JSON.parse(txt.replace(/^```(?:json)?|```$/g, "").trim()); }catch{ diag.push("json? " + txt.slice(0, 200)); } }
    if(r.status === 400 || r.status === 403) continue;
  }
  return null;
}
const hits = new Map();                                             // límite simple por IP para las búsquedas con IA
function limited(ip){ const now = Date.now(), l = (hits.get(ip) || []).filter(t => now - t < 600000); l.push(now); hits.set(ip, l); return l.length > 60; }
const thumbAt = (c, px) => c.src === "commons" ? c.thumb.replace(/\/\d+px-/, "/" + px + "px-") : c.thumb;
// Busca fotos reales de dominio público y deja que Gemini elija la que muestra el ingrediente solo y dónde está
async function stock(q, es, diag){
  const [a, b] = await Promise.all([openverse(q, diag).catch(() => []), commons(q, diag).catch(() => [])]);
  let cands = [...a.slice(0, 3), ...b.slice(0, 4)];
  if(cands.length < 4 && es) cands = cands.concat((await commons(es, diag).catch(() => [])).slice(0, 3));
  const seen = new Set(); cands = cands.filter(c => { const k = c.title.toLowerCase().replace(/^file:|\.\w+$/g, "").trim(); if(seen.has(k)) return false; seen.add(k); return true; }).slice(0, 7);
  if(!cands.length) return null;
  const imgs = await Promise.all(cands.map(c => fetch(thumbAt(c, 330), { headers:UA, signal: AbortSignal.timeout(7000) })
    .then(async r => r.ok ? { mime: (r.headers.get("content-type") || "image/jpeg").split(";")[0], data: Buffer.from(await r.arrayBuffer()).toString("base64") } : null).catch(() => null)));
  const ok = cands.map((c, k) => ({ ...c, img: imgs[k] })).filter(c => c.img && /^image\/(jpeg|png|webp)/.test(c.img.mime) && c.img.data.length > 2000);
  if(!ok.length) return null;
  const parts = [{ text:`Ingrediente de cocina: "${q}"${es ? ` (en español: "${es}")` : ""}. Te mando ${ok.length} fotos numeradas desde 0. Elige la que mejor muestre ESE ingrediente tal como se usa al cocinar (crudo o como se compra), solo o casi solo, reconocible y nítido; mejor si el fondo es liso y claro. Descarta paquetes o etiquetas con marca, platos ya cocinados, dibujos, personas, animales vivos o fotos donde el ingrediente casi no se ve. Responde SOLO JSON: {"i": número de la foto elegida o -1 si ninguna sirve, "box": [ymin, xmin, ymax, xmax] del ingrediente en esa foto en escala 0-1000 (si hay varias piezas, que las abarque todas), "liso": true si el fondo alrededor del ingrediente es liso y claro}` }];
  ok.forEach((c, k) => { parts.push({ text:"Foto " + k + ":" }); parts.push({ inlineData:{ mimeType:c.img.mime, data:c.img.data } }); });
  const pick = await gemJSON(GEM_TEXT(), parts, diag, { thinkingConfig:{ thinkingLevel:"low" } });
  const ch = pick && Number.isInteger(pick.i) && pick.i >= 0 ? ok[pick.i] : null;
  diag.push("elegida " + (ch ? ch.title : "ninguna"));
  if(!ch) return null;
  const r = await fetch(thumbAt(ch, 500), { headers:UA, signal: AbortSignal.timeout(9000) }).catch(() => null);
  const type = r?.headers?.get("content-type") || "";
  const buf = r?.ok && /^image\//.test(type) ? Buffer.from(await r.arrayBuffer()) : null;
  if(!buf || buf.length < 3000) return null;
  const box = Array.isArray(pick.box) && pick.box.length === 4 && pick.box.every(v => Number.isFinite(+v)) ? pick.box.map(v => Math.max(0, Math.min(1000, Math.round(+v)))).join(",") : "";
  return { buf, type, url: ch.url, src: "stock:" + ch.src, box, liso: pick.liso ? "1" : "0",
    credit: [ch.title.replace(/^File:/, "").replace(/\.\w+$/, ""), ch.by, ch.lic, ch.src === "commons" ? "Wikimedia Commons" : "Openverse"].filter(Boolean).join(" · ").slice(0, 180) };
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
  const deadline = Date.now() + 55000, info = req.query?.info;
  if(info === "list"){ res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ names: await mealNames() }); }
  const q = String(req.query?.q || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const seed = Math.abs(parseInt(req.query?.s, 10) || 7) % 1000000;
  const t = String(req.query?.t || "");
  if(req.method !== "GET" || q.length < 2) return res.status(400).end();
  const diag = [];
  try{
    const style = STYLES[t] || STYLES.plato;
    let img = null;
    if(t === "cut" && process.env.MEALDB !== "0") img = await mealdb(q, diag, !!(info && req.query?.any)).catch(e => { diag.push("mealdb " + (e?.name || "error")); return null; });
    // Sin clave, el modelo gratis no respeta "ingrediente solo sobre fondo blanco" (arma un plato): para ingredientes no se usa
    if(!img && (t !== "cut" || process.env.POLLINATIONS_API_KEY)) img = await pollinations(q, seed, deadline, style, t, diag);
    // Ingredientes: foto real de dominio público elegida por Gemini (solo para la app, con su código de acceso)
    if(!img && t === "cut" && process.env.GEMINI_API_KEY){
      const code = req.headers["x-app-code"], ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
      if(process.env.APP_CODE && code !== process.env.APP_CODE) diag.push("stock: falta el código de la app");
      else if(limited(ip)) diag.push("stock: demasiadas búsquedas");
      else img = await stock(q, String(req.query?.es || "").replace(/\s+/g, " ").trim().slice(0, 60), diag).catch(e => { diag.push("stock " + (e?.message || e)); return null; });
    }
    if(!img && process.env.PEXELS_API_KEY && !t) img = await pexels(q, process.env.PEXELS_API_KEY);
    if(!img){
      res.setHeader("Cache-Control", "no-store");
      return info ? res.status(404).json({ error:"no_image", diag }) : res.status(404).end();
    }
    if(info) return res.status(200).json({ src: img.src, type: img.type, bytes: img.buf.length, ...dims(img.buf), box: img.box, liso: img.liso, credit: img.credit, diag, ...(info === "b64" ? { b64: img.buf.toString("base64") } : {}) });
    if(img.buf.length > 4.3 * 1024 * 1024 && img.url){            // Vercel no envía respuestas de más de 4.5 MB: se redirige a la imagen
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=31536000");
      return res.redirect(302, img.url);
    }
    res.setHeader("Content-Type", img.type);
    res.setHeader("X-Foto-Fuente", img.src);
    if(img.box) res.setHeader("X-Foto-Box", img.box);
    if(img.liso) res.setHeader("X-Foto-Liso", img.liso);
    if(img.credit) res.setHeader("X-Foto-Credito", encodeURIComponent(img.credit));
    // Las fotos de Pollinations sin clave salen con logo y modelo básico: se guardan una semana, para cambiarlas cuando haya clave
    res.setHeader("Cache-Control", /pollinations:(sana|turbo|\?)/.test(img.src) ? "public, max-age=604800, s-maxage=604800" : "public, max-age=31536000, s-maxage=31536000, immutable");
    return res.status(200).send(img.buf);
  }catch(e){
    res.setHeader("Cache-Control", "no-store");
    return info ? res.status(502).json({ error: String(e?.message || e), diag }) : res.status(502).end();
  }
};
