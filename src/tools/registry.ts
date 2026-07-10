import * as vscode from 'vscode';
import type { ToolSchema } from '../llm/types';
import { listFilesTool, readFileTool, searchWorkspaceTool } from './readTools';
import { editFileTool, runTerminalTool } from './writeTools';
import { spawnSubagentTool } from './subagentTool';
import { fetchUrlTool, searchWebTool } from './webTools';

export interface ToolDefinition {
  schema: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<string>;
  readOnly: boolean;
}

export interface ToolRegistryOptions {
  includeSpawnSubagent?: boolean;
}

const SPAWN_SUBAGENT_TOOL: ToolDefinition = {
  readOnly: true,
  schema: {
    name: 'spawn_subagent',
    description:
      'Spawn a focused subagent to handle a self-contained subtask autonomously. Returns a report when done. Use for scoped work like "write tests for auth.ts" or "fix eslint errors in src/utils".',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear task description for the subagent' },
        name: { type: 'string', description: 'Optional short label, e.g. "TestWriter"' },
      },
      required: ['task'],
    },
  },
  execute: (args) =>
    spawnSubagentTool({
      task: String(args.task),
      name: args.name as string | undefined,
    }),
};

const BASE_TOOLS: ToolDefinition[] = [
  {
    readOnly: true,
    schema: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace. Returns numbered lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute path within workspace' },
          start_line: { type: 'number', description: 'Start line (1-indexed, optional)' },
          end_line: { type: 'number', description: 'End line (1-indexed, optional)' },
        },
        required: ['path'],
      },
    },
    execute: (args) =>
      readFileTool({
        path: String(args.path),
        start_line: args.start_line as number | undefined,
        end_line: args.end_line as number | undefined,
      }),
  },
  {
    readOnly: true,
    schema: {
      name: 'list_files',
      description: 'List files in the workspace matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts (default: **/*)' },
          max_results: { type: 'number', description: 'Max files to return (default 100)' },
        },
      },
    },
    execute: (args) =>
      listFilesTool({
        pattern: args.pattern as string | undefined,
        max_results: args.max_results as number | undefined,
      }),
  },
  {
    readOnly: true,
    schema: {
      name: 'search_workspace',
      description: 'Search for a regex pattern across workspace files using ripgrep.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search pattern (regex)' },
          file_pattern: { type: 'string', description: 'Optional glob to filter files, e.g. *.ts' },
          max_results: { type: 'number', description: 'Max matches (default 50)' },
        },
        required: ['query'],
      },
    },
    execute: (args) =>
      searchWorkspaceTool({
        query: String(args.query),
        file_pattern: args.file_pattern as string | undefined,
        max_results: args.max_results as number | undefined,
      }),
  },
  {
    readOnly: false,
    schema: {
      name: 'edit_file',
      description:
        'Edit a file via search/replace (old_string + new_string) or full write (content). User must approve via diff preview.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute path within workspace' },
          old_string: { type: 'string', description: 'Exact string to find (for search/replace)' },
          new_string: { type: 'string', description: 'Replacement string' },
          content: { type: 'string', description: 'Full new file content (alternative to search/replace)' },
        },
        required: ['path'],
      },
    },
    execute: (args) =>
      editFileTool({
        path: String(args.path),
        old_string: args.old_string as string | undefined,
        new_string: args.new_string as string | undefined,
        content: args.content as string | undefined,
      }),
  },
  {
    readOnly: false,
    schema: {
      name: 'run_terminal',
      description: 'Run a shell command in the workspace. Requires user approval unless trusted mode is enabled.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory relative to workspace (optional)' },
        },
        required: ['command'],
      },
    },
    execute: (args) =>
      runTerminalTool({
        command: String(args.command),
        cwd: args.cwd as string | undefined,
      }),
  },
  {
    readOnly: true,
    schema: {
      name: 'search_web',
      description:
        'Search the public web (Google via Serper, Brave, Google CSE, Tavily, or DuckDuckGo). Use for official docs, Docker/Alpine/CUDA specs, API references, and research when workspace search is insufficient. Follow with fetch_url for full pages.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Max results (default 8)' },
        },
        required: ['query'],
      },
    },
    execute: (args) =>
      searchWebTool({
        query: String(args.query),
        max_results: args.max_results as number | undefined,
      }),
  },
  {
    readOnly: true,
    schema: {
      name: 'fetch_url',
      description:
        'Fetch a public web page (https) and return readable text. Use after search_web to read official documentation, release notes, or guides.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL' },
          max_chars: { type: 'number', description: 'Max characters to return (default 12000)' },
        },
        required: ['url'],
      },
    },
    execute: (args) =>
      fetchUrlTool({
        url: String(args.url),
        max_chars: args.max_chars as number | undefined,
      }),
  },
];

export function getToolDefinitions(options: ToolRegistryOptions = {}): ToolDefinition[] {
  const tools = [...BASE_TOOLS];
  if (options.includeSpawnSubagent) {
    tools.push(SPAWN_SUBAGENT_TOOL);
  }
  return tools;
}

export function getToolSchemas(options: ToolRegistryOptions = {}): ToolSchema[] {
  return getToolDefinitions(options).map((t) => t.schema);
}

export function getToolByName(name: string, options: ToolRegistryOptions = {}): ToolDefinition | undefined {
  return getToolDefinitions(options).find((t) => t.schema.name === name);
}

export function registerVsCodeTools(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const defs = getToolDefinitions({ includeSpawnSubagent: true });

  for (const def of defs) {
    const tool = vscode.lm.registerTool(def.schema.name, {
      invoke: async (options, _token) => {
        const input = (options.input ?? {}) as Record<string, unknown>;
        const result = await def.execute(input);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(result),
        ]);
      },
    });
    disposables.push(tool);
  }

  context.subscriptions.push(...disposables);
  return disposables;
}
