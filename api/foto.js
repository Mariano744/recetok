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
// Licencias libres: dominio público o Creative Commons con atribución (se muestra en los créditos)
async function openverse(q, diag){
  const r = await fetch("https://api.openverse.org/v1/images/?page_size=12&mature=false&category=photograph&license=cc0,pdm,by,by-sa&q=" + encodeURIComponent(q), { headers:UA, signal: AbortSignal.timeout(8000) }).catch(e => ({ ok:false, status:"err:" + e?.name }));
  const d = r.ok ? await r.json().catch(() => ({})) : {};
  diag.push("openverse " + r.status + " " + (d.result_count ?? ""));
  return (d.results || []).filter(x => /jpe?g|png|webp/i.test(x.filetype || x.url || "")).map(x => ({ src:"openverse", title:x.title || "", thumb:x.thumbnail, url:x.foreign_landing_url || x.url, lic:String(x.license || "").toUpperCase() + (x.license_version ? " " + x.license_version : ""), by:x.creator || "", w:x.width, h:x.height, from:x.source }));
}
async function commons(q, diag){
  const u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=16&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=560&gsrsearch=" + encodeURIComponent(q + " filetype:bitmap");
  const r = await fetch(u, { headers:UA, signal: AbortSignal.timeout(8000) }).catch(e => ({ ok:false, status:"err:" + e?.name }));
  const d = r.ok ? await r.json().catch(() => ({})) : {};
  const pages = Object.values(d?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  diag.push("commons " + r.status + " " + pages.length);
  return pages.map(p => { const ii = p.imageinfo?.[0] || {}, m = ii.extmetadata || {};
    return { src:"commons", title:p.title, thumb:ii.thumburl, url:ii.descriptionurl, lic:String(m.LicenseShortName?.value || ""), by:String(m.Artist?.value || "").replace(/<[^>]+>/g, "").slice(0, 80), mime:ii.mime }; })
    .filter(x => x.thumb && /jpeg|png/.test(x.mime || "") && /^(public domain|cc0|pd|cc by)/i.test(x.lic) && !/nc|nd/i.test(x.lic));
}
// Elegir fotos con Claude (visión): lo usa la app cuando hay ANTHROPIC_API_KEY
async function claudeJSON(parts, diag, deadline){
  const content = parts.map(p => p.inlineData ? { type:"image", source:{ type:"base64", media_type:p.inlineData.mimeType, data:p.inlineData.data } } : { type:"text", text:p.text });
  const models = [...new Set([process.env.CLAUDE_PICK_MODEL, "claude-haiku-5-5", "claude-sonnet-5-5"].filter(Boolean))];
  for(const m of models){
    const left = deadline - Date.now(); if(left < 6000) break;
    const r = await fetch("https://api.anthropic.com/v1/messages", { method:"POST", signal: AbortSignal.timeout(Math.min(20000, left - 2000)),
      headers:{ "content-type":"application/json", "x-api-key":process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:m, max_tokens:400, system:"Respondes solo con el JSON pedido, sin texto antes ni después.", messages:[{ role:"user", content }] }) }).catch(e => ({ ok:false, status:"err:" + e?.name }));
    const d = r.json ? await r.json().catch(() => ({})) : {};
    const txt = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    diag.push("claude " + m + " " + r.status + (r.ok ? "" : " " + String(d?.error?.message || "").slice(0, 120)));
    const j = txt.match(/\{[\s\S]*\}/);
    if(r.ok && j){ try{ return JSON.parse(j[0]); }catch{ diag.push("json? " + txt.slice(0, 150)); } }
    if(r.status === 401 || r.status === 403) break;
  }
  return null;
}
// Para elegir fotos se usan modelos distintos a los que analizan las recetas (3.8 y 3.6), así no se gasta su cuota
const GEM_PICK = () => [...new Set([process.env.GEMINI_PICK_MODEL, "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.6-flash"].filter(Boolean))];
async function gemJSON(models, parts, diag, extra = {}, deadline = Date.now() + 40000){
  const key = process.env.GEMINI_API_KEY; if(!key) return null;
  for(const m of models){
    const left = deadline - Date.now(); if(left < 6000) break;
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(m) + ":generateContent", { method:"POST",
      headers:{ "content-type":"application/json", "x-goog-api-key":key }, signal: AbortSignal.timeout(Math.min(13000, left - 3000)),
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
const plainW = s => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, " ").split(/\s+/).filter(w => w.length > 2);
async function stock(q, es, diag, deadline){
  const lists = await Promise.all([openverse(q, diag), commons(q, diag), openverse(q + " isolated white background", diag), commons(q + " white background", diag), es ? commons(es, diag) : [], es ? openverse(es, diag) : []].map(p => Promise.resolve(p).catch(() => [])));
  const want = [...new Set([...plainW(q), ...plainW(es)])];
  const score = c => { const t = plainW(c.title).join(" "); return want.filter(w => t.includes(w.slice(0, Math.max(4, w.length - 2)))).length * 3 - (/drawing|illustration|logo|label|map|diagram|plant|flower|field|market|dish|recipe|soup|salad|cake|dessert/i.test(c.title) ? 4 : 0) + (/isolated|white background|fondo blanco/i.test(c.title) ? 4 : /raw|crudo|fresh|fresco/i.test(c.title) ? 2 : 0) - (/art|dark|experiment|science|fly|insect|bug|toy|costume/i.test(c.title) ? 5 : 0); };
  const seen = new Set();
  const cands = lists.flat().filter(c => { const k = c.title.toLowerCase().replace(/^file:|\.\w+$/g, "").trim(); if(seen.has(k)) return false; seen.add(k); return true; })
    .map(c => ({ ...c, sc: score(c) })).sort((x, y) => y.sc - x.sc).slice(0, 8);
  if(!cands.length) return null;
  const imgs = await Promise.all(cands.map(c => fetch(thumbAt(c, 330), { headers:UA, signal: AbortSignal.timeout(7000) })
    .then(async r => r.ok ? { mime: (r.headers.get("content-type") || "image/jpeg").split(";")[0], data: Buffer.from(await r.arrayBuffer()).toString("base64") } : null).catch(() => null)));
  const ok = cands.map((c, k) => ({ ...c, img: imgs[k] })).filter(c => c.img && /^image\/(jpeg|png|webp)/.test(c.img.mime) && c.img.data.length > 2000);
  if(!ok.length) return null;
  const parts = [{ text:`Ingrediente de cocina: "${q}"${es ? ` (en español: "${es}")` : ""}. Te mando ${ok.length} fotos numeradas desde 0. Elige la que mejor muestre ESE ingrediente tal como se usa al cocinar (crudo o como se compra), reconocible, nítido y bien iluminado, con colores naturales; mejor si se ve entero con algo de fondo liso y claro alrededor.
Reglas: la foto debe mostrar SOLO ese ingrediente (descarta fotos con varios ingredientes distintos). Para líquidos o lácteos (leche, crema, aceite, caldo, salsas, vino) tiene que verse el líquido mismo en un vaso, jarra, bol o cuchara: descarta latas, cajas y botellas o paquetes con etiqueta o marca. Tiene que verse como ese ingrediente se ve normalmente en una cocina o en una foto de producto. Descarta platos ya cocinados, dibujos, personas, animales vivos, insectos, cubiertos clavados, experimentos o cosas raras, fotos oscuras o artísticas y fotos donde el ingrediente casi no se ve.
Responde SOLO JSON: {"i": número de la foto elegida o -1 si ninguna sirve, "nota": del 1 al 10 qué tan bien esa foto muestra el ingrediente solo, "box": [ymin, xmin, ymax, xmax] del ingrediente en esa foto en escala 0-1000 (si hay varias piezas del mismo ingrediente, que las abarque todas), "liso": true solo si alrededor del ingrediente se ve un fondo liso y claro (false si el ingrediente llena la foto)}` }];
  ok.forEach((c, k) => { parts.push({ text:"Foto " + k + ":" }); parts.push({ inlineData:{ mimeType:c.img.mime, data:c.img.data } }); });
  const pick = process.env.ANTHROPIC_API_KEY ? await claudeJSON(parts, diag, deadline - 5000) : await gemJSON(GEM_PICK(), parts, diag, { thinkingConfig:{ thinkingLevel:"low" } }, deadline - 8000);
  const ch = pick && Number.isInteger(pick.i) && pick.i >= 0 && (pick.nota == null || +pick.nota >= 7) ? ok[pick.i] : null;
  diag.push("elegida " + (ch ? ch.title + " (" + pick.nota + "/10)" : "ninguna" + (pick?.i >= 0 ? " (nota " + pick.nota + ")" : "")));
  if(!ch) return null;
  const r = await fetch(thumbAt(ch, 500), { headers:UA, signal: AbortSignal.timeout(9000) }).catch(() => null);
  const type = r?.headers?.get("content-type") || "";
  const buf = r?.ok && /^image\//.test(type) ? Buffer.from(await r.arrayBuffer()) : null;
  if(!buf || buf.length < 3000) return null;
  const box = Array.isArray(pick.box) && pick.box.length === 4 && pick.box.every(v => Number.isFinite(+v)) ? pick.box.map(v => Math.max(0, Math.min(1000, Math.round(+v)))).join(",") : "";
  return { buf, type, url: ch.url, src: "stock:" + ch.src, box, liso: pick.liso ? "1" : "0",
    credit: [ch.title.replace(/^File:/, "").replace(/\.\w+$/, ""), ch.by, ch.lic, ch.src === "commons" ? "Wikimedia Commons" : "Openverse"].filter(Boolean).join(" · ").slice(0, 180) + (ch.url ? "|" + ch.url : "") };
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
  if(info === "models" && process.env.VERCEL_ENV === "preview"){
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers:{ "x-goog-api-key": process.env.GEMINI_API_KEY || "" } }).catch(() => null);
    const d = r?.ok ? await r.json().catch(() => ({})) : {};
    return res.status(200).json({ models: (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, "")) });
  }
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
    if(!img && t === "cut" && (process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY)){
      const code = req.headers["x-app-code"], ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
      const probe = info && process.env.VERCEL_ENV === "preview";            // diagnóstico solo en versiones de prueba
      if(process.env.APP_CODE && code !== process.env.APP_CODE && !probe) diag.push("stock: falta el código de la app");
      else if(limited(ip)) diag.push("stock: demasiadas búsquedas");
      else img = await stock(q, String(req.query?.es || "").replace(/\s+/g, " ").trim().slice(0, 60), diag, deadline).catch(e => { diag.push("stock " + (e?.message || e)); return null; });
    }
    if(!img && process.env.PEXELS_API_KEY && !t) img = await pexels(q, process.env.PEXELS_API_KEY);
    if(!img){
      res.setHeader("Cache-Control", t === "cut" && diag.some(x => /^elegida ninguna/.test(x)) && !info ? "public, max-age=0, s-maxage=86400" : "no-store");
      return info ? res.status(404).json({ error:"no_image", diag }) : res.status(404).end();
    }
    if(info) return res.status(200).json({ src: img.src, type: img.type, bytes: img.buf.length, ...dims(img.buf), box: img.box, liso: img.liso, credit: img.credit, diag, ...(info === "b64" ? { b64: img.buf.toString("base64"), pad: req.query?.pad ? "-".repeat(120000) : undefined } : {}) });
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
