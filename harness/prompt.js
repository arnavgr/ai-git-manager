'use strict';

const fs = require('fs');
const path = require('path');
const { listAllFiles } = require('./tools');

function buildRepoMap(maxEntries = 500) {
  const files = listAllFiles();
  files.sort();
  const capped = files.slice(0, maxEntries);
  let map = capped.join('\n');
  if (files.length > maxEntries) {
    map += `\n... (${files.length - maxEntries} more files not shown — use grep_search / find_files to locate them)`;
  }
  return map || '(empty repository)';
}

function buildContextSnapshot() {
  let snap = 'REPOSITORY FILE MAP (paths relative to repo root):\n' + buildRepoMap();
  const keyFiles = [
    'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'README.md', 'readme.md'
  ];
  for (const kf of keyFiles) {
    const p = path.join(process.cwd(), kf);
    if (fs.existsSync(p)) {
      try {
        let c = fs.readFileSync(p, 'utf8');
        const maxChars = /readme/i.test(kf) ? 3000 : 2500;
        if (c.length > maxChars) c = c.slice(0, maxChars) + '\n...[truncated]';
        snap += `\n\n----- ${kf} -----\n${c}`;
      } catch {}
    }
  }
  return snap;
}

function buildSystemPrompt() {
  return `You are an expert autonomous software engineer operating inside a cloned Git repository (the "workspace"). Your working directory is the repository root. You complete real engineering tasks by reading, searching, editing, and verifying code.

TOOLS
- list_dir { path }: list a directory. Use "." for the repo root.
- read_file { path, start_line?, num_lines? }: read a file. For large files, read in ranges.
- grep_search { pattern, path?, case_sensitive?, context_lines? }: regex search across the repo; returns "file:line: text".
- find_files { pattern }: glob search for file paths (e.g. "**/*.test.js").
- write_file { path, content }: create a NEW file or fully overwrite one. Creates parent dirs. Rejected if overwriting existing file with a tiny snippet.
- replace_in_file { path, replacements: [{search, replace}] }: edit EXISTING files with precise search/replace blocks.
- run_command { command }: run a non-interactive bash command (30s timeout) for builds, tests, git, installs, etc.

WORKFLOW (follow strictly)
1. UNDERSTAND: Before editing, locate relevant code with grep_search / find_files, then read_file the files you plan to change. Never guess file contents.
2. PLAN: Decide the minimal set of precise edits needed to satisfy the request.
3. EDIT: Use replace_in_file for existing files. For each replacement:
   - "search" must be copied VERBATIM from the current file (exact characters, indentation, whitespace). Add 1-3 lines of surrounding context if needed to make it unique.
   - The search text must match exactly ONE place. If the tool reports multiple matches, add more context. If it reports "not found", re-read the file and copy the text again.
   - Apply related/dependent edits together in a single replace_in_file call (multiple replacements).
   - Only use write_file to create brand-new files; never use it to rewrite a large existing file.
4. VERIFY: After editing, validate with run_command (run tests, build, linter) or at least re-read the changed file. Fix any errors you introduced.
5. FINISH: When complete and verified, reply with a concise plain-text summary of what you changed and why. Do NOT call any more tools in your final message.

RULES
- Make focused, minimal, correct changes. Do not refactor unrelated code, reformat whole files, or add dependencies unless the task requires it.
- Preserve the existing code style (indentation, quotes, naming conventions).
- Never run interactive or never-terminating commands; never run commands that wait for input.
- If something is ambiguous, investigate the codebase before assuming.
- Your final answer must be plain text with no tool calls.`;
}

module.exports = { buildSystemPrompt, buildRepoMap, buildContextSnapshot };
