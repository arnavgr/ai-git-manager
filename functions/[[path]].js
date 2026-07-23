export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // FIX 1: Simple HTML escaper — prevents XSS from repo/branch query params
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  const ghHeaders = {
    "Authorization": `Bearer ${env.GH_PAT}`,
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "CF-Worker-Agent"
  };

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
  //  /log — GET, raw log of the most recent GitHub Actions run
  //  FIX 5: dumbphone-friendly log viewer (240x320), gated by the same PIN
  //  token as /status. Fetches job logs via the GitHub API's redirect-to-blob
  //  endpoint, without forwarding the GH_PAT to the blob host.
  // =========================================================================
  if (url.pathname === "/log" && request.method === "GET") {
    if (url.searchParams.get("token") !== env.AUTH_PIN) {
      return new Response("Forbidden", { status: 403 });
    }

    const MAX_CHARS = 60000; // keep it renderable on very small/slow phone browsers
    let body = "";
    let runUrl = "";

    try {
      const runsRes = await fetch(
        `https://api.github.com/repos/${env.GH_USER}/${env.MANAGER_REPO}/actions/workflows/agent.yml/runs?per_page=1`,
        { headers: ghHeaders }
      );
      const runsData = await runsRes.json();
      const run = runsData.workflow_runs && runsData.workflow_runs[0];

      if (!run) {
        body = "No workflow runs found yet.";
      } else {
        runUrl = run.html_url;
        const jobsRes = await fetch(run.jobs_url, { headers: ghHeaders });
        const jobsData = await jobsRes.json();
        const jobs = jobsData.jobs || [];

        if (jobs.length === 0) {
          body = `Run #${run.run_number} is ${run.status}, no jobs started yet. Reload in a few seconds.`;
        } else {
          for (const job of jobs) {
            body += `===== ${job.name} [${job.status}/${job.conclusion || "pending"}] =====\n\n`;
            const raw = await fetch(
              `https://api.github.com/repos/${env.GH_USER}/${env.MANAGER_REPO}/actions/jobs/${job.id}/logs`,
              { headers: ghHeaders, redirect: "manual" }
            );
            if (raw.status >= 300 && raw.status < 400) {
              const loc = raw.headers.get("location");
              const blob = await fetch(loc); // pre-signed URL — no GH auth header sent here
              body += await blob.text();
            } else if (raw.ok) {
              body += await raw.text();
            } else if (raw.status === 404) {
              body += `[log not available yet — job still running, reload in a bit]`;
            } else {
              body += `[couldn't fetch logs for this job — HTTP ${raw.status}]`;
            }
            body += "\n\n";
          }
        }
      }
    } catch (err) {
      body = `Error fetching logs: ${err.message}`;
    }

    let truncNote = "";
    if (body.length > MAX_CHARS) {
      body = body.slice(-MAX_CHARS);
      truncNote = `[...older log lines cut for length...]\n\n`;
    }

    const backRepo   = encodeURIComponent(url.searchParams.get("repo")   || "");
    const backBranch = encodeURIComponent(url.searchParams.get("branch") || "");
    const backToken  = encodeURIComponent(url.searchParams.get("token")  || "");

    return new Response(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=240, initial-scale=1">
<title>Log</title>
</head>
<body style="background:#000;color:#0f0;font-family:monospace;font-size:11px;line-height:1.3;padding:4px;margin:0;">
<div style="color:#aaa;">Action Log</div>
<hr style="border-color:#333;margin:4px 0;">
<pre style="white-space:pre-wrap;word-break:break-all;margin:0;font-size:11px;">${esc(truncNote + body)}</pre>
<hr style="border-color:#333;margin:4px 0;">
${runUrl ? `<a href="${esc(runUrl)}" style="color:#aaa;">[ Full log on GitHub ]</a><br><br>` : ""}
<a href="/dispatched?repo=${backRepo}&branch=${backBranch}&token=${backToken}" style="color:#0f0;">[ Back ]</a>
</body>
</html>`, { headers: { "content-type": "text/html" } });
  }

  // =========================================================================
  //  /dispatched — GET only, PRG target
  // =========================================================================
  if (url.pathname === "/dispatched" && request.method === "GET") {
    // FIX 3: Escape repo and branch before injecting into HTML (XSS)
    const repoRaw   = url.searchParams.get("repo")   || "arnavgr/";
    const branchRaw = url.searchParams.get("branch") || "main";
    const token     = url.searchParams.get("token")  || "";
    const repo   = esc(repoRaw);
    const branch = esc(branchRaw);

    const currentStatus = await env.AGENT_KV.get("agent_status") || "⏳ Waiting for GitHub Actions...";
    const isDone = currentStatus.includes('✅') || currentStatus.includes('❌');
    const refreshMeta = isDone ? "" : '<meta http-equiv="refresh" content="5">';

    // FIX 6: carry the PIN through as ?token= so /log (and /status) work
    // without re-prompting. Same trust model as the existing /status check.
    const logHref = `/log?repo=${encodeURIComponent(repoRaw)}&branch=${encodeURIComponent(branchRaw)}&token=${encodeURIComponent(token)}`;

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
        <br><br><a href="${logHref}" style="color:#aaa;text-decoration:none;">[ Show Log ]</a>
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

    // NEW: Determine which branch of the MANAGER repo to run
    // Falls back to "main" if the env var isn't set.
    const managerBranch = env.MANAGER_BRANCH || "main"; 

    const res = await fetch(
      `https://api.github.com/repos/${env.GH_USER}/${env.MANAGER_REPO}/actions/workflows/agent.yml/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GH_PAT}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "CF-Worker-Agent"
        },
        body: JSON.stringify({
          ref: managerBranch, // Targets the specific branch (main or testing)
          inputs: { prompt, repo, branch }
        })
      }
    );

    if (!res.ok) {
      await env.AGENT_KV.put("agent_status", `❌ Dispatch failed.`);
      return new Response(`❌ GitHub dispatch failed`, { status: 500 });
    }

    // FIX 6: pass the (now-validated) PIN through as ?token= so /dispatched
    // can link to /log and /status without asking again.
    const params = new URLSearchParams({ repo, branch, token: pin });
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
