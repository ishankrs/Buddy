// Lifecycle owner for the local OpenCode integration:
//
//   OpenCodeDetector (detector.ts)
//         ↓
//   OpenCodeProcessManager (this file: one `opencode acp` child process)
//         ↓
//   AcpClient (acp.ts: initialize / sessions / prompts / permissions)
//         ↓
//   BuddyProviderAdapter (localProvider.ts: Buddy LLMProvider shape)
//
// Pure module: persistence and client construction are injected.

import {
  AcpClient,
  OpenCodeError,
  type PermissionResolver,
  type SessionConfigOption,
  type SpawnDeps,
} from './acp';
import { findOpencodeBinary, type ExecDeps } from './detector';

export interface SessionStore {
  get(key: string): string | undefined;
  set(key: string, value: string): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface ManagerDeps {
  execDeps: ExecDeps;
  spawnDeps: SpawnDeps;
  store: SessionStore;
  permissionResolver: PermissionResolver;
  logger?: (message: string) => void;
}

export interface EnsuredSession {
  sessionId: string;
  /** True when the session was created fresh in this call. */
  created: boolean;
}

export interface PromptEvents {
  onText(text: string): void;
  onThought?(text: string): void;
  onTool?(event: { toolCallId: string; status: string; title?: string }) : void;
}

function sessionStoreKey(workspacePath: string): string {
  return `buddy.opencode.session.${hashString(workspacePath)}`;
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export class OpenCodeProcessManager {
  private client: AcpClient | undefined;
  private binaryPath = 'opencode';
  private binaryVersion = '';
  private starting: Promise<void> | undefined;
  /** Serializes prompts per session: one prompt turn at a time. */
  private readonly promptChains = new Map<string, Promise<unknown>>();
  private clientFactory: ((binary: string) => AcpClient) | undefined;

  constructor(private readonly deps: ManagerDeps) {}

  /** Override client construction (tests). */
  setClientFactory(factory: (binary: string) => AcpClient): void {
    this.clientFactory = factory;
  }

  /** Detect the CLI and start/reuse the ACP process. Throws OpenCodeError. */
  async ensureRunning(customBinary?: string): Promise<{ path: string; version: string }> {
    if (this.client?.running) {
      return { path: this.binaryPath, version: this.binaryVersion };
    }
    if (!this.starting) {
      this.starting = this.startLocked(customBinary).finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
    return { path: this.binaryPath, version: this.binaryVersion };
  }

  private async startLocked(customBinary?: string): Promise<void> {
    const detection = await findOpencodeBinary(this.deps.execDeps, customBinary);
    if (!detection.ok) {
      throw new OpenCodeError(
        `OpenCode is not installed. ${detection.reason} Install OpenCode CLI and configure your account before using OpenCode with Buddy. See https://opencode.ai/docs.`,
        'not-installed'
      );
    }
    this.binaryPath = detection.path;
    this.binaryVersion = detection.version;
    const factory =
      this.clientFactory ??
      (() =>
        new AcpClient(
          this.deps.spawnDeps,
          this.deps.permissionResolver,
          this.deps.logger
        ));
    const client = factory(detection.path);
    // Use the first workspace-ish cwd available; sessions carry their own cwd.
    await client.start(detection.path, process.cwd());
    this.client = client;
  }

  private requireClient(): AcpClient {
    if (!this.client?.running) {
      throw new OpenCodeError(
        'The local OpenCode process is not running.',
        'start-failed'
      );
    }
    return this.client;
  }

  /**
   * Return the OpenCode session for a workspace, resuming a previously stored
   * one when possible, otherwise creating a new session.
   */
  async ensureSession(workspacePath: string): Promise<EnsuredSession> {
    await this.ensureRunning();
    const client = this.requireClient();
    const stored = this.deps.store.get(sessionStoreKey(workspacePath));
    if (stored) {
      const resumed = await client.resumeSession(stored, workspacePath);
      if (resumed) {
        return { sessionId: stored, created: false };
      }
      await this.deps.store.delete(sessionStoreKey(workspacePath));
    }
    const { sessionId } = await client.createSession(workspacePath);
    await this.deps.store.set(sessionStoreKey(workspacePath), sessionId);
    return { sessionId, created: true };
  }

  /** Close and forget the workspace session (fresh session next time). */
  async resetSession(workspacePath: string): Promise<void> {
    const stored = this.deps.store.get(sessionStoreKey(workspacePath));
    await this.deps.store.delete(sessionStoreKey(workspacePath));
    if (stored && this.client?.running) {
      await this.client.closeSession(stored);
    }
  }

  /** Serialized prompt turn on an already-ensured session. */
  async promptOnSession(
    sessionId: string,
    text: string,
    events: PromptEvents,
    signal?: AbortSignal
  ): Promise<{ stopReason: string; cancelled: boolean }> {
    const previous = this.promptChains.get(sessionId) ?? Promise.resolve();
    const turn = previous.then(() => {
      if (signal?.aborted) {
        return { stopReason: 'cancelled', cancelled: true };
      }
      return this.requireClient().prompt(sessionId, text, events, signal);
    });
    let tracked: Promise<unknown>;
    const cleanup = () => {
      if (this.promptChains.get(sessionId) === tracked) {
        this.promptChains.delete(sessionId);
      }
    };
    tracked = turn.then(cleanup, cleanup);
    this.promptChains.set(sessionId, tracked);
    return turn;
  }

  /** Serialized prompt turn on the workspace session. */
  async prompt(
    workspacePath: string,
    text: string,
    events: PromptEvents,
    signal?: AbortSignal
  ): Promise<{ stopReason: string; cancelled: boolean; freshSession: boolean }> {
    const { sessionId, created } = await this.ensureSession(workspacePath);
    const result = await this.promptOnSession(sessionId, text, events, signal);
    return { ...result, freshSession: created };
  }

  async getModelOptions(
    workspacePath: string
  ): Promise<{ current: string; options: Array<{ value: string; name: string; description?: string }> }> {
    const { sessionId } = await this.ensureSession(workspacePath);
    const found = this.requireClient().getModelOptions(sessionId);
    if (found && found.options.length > 0) {
      return found;
    }
    // The backend handed us a session with no configuration (e.g. an older
    // OpenCode whose resume response carries none). A fresh session always
    // advertises the model list, so reset once instead of dead-ending.
    await this.resetSession(workspacePath);
    const fresh = await this.ensureSession(workspacePath);
    const retry = this.requireClient().getModelOptions(fresh.sessionId);
    if (!retry || retry.options.length === 0) {
      throw new OpenCodeError(
        'The local OpenCode did not advertise any models for this session. Configure your providers/models through OpenCode.',
        'protocol-error'
      );
    }
    return retry;
  }

  async setModel(workspacePath: string, value: string): Promise<SessionConfigOption[]> {
    const { sessionId } = await this.ensureSession(workspacePath);
    return this.requireClient().setModel(sessionId, value);
  }

  /** Terminate the child process if Buddy started it. No orphans. */
  async dispose(): Promise<void> {
    this.promptChains.clear();
    const client = this.client;
    this.client = undefined;
    await client?.dispose();
  }
}

let shared: OpenCodeProcessManager | undefined;

/** Process-wide singleton (one `opencode acp` child for the extension host). */
export function getSharedManager(deps?: ManagerDeps): OpenCodeProcessManager {
  if (!shared) {
    if (!deps) {
      throw new Error('OpenCodeProcessManager has not been configured.');
    }
    shared = new OpenCodeProcessManager(deps);
  }
  return shared;
}

/** Test/extension helper to drop the singleton (dispose first). */
export function resetSharedManager(): void {
  shared = undefined;
}
