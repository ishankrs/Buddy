// ACP (Agent Client Protocol) client for a locally spawned `opencode acp`
// process. JSON-RPC over stdio; no network, no API keys.
//
// Pure module: process spawning, permission decisions, and logging are all
// injected, so this stays unit testable without `vscode`.

import { JsonRpcPeer, RpcError } from './rpc';

export type OpenCodeErrorKind =
  | 'not-installed'
  | 'start-failed'
  | 'init-failed'
  | 'not-authenticated'
  | 'provider-error'
  | 'protocol-error'
  | 'cancelled'
  | 'crashed';

export class OpenCodeError extends Error {
  constructor(
    message: string,
    public readonly kind: OpenCodeErrorKind
  ) {
    super(message);
    this.name = 'OpenCodeError';
  }
}

export interface SpawnedProcess {
  writeStdin(data: string): void;
  onStdout(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnDeps {
  spawn(binary: string, args: string[], cwd: string): SpawnedProcess;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawInput?: any;
    locations?: Array<{ path: string }>;
  };
  options: PermissionOption[];
}

/** Resolve to an optionId to grant, or undefined to deny/cancel. */
export type PermissionResolver = (
  request: PermissionRequest
) => Promise<string | undefined>;

export interface ModelOption {
  value: string;
  name: string;
  description?: string;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: ModelOption[];
}

export interface SessionSummary {
  sessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

export interface ReplayTool {
  title: string;
  status: string;
}

export interface ReplayItem {
  kind: 'user' | 'assistant';
  text: string;
  thoughts: string[];
  tools: ReplayTool[];
}

interface AgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: {
    close?: unknown;
    delete?: unknown;
    fork?: unknown;
    list?: unknown;
    resume?: unknown;
  };
}

export interface AcpToolEvent {
  toolCallId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  title?: string;
  kind?: string;
}

export interface PromptSink {
  onText(text: string): void;
  onThought?(text: string): void;
  onTool?(event: AcpToolEvent): void;
}

export interface PromptResult {
  stopReason: string;
  cancelled: boolean;
}

interface SessionState {
  sessionId: string;
  configOptions: SessionConfigOption[];
}

const PROTOCOL_VERSION = 1;

export class AcpClient {
  private peer: JsonRpcPeer | undefined;
  private proc: SpawnedProcess | undefined;
  private exited: number | null | undefined;
  private readonly sessions = new Map<string, SessionState>();
  private readonly activePrompts = new Map<string, PromptSink>();
  private readonly activeLoads = new Map<string, (update: AcpUpdate) => void>();
  private capabilities: AgentCapabilities = {};
  private agentName = 'OpenCode';

  constructor(
    private readonly spawnDeps: SpawnDeps,
    private readonly permissionResolver: PermissionResolver,
    private readonly logger: (message: string) => void = () => undefined
  ) {}

  get running(): boolean {
    return !!this.proc && this.exited === undefined;
  }

  /** Spawn `opencode acp` and complete ACP initialization. */
  async start(binary: string, cwd: string): Promise<void> {
    if (this.running) {
      return;
    }
    this.exited = undefined;
    let proc: SpawnedProcess;
    try {
      proc = this.spawnDeps.spawn(binary, ['acp'], cwd);
    } catch (err) {
      throw new OpenCodeError(
        `Could not start the local OpenCode process (${describeError(err)}). Is OpenCode installed? See https://opencode.ai/docs.`,
        'start-failed'
      );
    }
    this.proc = proc;
    proc.onExit((code) => this.handleExit(code));

    this.peer = new JsonRpcPeer(
      {
        onData: (listener) => {
          proc.onStdout((chunk) => listener(chunk));
        },
      },
      { writeLine: (line) => proc.writeStdin(line + '\n') },
      {
        onNotification: (method, params) => this.handleNotification(method, params),
        onRequest: (method, params) => this.handleRequest(method, params),
        onParseError: (line) => this.logger(`Ignoring non-JSON ACP line: ${line.slice(0, 120)}`),
      }
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await this.peer.call<any>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      if (result?.agentInfo?.name) {
        this.agentName = String(result.agentInfo.name);
      }
      if (result?.agentCapabilities && typeof result.agentCapabilities === 'object') {
        this.capabilities = result.agentCapabilities as AgentCapabilities;
      }
    } catch (err) {
      const message =
        err instanceof RpcError
          ? err.message
          : `OpenCode did not answer the ACP handshake (${describeError(err)}).`;
      throw new OpenCodeError(
        `${message} The installed OpenCode version may not support ACP — update OpenCode and try again.`,
        'init-failed'
      );
    }
  }

  async createSession(cwd: string): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
    const peer = this.requirePeer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await peer.call<any>('session/new', { cwd, mcpServers: [] });
    const sessionId = result?.sessionId as string;
    if (!sessionId) {
      throw new OpenCodeError(
        'OpenCode did not return a session id for session/new.',
        'protocol-error'
      );
    }
    const configOptions = Array.isArray(result.configOptions)
      ? (result.configOptions as SessionConfigOption[])
      : [];
    this.sessions.set(sessionId, { sessionId, configOptions });
    return { sessionId, configOptions };
  }

  async resumeSession(sessionId: string, cwd: string): Promise<boolean> {
    const peer = this.requirePeer();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await peer.call<any>('session/resume', { sessionId, cwd, mcpServers: [] });
      // Resume responses MAY carry the current session configuration —
      // keep it, otherwise the model picker has nothing to show.
      const configOptions = Array.isArray(result?.configOptions)
        ? (result.configOptions as SessionConfigOption[])
        : (this.sessions.get(sessionId)?.configOptions ?? []);
      this.sessions.set(sessionId, { sessionId, configOptions });
      return true;
    } catch {
      this.sessions.delete(sessionId);
      return false;
    }
  }

  getCachedConfig(sessionId: string): SessionConfigOption[] {
    return this.sessions.get(sessionId)?.configOptions ?? [];
  }

  getModelOptions(sessionId: string): { current: string; options: ModelOption[] } | undefined {
    const model = this.getCachedConfig(sessionId).find((c) => c.id === 'model');
    if (!model) {
      return undefined;
    }
    return { current: model.currentValue, options: model.options ?? [] };
  }

  async setModel(sessionId: string, value: string): Promise<SessionConfigOption[]> {
    const peer = this.requirePeer();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await peer.call<any>('session/set_config_option', {
        sessionId,
        configId: 'model',
        value,
      });
      const configOptions = Array.isArray(result?.configOptions)
        ? (result.configOptions as SessionConfigOption[])
        : this.getCachedConfig(sessionId);
      this.sessions.set(sessionId, { sessionId, configOptions });
      return configOptions;
    } catch (err) {
      throw this.wrapCallError(err, 'switch the OpenCode model');
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const peer = this.requirePeer();
    try {
      await peer.call('session/set_mode', { sessionId, modeId });
    } catch (err) {
      throw this.wrapCallError(err, 'switch the OpenCode mode');
    }
  }

  async prompt(sessionId: string, text: string, sink: PromptSink, signal?: AbortSignal): Promise<PromptResult> {
    const peer = this.requirePeer();
    if (this.activePrompts.has(sessionId)) {
      throw new OpenCodeError(
        'A prompt is already running on this OpenCode session.',
        'protocol-error'
      );
    }
    this.activePrompts.set(sessionId, sink);
    let cancelSent = false;
    const onAbort = () => {
      if (!cancelSent) {
        cancelSent = true;
        peer.notify('session/cancel', { sessionId });
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await peer.call<any>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      const stopReason = String(result?.stopReason ?? 'end_turn');
      return { stopReason, cancelled: stopReason === 'cancelled' || !!signal?.aborted };
    } catch (err) {
      if (signal?.aborted || /cancel/i.test(describeError(err))) {
        return { stopReason: 'cancelled', cancelled: true };
      }
      throw this.wrapCallError(err, 'send the prompt to OpenCode');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activePrompts.delete(sessionId);
    }
  }

  cancel(sessionId: string): void {
    this.peer?.notify('session/cancel', { sessionId });
  }

  /** List known OpenCode sessions (newest activity first, per the backend). */
  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    if (!this.capabilities.sessionCapabilities?.list) {
      throw new OpenCodeError(
        'The installed OpenCode version does not support listing sessions — update OpenCode and try again.',
        'protocol-error'
      );
    }
    const peer = this.requirePeer();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await peer.call<any>('session/list', cwd ? { cwd } : {});
      const sessions: Record<string, unknown>[] = Array.isArray(result?.sessions)
        ? result.sessions.filter(
            (s: unknown): s is Record<string, unknown> => !!s && typeof s === 'object'
          )
        : [];
      return sessions
        .map((s) => ({
          sessionId: String(s.sessionId ?? ''),
          title: typeof s.title === 'string' ? s.title : undefined,
          cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
          updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : undefined,
        }))
        .filter((s) => s.sessionId);
    } catch (err) {
      throw this.wrapCallError(err, 'list OpenCode sessions');
    }
  }

  /**
   * Load a session, replaying its history into ordered items (user and
   * assistant turns with thoughts and tool activity). Also refreshes the
   * cached config options, which `session/load` returns.
   */
  async loadSession(
    sessionId: string,
    cwd: string
  ): Promise<{ configOptions: SessionConfigOption[]; items: ReplayItem[] }> {
    if (!this.capabilities.loadSession) {
      throw new OpenCodeError(
        'The installed OpenCode version does not support loading sessions — update OpenCode and try again.',
        'protocol-error'
      );
    }
    const peer = this.requirePeer();
    const items: ReplayItem[] = [];
    let current: ReplayItem | undefined;
    let currentKind: 'user' | 'assistant' | undefined;
    let currentId: string | undefined;
    let thoughtId: string | undefined;

    const forTurn = (kind: 'user' | 'assistant', id: string | undefined): ReplayItem => {
      if (!current || currentKind !== kind || currentId !== id) {
        current = { kind, text: '', thoughts: [], tools: [] };
        currentKind = kind;
        currentId = id;
        items.push(current);
      }
      return current;
    };

    // Tool events rarely carry a message id — attach id-less ones to the
    // ongoing assistant turn instead of fragmenting the replay.
    const forTool = (id: string | undefined): ReplayItem => {
      if (current && currentKind === 'assistant' && (id === undefined || currentId === id)) {
        return current;
      }
      return forTurn('assistant', id);
    };

    this.activeLoads.set(sessionId, (update) => {
      const id = update.messageId;
      switch (update.sessionUpdate) {
        case 'user_message_chunk': {
          const text = contentText(update.content);
          if (text) {
            forTurn('user', id).text += text;
          }
          break;
        }
        case 'agent_message_chunk': {
          const text = contentText(update.content);
          if (text) {
            forTurn('assistant', id).text += text;
          }
          break;
        }
        case 'agent_thought_chunk': {
          const text = contentText(update.content);
          if (text) {
            const turn = forTurn('assistant', id);
            if (thoughtId !== id) {
              thoughtId = id;
              turn.thoughts.push(text);
            } else {
              turn.thoughts[turn.thoughts.length - 1] += text;
            }
          }
          break;
        }
        case 'tool_call': {
          const turn = forTool(id);
          const tool: ReplayTool & { callId?: string } = {
            title: update.title ?? 'tool',
            status: 'pending',
            callId: update.toolCallId !== undefined ? String(update.toolCallId) : undefined,
          };
          turn.tools.push(tool);
          break;
        }
        case 'tool_call_update': {
          const turn = forTool(id);
          const callId = update.toolCallId !== undefined ? String(update.toolCallId) : undefined;
          const existing = [...turn.tools]
            .reverse()
            .find(
              (t) =>
                (t as ReplayTool & { callId?: string }).callId === callId ||
                (callId === undefined && t.status === 'pending')
            );
          if (existing) {
            existing.status = update.status ?? existing.status;
            if (update.title) {
              existing.title = update.title;
            }
          } else {
            turn.tools.push({ title: update.title ?? 'tool', status: update.status ?? 'pending' });
          }
          break;
        }
        default:
          break;
      }
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await peer.call<any>('session/load', {
        sessionId,
        cwd,
        mcpServers: [],
      });
      const configOptions = Array.isArray(result?.configOptions)
        ? (result.configOptions as SessionConfigOption[])
        : this.getCachedConfig(sessionId);
      this.sessions.set(sessionId, { sessionId, configOptions });
      return {
        configOptions,
        items: items.filter((item) => item.text.trim() || item.thoughts.length > 0 || item.tools.length > 0),
      };
    } catch (err) {
      throw this.wrapCallError(err, 'load the OpenCode session');
    } finally {
      this.activeLoads.delete(sessionId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.activePrompts.delete(sessionId);
    if (!this.running || !this.peer) {
      return;
    }
    try {
      await this.peer.call('session/close', { sessionId });
    } catch {
      // Best effort: the session is forgotten locally regardless.
    }
  }

  /** Whether the backend advertised `session/delete` support. */
  supportsDelete(): boolean {
    return !!this.capabilities.sessionCapabilities?.delete;
  }

  /**
   * Permanently remove a session from backend history (`session/delete`).
   * Deleted sessions disappear from future `session/list` results.
   * Deleting an unknown session succeeds silently per the ACP spec.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.capabilities.sessionCapabilities?.delete) {
      throw new OpenCodeError(
        'The installed OpenCode version does not support deleting sessions — update OpenCode and try again.',
        'protocol-error'
      );
    }
    const peer = this.requirePeer();
    try {
      await peer.call('session/delete', { sessionId });
    } catch (err) {
      throw this.wrapCallError(err, 'delete the OpenCode session');
    }
    this.sessions.delete(sessionId);
    this.activePrompts.delete(sessionId);
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.peer?.close(new Error('Client disposed.'));
    this.peer = undefined;
    this.sessions.clear();
    this.activePrompts.clear();
    if (proc && this.exited === undefined) {
      proc.kill('SIGTERM');
    }
  }

  private requirePeer(): JsonRpcPeer {
    if (!this.peer || !this.running) {
      throw new OpenCodeError(
        'The local OpenCode process is not running.',
        this.exited !== undefined ? 'crashed' : 'start-failed'
      );
    }
    return this.peer;
  }

  private handleExit(code: number | null): void {
    this.exited = code ?? 0;
    const err = new OpenCodeError(
      `The local OpenCode process exited unexpectedly (code ${this.exited}). Your sessions may need to be resumed.`,
      'crashed'
    );
    this.peer?.close(err);
    this.activePrompts.clear();
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      return;
    }
    const update = (params as { sessionId?: string; update?: AcpUpdate })?.update;
    const sessionId = (params as { sessionId?: string })?.sessionId;
    if (!update || !sessionId) {
      return;
    }
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.configOptions = update.configOptions;
      } else {
        this.sessions.set(sessionId, { sessionId, configOptions: update.configOptions });
      }
      return;
    }
    const sink = this.activePrompts.get(sessionId);
    if (sink) {
      this.routePromptUpdate(sink, update);
      return;
    }
    const load = this.activeLoads.get(sessionId);
    if (load) {
      load(update);
    }
  }

  private routePromptUpdate(sink: PromptSink, update: AcpUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content);
        if (text) {
          sink.onText(text);
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        if (text && sink.onThought) {
          sink.onThought(text);
        }
        break;
      }
      case 'tool_call':
        sink.onTool?.({
          toolCallId: String(update.toolCallId ?? ''),
          status: 'pending',
          title: update.title,
          kind: update.kind,
        });
        break;
      case 'tool_call_update':
        sink.onTool?.({
          toolCallId: String(update.toolCallId ?? ''),
          status: normalizeToolStatus(update.status),
          title: update.title,
          kind: update.kind,
        });
        break;
      default:
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleRequest(method: string, params: any): Promise<any> {
    if (method === 'session/request_permission') {
      const request = normalizePermissionRequest(params);
      const optionId = await this.permissionResolver(request);
      if (optionId === undefined) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId } };
    }
    // Buddy implements no fs/terminal/elicitation capabilities: the local
    // OpenCode agent must use its own tools. Signal that explicitly.
    throw new RpcError(`Method not found: ${method}`, -32601);
  }

  private wrapCallError(err: unknown, action: string): OpenCodeError {
    // Never downgrade an already-classified error (e.g. process crash
    // surfacing while a prompt was in flight).
    if (err instanceof OpenCodeError) {
      return err;
    }
    const message = describeError(err);
    if (/auth|login|unauthenticated|not signed in|credential/i.test(message)) {
      return new OpenCodeError(
        `OpenCode is not authenticated. Configure your provider/account through OpenCode (run \`opencode auth login\` in a terminal), then try again. Buddy does not manage OpenCode authentication. Details: ${message}`,
        'not-authenticated'
      );
    }
    if (/model|provider|billing|payment|rate.?limit|quota|plan/i.test(message)) {
      return new OpenCodeError(`OpenCode provider error: ${message}`, 'provider-error');
    }
    return new OpenCodeError(`Could not ${action}: ${message}`, 'protocol-error');
  }
}

interface AcpUpdate {
  sessionUpdate: string;
  messageId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any;
  toolCallId?: string | number;
  title?: string;
  kind?: string;
  status?: string;
  configOptions?: SessionConfigOption[];
}

function contentText(content: unknown): string {
  if (!content || typeof content !== 'object') {
    return '';
  }
  const typed = content as { type?: string; text?: unknown };
  if (typed.type === 'text' && typeof typed.text === 'string') {
    return typed.text;
  }
  return '';
}

function normalizeToolStatus(status: string | undefined): AcpToolEvent['status'] {
  switch (status) {
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function normalizePermissionRequest(params: unknown): PermissionRequest {
  const p = (params ?? {}) as {
    sessionId?: unknown;
    toolCall?: unknown;
    options?: unknown;
  };
  const toolCall = (p.toolCall ?? {}) as PermissionRequest['toolCall'];
  const options = Array.isArray(p.options)
    ? (p.options as PermissionOption[]).filter((o) => o && typeof o.optionId === 'string')
    : [];
  return {
    sessionId: typeof p.sessionId === 'string' ? p.sessionId : '',
    toolCall: {
      toolCallId: String(toolCall.toolCallId ?? ''),
      title: typeof toolCall.title === 'string' ? toolCall.title : undefined,
      kind: typeof toolCall.kind === 'string' ? toolCall.kind : undefined,
      status: typeof toolCall.status === 'string' ? toolCall.status : undefined,
      rawInput: toolCall.rawInput,
      locations: Array.isArray(toolCall.locations) ? toolCall.locations : undefined,
    },
    options,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
