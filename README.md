# ai-git-manager (or preferred name)

A zero-local-compute, headless AI coding agent. 

This project allows you to dispatch complex, autonomous code refactoring tasks to any of your GitHub repositories directly from a web browser. It completely offloads the heavy LLM processing and Git operations to the cloud, making it possible to execute massive codebase changes even from aging hardware like an Intel Core 2 Duo with 2GB of RAM, or directly from a mobile device.

## Architecture

The system operates across a dual-tier cloud architecture:

1. **The Dispatcher (Cloudflare Pages):** A lightweight HTML interface and routing function (`[[path]].js`) that securely accepts a prompt, validates an HMAC PIN, updates a live KV status database, and triggers the CI pipeline.
2. **The Surgeon (GitHub Actions):** An `ubuntu-latest` runner equipped with 7GB of RAM that spins up [OpenClaude](https://github.com/gitlawb/openclaude). It clones the target repository, reads the codebase, autonomously writes and verifies the requested code modifications using the `gemini-3.1-flash-lite` model, and pushes the final commits back to the branch.

## Features

* **Zero Local Overhead:** Requires no local Node.js environments, Python scripts, or Docker containers. 
* **Suckless Philosophy:** Does one thing (autonomous codebase editing) and does it efficiently without unnecessary toolchain bloat.
* **Live Status Tracking:** Utilizes Cloudflare KV to provide real-time updates (e.g., `⏳ Reading codebase...`) to the front-end interface.
* **Headless Autonomy:** Bypasses interactive terminal prompts using `--dangerously-skip-permissions` to allow OpenClaude to refactor without human intervention during the run.

## Setup & Deployment

### 1. GitHub Setup
1. Fork or clone this repository.
2. Navigate to **Settings > Secrets and variables > Actions**.
3. Add the following repository secrets:
   - `CF_ACCOUNT_ID`: Your Cloudflare Account ID.
   - `CF_API_TOKEN`: Cloudflare API Token (with KV edit permissions).
   - `KV_NAMESPACE_ID`: The ID of your Cloudflare KV namespace.
   - `GEMINI_API_KEY`: Your Google Gemini API Key.
   - `GH_PAT`: A GitHub Personal Access Token (Classic) with `repo` scope to clone and push to your target repositories.

### 2. Cloudflare Pages Setup
1. Create a new Cloudflare Pages project connected to this repository.
2. Navigate to **Settings > Functions > Variables**.
3. Add your `AUTH_PIN` (the password used on the web interface), `GH_USER`, `MANAGER_REPO`, and `GH_PAT`.
4. Ensure you bind your KV Namespace (e.g., `AGENT_KV`) to both Production and Preview environments under the Functions bindings settings.

## Usage

1. Visit your deployed Cloudflare Pages URL.
2. Enter your `PIN`.
3. Specify the target `repo` (e.g., `arnavgr/target-project`) and `branch`.
4. Provide a detailed task description in the prompt.
5. Hit **EXECUTE**. 

The web interface will redirect to a live status page. Behind the scenes, the GitHub Action will spin up, OpenClaude will patch the files, and the updated code will be pushed directly to your specified branch.

## License

MIT
