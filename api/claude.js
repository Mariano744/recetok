// Puente entre la app y la API de Claude. La clave vive solo aquí, en el servidor.
// Variables de entorno en Vercel:
//   GEMINI_API_KEY     clave gratis de https://aistudio.google.com/apikey (recomendada)
//   GEMINI_MODEL       opcional; opcional (se prueba gemini-3.8-flash por defecto)
//   ANTHROPIC_API_KEY  opcional; solo si no hay clave de Gemini
//   APP_CODE           código de acceso que la app pide una vez (obligatorio)

const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-sonnet-5-5" };
const MAX_IMAGES = 3;
const MAX_IMAGE_B64 = 1_500_000;      // ~1.1 MB por imagen
const MAX_TEXT = 200_000;             // caracteres de texto en total
const WINDOW_MS = 10 * 60 * 1000, MAX_PER_WINDOW = 40;
const hits = new Map();               // límite simple por IP (por instancia)

function limited(ip){
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now); hits.set(ip, list);
  return list.length > MAX_PER_WINDOW;
}


// Videos pesados: se suben al almacenamiento de Gemini y se usan por referencia.
async function uploadToGemini(buf, key){
  const base = "https://generativelanguage.googleapis.com";
  const start = await fetch(base + "/upload/v1beta/files", { method:"POST", headers:{
    "x-goog-api-key":key, "X-Goog-Upload-Protocol":"resumable", "X-Goog-Upload-Command":"start",
    "X-Goog-Upload-Header-Content-Length":String(buf.length), "X-Goog-Upload-Header-Content-Type":"video/mp4",
    "content-type":"application/json" }, body: JSON.stringify({ file:{ display_name:"recetok-video" } }), signal: AbortSignal.timeout(10000) });
  const url = start.headers.get("x-goog-upload-url");
  if(!start.ok || !url) throw { code:"video_unavailable" };
  const up = await fetch(url, { method:"POST", headers:{ "Content-Length":String(buf.length), "X-Goog-Upload-Offset":"0", "X-Goog-Upload-Command":"upload, finalize" }, body: buf, signal: AbortSignal.timeout(60000) });
  let f = (await up.json().catch(() => ({}))).file;
  if(!up.ok || !f?.uri) throw { code:"video_unavailable" };
  for(let i = 0; i < 30 && f.state === "PROCESSING"; i++){
    await new Promise(r => setTimeout(r, 2000));
    const g = await fetch(base + "/v1beta/" + f.name, { headers:{ "x-goog-api-key":key } });
    f = await g.json().catch(() => f);
  }
  if(f.state && f.state !== "ACTIVE") throw { code:"video_unavailable" };
  return { fileData:{ mimeType:"video/mp4", fileUri:f.uri } };
}

async function run(req, res, deadline){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST") return res.status(405).json({ code:"invalid_request", message:"Usa POST." });
  if(!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return res.status(503).json({ code:"not_configured", message:"Falta GEMINI_API_KEY en Vercel." });
  if(!process.env.APP_CODE) return res.status(503).json({ code:"not_configured", message:"Falta APP_CODE en Vercel." });
  if(req.headers["x-app-code"] !== process.env.APP_CODE) return res.status(401).json({ code:"not_granted", message:"Código de acceso incorrecto." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
  if(limited(ip)) return res.status(429).json({ code:"rate_limited", message:"Demasiadas consultas. Espera unos minutos." });

  let body = req.body;
  try{ if(typeof body === "string") body = JSON.parse(body); }catch{ body = null; }
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if(!messages || !messages.length || messages[messages.length-1].role !== "user")
    return res.status(400).json({ code:"invalid_request", message:"Mensajes inválidos." });
  const textLen = messages.reduce((a,m)=>a + String(m.content||"").length, 0);
  if(textLen > MAX_TEXT) return res.status(413).json({ code:"prompt_too_large", message:"El texto es demasiado largo." });

  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
    .filter(im => im && /^image\/(jpeg|png|webp|gif)$/.test(im.media_type) && typeof im.data === "string" && im.data.length <= MAX_IMAGE_B64);

  if(process.env.GEMINI_API_KEY){
    let videoPart = null, videoTitle = "";
    if(typeof body.videoUrl === "string" && body.videoUrl){
      let host = "";
      try{ const u = new URL(body.videoUrl); if(u.protocol === "https:") host = u.hostname.replace(/^www\./, "").replace(/^m\./, ""); }catch{}
      try{
        if(/^(youtube\.com|youtu\.be)$/.test(host)){
          videoPart = { fileData:{ fileUri: body.videoUrl } };
        }else if(/(^|\.)tiktok\.com$/.test(host)){
          const info = await (await fetch("https://www.tikwm.com/api/?url=" + encodeURIComponent(body.videoUrl), { signal: AbortSignal.timeout(10000) })).json();
          const play = info?.data?.play;
          if(!play) throw { code:"video_unavailable" };
          videoTitle = String(info.data.title || "");
          const vr = await fetch(play.startsWith("http") ? play : "https://www.tikwm.com" + play, { signal: AbortSignal.timeout(45000) });
          const buf = Buffer.from(await vr.arrayBuffer());
          if(!vr.ok || !buf.length) throw { code:"video_unavailable" };
          if(buf.length > 100 * 1024 * 1024) throw { code:"video_too_large" };
          if(buf.length <= 12 * 1024 * 1024){
            videoPart = { inlineData:{ mimeType:"video/mp4", data: buf.toString("base64") } };
          }else{
            videoPart = await uploadToGemini(buf, process.env.GEMINI_API_KEY);
          }
        }else throw { code:"video_unavailable" };
      }catch(e){
        if(e?.name === "TimeoutError" || e?.name === "AbortError") return res.status(504).json({ code:"timeout", message:"El video tardó demasiado." });
        const code = e?.code === "video_too_large" ? "video_too_large" : "video_unavailable";
        return res.status(422).json({ code, message: code === "video_too_large" ? "El video es muy pesado." : "No se pudo abrir el video." });
      }
    }
    const models = [...new Set([process.env.GEMINI_MODEL, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3-flash-preview"].filter(Boolean))];
    const contents = messages.map((m, i) => {
      const parts = [{ text:String(m.content||"") }];
      if(i === messages.length-1){
        parts.unshift(...images.map(im => ({ inlineData:{ mimeType:im.media_type, data:im.data } })));
        if(videoPart) parts.unshift(videoPart);
        if(videoTitle) parts.push({ text:"Descripción del video en TikTok: " + videoTitle });
      }
      return { role: m.role === "assistant" ? "model" : "user", parts };
    });
    const systemG = "Eres el asistente de cocina y nutrición de la app Recetok. Respondes en español." +
      (body.json ? " Tu respuesta será leída por un programa: responde SOLO con el JSON pedido, sin texto antes ni después y sin bloques de código." : "");
    try{
      let r, d;
      const busy = () => !r.ok && (r.status === 503 || r.status === 500 || r.status === 429 || r.status === 404 ||
        /high demand|overloaded|unavailable|no longer available|not found|not supported|quota/i.test(d?.error?.message || ""));
      outer: for(let round = 0; round < 3; round++){
        for(const model of models){
          if(deadline - Date.now() < 15000) break outer;
          r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
            method:"POST",
            headers:{ "content-type":"application/json", "x-goog-api-key":process.env.GEMINI_API_KEY },
            signal: AbortSignal.timeout(Math.max(8000, deadline - Date.now())),
            body: JSON.stringify({ systemInstruction:{ parts:[{ text:systemG }] }, contents,
              generationConfig:{ maxOutputTokens: 16384, ...(body.json ? { responseMimeType:"application/json" } : {}) } }),
          });
          d = await r.json().catch(() => ({}));
          if(r.ok || !busy()) break outer;   // éxito o error que no se arregla cambiando de modelo
        }
        await new Promise(res2 => setTimeout(res2, 4000 * (round + 1)));  // todos ocupados: esperar y reintentar
      }
      if(!r.ok){
        const bad = r.status === 400 && /API key/i.test(d?.error?.message || "") || r.status === 403;
        if(bad) return res.status(503).json({ code:"not_configured", message:"La clave de Gemini no es válida." });
        if(r.status === 429) return res.status(429).json({ code:"rate_limited", message:"Se alcanzó el límite gratis de Gemini. Espera un momento." });
        if(r.status === 503 || /high demand|overloaded/i.test(d?.error?.message || "")) return res.status(503).json({ code:"busy", message:"Gemini está muy ocupado." });
        return res.status(r.status >= 500 ? 502 : r.status).json({ code: r.status === 400 ? "invalid_request" : "upstream_error", message: d?.error?.message || "Error del servicio de IA." });
      }
      const cand = d.candidates?.[0];
      const text = (cand?.content?.parts || []).filter(p => p.text).map(p => p.text).join("");
      if(!text.trim()) return res.status(502).json({ code:"empty_completion", message:"La IA no respondió." });
      return res.status(200).json({ text, truncated: cand?.finishReason === "MAX_TOKENS" });
    }catch(e){
      if(e?.name === "TimeoutError" || e?.name === "AbortError") return res.status(504).json({ code:"timeout", message:"La IA tardó demasiado." });
      return res.status(502).json({ code:"upstream_error", message:"No se pudo contactar a la IA (" + (e?.name || "error") + ": " + String(e?.message || "").slice(0,80) + ")." });
    }
  }

  const msgs = messages.map((m, i) => {
    const content = [{ type:"text", text:String(m.content||"") }];
    if(i === messages.length-1 && images.length)
      content.unshift(...images.map(im => ({ type:"image", source:{ type:"base64", media_type:im.media_type, data:im.data } })));
    return { role: m.role === "assistant" ? "assistant" : "user", content };
  });

  const system = "Eres el asistente de cocina y nutrición de la app Recetok. Respondes en español." +
    (body.json ? " Tu respuesta será leída por un programa: responde SOLO con el JSON pedido, sin texto antes ni después y sin bloques de código." : "");

  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "content-type":"application/json", "x-api-key":process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model: MODELS[body.tier] || MODELS.default, max_tokens: body.tier === "quick" ? 1500 : 8000, system, messages: msgs }),
    });
    const d = await r.json().catch(() => ({}));
    if(!r.ok){
      const map = { 400:"invalid_request", 401:"not_configured", 403:"not_configured", 413:"prompt_too_large", 429:"rate_limited" };
      const code = map[r.status] || "upstream_error";
      const msg = r.status === 401 || r.status === 403 ? "La clave de Anthropic no es válida." : (d?.error?.message || "Error del servicio de IA.");
      return res.status(r.status === 401 || r.status === 403 ? 503 : r.status).json({ code, message: msg });
    }
    const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    if(!text.trim()) return res.status(502).json({ code:"empty_completion", message:"La IA no respondió." });
    return res.status(200).json({ text, truncated: d.stop_reason === "max_tokens" });
  }catch(e){
    return res.status(502).json({ code:"upstream_error", message:"No se pudo contactar a la IA." });
  }
}

module.exports = async function handler(req, res){
  const deadline = Date.now() + 165000;
  try{ return await run(req, res, deadline); }
  catch(e){
    if(res.headersSent) return;
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError" || e?.code === "timeout";
    return res.status(timeout ? 504 : 500).json({ code: timeout ? "timeout" : "upstream_error", message: timeout ? "El video tardó demasiado." : "Error inesperado en el servidor." });
  }
};
