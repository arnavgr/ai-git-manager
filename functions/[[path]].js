export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // =========================================================================
  // GET /browse — Dumbphone GitHub Repo & Branch Explorer / Downloader
  // =========================================================================
  if (url.pathname === "/browse" && request.method === "GET") {
    const pin = url.searchParams.get("pin") || "";
    if (env.AUTH_PIN && pin !== env.AUTH_PIN) return new Response("Forbidden", { status: 403 });

    let repo = (url.searchParams.get("repo") || "").trim();
    if (repo.startsWith("https://github.com/")) {
      repo = repo.replace("https://github.com/", "");
    }
    repo = repo.replace(/\/$/, "");

    const filePath = url.searchParams.get("path") || "";
    const action = url.searchParams.get("action") || "";
    const branch = (url.searchParams.get("branch") || url.searchParams.get("ref") || "").trim();
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : "";
    const refQuery = branch ? `?ref=${encodeURIComponent(branch)}` : "";

    // 1. Home screen: list authenticated user's repos + manual input form
    if (!repo) {
      let repoListHtml = "";
      try {
        const ghRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
          headers: {
            "User-Agent": "CF-Pages-Dumbphone-Browser",
            "Accept": "application/vnd.github+json",
            ...(env.GH_PAT && { Authorization: `Bearer ${env.GH_PAT}` })
          }
        });

        if (ghRes.ok) {
          const repos = await ghRes.json();
          if (Array.isArray(repos) && repos.length > 0) {
            for (const r of repos) {
              repoListHtml += `<li>📦 <a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(r.full_name)}" style="color:#0f0;text-decoration:none;">${esc(r.full_name)}</a> ${r.private ? '<span style="color:#888;font-size:10px;">[private]</span>' : ''}</li>`;
            }
          }
        }
      } catch (e) {
        repoListHtml = `<li style="color:#f55;">Could not fetch repos: ${esc(e.message)}</li>`;
      }

      return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub File Browser</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;padding:10px;margin:0;">
  <div style="font-size:12px;border-bottom:1px solid #333;padding-bottom:5px;margin-bottom:10px;">
    <b>GITHUB BROWSER</b> | <a href="/?pin=${encodeURIComponent(pin)}" style="color:#888;">[Agent Dispatch]</a> | <a href="/chat?token=${encodeURIComponent(pin)}" style="color:#888;">[Live Chat]</a>
  </div>

  <form method="GET" action="/browse">
    <input type="hidden" name="pin" value="${esc(pin)}">
    <label style="color:#aaa;font-size:11px;">Enter any repository (owner/repo):</label><br>
    <input type="text" name="repo" placeholder="owner/repo" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:8px;margin-top:4px;box-sizing:border-box;" required><br><br>
    <button type="submit" style="width:100%;padding:10px;background:#0f0;color:#000;border:none;font-weight:bold;font-size:14px;">BROWSE REPO</button>
  </form>

  ${repoListHtml ? `
  <h4 style="color:#aaa;margin-top:20px;margin-bottom:8px;font-size:12px;">YOUR REPOSITORIES:</h4>
  <ul style="list-style:none;padding-left:0;line-height:1.9;margin:0;font-size:13px;">${repoListHtml}</ul>
  ` : ''}
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      return new Response("Invalid repository format. Please use 'owner/repo'.", { status: 400 });
    }

    // 2. Branch Selector View (`action=branches`)
    if (action === "branches") {
      let branchListHtml = "";
      try {
        const bRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/branches?per_page=100`, {
          headers: {
            "User-Agent": "CF-Pages-Dumbphone-Browser",
            "Accept": "application/vnd.github+json",
            ...(env.GH_PAT && { Authorization: `Bearer ${env.GH_PAT}` })
          }
        });

        if (bRes.ok) {
          const branches = await bRes.json();
          if (Array.isArray(branches) && branches.length > 0) {
            for (const b of branches) {
              const isCurrent = branch === b.name;
              branchListHtml += `<li>🌿 <a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(b.name)}" style="color:${isCurrent ? '#ff0' : '#0f0'};text-decoration:none;">${esc(b.name)}</a> ${isCurrent ? '<span style="color:#ff0;font-size:11px;">[active]</span>' : ''}</li>`;
            }
          }
        }
      } catch (e) {
        branchListHtml = `<li style="color:#f55;">Could not fetch branches: ${esc(e.message)}</li>`;
      }

      return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Branches · ${esc(repo)}</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;padding:10px;margin:0;">
  <div style="font-size:12px;border-bottom:1px solid #333;padding-bottom:5px;margin-bottom:8px;">
    <b>/${esc(repo)}/branches</b>
  </div>
  <div style="font-size:11px;margin-bottom:10px;">
    <a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}${branchParam}" style="color:#0f0;">← Back to Files</a> &nbsp;|&nbsp;
    <a href="/browse?pin=${encodeURIComponent(pin)}" style="color:#888;">[Repo List]</a>
  </div>
  <h4 style="color:#aaa;margin-top:10px;margin-bottom:8px;font-size:12px;">AVAILABLE BRANCHES:</h4>
  <ul style="list-style:none;padding-left:0;line-height:1.9;margin:0;font-size:13px;">${branchListHtml}</ul>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // 3. Direct Raw Download Handler for specific Branch / Ref
    if (action === "download" || action === "raw") {
      const rawRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}${refQuery}`, {
        headers: {
          "User-Agent": "CF-Pages-Dumbphone-Browser",
          "Accept": "application/vnd.github.raw+json",
          ...(env.GH_PAT && { Authorization: `Bearer ${env.GH_PAT}` })
        }
      });

      if (!rawRes.ok) {
        return new Response(`File not found or inaccessible on branch '${branch || "default"}'.`, { status: rawRes.status });
      }

      const fileName = filePath.split("/").pop() || "downloaded_file";
      const isDownload = action === "download";

      return new Response(rawRes.body, {
        headers: {
          "Content-Type": isDownload ? "application/octet-stream" : "text/plain; charset=utf-8",
          ...(isDownload && { "Content-Disposition": `attachment; filename="${fileName}"` })
        }
      });
    }

    // 4. Directory Listing for specific Branch / Ref
    const apiRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}${refQuery}`, {
      headers: {
        "User-Agent": "CF-Pages-Dumbphone-Browser",
        "Accept": "application/vnd.github+json",
        ...(env.GH_PAT && { Authorization: `Bearer ${env.GH_PAT}` })
      }
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return new Response(`<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width"><title>Error</title></head>
<body style="background:#000;color:#f55;font-family:monospace;padding:10px;">
  <h3>GitHub Error (${apiRes.status})</h3>
  <pre style="white-space:pre-wrap;word-break:break-all;color:#aaa;">${esc(errText)}</pre>
  <p><a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}&action=branches" style="color:#0f0;">🌿 Switch Branch</a> | <a href="/browse?pin=${encodeURIComponent(pin)}" style="color:#0f0;">← Repos</a></p>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" }, status: apiRes.status });
    }

    const items = await apiRes.json();
    const entries = Array.isArray(items) ? items : [items];

    let parentPath = "";
    if (filePath) {
      const parts = filePath.split("/").filter(Boolean);
      parts.pop();
      parentPath = parts.join("/");
    }

    let listHtml = "";
    if (filePath) {
      listHtml += `<li><a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(parentPath)}${branchParam}" style="color:#0f0;text-decoration:none;">[.. Up one level]</a></li>`;
    }

    for (const item of entries) {
      if (item.type === "dir") {
        listHtml += `<li>📁 <a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(item.path)}${branchParam}" style="color:#0f0;text-decoration:none;">${esc(item.name)}/</a></li>`;
      } else {
        const sizeStr = item.size ? `(${(item.size / 1024).toFixed(1)} KB)` : '';
        listHtml += `<li>📄 <a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(item.path)}&action=download${branchParam}" style="color:#fff;">${esc(item.name)}</a> <span style="color:#666;font-size:11px;">${sizeStr}</span> <a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(item.path)}&action=raw${branchParam}" style="color:#0f0;font-size:11px;margin-left:6px;">[view]</a></li>`;
      }
    }

    return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(repo)}/${esc(filePath)}</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;padding:10px;margin:0;">
  <div style="font-size:12px;border-bottom:1px solid #333;padding-bottom:5px;margin-bottom:8px;">
    <b>/${esc(repo)}${filePath ? '/' + esc(filePath) : ''}</b>
  </div>
  <div style="font-size:11px;margin-bottom:10px;">
    🌿 Branch: <a href="/browse?pin=${encodeURIComponent(pin)}&repo=${encodeURIComponent(repo)}&action=branches" style="color:#ff0;text-decoration:underline;">[${esc(branch || "default")}] (Switch)</a> &nbsp;|&nbsp;
    <a href="/browse?pin=${encodeURIComponent(pin)}" style="color:#888;">[Repo List]</a> &nbsp;|&nbsp;
    <a href="/?pin=${encodeURIComponent(pin)}" style="color:#888;">[Agent]</a> &nbsp;|&nbsp;
    <a href="/chat?token=${encodeURIComponent(pin)}" style="color:#888;">[Chat]</a>
  </div>
  <ul style="list-style:none;padding-left:0;line-height:1.9;margin:0;font-size:13px;">${listHtml}</ul>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // =========================================================================
  // POST /send — User sends a new message or file from chat
  // =========================================================================
  if (url.pathname === "/send" && request.method === "POST") {
    const data = await request.formData();
    const pin = data.get("pin") || "";
    
    if (pin !== env.AUTH_PIN) return new Response("Forbidden", { status: 403 });

    const state = await env.AGENT_KV.get("chat_state", { type: "json" }) || { msg_id: 0 };

    if (state.status === "exited") {
      return new Response("Session already ended — start a new one from the main page.", { status: 409 });
    }

    const msg = String(data.get("msg") || "");
    const file = data.get("file");
    let attachment = null;

    if (file && typeof file === "object" && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) {
        return new Response("File exceeds 10MB limit.", { status: 413 });
      }
      attachment = {
        name: file.name || "attached_file.txt",
        content: await file.text()
      };
    }

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
  // GET /chat — Live chat interface with Jump Anchor & Full Telemetry
  // =========================================================================
  if (url.pathname === "/chat" && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (token !== env.AUTH_PIN) return new Response("Forbidden", { status: 403 });

    const state = await env.AGENT_KV.get("chat_state", { type: "json" }) || { 
      status: "waiting", 
      last_agent: "Waiting for agent to boot...",
      model_info: "Initializing...",
      effort: "high"
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
    STATUS: ${esc((state.status || "unknown").toUpperCase())} | EFFORT: ${esc((state.effort || "HIGH").toUpperCase())}
    &nbsp;·&nbsp;<a href="#latest" style="color:#0f0;">jump to latest ↓</a>
    &nbsp;·&nbsp;<a href="/browse?pin=${encodeURIComponent(token)}" style="color:#888;">[Browse Repos]</a>
  </div>
  <div style="color:#888;font-size:11px;margin-bottom:10px;word-break:break-all;">
    📡 ${esc(state.model_info || "Model: Pending initial run...")}
  </div>
  
  <pre style="white-space:pre-wrap;word-break:break-all;background:#111;padding:10px;border:1px solid #333;font-size:13px;margin:0 0 10px 0;">${esc(state.last_agent || "No output yet.")}</pre>
  <a name="latest"></a>

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
    Changes auto-push after every message.<br>
    Commands: <b>/push</b> (manual retry), <b>/revert</b> (undo last commit), <b>/exit</b> (terminate runner)<br>
    <a href="/chat?token=${encodeURIComponent(token)}" style="color:#555;text-decoration:underline;">[ Manual Reload ]</a> |
    <a href="/browse?pin=${encodeURIComponent(token)}" style="color:#555;text-decoration:underline;">[ Browse Files ]</a>
  </div>` : `<div style="color:#f55;">Runner terminated. Return to <a href="/" style="color:#0f0;">main page</a> to start a new task.</div>`}
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // =========================================================================
  // POST / — Dispatch the GitHub Action with Provider Choice, Effort & File
  // =========================================================================
  if (request.method === "POST" && url.pathname === "/") {
    const data = await request.formData();
    const pin = data.get("pin") || "";
    if (pin !== env.AUTH_PIN) return new Response("❌ Bad PIN.", { status: 401 });

    const prompt = String(data.get("prompt") || "");
    const repo = String(data.get("repo") || "");
    const branch = String(data.get("branch") || "main");
    const providerChoice = String(data.get("provider") || "auto");
    const effortChoice = String(data.get("effort") || "high");

    const file = data.get("file");
    let attachment = null;

    if (file && typeof file === "object" && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) {
        return new Response("File exceeds 10MB limit.", { status: 413 });
      }
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
      effort: effortChoice,
      model_info: `Selected: ${providerChoice.toUpperCase()} [Effort: ${effortChoice.toUpperCase()}] (Starting...)`,
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
  // GET / — Main Dispatch Form
  // =========================================================================
  const pinParam = url.searchParams.get("pin") || "";
  return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CloudPhone Agent</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;padding:10px;">
  <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:5px;margin-bottom:10px;">
    <h2 style="margin:0;font-size:16px;">Live Chat Agent</h2>
    <a href="/browse?pin=${encodeURIComponent(pinParam)}" style="color:#0f0;font-size:12px;">📁 Browse Repos</a>
  </div>
  <form method="POST" action="/" enctype="multipart/form-data">
    <input type="password" name="pin" value="${esc(pinParam)}" placeholder="PIN" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;" required>
    
    <label style="color:#aaa;font-size:11px;">Target Repository & Branch:</label>
    <input type="text" name="repo" value="arnavgr/" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;" required>
    <input type="text" name="branch" value="main" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;">
    
    <label style="color:#aaa;font-size:11px;">Primary Provider / Fallback Mode:</label>
    <select name="provider" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;">
      <option value="auto">Auto Fallback (3.7 Flash -> 3.6 Flash -> 3.5 Flash -> 3.5 Lite -> Empero Qwen 3.8 -> 3.1 Lite -> OpenRouter -> Groq)</option>
      <option value="gemini-3.7">Gemini 3.7 Flash</option>
      <option value="gemini-3.6">Gemini 3.6 Flash</option>
      <option value="gemini-3.5">Gemini 3.5 Flash</option>
      <option value="gemini-3.5-lite">Gemini 3.5 Flash Lite</option>
      <option value="empero-qwen">Empero Qwen 3.8 (27B-FP8)</option>
      <option value="gemini-3.1-lite">Gemini 3.1 Flash Lite</option>
      <option value="openrouter">OpenRouter Free</option>
      <option value="groq">Groq (Qwen 3.6 27B)</option>
    </select>

    <label style="color:#aaa;font-size:11px;">Reasoning Effort Level:</label>
    <select name="effort" style="width:100%;background:#222;color:#fff;border:1px solid #555;padding:10px;margin-bottom:10px;box-sizing:border-box;">
      <option value="high" selected>High (Deepest Reasoning / Maximum Effort)</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
      <option value="none">None (Direct Execution)</option>
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
