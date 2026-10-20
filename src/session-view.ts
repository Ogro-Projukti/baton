import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { JsonStore } from './store';
import { isSessionViewMessage, SessionRecord } from './types';
import { currentProject, sameProject } from './project';
import { clearPersonalKey, defaultKeyStatus, personalKeyStatus, savePersonalKey, setKeys } from './secrets';
import { configureRouter } from './router';
import { getRouterSettings, RouterSettingsSchema } from './router/settings';
import { copyMcpConfig } from './mcp/config';
import { McpSession } from './mcp/session';
import { TaskFlow } from './task-flow';

export class SessionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'baton.sessions';
  private view?: vscode.WebviewView;
  private activeSessionId?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: JsonStore,
    private readonly onSelectSession: (sessionId: string) => Promise<void> | void,
    private readonly onNewSession: () => Promise<void> | void,
    private readonly secrets: vscode.SecretStorage,
    private readonly mcp: McpSession,
    private readonly context: vscode.ExtensionContext,
    private readonly taskFlow: TaskFlow,
  ) {}

  public setActiveSessionId(id: string | undefined): void {
    this.activeSessionId = id;
    void this.postActiveSession();
  }

  public getActiveSessionId(): string | undefined {
    return this.activeSessionId;
  }

  public async refresh(): Promise<void> {
    if (!this.view) return;
    try {
      const workspace = currentProject();
      const allSessions = (await this.store.loadSessions()) ?? [];
      const sessions = workspace
        ? allSessions.filter((s) => sameProject(s.workspaceUri, workspace.uri))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : [];
      const folder = vscode.workspace.workspaceFolders?.find((entry) => entry.uri.toString() === workspace?.uri);
      const states = folder ? await this.taskFlow.files.listTasks(folder.uri.fsPath) : [];
      const stateById = new Map(states.map((entry) => [entry.id, entry]));
      await this.view.webview.postMessage({
        type: 'sessionsList',
        sessions: sessions.map((session) => ({ ...session,
          taskState: stateById.get(session.taskIds?.[0] ?? '')?.state,
          nextAction: stateById.get(session.taskIds?.[0] ?? '')?.nextAction })),
        activeSessionId: sessions.some((session) => session.id === this.activeSessionId) ? this.activeSessionId : undefined,
        project: workspace ? { name: workspace.name, uri: workspace.uri } : undefined,
      });
    } catch {
      // Sidebar post failed, fall through safely
    }
  }

  private async postActiveSession(): Promise<void> {
    if (!this.view) return;
    try {
      await this.view.webview.postMessage({
        type: 'activeSessionChanged',
        activeSessionId: this.activeSessionId,
      });
    } catch {
      // closed
    }
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSessionViewMessage(message)) return;
      try {
        if (message.type === 'loadSessions') {
          await this.refresh();
        } else if (message.type === 'openProject') {
          await vscode.commands.executeCommand('vscode.openFolder');
        } else if (message.type === 'selectSession') {
          const project = currentProject();
          const session = await this.store.getSession(message.sessionId);
          if (!project || !sameProject(session?.workspaceUri, project.uri)) { await this.refresh(); return; }
          await this.onSelectSession(message.sessionId);
          this.activeSessionId = message.sessionId;
          await this.postActiveSession();
        } else if (message.type === 'newSession') {
          if (!currentProject()) {
            void vscode.window.showWarningMessage('Please open or create a project first before creating tasks.');
            return;
          }
          await this.onNewSession();
        } else if (message.type === 'deleteSession') {
          const project = currentProject();
          const session = await this.store.getSession(message.sessionId);
          if (!project || !sameProject(session?.workspaceUri, project.uri)) { await this.refresh(); return; }
          const folder = vscode.workspace.workspaceFolders?.find((entry) => sameProject(entry.uri.toString(), project.uri));
          const location = folder && session?.taskIds?.[0]
            ? await this.taskFlow.files.findTask(folder.uri.fsPath, session.taskIds[0]) : undefined;
          if (location) {
            const state = await this.taskFlow.files.state(location.task);
            if (state.status !== 'done' && state.status !== 'abandoned') {
              await this.taskFlow.files.transition(location.task, 'abandoned', 'User abandoned task');
              await this.store.updateTask(location.id, (task) => ({ ...task, flowStatus: 'abandoned', status: 'blocked' }));
            }
          } else {
            await this.store.deleteSession(message.sessionId);
            if (this.activeSessionId === message.sessionId) this.activeSessionId = undefined;
          }
          await this.refresh();
        } else if (message.type === 'personalKeysStatus') {
          const configured = await personalKeyStatus(this.secrets);
          const hasDefault = defaultKeyStatus();
          await this.view?.webview.postMessage({ type: 'personalKeysStatus', configured, hasDefault });
        } else if (message.type === 'savePersonalKey') {
          const saved = await savePersonalKey(this.secrets, message.provider, message.value);
          const configured = await personalKeyStatus(this.secrets);
          const hasDefault = defaultKeyStatus();
          const name = message.provider === 'gemma' ? 'Google AI Studio' : message.provider === 'ollama' ? 'Ollama Cloud' : 'ElevenLabs';
          await this.view?.webview.postMessage({
            type: 'personalKeysStatus',
            configured,
            hasDefault,
            notice: saved ? `${name} key saved.` : `Could not save ${name} key.`,
          });
        } else if (message.type === 'clearPersonalKey') {
          const cleared = await clearPersonalKey(this.secrets, message.provider);
          const configured = await personalKeyStatus(this.secrets);
          const hasDefault = defaultKeyStatus();
          const name = message.provider === 'gemma' ? 'Google AI Studio' : message.provider === 'ollama' ? 'Ollama Cloud' : 'ElevenLabs';
          await this.view?.webview.postMessage({
            type: 'personalKeysStatus',
            configured,
            hasDefault,
            notice: cleared ? `${name} key removed. Reverted to default.` : `Could not remove ${name} key.`,
          });
        } else if (message.type === 'openVsCodeSetKeys') {
          await setKeys(this.secrets);
          const configured = await personalKeyStatus(this.secrets);
          const hasDefault = defaultKeyStatus();
          await this.view?.webview.postMessage({ type: 'personalKeysStatus', configured, hasDefault });
        } else if (message.type === 'routerSettingsStatus') {
          await this.view?.webview.postMessage({ type: 'routerSettingsStatus', settings: getRouterSettings() });
        } else if (message.type === 'saveRouterSettings') {
          const parsed = RouterSettingsSchema.safeParse(message.settings);
          if (parsed.success && (await this.store.saveRouterSettings(parsed.data))) {
            configureRouter(parsed.data);
            await this.view?.webview.postMessage({
              type: 'routerSettingsStatus',
              settings: getRouterSettings(),
              notice: 'Intelligent routing settings saved.',
            });
          } else {
            await this.view?.webview.postMessage({
              type: 'routerSettingsStatus',
              settings: getRouterSettings(),
              notice: 'Could not save routing settings.',
            });
          }
        } else if (message.type === 'mcpStatusRequest') {
          let options;
          try { options = this.mcp.running ? this.mcp.options() : undefined; } catch { /* closed */ }
          await this.view?.webview.postMessage({
            type: 'mcpStatus',
            running: this.mcp.running,
            endpoint: options?.args[0],
            command: options?.command,
          });
        } else if (message.type === 'mcpToggle') {
          const notice = this.mcp.running ? await this.mcp.stop() : await this.mcp.start();
          let options;
          try { options = this.mcp.running ? this.mcp.options() : undefined; } catch { /* closed */ }
          await this.view?.webview.postMessage({
            type: 'mcpStatus',
            running: this.mcp.running,
            endpoint: options?.args[0],
            command: options?.command,
            notice,
          });
        } else if (message.type === 'mcpCopyConfig') {
          await copyMcpConfig(this.context);
        }
      } catch {
        // Fall through safely
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    try {
      const template = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'session.html'));
      const replacements: Record<string, string> = {
        nonce: randomBytes(16).toString('hex'),
        cspSource: webviewView.webview.cspSource,
        scriptUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'session.js')).toString(),
        styleUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'session.css')).toString(),
      };
      webviewView.webview.html = Buffer.from(template).toString('utf8').replace(
        /\{\{(\w+)\}\}/g,
        (_, name: string) => replacements[name] ?? '',
      );
    } catch {
      webviewView.webview.html = '<!doctype html><html><body>Could not load session manager.</body></html>';
    }
  }

}
