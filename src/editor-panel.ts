import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { clearPersonalKey, defaultKeyStatus, personalKeyStatus, savePersonalKey } from './secrets';
import { JsonStore } from './store';
import { configureRouter, routeTask } from './router';
import { classify } from './router/rules';
import { getRouterSettings, RouterSettingsSchema } from './router/settings';
import { decide } from './policy';
import {
  ExtensionMessage,
  isHandoffMessage,
  isHistoryMessage,
  isPanelMessage,
  isTaskActionMessage,
  isVoiceMessage,
  Route,
  SessionRecord,
  TaskResourcesResult,
  UserAgentConfig,
} from './types';
import { buildContext, BuiltContext, MAX_CONTEXT_CHARS, selectContext } from './context';
import { TaskHistory } from './history';
import { handoffAvailability, openExternalHandoff, planExternal, readClipboard } from './handoff';
import { VoiceRecorderSession, startVoiceRecorderServer, transcribe } from './voice';
import { openIntegratedBrowser } from './browser';
import { CodexRunner } from './codex';
import { codexAvailable } from './terminal';
import { copyMcpConfig } from './mcp/config';
import { McpSession } from './mcp/session';
import { discoverResources } from './resources';
import { currentProject, currentProjectFolder, sameProject } from './project';
import { TaskFlow } from './task-flow';
import { TaskOutputChunk, TaskOutputManager } from './task-output';
import { routeToUserAgent } from './router/agent-router';

export class BatonEditorPanel {
  public static currentPanel: BatonEditorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly outputManager: TaskOutputManager;
  private disposables: vscode.Disposable[] = [];
  private activeSession?: SessionRecord;
  private recorderSession?: VoiceRecorderSession;
  private preview?: { requestId: number; text: string; context: BuiltContext; sessionId: string };
  private latestPreview = 0;
  private sessionGeneration = 0;
  private lastRouted?: { taskId: string; text: string; snippet: string };
  private pendingParentTaskId?: string;
  private isDisposed = false;

  public static async createOrShow(
    extensionUri: vscode.Uri,
    store: JsonStore,
    history: TaskHistory,
    codex: CodexRunner,
    mcp: McpSession,
    secrets: vscode.SecretStorage,
    taskFlow: TaskFlow,
    onSessionUpdated?: () => void,
    sessionId?: string,
  ): Promise<BatonEditorPanel> {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Active : vscode.ViewColumn.One;

    if (BatonEditorPanel.currentPanel) {
      BatonEditorPanel.currentPanel.panel.reveal(column);
      if (sessionId) {
        await BatonEditorPanel.currentPanel.loadSession(sessionId);
      }
      return BatonEditorPanel.currentPanel;
    }

    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'baton.editor',
      'Baton',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'baton.svg');

    BatonEditorPanel.currentPanel = new BatonEditorPanel(
      panel,
      extensionUri,
      store,
      history,
      codex,
      mcp,
      secrets,
      taskFlow,
      onSessionUpdated,
    );

    await BatonEditorPanel.currentPanel.init(sessionId);
    return BatonEditorPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly store: JsonStore,
    private readonly history: TaskHistory,
    private readonly codex: CodexRunner,
    private readonly mcp: McpSession,
    private readonly secrets: vscode.SecretStorage,
    private readonly taskFlow: TaskFlow,
    private readonly onSessionUpdated?: () => void,
  ) {
    this.panel = panel;
    this.outputManager = new TaskOutputManager(this.taskFlow.files);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      null,
      this.disposables,
    );
  }

  public getActiveSessionId(): string | undefined {
    return this.activeSession?.id;
  }

  private setTitle(title: string): void {
    if (this.isDisposed) return;
    try {
      this.panel.title = title;
    } catch {
      // Panel disposed
    }
  }

  public async loadSession(sessionId: string): Promise<void> {
    try {
      const generation = ++this.sessionGeneration;
      const project = this.historyProject();
      if (!project) {
        this.activeSession = undefined;
        this.onSessionUpdated?.();
        await this.postMessage({ type: 'projectState', hasProject: false });
        return;
      }
      const session = await this.store.getSession(sessionId);
      if (!session || !sameProject(session.workspaceUri, project.uri) || generation !== this.sessionGeneration) return;
      const allTasks = (await this.store.loadTasks()) ?? [];
      const tasks = allTasks.filter((t) => session.taskIds?.includes(t.id) && sameProject(t.workspaceUri, project.uri));
      const taskFolder = vscode.workspace.workspaceFolders?.find((folder) => sameProject(folder.uri.toString(), project.uri));
      const latestTask = tasks[tasks.length - 1] ?? tasks[0];
      const flow = taskFolder && latestTask ? await this.taskFlow.inspectSession(taskFolder.uri.fsPath, latestTask.id) : undefined;
      if (generation !== this.sessionGeneration) return;
      if (flow && latestTask) {
        latestTask.flowStatus = flow.state;
        latestTask.planningPrompt = flow.prompt ?? latestTask.planningPrompt;
      }
      let outputBuffer: TaskOutputChunk[] = [];
      if (latestTask) {
        outputBuffer = this.store.getTaskOutputBuffer(latestTask.id);
        if (outputBuffer.length === 0 && taskFolder) {
          const location = await this.taskFlow.files.findTask(taskFolder.uri.fsPath, latestTask.id);
          if (location) {
            outputBuffer = await this.outputManager.loadFromLog(location.task, location.project, latestTask.id);
            this.store.setTaskOutputBuffer(latestTask.id, outputBuffer);
          }
        }
      }

      this.activeSession = session;
      this.onSessionUpdated?.();
      this.setTitle(`Baton · ${session.title.slice(0, 20)}`);
      await this.postMessage({
        type: 'projectState',
        hasProject: true,
        projectName: project.name,
        projectUri: project.uri,
      });
      if (generation !== this.sessionGeneration) return;
      await this.postMessage({
        type: 'activeSession',
        session,
        tasks,
        flow,
        outputBuffer,
        sessionId,
        projectId: project.name,
        taskId: latestTask?.id,
      });

      const latestTaskWithResources = [...tasks].reverse().find((t) => t.resources && (t.resources.videos?.length || t.resources.blogs?.length || t.resources.artifacts?.length));
      const latestResources = latestTaskWithResources?.resources ?? tasks[tasks.length - 1]?.resources;
      if (latestResources) {
        await this.postForSession(sessionId, { type: 'resourcesReady', resources: latestResources });
      } else if (tasks.length > 0 && tasks[tasks.length - 1]?.text) {
        const lastTask = tasks[tasks.length - 1];
        void (async () => {
          try {
            await this.postForSession(sessionId, { type: 'resourcesSearching', taskId: lastTask.id, query: lastTask.text });
            const resources = await discoverResources(this.secrets, lastTask.id, lastTask.text, lastTask.contextSnippet);
            await this.saveTaskResources(lastTask.id, resources, sessionId);
            await this.postForSession(sessionId, { type: 'resourcesReady', resources });
          } catch {
            // Silently fall through
          }
        })();
      }
    } catch {
      // Safely ignore during transitions/disposal
    }
  }

  public async startNewSession(): Promise<void> {
    try {
      const generation = ++this.sessionGeneration;
      this.pendingParentTaskId = undefined;
      const project = this.historyProject();
      if (!project) {
        this.activeSession = undefined;
        this.onSessionUpdated?.();
        await this.postMessage({ type: 'projectState', hasProject: false });
        return;
      }
      const session = await this.store.createSession('New race session', project.uri);
      if (generation !== this.sessionGeneration) return;
      this.activeSession = session;
      this.setTitle('Baton · New race session');
      this.onSessionUpdated?.();
      await this.postMessage({
        type: 'projectState',
        hasProject: true,
        projectName: project.name,
        projectUri: project.uri,
      });
      if (generation !== this.sessionGeneration) return;
      await this.postMessage({
        type: 'activeSession',
        session,
        tasks: [],
      });
    } catch {
      // Safely ignore during transitions/disposal
    }
  }

  public async refreshProjectState(): Promise<void> {
    try {
      const project = this.historyProject();
      if (!project) {
        this.activeSession = undefined;
        this.onSessionUpdated?.();
        await this.postMessage({ type: 'projectState', hasProject: false });
      } else {
        await this.postMessage({
          type: 'projectState',
          hasProject: true,
          projectName: project.name,
          projectUri: project.uri,
        });
        if (!sameProject(this.activeSession?.workspaceUri, project.uri)) {
          const sessions = (await this.store.loadSessions()) ?? [];
          const latest = sessions.filter((session) => sameProject(session.workspaceUri, project.uri))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          if (latest) await this.loadSession(latest.id);
          else await this.startNewSession();
        }
      }
    } catch {
      // Safely ignore during transitions/disposal
    }
  }

  private async init(sessionId?: string): Promise<void> {
    await this.renderHtml();
    const project = this.historyProject();
    if (!project) {
      await this.postMessage({ type: 'projectState', hasProject: false });
      return;
    }
    if (sessionId) await this.loadSession(sessionId);
    else {
      const sessions = (await this.store.loadSessions()) ?? [];
      const latest = sessions.filter((entry) => sameProject(entry.workspaceUri, project.uri))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (latest) await this.loadSession(latest.id);
      else await this.startNewSession();
    }
  }

  private async postMessage(message: unknown): Promise<void> {
    try {
      await this.panel.webview.postMessage(message);
    } catch {
      // Panel disposed
    }
  }

  private async postForSession(sessionId: string | undefined, message: Record<string, unknown>): Promise<void> {
    if (!sessionId || this.activeSession?.id !== sessionId) return;
    await this.postMessage({ ...message, sessionId });
  }

  private async refreshActiveSession(sessionId: string | undefined): Promise<void> {
    if (sessionId && this.activeSession?.id === sessionId) await this.loadSession(sessionId);
  }

  private availableDestinations = async () => ({
    ...handoffAvailability(),
    codex: await codexAvailable(
      vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')?.uri.fsPath ?? process.cwd(),
    ),
  });

  private historyProject(): { uri: string; name: string } | undefined {
    return currentProject();
  }

  private async refreshHistory(): Promise<void> {
    try {
      await this.postMessage(await this.history.handle({ type: 'loadHistory' }, this.historyProject()));
    } catch {
      // closed
    }
  }

  private parseVoiceIntent(raw: string): { text: string; autoRoute: boolean } {
    const trimmed = raw.trim();
    const startsWithRoute = /^route\s+/i.test(trimmed);
    const endsWithGo = /\s+go\.?$/i.test(trimmed);
    let text = trimmed;
    if (startsWithRoute) text = text.replace(/^route\s+/i, '');
    else if (endsWithGo) text = text.replace(/\s+go\.?$/i, '');
    return { text: text.trim(), autoRoute: startsWithRoute || endsWithGo };
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message === 'object' && message !== null && 'type' in message) {
      if (message.type === 'openProject') {
        await vscode.commands.executeCommand('vscode.openFolder');
        return;
      }
      if (message.type === 'baton.kb.update' || message.type === 'baton.kb.openSources') {
        await vscode.commands.executeCommand(message.type);
        return;
      }
      if (message.type === 'checkProjectState') {
        await this.refreshProjectState();
        return;
      }

      if (message.type === 'newSession') {
        await this.startNewSession();
        return;
      }
      if (message.type === 'newSessionPrefilled' && 'text' in message && typeof message.text === 'string') {
        await this.startNewSession();
        this.pendingParentTaskId = 'parentTaskId' in message && typeof message.parentTaskId === 'string'
          ? message.parentTaskId : undefined;
        await this.postMessage({ type: 'draftTask', text: message.text.slice(0, 10000) });
        return;
      }
      if (message.type === 'finishRaceSession') {
        const targetSessionId = ('sessionId' in message && typeof message.sessionId === 'string' && message.sessionId)
          ? message.sessionId
          : this.activeSession?.id;
        if (!targetSessionId) return;
        const current = await this.store.getSession(targetSessionId);
        if (!current) return;

        const projectFolder = currentProjectFolder();
        if (current.taskIds?.length) {
          for (const tId of current.taskIds) {
            await this.store.updateTask(tId, (t) => ({ ...t, status: 'done', flowStatus: 'done' }));
            if (projectFolder) {
              try {
                const location = await this.taskFlow.files.findTask(projectFolder.uri.fsPath, tId);
                if (location) {
                  await this.taskFlow.files.transition(location.task, 'done', 'Race session completed');
                }
              } catch {
                // Non-fatal
              }
            }
          }
        }

        const updatedSession = await this.store.updateSession(targetSessionId, (s) => ({
          ...s,
          finished: true,
          turns: s.turns?.map((turn) => ({ ...turn, status: 'done' })),
        }));

        if (this.activeSession?.id === targetSessionId && updatedSession) {
          this.activeSession = updatedSession;
          this.onSessionUpdated?.();
        }

        const allTasks = (await this.store.loadTasks()) ?? [];
        const sessionTasks = allTasks.filter((t) => updatedSession?.taskIds?.includes(t.id));

        if (updatedSession) {
          await this.postForSession(targetSessionId, {
            type: 'raceSessionFinished',
            sessionId: targetSessionId,
            session: updatedSession,
            tasks: sessionTasks,
          });
        }

        await this.refreshHistory();
        return;
      }
      if (message.type === 'switchSession' && 'sessionId' in message && typeof message.sessionId === 'string') {
        await this.loadSession(message.sessionId);
        return;
      }

      if (message.type === 'openExternalUrl' && 'url' in message && typeof message.url === 'string') {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        } catch {
          // Open failed
        }
        return;
      }

      if (message.type === 'loadUserAgents') {
        const agents = await this.store.loadUserAgents();
        await this.postMessage({ type: 'userAgentsLoaded', agents });
        return;
      }

      if (message.type === 'saveUserAgents' && 'agents' in message && Array.isArray(message.agents)) {
        await this.store.saveUserAgents(message.agents);
        await this.postMessage({ type: 'userAgentsLoaded', agents: message.agents });
        return;
      }

      if (message.type === 'refreshResources' && 'query' in message && typeof message.query === 'string') {
        const sessionId = this.activeSession?.id;
        const queryText = message.query;
        const tId = 'taskId' in message && typeof message.taskId === 'string' ? message.taskId : randomUUID();
        if (this.activeSession?.taskIds?.length && !this.activeSession.taskIds.includes(tId)) return;
        void (async () => {
          try {
            await this.postForSession(sessionId, { type: 'resourcesSearching', taskId: tId, query: queryText });
            const resources = await discoverResources(this.secrets, tId, queryText);
            await this.saveTaskResources(tId, resources, sessionId);
            await this.postForSession(sessionId, { type: 'resourcesReady', resources });
          } catch {
            // Silently fall through
          }
        })();
        return;
      }

      if (message.type === 'personalKeysStatus' || message.type === 'savePersonalKey' || message.type === 'clearPersonalKey') {
        const provider = 'provider' in message && (message.provider === 'gemma'
          || message.provider === 'ollama' || message.provider === 'elevenlabs')
          ? message.provider : undefined;
        let notice: string | undefined;
        if (message.type === 'savePersonalKey' && provider) {
          const value = 'value' in message && typeof message.value === 'string' ? message.value.trim() : '';
          notice = value && value.length <= 4096 && await savePersonalKey(this.secrets, provider, value)
            ? `${provider === 'gemma' ? 'Google AI Studio' : provider === 'ollama' ? 'Ollama Cloud' : 'ElevenLabs'} key saved.` : 'Could not save the key.';
        } else if (message.type === 'clearPersonalKey' && provider) {
          notice = await clearPersonalKey(this.secrets, provider)
            ? `${provider === 'gemma' ? 'Google AI Studio' : provider === 'ollama' ? 'Ollama Cloud' : 'ElevenLabs'} key removed.` : 'Could not remove the key.';
        }
        await this.postMessage({
          type: 'personalKeysStatus',
          configured: await personalKeyStatus(this.secrets),
          hasDefault: defaultKeyStatus(),
          notice,
        });
        return;
      }

      if (message.type === 'routerSettingsStatus' || message.type === 'saveRouterSettings') {
        let notice: string | undefined;
        if (message.type === 'saveRouterSettings') {
          const parsed = RouterSettingsSchema.safeParse('settings' in message ? message.settings : undefined);
          if (!parsed.success) notice = 'Choose a provider and enter valid model names.';
          else if (await this.store.saveRouterSettings(parsed.data)) {
            configureRouter(parsed.data);
            notice = 'Intelligent routing settings saved.';
          } else notice = 'Could not save routing settings.';
        }
        await this.postMessage({ type: 'routerSettingsStatus', settings: getRouterSettings(), notice });
        return;
      }

      if (message.type === 'mcpToggle' || message.type === 'mcpStatusRequest' || message.type === 'mcpCopyConfig') {
        if (message.type === 'mcpCopyConfig') {
          // copyMcpConfig requires ExtensionContext, handled via command or direct
          await vscode.commands.executeCommand('baton.copyMcpConfig');
          return;
        }
        let notice = message.type === 'mcpToggle' ? (this.mcp.running ? await this.mcp.stop() : await this.mcp.start()) : undefined;
        let options;
        try { options = this.mcp.running ? this.mcp.options() : undefined; } catch { /* closed */ }
        await this.postMessage({ type: 'mcpStatus', running: this.mcp.running, command: options?.command, endpoint: options?.args[0], notice });
        return;
      }
    }

    if (isTaskActionMessage(message)) {
      const sessionId = this.activeSession?.taskIds?.includes(message.taskId) ? this.activeSession.id : undefined;
      const reply = await this.codex.handle(message);
      const actionFolder = currentProjectFolder();
      const actionLocation = actionFolder && await this.taskFlow.files.findTask(actionFolder.uri.fsPath, message.taskId);
      if (actionLocation) await this.taskFlow.files.log(actionLocation.task, 'task_action', { action: message.type, notice: reply.notice }).catch(() => undefined);
      if (sessionId) {
        const tasks = await this.store.loadTasks();
        const updatedTask = tasks?.find((t) => t.id === message.taskId);
        if (updatedTask) {
          const folder = currentProjectFolder();
          const location = folder && await this.taskFlow.files.findTask(folder.uri.fsPath, message.taskId);
          if (location && updatedTask.status === 'running') await this.taskFlow.files.transition(location.task, 'running', 'Codex launched');
          if (location && updatedTask.status === 'done') await this.taskFlow.files.transition(location.task, 'done', 'Task completed');
          const updatedSession = await this.store.updateSession(sessionId, (curr) => ({
            ...curr,
            turns: curr.turns?.map((t) => (t.taskId === message.taskId ? { ...t, status: updatedTask.status, outcome: updatedTask.outcome } : t)),
          }));
          if (this.activeSession?.id === sessionId) this.activeSession = updatedSession;
        }
      }
      await this.postForSession(sessionId, reply);
      await this.refreshActiveSession(sessionId);
      await this.refreshHistory();
      return;
    }

    if (isHistoryMessage(message)) {
      if (message.type === 'importPlan') {
        try {
          const folder = currentProjectFolder();
          if (!folder) throw new Error('Open this task’s project first.');
          const task = (await this.store.loadTasks())?.find((entry) => entry.id === message.taskId);
          if (!task || !sameProject(task.workspaceUri, folder.uri.toString())) throw new Error('Task is not in this project.');
          await this.taskFlow.submitPlan(folder.uri.fsPath, message.taskId, message.plan, task.attachedFiles ?? []);
          await this.history.save(message.taskId, { plan: message.plan });
          await this.store.updateTask(message.taskId, (current) => ({ ...current, flowStatus: 'race_ready' }));
        } catch (error) {
          await this.postMessage({ type: 'historyError', message: error instanceof Error ? error.message : 'Could not import plan.' });
          return;
        }
        await this.postMessage(await this.history.handle({ type: 'loadHistory' }, this.historyProject()));
        return;
      }
      await this.postMessage(await this.history.handle(message, this.historyProject()));
      return;
    }

    if (isHandoffMessage(message)) {
      const sessionId = 'taskId' in message && this.activeSession?.taskIds?.includes(message.taskId)
        ? this.activeSession.id : this.activeSession?.id;
      try {
        if (message.type === 'copyToClipboard') {
          await vscode.env.clipboard.writeText(message.text);
          await this.postForSession(sessionId, { type: 'clipboardCopied', notice: 'Copied to clipboard.' });
        } else if (message.type === 'readClipboard') {
          const text = await readClipboard();
          await this.postForSession(sessionId, { type: 'clipboardContent', text });
        } else if (message.type === 'openExternalHandoff') {
          const notice = await openExternalHandoff(message.target);
          await this.postForSession(sessionId, { type: 'handoffExternalResult', notice });
        } else if (message.type === 'handoffAvailabilityRequest') {
          await this.postMessage({ type: 'handoffAvailability', installed: await this.availableDestinations() });
        } else if (message.type === 'planExternal') {
          let text = this.lastRouted?.taskId === message.taskId ? this.lastRouted.text : '';
          let snippet = this.lastRouted?.taskId === message.taskId ? this.lastRouted.snippet : '';
          if (!text) {
            const tasks = await this.store.loadTasks();
            const task = tasks?.find((entry) => entry.id === message.taskId);
            text = task?.text ?? '';
            snippet = task?.contextSnippet ?? '';
          }
          if (!text) {
            await this.postMessage({ type: 'handoffResult', notice: 'Saved task not found. Refresh History and try again.' });
            return;
          }
          const task = (await this.store.loadTasks())?.find((entry) => entry.id === message.taskId);
          const outcome = await planExternal(message.target, text, snippet, task?.planningPrompt);
          const folder = currentProjectFolder();
          const location = folder && await this.taskFlow.files.findTask(folder.uri.fsPath, message.taskId);
          if (location) await this.taskFlow.files.log(location.task, 'external_handoff', { target: message.target, notice: outcome.notice });
          await this.postForSession(sessionId, { type: 'handoffResult', ...outcome });
        } else if (message.type === 'savePlan') {
          if (!sessionId || !this.activeSession?.taskIds?.includes(message.taskId)) throw new Error('Open this task session to save its plan.');
          const projectFolder = currentProjectFolder();
          if (!projectFolder) throw new Error('Open the task project first.');
          const result = await this.taskFlow.submitPlan(projectFolder.uri.fsPath, message.taskId, message.plan,
            (await this.store.loadTasks())?.find((entry) => entry.id === message.taskId)?.attachedFiles ?? []);
          await this.history.save(message.taskId, { plan: message.plan });
          await this.store.updateTask(message.taskId, (task) => ({ ...task, flowStatus: 'race_ready' }));
          const flowView = await this.taskFlow.inspectSession(projectFolder.uri.fsPath, message.taskId);
          const notice = result.notice;
          if (sessionId) {
            const updatedSession = await this.store.updateSession(sessionId, (curr) => ({
              ...curr,
              turns: curr.turns?.map((t) => (t.taskId === message.taskId ? { ...t, plan: message.plan, status: 'planned' } : t)),
            }));
            if (this.activeSession?.id === sessionId) this.activeSession = updatedSession;
          }
          await this.postForSession(sessionId, {
            type: 'planSaved',
            taskId: message.taskId,
            notice,
            summary: result.summary,
            race: flowView?.race,
            stepSummaries: flowView?.stepSummaries,
            readySteps: flowView?.readySteps,
          });
          await this.refreshActiveSession(sessionId);
          await this.refreshHistory();
        } else if (message.type === 'saveStepSummary') {
          if (!sessionId || !this.activeSession?.taskIds?.includes(message.taskId)) throw new Error('Open this task session to save its step summary.');
          const projectFolder = currentProjectFolder();
          if (!projectFolder) throw new Error('Open the task project first.');
          const result = await this.taskFlow.saveStepSummary(projectFolder.uri.fsPath, message.taskId, message.stepId, message.summary);
          if (result.allDone) {
            await this.store.updateTask(message.taskId, (task) => ({ ...task, status: 'done', flowStatus: 'done' }));
            await this.store.updateSession(sessionId, (curr) => ({
              ...curr,
              turns: curr.turns?.map((turn) => (turn.taskId === message.taskId ? { ...turn, status: 'done' } : turn)),
            }));
            await this.postForSession(sessionId, {
              type: 'taskCompleted',
              taskId: message.taskId,
              parentTaskId: message.taskId,
              notice: 'Task completed! All steps have saved summaries.',
            });
          }
          await this.postForSession(sessionId, {
            type: 'stepSummarySaved',
            taskId: message.taskId,
            stepId: message.stepId,
            summary: message.summary,
            readySteps: result.readySteps,
            allDone: result.allDone,
            stepSummaries: result.stepSummaries,
            notice: `Summary for ${message.stepId} saved.`,
          });
          await this.refreshActiveSession(sessionId);
          await this.refreshHistory();
        } else if (message.type === 'finishTask') {
          const projectFolder = currentProjectFolder();
          const taskRecord = (await this.store.loadTasks())?.find((entry) => entry.id === message.taskId);
          if (!taskRecord || taskRecord.status === 'blocked') throw new Error('This task cannot be finished.');
          const cleanSummary = message.summary.trim();
          const savedSummary = await this.store.updateTask(message.taskId, (current) => ({
            ...current,
            status: 'done',
            flowStatus: 'done',
            finishSummary: cleanSummary,
          }));
          if (!savedSummary) throw new Error('Could not save the finish summary.');

          if (projectFolder) {
            try {
              const location = await this.taskFlow.files.findTask(projectFolder.uri.fsPath, message.taskId);
              if (location) {
                await this.taskFlow.files.transition(location.task, 'done', 'Finish summary saved');
                await this.taskFlow.files.log(location.task, 'finish_summary', { summary: cleanSummary });
              }
            } catch {
              // Non-fatal: disk task file state transition failure does not block memory persistence
            }
          }

          const notice = await this.history.finishWithSummary(message.taskId, cleanSummary);
          if (sessionId) {
            await this.store.updateSession(sessionId, (curr) => ({ ...curr,
              turns: curr.turns?.map((turn) => turn.taskId === message.taskId
                ? { ...turn, status: 'done' } : turn),
            }));
          }
          await this.postForSession(sessionId, { type: 'taskFinished', taskId: message.taskId, summary: cleanSummary, notice });
          await this.refreshActiveSession(sessionId);
          await this.refreshHistory();
        }
      } catch (error) {
        await this.postForSession(sessionId, { type: message.type === 'finishTask' ? 'finishError' : 'planSaveError',
          taskId: 'taskId' in message ? message.taskId : undefined,
          message: error instanceof Error ? error.message : 'Handoff action failed. Please try again.' });
      }
      return;
    }

    if (isVoiceMessage(message)) {
      const sessionId = this.activeSession?.id;
      try {
        this.recorderSession?.close();
        this.recorderSession = await startVoiceRecorderServer(async (audioBuffer, mime) => {
          try {
            await this.postForSession(sessionId, { type: 'voiceTranscribing' });
            const transcript = await transcribe(audioBuffer, mime, this.secrets);
            const { text, autoRoute } = this.parseVoiceIntent(transcript);
            await this.postForSession(sessionId, { type: 'voiceText', text, autoRoute });
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : 'Transcription failed';
            await this.postForSession(sessionId, { type: 'voiceError', message: errorMsg });
          } finally {
            this.recorderSession = undefined;
          }
        }, (reason) => {
          this.recorderSession = undefined;
          void this.postForSession(sessionId, { type: 'voiceError', message: reason });
        });
        await openIntegratedBrowser(this.recorderSession.url);
        await this.postForSession(sessionId, { type: 'voiceRecorderReady' });
      } catch (err: unknown) {
        this.recorderSession?.close();
        this.recorderSession = undefined;
        const errorMsg = err instanceof Error ? err.message : 'Voice recording error';
        await this.postForSession(sessionId, { type: 'voiceError', message: errorMsg });
      }
      return;
    }

    if (!isPanelMessage(message)) return;
    const sessionId = this.activeSession?.id;
    const parentTaskId = this.pendingParentTaskId;
    const requestSession = sessionId ? await this.store.getSession(sessionId) : undefined;
    if (!requestSession) return;

    let reply: ExtensionMessage;
    try {
      if (message.type === 'previewContext') {
        const generation = ++this.latestPreview;
        this.preview = undefined;
        const collected = await buildContext(message.text);
        if (generation !== this.latestPreview || this.activeSession?.id !== sessionId || !sessionId) return;
        this.preview = { requestId: message.requestId, text: message.text, context: collected, sessionId };
        await this.postForSession(sessionId, {
          type: 'contextPreview',
          requestId: message.requestId,
          parts: collected.parts,
          limit: MAX_CONTEXT_CHARS,
        });
        return;
      }

      let snippet = '';
      let collected: BuiltContext | undefined;
      if (this.preview && this.preview.sessionId === sessionId && this.preview.requestId === message.requestId && this.preview.text === message.text) {
        collected = this.preview.context;
        snippet = selectContext(this.preview.context, message.sources ?? []);
      } else {
        collected = await buildContext(message.text);
        const sources = (message.sources && message.sources.length > 0)
          ? message.sources
          : collected.parts.map((p) => p.source);
        snippet = selectContext(collected, sources);
      }
      const workspaceUri = collected?.workspaceUri ?? this.historyProject()?.uri;
      if (!sameProject(requestSession.workspaceUri, workspaceUri)) throw new Error('Task project changed. Start a new task.');
      const projectFolder = currentProjectFolder();
      if (!projectFolder) throw new Error('Open a project first.');
      const previousTaskId = requestSession.taskIds?.[requestSession.taskIds.length - 1] ?? parentTaskId;
      const flow = await this.taskFlow.start(projectFolder.uri.fsPath, message.text, previousTaskId);
      const flowView = await this.taskFlow.inspectSession(projectFolder.uri.fsPath, flow.location.id);
      if (this.activeSession?.id === sessionId) this.pendingParentTaskId = undefined;
      const userAgents: UserAgentConfig[] = ('userAgents' in message && Array.isArray(message.userAgents) && message.userAgents.length > 0)
        ? message.userAgents
        : await this.store.loadUserAgents();
      // Intelligent LLM Router: Gemma 4 via Google AI Studio -> Ollama Cloud -> Rules fallback
      const routerResult = await routeTask(message.text, snippet, workspaceUri);
      const tier = routerResult.tier;

      // Select runner agent strictly from user's configured agents
      const agentDecision = routeToUserAgent(message.text, userAgents, snippet, routerResult.route);
      const lapNumber = (requestSession.turns?.filter((t) => t.role === 'user').length || 0) + 1;

      const route: Route = {
        ...routerResult.route,
        reason: agentDecision.reason || routerResult.route.reason || 'Task routed successfully.',
      };
      if (agentDecision.recommendedModel) {
        route.recommended_model = agentDecision.recommendedModel;
      }
      const notice = flow.warning.length
        ? `Overlapping open tasks: ${flow.warning.join('; ')}`
        : routerResult.notice;
      const decision = decide(route, message.text);
      const taskId = flow.location.id;
      await this.taskFlow.files.log(flow.location.task, 'route', { route: decision.route, action: decision.action, tier });
      const attachedFiles = message.sources.map((source) => source.startsWith(`${projectFolder.name}/`)
        ? source.slice(projectFolder.name.length + 1).replace(/\\/g, '/') : '')
        .filter((source) => source && !source.includes(':'));

      const saved = await this.store.appendTask({
        id: taskId,
        createdAt: new Date().toISOString(),
        text: message.text,
        route: decision.route,
        routerTier: tier,
        decision: decision.action,
        // KB routing metadata from the route
        recommended_model: decision.route.recommended_model,
        model_reasoning: decision.route.model_reasoning,
        kb_refs: decision.route.kb_refs,
        kb_stale: decision.route.kb_stale,
        kb_note: decision.route.kb_note,
        workspaceUri,
        contextSnippet: snippet,
        taskFolder: flow.location.task,
        planningPrompt: undefined,
        planningPlatform: flow.platform,
        planningReason: flow.reason,
        attachFiles: flow.attachFiles,
        attachedFiles,
        flowStatus: 'race_ready',
        status: decision.action === 'BLOCK' ? 'blocked' : 'routed',
        runnerAgent: agentDecision.selectedAgent,
        agentType: agentDecision.agentKind,
        githubAttached: agentDecision.githubAttached,
        githubUrl: agentDecision.githubUrl,
        lapNumber,
      });

      this.lastRouted = { taskId, text: message.text, snippet };

      // Update current session with this task and turn
      if (sessionId) {
        const requestSession = await this.store.getSession(sessionId);
        if (!requestSession) throw new Error('Task session is unavailable.');
        const updatedTitle = (requestSession.title === 'New task' || requestSession.title === 'New session' || requestSession.title === 'New race' || requestSession.title === 'New race session')
          ? (message.text.length > 30 ? `${message.text.slice(0, 30)}…` : message.text)
          : requestSession.title;

        const updatedSession = await this.store.updateSession(sessionId, (curr) => ({
          ...curr,
          title: updatedTitle,
          taskIds: [...(curr.taskIds ?? []), taskId],
          turns: [
            ...(curr.turns ?? []),
            {
              id: randomUUID(),
              role: 'user',
              content: message.text,
              createdAt: new Date().toISOString(),
              taskId,
            },
            {
              id: randomUUID(),
              role: 'assistant',
              content: route.reason,
              createdAt: new Date().toISOString(),
              taskId,
              route,
              decision: decision.action,
              routerTier: tier,
              status: decision.action === 'BLOCK' ? 'blocked' : 'routed',
              contextSnippet: snippet,
              why: decision.why,
              overrode: decision.overrode,
              recommended_model: decision.route.recommended_model,
              model_reasoning: decision.route.model_reasoning,
              runnerAgent: agentDecision.selectedAgent,
              agentType: agentDecision.agentKind,
              githubAttached: agentDecision.githubAttached,
              githubUrl: agentDecision.githubUrl,
              lapNumber,
            },
          ],
        }));

        if (this.activeSession?.id === sessionId) this.activeSession = updatedSession;
        this.onSessionUpdated?.();
      }

      reply = {
        type: 'routed',
        requestId: message.requestId,
        taskId,
        task_id: taskId,
        project_id: flow.location.project,
        run_id: randomUUID().slice(0, 8),
        text: message.text,
        decision,
        route: decision.route,
        tier,
        saved,
        notice,
        contextSnippet: snippet,
        contextParts: collected?.parts,
        planningPrompt: undefined,
        planningPlatform: flow.platform,
        planningReason: flow.reason,
        attachFiles: flow.attachFiles,
        flowStatus: 'race_ready',
        race: flowView?.race,
        stepSummaries: flowView?.stepSummaries,
        readySteps: flowView?.readySteps,
        runnerAgent: agentDecision.selectedAgent,
        agentType: agentDecision.agentKind,
        githubAttached: agentDecision.githubAttached,
        githubUrl: agentDecision.githubUrl,
        lapNumber,
      };

    } catch {
      reply = { type: 'routeError', requestId: message.requestId };
    }

    await this.postForSession(sessionId, reply);

    if (reply.type === 'routed') {
      const currentTaskId = reply.taskId;
      const currentText = reply.text;
      const currentSnippet = reply.contextSnippet;
      void (async () => {
        try {
          await this.postForSession(sessionId, { type: 'resourcesSearching', taskId: currentTaskId, query: currentText });
          const resources = await discoverResources(this.secrets, currentTaskId, currentText, currentSnippet);
          await this.saveTaskResources(currentTaskId, resources, sessionId);
          await this.postForSession(sessionId, { type: 'resourcesReady', resources });
        } catch {
          // Silently fall through
        }
      })();
    }
  }

  private async saveTaskResources(taskId: string, resources: TaskResourcesResult, sessionId?: string): Promise<void> {
    try {
      await this.store.updateTask(taskId, (t) => ({ ...t, resources }));
      if (sessionId) {
        const updatedSession = await this.store.updateSession(sessionId, (curr) => ({
          ...curr,
          turns: curr.turns?.map((turn) => (turn.taskId === taskId ? { ...turn, resources } : turn)),
        }));
        if (this.activeSession?.id === sessionId) this.activeSession = updatedSession;
      }
    } catch {
      // Silently fall through
    }
  }

  private async renderHtml(): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    try {
      const template = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'panel.html'));
      const replacements: Record<string, string> = {
        nonce: randomBytes(16).toString('hex'),
        cspSource: this.panel.webview.cspSource,
        scriptUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js')).toString(),
        resourcesUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'resources.js')).toString(),
        styleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css')).toString(),
        watermarkUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'baton-watermark.png')).toString(),
      };
      this.panel.webview.html = Buffer.from(template).toString('utf8').replace(
        /\{\{(\w+)\}\}/g,
        (_, name: string) => replacements[name] ?? '',
      );
    } catch {
      this.panel.webview.html = '<!doctype html><html><body>Baton could not load. Please reload.</body></html>';
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    BatonEditorPanel.currentPanel = undefined;
    if (this.recorderSession) {
      this.recorderSession.close();
      this.recorderSession = undefined;
    }
    try {
      this.panel.dispose();
    } catch {
      // already disposed
    }
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) disposable.dispose();
    }
  }
}
