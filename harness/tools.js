'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class ToolError extends Error {}

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.output',
  'coverage', '__pycache__', '.venv', 'venv', '.cache', '.turbo', 'out',
  'vendor', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', 'target'
]);

const IGNORE_FILE_PATTERNS = [
  /\.min\.js$/, /\.min\.css$/, /\.map$/, /\.lock$/, /package-lock\.json$/,
  /yarn\.lock$/, /pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|webp|svg|bmp)$/i,
  /\.(woff2?|ttf|eot|otf)$/i, /\.(mp4|webm|mp3|wav)$/i,
  /\.(zip|gz|tar|bz2|7z|rar)$/i, /\.pdf$/i, /\.wasm$/i, /\.(pyc|pyo|class|o|obj|so|dll|exe)$/i
];

function safeResolve(rel) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, rel || '.');
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new ToolError('Path escapes the workspace: ' + rel);
  }
  return resolved;
}

function walkDir(root, onFile) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink && e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (IGNORE_FILE_PATTERNS.some(p => p.test(e.name))) continue;
        const rel = path.relative(root, full);
        if (onFile(full, rel)) return;
      }
    }
  }
}

function listAllFiles() {
  const files = [];
  walkDir(process.cwd(), (full, rel) => { files.push(rel); });
  return files;
}

function countOccurrences(haystack, needle) {
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

function normalizeWithMap(haystack) {
  const norm = [], map = [];
  let lastSpace = true;
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (!lastSpace) { norm.push(' '); map.push(i); lastSpace = true; }
    } else {
      norm.push(ch); map.push(i); lastSpace = false;
    }
  }
  return { normStr: norm.join(''), map };
}

function flexMatchUnique(haystack, needle) {
  const { normStr, map } = normalizeWithMap(haystack);
  const normNeedle = needle.replace(/[ \t\n\r\f\v]+/g, ' ').trim();
  if (!normNeedle) return null;
  let count = 0, first = -1, idx = 0;
  while ((idx = normStr.indexOf(normNeedle, idx)) !== -1) {
    count++;
    if (count === 1) first = idx;
    if (count > 1) return { ambiguous: true };
    idx += normNeedle.length;
  }
  if (count === 0) return null;
  const start = map[first];
  const end = map[first + normNeedle.length - 1] + 1;
  return { start, end };
}

function applyReplacements(original, replacements) {
  let content = original;
  const notes = [];
  for (let i = 0; i < replacements.length; i++) {
    const r = replacements[i] || {};
    const search = r.search, replace = typeof r.replace === 'string' ? r.replace : '';
    if (typeof search !== 'string' || search === '') {
      throw new ToolError(`Replacement #${i + 1}: 'search' must be a non-empty string.`);
    }
    const exact = countOccurrences(content, search);
    if (exact === 1) {
      content = content.replace(search, () => replace);
      notes.push(`#${i + 1} applied (exact match)`);
      continue;
    }
    if (exact > 1) {
      throw new ToolError(`Replacement #${i + 1}: search text matches ${exact} locations. Add more surrounding context so it matches exactly once.`);
    }
    const flex = flexMatchUnique(content, search);
    if (!flex) {
      throw new ToolError(`Replacement #${i + 1}: search text not found. Re-read the file and copy the current text exactly.`);
    }
    if (flex.ambiguous) {
      throw new ToolError(`Replacement #${i + 1}: search text matches multiple locations even ignoring whitespace. Add more context.`);
    }
    content = content.slice(0, flex.start) + replace + content.slice(flex.end);
    notes.push(`#${i + 1} applied (whitespace-tolerant match)`);
  }
  return { content, notes };
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

function buildSearchRegex(pattern, caseSensitive) {
  try { return new RegExp(pattern, caseSensitive ? '' : 'i'); }
  catch {
    const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(esc, caseSensitive ? '' : 'i');
  }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a directory. Use "." for the repository root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file. For large files, use start_line/num_lines to read a specific range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', description: '1-based line to start at (optional)' },
          num_lines: { type: 'integer', description: 'Number of lines to read (optional)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Regex search across the repository. Returns "file:line: text". Use to locate code before editing.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or literal pattern to search for' },
          path: { type: 'string', description: 'Optional path/substring to restrict the search (e.g. "src/")' },
          case_sensitive: { type: 'boolean' },
          context_lines: { type: 'integer', description: 'Lines of context above/below each match (default 0)' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find file paths by glob pattern, e.g. "**/*.test.js" or "*.py".',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a NEW file or fully overwrite one. Will be rejected if attempting to overwrite an existing large file with a truncated snippet.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Edit an EXISTING file with precise search/replace blocks. Each search must match exactly one place; copy it verbatim from read_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          replacements: {
            type: 'array',
            description: 'Ordered list of edits to apply.',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: 'Exact existing text to find (verbatim, including indentation).' },
                replace: { type: 'string', description: 'New text to insert in its place.' }
              },
              required: ['search', 'replace']
            }
          }
        },
        required: ['path', 'replacements']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a non-interactive bash command in the repo root (30s timeout). Use for builds, tests, git, installs.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }
  }
];

function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_dir': {
        const p = safeResolve(args.path || '.');
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const lines = entries.map(e => e.isDirectory() ? e.name + '/' : e.name);
        return lines.length ? lines.join('\n') : '(empty directory)';
      }

      case 'read_file': {
        const p = safeResolve(args.path);
        const raw = fs.readFileSync(p, 'utf8');
        const allLines = raw.split('\n');
        const total = allLines.length;
        const start = Math.max(1, parseInt(args.start_line, 10) || 1);
        const numLines = args.num_lines !== undefined ? parseInt(args.num_lines, 10) : undefined;
        const startIdx = start - 1;
        let lines = allLines;
        if (startIdx > 0 || numLines !== undefined) {
          lines = allLines.slice(startIdx, numLines !== undefined ? startIdx + numLines : undefined);
        }
        let text = lines.join('\n');
        const MAX_CHARS = 150000;
        if (text.length > MAX_CHARS) {
          text = text.slice(0, MAX_CHARS) + '\n...[truncated — use start_line/num_lines to read specific ranges]';
        }
        const shownEnd = Math.min(startIdx + lines.length, total);
        const rangeNote = (startIdx > 0 || numLines !== undefined) ? `, showing lines ${start}-${shownEnd}` : '';
        return `File: ${args.path} (${total} lines${rangeNote})\n${text}`;
      }

      case 'grep_search': {
        const caseSensitive = !!args.case_sensitive;
        const regex = buildSearchRegex(String(args.pattern || ''), caseSensitive);
        const filter = args.path ? String(args.path) : '';
        const ctx = Math.max(0, parseInt(args.context_lines, 10) || 0);
        const results = [];
        const MAX_RESULTS = 60;
        walkDir(process.cwd(), (full, rel) => {
          if (results.length >= MAX_RESULTS) return true;
          if (filter && !rel.includes(filter)) return;
          let st;
          try { st = fs.statSync(full); } catch { return; }
          if (st.size > 2 * 1024 * 1024) return;
          let text;
          try { text = fs.readFileSync(full, 'utf8'); } catch { return; }
          if (text.includes('\u0000')) return;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              if (ctx > 0) {
                const lo = Math.max(0, i - ctx), hi = Math.min(lines.length - 1, i + ctx);
                let block = '';
                for (let j = lo; j <= hi; j++) block += `${j === i ? '>' : ' '} ${rel}:${j + 1}: ${lines[j]}\n`;
                results.push(block.replace(/\n$/, ''));
              } else {
                results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
              }
              if (results.length >= MAX_RESULTS) break;
            }
          }
        });
        return results.length ? results.join('\n') : 'No matches found.';
      }

      case 'find_files': {
        const re = globToRegex(String(args.pattern || ''));
        const matches = [];
        const MAX = 100;
        walkDir(process.cwd(), (full, rel) => {
          if (matches.length >= MAX) return true;
          const base = path.basename(rel);
          if (re.test(rel) || re.test(base)) matches.push(rel);
        });
        return matches.length ? matches.join('\n') : 'No files matched.';
      }

      case 'write_file': {
        const p = safeResolve(args.path);
        const content = String(args.content || '');
        if (fs.existsSync(p)) {
          const existing = fs.readFileSync(p, 'utf8');
          if (existing.length > 300 && content.length < existing.length * 0.35) {
            return `Safety rejection: '${args.path}' already exists (${existing.length} chars). Your proposed write is significantly shorter (${content.length} chars). To modify existing files, use 'replace_in_file' for targeted edits, or provide the complete file contents.`;
          }
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
        return `Created/overwrote ${args.path} (${content.length} chars).`;
      }

      case 'replace_in_file': {
        const p = safeResolve(args.path);
        if (!fs.existsSync(p)) {
          throw new ToolError(`File not found: ${args.path}. Use write_file to create new files.`);
        }
        const replacements = Array.isArray(args.replacements) ? args.replacements : [];
        if (replacements.length === 0) throw new ToolError("'replacements' must contain at least one {search, replace} pair.");
        const original = fs.readFileSync(p, 'utf8');
        const { content, notes } = applyReplacements(original, replacements);
        fs.writeFileSync(p, content, 'utf8');
        return `Edited ${args.path}:\n` + notes.join('\n');
      }

      case 'run_command': {
        const command = String(args.command || '').trim();
        if (!command) return 'Error: no command provided.';
        try {
          const out = execSync(command, {
            encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024,
            cwd: process.cwd(), shell: '/bin/bash'
          });
          return (out && out.trim()) ? out : '(command completed with no output)';
        } catch (e) {
          let detail = '';
          if (e.stdout) detail += 'STDOUT:\n' + e.stdout + '\n';
          if (e.stderr) detail += 'STDERR:\n' + e.stderr + '\n';
          const timedOut = e.killed ? ' (timed out after 30s)' : '';
          return `Command exited with an error${timedOut}:\n${detail || e.message}`;
        }
      }

      default:
        return 'Unknown tool: ' + name;
    }
  } catch (e) {
    return 'Tool error: ' + (e && e.message ? e.message : String(e));
  }
}

module.exports = {
  TOOLS,
  executeTool,
  listAllFiles,
  countOccurrences,
  flexMatchUnique,
  applyReplacements,
  globToRegex,
  ToolError
};
