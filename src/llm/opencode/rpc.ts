// Minimal JSON-RPC 2.0 peer over newline-delimited stdio (what `opencode acp`
// speaks). Pure module: works with any line-oriented byte streams, no
// `vscode` imports.

export interface ReadableLines {
  onData(listener: (chunk: string) => void): void;
}

export interface WritableLines {
  writeLine(line: string): void;
}

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: { code: number; message: string; data?: any };
  method?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

export type RpcNotificationHandler = (method: string, params: unknown) => void;
export type RpcRequestHandler = (
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<any>;

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

const METHOD_NOT_FOUND = -32601;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (msg: RpcResponse) => void; reject: (err: Error) => void }
  >();
  private buffer = '';
  private closed = false;
  private closeError: Error | undefined;

  constructor(
    private readonly input: ReadableLines,
    private readonly output: WritableLines,
    private readonly options: {
      onNotification?: RpcNotificationHandler;
      onRequest?: RpcRequestHandler;
      onParseError?: (line: string) => void;
    } = {}
  ) {
    input.onData((chunk) => this.feed(chunk));
  }

  /** Send a request and resolve with the full response envelope. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(method: string, params?: any): Promise<RpcResponse> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error('Connection is closed.'));
    }
    const id = this.nextId++;
    return new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.output.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a request and resolve/reject on result/error. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call<T = any>(method: string, params?: any): Promise<T> {
    const res = await this.request(method, params);
    if (res.error !== undefined) {
      throw new RpcError(res.error.message || `Request ${method} failed.`, res.error.code);
    }
    return res.result as T;
  }

  /** Fire-and-forget notification. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notify(method: string, params?: any): void {
    if (this.closed) {
      return;
    }
    this.output.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Fail all pending requests; further calls reject. */
  close(err?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = err ?? new Error('Connection closed.');
    for (const [, entry] of this.pending) {
      entry.reject(this.closeError);
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(line) as RpcResponse;
    } catch {
      this.options.onParseError?.(line);
      return;
    }
    if (typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0') {
      this.options.onParseError?.(line);
      return;
    }

    if (msg.method !== undefined) {
      void this.handleIncomingCall(msg);
      return;
    }

    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
      return;
    }

    this.options.onParseError?.(line);
  }

  private async handleIncomingCall(msg: RpcResponse): Promise<void> {
    const method = msg.method as string;
    if (msg.id === undefined) {
      // One-way notification.
      this.options.onNotification?.(method, msg.params);
      return;
    }

    // A method call expecting a response.
    const handler = this.options.onRequest;
    if (!handler) {
      this.sendError(msg.id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(method, msg.params);
      this.output.writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }));
    } catch (err) {
      this.sendError(
        msg.id,
        err instanceof RpcError && err.code !== undefined ? err.code : -32603,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private sendError(id: number | string, code: number, message: string): void {
    if (this.closed) {
      return;
    }
    this.output.writeLine(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
    );
  }
}
