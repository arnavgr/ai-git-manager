export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Simple HTML escaper
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  // =========================================================================
  // POST /send — User sends a new message from the dumbphone
  // =========================================================================
  if (url.pathname === "/send" && request.method === "POST") {
    const data = await request.formData();
    const pin = data.get("pin") || "";
    
    if (pin !== env.AUTH_PIN) return new Response("Forbidden", { status: 403 });

    const msg = String(data.get("msg") || "");
    const state = await env.AGENT_KV.get("chat_state", { type: "json" }) || { msg_id: 0, history: "" };
    
    const newState = {
      status: "thinking",
      last_user: msg,
      last_agent: state.last_agent || "",
      msg_id: (state.msg_id || 0) + 1,
      history: state.history || ""
    };
    
    await env.AGENT_KV.put("chat_state", JSON.stringify(newState));
    return Response.redirect(`${url.origin}/chat?token=${encodeURIComponent(pin)}`, 303);
  }

  // =========================================================================
  // GET /chat — The live chat interface
  // =========================================================================
  if (url.pathname === "/chat" && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (token !== env.AUTH_PIN) return new Response("Forbidden", { status: 403 });

    const state = await env.AGENT_KV.get("chat_state", { type: "json" }) || { status: "waiting", last_agent: "Waiting for agent to boot..." };
    
    const isThinking = state.status === "thinking" || state.status === "booting";
    const refreshRate = isThinking ? 3 : 10; // Poll faster while thinking
    const statusColor = isThinking ? "#ff0" : "#0f0";

    return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${refreshRate}">
  <title>Live Chat</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;padding:10px;margin:0;">
  <div style="color:${statusColor};font-size:12px;border-bottom:1px solid #333;padding-bottom:5px;margin-bottom:10px;">
    STATUS: ${esc(state.status.toUpperCase())}
  </div>
  
  <pre style="white-space:pre-wrap;word-break:break-all;background:#111;padding:10px;border:1px solid #333;font-size:14px;">${esc(state.last_agent || "No output yet.")}</pre>

  <br>
  <form method="POST" action="/send?token=${esc(token)}">
    <input type="hidden" name="pin" value="${esc(token)}">
    <textarea name="msg" rows="3" placeholder="Next instruction..." style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;font-size:16px;" required></textarea>
    <button type="submit" style="width:100%;padding:15px;background:#0f0;color:#000;border:none;font-weight:bold;font-size:16px;margin-top:5px;">SEND</button>
  </form>
  <br>
  <div style="font-size:12px;color:#555;">
    Type <b>/push</b> to commit & push.<br>
    Type <b>/exit</b> to terminate the runner.
  </div>
</body>
</html>`, { headers: { "content-type": "text/html" } });
  }

  // =========================================================================
  // POST / — Dispatch the GitHub Action
  // =========================================================================
  if (request.method === "POST" && url.pathname === "/") {
    const data = await request.formData();
    const pin = data.get("pin") || "";
    if (pin !== env.AUTH_PIN) return new Response("❌ Bad PIN.", { status: 401 });

    const prompt = String(data.get("prompt") || "");
    const repo = String(data.get("repo") || "");
    const branch = String(data.get("branch") || "main");

    // Reset chat state
    await env.AGENT_KV.put("chat_state", JSON.stringify({
      status: "booting",
      last_user: prompt,
      last_agent: "Booting GitHub Action runner...",
      msg_id: 1,
      history: ""
    }));

    // Trigger GH Action (same as your original code)
    const ghHeaders = { "Authorization": `Bearer ${env.GH_PAT}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "CF-Worker-Agent" };
    await fetch(`https://api.github.com/repos/${env.GH_USER}/${env.MANAGER_REPO}/actions/workflows/agent.yml/dispatches`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ ref: env.MANAGER_BRANCH || "main", inputs: { prompt, repo, branch } })
    });

    return Response.redirect(`${url.origin}/chat?token=${encodeURIComponent(pin)}`, 303);
  }

  // GET / — Main landing page (same as your original)
  return new Response(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="background:#000;color:#0f0;font-family:monospace;padding:10px;"><h2>Dispatch Agent</h2><form method="POST"><input type="password" name="pin" placeholder="PIN" style="width:100%;background:#222;color:#fff;padding:10px;margin-bottom:10px;" required><input type="text" name="repo" value="arnavgr/" style="width:100%;background:#222;color:#fff;padding:10px;margin-bottom:10px;" required><input type="text" name="branch" value="main" style="width:100%;background:#222;color:#fff;padding:10px;margin-bottom:10px;"><textarea name="prompt" rows="3" placeholder="First prompt..." style="width:100%;background:#222;color:#fff;padding:10px;margin-bottom:10px;" required></textarea><button type="submit" style="width:100%;padding:15px;background:#0f0;color:#000;border:none;font-weight:bold;">START</button></form></body></html>`, { headers: { "content-type": "text/html" } });
}
