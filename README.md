# OpenClaude Live Git Agent

A headless, zero-local-compute AI coding agent for managing and refactoring GitHub repositories via a browser interface.

The system runs [OpenClaude](https://github.com/gitlawb/openclaude) inside GitHub Actions and connects to a Cloudflare Pages dispatch bridge over Cloudflare KV. It supports multi-turn iterative editing, direct file uploads, real-time provider telemetry, and automated multi-tier provider fallbacks.

---

## Architecture

* **Cloudflare Pages (`[[path]].js`):** Lightweight UI and router. Handles HMAC PIN authentication, accepts prompts/files, and synchronizes state via Cloudflare KV. Polling is state-aware (polls every 3s during agent execution, pauses when waiting for user input).
* **GitHub Actions (`agent.yml`):** Ubuntu runner executing OpenClaude with session resumption (`--resume`). Ingests uploaded files to the repo root, handles provider fallback cascades, and executes git commits/pushes.

---

## Model Fallback Chain

If a provider exhausts its quota or returns a `429`, the runner automatically falls back to the next tier:

1. **Gemini 3.5 Flash** (`gemini-3.5-flash`)
2. **Gemini 3.1 Flash-Lite** (`gemini-3.1-flash-lite`)
3. **Groq** (`qwen/qwen3.6-27b` with `16384` token output limiter)
4. **OpenRouter** (`openrouter/free`)

---

## Self-Hosting Setup

### 1. GitHub Repository Secrets

In the repository hosting your `agent.yml` workflow, navigate to **Settings > Secrets and variables > Actions** and add:

| Secret               | Description                                                              |
| :------------------- | :----------------------------------------------------------------------- |
| `CF_ACCOUNT_ID`      | Cloudflare Account ID                                                    |
| `CF_API_TOKEN`       | Cloudflare API Token (Requires **Workers KV:Edit** permissions)          |
| `KV_NAMESPACE_ID`    | ID of your Cloudflare KV Namespace                                       |
| `GH_PAT`             | GitHub Personal Access Token (Classic) with `repo` and `workflow` scopes |
| `GEMINI_API_KEY`     | Google Gemini API Key                                                    |
| `GROQ_API_KEY`       | Groq API Key                                                             |
| `OPENROUTER_API_KEY` | *(Optional)* OpenRouter API Key                                          |
| `TAVILY_API_KEY`     | *(Optional)* Tavily API Key for web search capabilities                  |

### 2. Cloudflare Pages Deployment

1. Deploy `[[path]].js` to Cloudflare Pages (or as a Cloudflare Worker).
2. Create a KV namespace named `AGENT_KV` and bind it to variable `AGENT_KV` under **Settings > Functions > KV namespace bindings**.
3. Add the following Environment Variables in Cloudflare Pages (**Settings > Environment variables**):

   * `AUTH_PIN`: Access PIN for the web interface.
   * `GH_USER`: Your GitHub username.
   * `GH_PAT`: Same GitHub Personal Access Token configured above.
   * `MANAGER_REPO`: Repository name where `agent.yml` is stored.
   * `MANAGER_BRANCH`: *(Optional)* Branch for the workflow dispatch (defaults to `main`).

---

## Runtime Commands

Send these commands directly in the chat interface during an active session:

* `/push` — Stages all changes (`git add .`), creates a commit, and pushes to the target branch.
* `/exit` — Forcefully terminates the runner and ends the session.

*Note: The runner automatically shuts down after 15 minutes of inactivity to prevent consuming GitHub Actions minutes.*

---

## License

MIT

