export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // =========================================================================
  // POST /send — User sends a new message or file from chat
  // =========================================================================
  if (url.pathname === "/send" && request.method === "POST") {
    const data = await request.formData();
    const pin = data.get("pin") || "";
    
    if (pin !== env.AUTH_PIN) return new Response("Forbidden", { status: 403 });

    const msg = String(data.get("msg") || "");
    const file = data.get("file");
    let attachment = null;

    if (file && typeof file === "object" && file.size > 0) {
      attachment = {
        name: file.name || "attached_file.txt",
        content: await file.text()
      };
    }

    const state = await env.AGENT_KV.get("chat_state", { type: "json" }) || { msg_id: 0 };
    
    const newState = {
      ...state,
      status: "thinking",
      last_user: msg,
      attachment: attachment,
      msg_id: (Number(state.msg_id) || 0) + 1
    };
    
    await env.AGENT_KV.put("chat_state", JSON.stringify(newState));
    return Response.redirect(`${url.origin}/chat?token=${encodeURIComponent(pin)}`, 303);
  }

  // =========================================================================
  // GET /chat — Live chat interface with Model Telemetry & File Attachment
  // =========================================================================
  if (url.pathname === "/chat" && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (token !== env.AUTH_PIN) return new Response("Forbidden", { status: 403 });

    const state = await env.AGENT_KV.get("chat_state", { type: "json" }) || { 
      status: "waiting", 
      last_agent: "Waiting for agent to boot...",
      model_info: "Initializing..."
    };
    
    const isThinking = state.status === "thinking" || state.status === "booting";
    const refreshMeta = isThinking ? '<meta http-equiv="refresh" content="3">' : '';
    const statusColor = isThinking ? "#ff0" : (state.status === "exited" ? "#f00" : "#0f0");

    return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refreshMeta}
  <title>Live Chat</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;padding:10px;margin:0;">
  <div style="color:${statusColor};font-size:12px;border-bottom:1px solid #333;padding-bottom:5px;margin-bottom:6px;">
    STATUS: ${esc(state.status.toUpperCase())}
  </div>
  <div style="color:#888;font-size:11px;margin-bottom:10px;word-break:break-all;">
    📡 ${esc(state.model_info || "Model: Pending initial run...")}
  </div>
  
  <pre style="white-space:pre-wrap;word-break:break-all;background:#111;padding:10px;border:1px solid #333;font-size:13px;max-height:300px;overflow-y:auto;">${esc(state.last_agent || "No output yet.")}</pre>

  <br>
  ${state.status !== "exited" ? `
  <form method="POST" action="/send" enctype="multipart/form-data">
    <input type="hidden" name="pin" value="${esc(token)}">
    <textarea name="msg" rows="3" placeholder="Next instruction..." style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;font-size:14px;box-sizing:border-box;" required></textarea>
    
    <div style="margin-top:6px;margin-bottom:6px;">
      <label style="color:#aaa;font-size:11px;">Attach file (optional):</label><br>
      <input type="file" name="file" style="width:100%;color:#aaa;font-size:12px;margin-top:2px;">
    </div>

    <button type="submit" style="width:100%;padding:12px;background:#0f0;color:#000;border:none;font-weight:bold;font-size:14px;margin-top:5px;">SEND</button>
  </form>
  <br>
  <div style="font-size:11px;color:#777;">
    Commands: <b>/push</b> (commit & push), <b>/exit</b> (terminate runner)<br>
    <a href="/chat?token=${encodeURIComponent(token)}" style="color:#555;text-decoration:underline;">[ Manual Reload ]</a>
  </div>` : `<div style="color:#f55;">Runner terminated. Return to <a href="/" style="color:#0f0;">main page</a> to start a new task.</div>`}
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // =========================================================================
  // POST / — Dispatch the GitHub Action with Provider Choice & Optional File
  // =========================================================================
  if (request.method === "POST" && url.pathname === "/") {
    const data = await request.formData();
    const pin = data.get("pin") || "";
    if (pin !== env.AUTH_PIN) return new Response("❌ Bad PIN.", { status: 401 });

    const prompt = String(data.get("prompt") || "");
    const repo = String(data.get("repo") || "");
    const branch = String(data.get("branch") || "main");
    const providerChoice = String(data.get("provider") || "auto");

    const file = data.get("file");
    let attachment = null;

    if (file && typeof file === "object" && file.size > 0) {
      attachment = {
        name: file.name || "initial_file.txt",
        content: await file.text()
      };
    }

    await env.AGENT_KV.put("chat_state", JSON.stringify({
      status: "booting",
      last_user: prompt,
      last_agent: "⏳ Booting GitHub Actions runner...",
      msg_id: 1,
      attachment: attachment,
      provider_choice: providerChoice,
      model_info: `Selected: ${providerChoice.toUpperCase()} (Starting...)`,
      session_id: null,
      provider: null
    }));

    const ghHeaders = { 
      "Authorization": `Bearer ${env.GH_PAT}`, 
      "Accept": "application/vnd.github+json", 
      "X-GitHub-Api-Version": "2022-11-28", 
      "User-Agent": "CF-Worker-Agent" 
    };

    const res = await fetch(`https://api.github.com/repos/${env.GH_USER}/${env.MANAGER_REPO}/actions/workflows/agent.yml/dispatches`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ ref: env.MANAGER_BRANCH || "main", inputs: { prompt, repo, branch } })
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(`❌ GitHub API Error: ${errText}`, { status: res.status });
    }

    return Response.redirect(`${url.origin}/chat?token=${encodeURIComponent(pin)}`, 303);
  }

  // =========================================================================
  // GET / — Main Dispatch Form (Provider Selector + File Attachment)
  // =========================================================================
  return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CloudPhone Agent</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;padding:10px;">
  <h2>Live Chat Agent</h2>
  <form method="POST" action="/" enctype="multipart/form-data">
    <input type="password" name="pin" placeholder="PIN" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;" required>
    
    <label style="color:#aaa;font-size:11px;">Target Repository & Branch:</label>
    <input type="text" name="repo" value="arnavgr/" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;" required>
    <input type="text" name="branch" value="main" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;">
    
    <label style="color:#aaa;font-size:11px;">Primary Provider / Fallback Mode:</label>
    <select name="provider" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;">
      <option value="auto">Auto Fallback (Gemini 3.5 -> 3.1 Lite -> Groq -> OpenRouter)</option>
      <option value="gemini">Gemini 3.5 Flash</option>
      <option value="gemini-lite">Gemini 3.1 Flash Lite</option>
      <option value="groq">Groq (Qwen 3.6 27B)</option>
      <option value="openrouter">OpenRouter Free</option>
    </select>

    <label style="color:#aaa;font-size:11px;">Initial Prompt:</label>
    <textarea name="prompt" rows="3" placeholder="Initial prompt..." style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;" required></textarea>
    
    <label style="color:#aaa;font-size:11px;">Attach initial file (optional):</label>
    <input type="file" name="file" style="width:100%;color:#aaa;font-size:12px;margin-bottom:15px;display:block;">

    <button type="submit" style="width:100%;padding:15px;background:#0f0;color:#000;border:none;font-weight:bold;font-size:16px;">START LIVE SESSION</button>
  </form>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
