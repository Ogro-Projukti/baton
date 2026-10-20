import type * as vscode from 'vscode';

declare const process: {
  env: {
    BATON_DEFAULT_GEMINI_KEY?: string;
    BATON_DEFAULT_OLLAMA_KEY?: string;
    BATON_DEFAULT_ELEVENLABS_KEY?: string;
    GEMINI_API_KEY?: string;
    OLLAMA_API_KEY?: string;
    ELEVENLABS_API_KEY?: string;
    [key: string]: string | undefined;
  };
};

export const KEY_NAMES = ['GEMINI_API_KEY', 'OLLAMA_API_KEY', 'ELEVENLABS_API_KEY'] as const;
export type KeyName = typeof KEY_NAMES[number];
export const PERSONAL_KEYS = {
  gemma: 'BATON_PERSONAL_GEMINI_API_KEY',
  ollama: 'BATON_PERSONAL_OLLAMA_API_KEY',
  elevenlabs: 'BATON_PERSONAL_ELEVENLABS_API_KEY',
} as const;
export type PersonalProvider = keyof typeof PERSONAL_KEYS;

export const DEFAULT_KEYS: Record<PersonalProvider, string | undefined> = {
  gemma: (typeof process !== 'undefined' && (process.env?.BATON_DEFAULT_GEMINI_KEY || process.env?.GEMINI_API_KEY)) || undefined,
  ollama: (typeof process !== 'undefined' && (process.env?.BATON_DEFAULT_OLLAMA_KEY || process.env?.OLLAMA_API_KEY)) || undefined,
  elevenlabs: (typeof process !== 'undefined' && (process.env?.BATON_DEFAULT_ELEVENLABS_KEY || process.env?.ELEVENLABS_API_KEY)) || undefined,
};

export function hasDefaultKey(provider: PersonalProvider): boolean {
  return Boolean(DEFAULT_KEYS[provider]?.trim());
}

export function defaultKeyStatus(): Record<PersonalProvider, boolean> {
  return {
    gemma: hasDefaultKey('gemma'),
    ollama: hasDefaultKey('ollama'),
    elevenlabs: hasDefaultKey('elevenlabs'),
  };
}

export async function preferredKey(secrets: vscode.SecretStorage, provider: PersonalProvider): Promise<string | undefined> {
  const personal = await getKey(secrets, PERSONAL_KEYS[provider]);
  if (personal) return personal;

  const legacy = await getKey(secrets, provider === 'gemma' ? 'GEMINI_API_KEY'
    : provider === 'ollama' ? 'OLLAMA_API_KEY' : 'ELEVENLABS_API_KEY');
  if (legacy) return legacy;

  return DEFAULT_KEYS[provider];
}

export async function personalKeyStatus(secrets: vscode.SecretStorage): Promise<Record<PersonalProvider, boolean>> {
  return {
    gemma: Boolean(await getKey(secrets, PERSONAL_KEYS.gemma)),
    ollama: Boolean(await getKey(secrets, PERSONAL_KEYS.ollama)),
    elevenlabs: Boolean(await getKey(secrets, PERSONAL_KEYS.elevenlabs)),
  };
}

export async function savePersonalKey(secrets: vscode.SecretStorage, provider: PersonalProvider, value: string): Promise<boolean> {
  return setKey(secrets, PERSONAL_KEYS[provider], value);
}

export async function clearPersonalKey(secrets: vscode.SecretStorage, provider: PersonalProvider): Promise<boolean> {
  try {
    await secrets.delete(PERSONAL_KEYS[provider]);
    return true;
  } catch {
    return false;
  }
}

// F5 runs the extension from this repository.
// Import only known keys into SecretStorage; never expose .env to task context.
export async function importDevelopmentKeys(context: vscode.ExtensionContext): Promise<void> {
  try {
    // Required lazily so KB scripts can import the router outside the extension host.
    const vscode = require('vscode') as typeof import('vscode');
    if (!vscode?.ExtensionMode || context?.extensionMode !== vscode.ExtensionMode.Development) return;
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, '.env'));
    const source = Buffer.from(bytes).toString('utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(GEMINI_API_KEY|OLLAMA_API_KEY|ELEVENLABS_API_KEY)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '').trim();
      }
      if (value) await setKey(context.secrets, match[1] as KeyName, value);
    }
  } catch {
    // No development .env, or unavailable storage: existing keys remain usable.
  }
}

export async function getKey(secrets: vscode.SecretStorage, name: KeyName | typeof PERSONAL_KEYS[PersonalProvider]): Promise<string | undefined> {
  try {
    const val = await secrets.get(name);
    if (val?.trim()) return val.trim();
  } catch {
    // Missing or unavailable SecretStorage leaves this provider disabled.
  }
  return undefined;
}

export async function setKey(secrets: vscode.SecretStorage, name: KeyName | typeof PERSONAL_KEYS[PersonalProvider], value: string): Promise<boolean> {
  if (!value.trim()) return false;
  try {
    await secrets.store(name, value.trim());
    return true;
  } catch {
    return false;
  }
}

export async function setKeys(secrets: vscode.SecretStorage): Promise<void> {
  const vscode = require('vscode') as typeof import('vscode');
  let saved = 0;
  try {
    for (const name of KEY_NAMES) {
      const value = await vscode.window.showInputBox({
        title: `Baton: ${name}`,
        password: true,
        ignoreFocusOut: true,
        prompt: 'Stored securely in VS Code. Leave empty to keep the existing key.',
      });
      if (value === undefined) break;
      if (!value.trim()) continue;
      if (await setKey(secrets, name, value)) saved++;
      else void vscode.window.showErrorMessage(`Baton could not save ${name}. Please try again.`);
    }
    if (saved) void vscode.window.showInformationMessage(`Baton: ${saved} API key(s) saved.`);
  } catch {
    void vscode.window.showErrorMessage('Baton could not open the API key prompt. Please try again.');
  }
}
