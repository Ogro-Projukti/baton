import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const envVars = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
};

if (fs.existsSync('.env')) {
  try {
    const content = fs.readFileSync('.env', 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(GEMINI_API_KEY|OLLAMA_API_KEY|ELEVENLABS_API_KEY)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '').trim();
      }
      if (value && !envVars[match[1]]) {
        envVars[match[1]] = value;
      }
    }
  } catch {
    // Graceful fallback if .env cannot be read
  }
}

const base = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
  define: {
    'process.env.BATON_DEFAULT_GEMINI_KEY': JSON.stringify(envVars.GEMINI_API_KEY),
    'process.env.BATON_DEFAULT_OLLAMA_KEY': JSON.stringify(envVars.OLLAMA_API_KEY),
    'process.env.BATON_DEFAULT_ELEVENLABS_KEY': JSON.stringify(envVars.ELEVENLABS_API_KEY),
  },
};
const entries = [
  { ...base, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...base, entryPoints: ['src/mcp/server.ts'], outfile: 'out/mcp.js', external: ['vscode'] },
];

try {
  if (process.argv.includes('--watch')) {
    const contexts = await Promise.all(entries.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
  } else {
    await Promise.all(entries.map((options) => esbuild.build(options)));
  }
} catch {
  process.exitCode = 1;
}
