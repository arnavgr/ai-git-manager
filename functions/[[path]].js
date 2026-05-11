export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // FIX 1: Simple HTML escaper — prevents XSS from repo/branch query params
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  // =========================================================================
  //  /status — internal KV read
  //  FIX 2: Added a simple secret-token check so anyone can't poll your KV
  // =========================================================================
  if (url.pathname === "/status") {
    if (url.searchParams.get("token") !== env.AUTH_PIN) {
      return new Response("Forbidden", { status: 403 });
    }
    const val = await env.AGENT_KV.get("agent_status");
    return new Response(val || "⏳ Waiting for agent...", {
      headers: { "content-type": "text/plain" }
    });
  }

  // =========================================================================
  //  /dispatched — GET only, PRG target
  // =========================================================================
  if (url.pathname === "/dispatched" && request.method === "GET") {
    // FIX 3: Escape repo and branch before injecting into HTML (XSS)
    const repo   = esc(url.searchParams.get("repo")   || "arnavgr/");
    const branch = esc(url.searchParams.get("branch") || "main");

    const currentStatus = await env.AGENT_KV.get("agent_status") || "⏳ Waiting for GitHub Actions...";
    const isDone = currentStatus.includes('✅') || currentStatus.includes('❌');
    const refreshMeta = isDone ? "" : '<meta http-equiv="refresh" content="5">';

    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        ${refreshMeta}
        <title>Agent Status</title>
      </head>
      <body style="background:#000;color:#0f0;font-family:monospace;padding:10px;margin:0;">
        <h3>⚡ Task Dispatched</h3>
        <p>Repo: ${repo}<br>Branch: ${branch}</p>
        <hr style="border-color:#333;">
        <p style="color:#aaa;">Live Status:</p>
        <div style="padding:10px;background:#111;border:1px solid #333;">
          ${esc(currentStatus)}
        </div>
        <br>
        <a href="/" style="color:#0f0;text-decoration:none;">[ ← New Task ]</a>
        ${!isDone ? '<br><br><a href="" style="color:#aaa;">[ Force Refresh ]</a>' : ''}
      </body>
      </html>
    `, { headers: { "content-type": "text/html" } });
  }

  // =========================================================================
  //  POST / — dispatch the agent
  // =========================================================================
  if (request.method === "POST") {
    const data = await request.formData();
    const pin = data.get("pin") || "";

    // FIX 4: timing-safe HMAC comparison (crypto.subtle, Works runtime compatible)
    let valid = false;
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw", enc.encode(env.AUTH_PIN || ""),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const [sigA, sigB] = await Promise.all([
        crypto.subtle.sign("HMAC", key, enc.encode(pin)),
        crypto.subtle.sign("HMAC", key, enc.encode(env.AUTH_PIN || ""))
      ]);
      const a = new Uint8Array(sigA), b = new Uint8Array(sigB);
      valid = a.length === b.length && a.every((byte, i) => byte === b[i]);
    } catch {
      valid = false;
    }

    if (!valid) return new Response("❌ Bad PIN.", { status: 401 });

    const prompt = data.get("prompt");
    const repo   = data.get("repo");
    const branch = data.get("branch") || "main";

    await env.AGENT_KV.put("agent_status", "⏳ 1/4: Action Triggered...");

    const res = await fetch(
      `https://api.github.com/repos/${env.GH_USER}/${env.MANAGER_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GH_PAT}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "CF-Worker-Agent"
        },
        body: JSON.stringify({
          event_type: "ai_cmd",
          client_payload: { prompt, repo, branch }
        })
      }
    );

    if (!res.ok) {
      await env.AGENT_KV.put("agent_status", `❌ Dispatch failed.`);
      return new Response(`❌ GitHub dispatch failed`, { status: 500 });
    }

    const params = new URLSearchParams({ repo, branch });
    return Response.redirect(`${url.origin}/dispatched?${params}`, 303);
  }

  // =========================================================================
  //  GET / — Main Form
  // =========================================================================
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>CloudPhone Agent</title>
    </head>
    <body style="background:#000;color:#0f0;font-family:monospace;padding:10px;margin:0;">
      <h2>Gemini Agent</h2>
      <form method="POST">
        <input type="password" name="pin" placeholder="PIN" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;" required>
        <input type="text" name="repo" value="arnavgr/" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;" required>
        <input type="text" name="branch" value="main" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;">
        <textarea name="prompt" rows="5" placeholder="Feature to add/remove..." style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;" required></textarea>
        <input type="submit" value="[ EXECUTE ]" style="width:100%;padding:15px;background:#0f0;color:#000;border:none;font-weight:bold;font-size:16px;">
      </form>
    </body>
    </html>
  `, { headers: { "content-type": "text/html" } });
}
