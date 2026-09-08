// Handlers for action slash-commands (see commands.ts for parsing).
//
// VS Code-side module: May import vscode, the provider router, and settings.
// Pure parsing stays in commands.ts so it remains unit testable.

import * as vscode from 'vscode';
import { execFile as execFileCb } from 'node:child_process';
import { SessionMemory, type StoredTurn } from './memory';
import { buildHelpMarkdown, type AgentAction } from './commands';
import { formatProviderModelSummary, getConfiguredProviderId } from '../llm/providerConfig';
import { getProviderDefinition } from '../llm/providerCatalog';
import { getApiKey } from '../llm/secrets';
import { getProvider } from '../llm/router';
import { findOpencodeBinary } from '../llm/opencode/detector';
import { getSharedManager } from '../llm/opencode/manager';
import { getWorkspacePath, nodeManagerDeps } from '../llm/opencode/vscode';
import { selectModelOnly, selectProviderAndModel } from '../llm/selectProviderModel';
import type { Message } from '../llm/types';

export interface AgentActionInput {
  action: AgentAction;
  rest: string;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  memory: SessionMemory;
}

const ISSUES_URL = 'https://github.com/ishankrs/Buddy/issues/new';

/** Clear Buddy memory and reset the OpenCode session (fresh conversation). */
export async function startFreshConversation(
  context: vscode.ExtensionContext,
  memory: SessionMemory
): Promise<void> {
  await memory.clear();
  try {
    await getSharedManager(nodeManagerDeps(context)).resetSession(getWorkspacePath());
  } catch {
    // Best effort: memory is cleared regardless.
  }
}

/**
 * Execute an action slash-command. Returns a follow-up message to send as a
 * fresh request (only `/new <message>` does this), or undefined when the
 * action was fully handled and nothing further should run.
 */
export async function runAgentAction(
  input: AgentActionInput,
  context: vscode.ExtensionContext
): Promise<{ message: string } | undefined> {
  switch (input.action) {
    case 'new':
    case 'clear': {
      await startFreshConversation(context, input.memory);
      if (!input.rest) {
        input.stream.markdown(
          '✨ Started a new conversation. Memory and OpenCode session cleared.'
        );
        return undefined;
      }
      return { message: input.rest };
    }
    case 'models':
    case 'model':
      await selectModelOnly(context);
      input.stream.markdown(`Now using **${formatProviderModelSummary()}**.`);
      return undefined;
    case 'provider':
      await selectProviderAndModel(context);
      input.stream.markdown(`Now using **${formatProviderModelSummary()}**.`);
      return undefined;
    case 'help':
      input.stream.markdown(buildHelpMarkdown());
      return undefined;
    case 'status':
      await showStatus(input);
      return undefined;
    case 'context':
      await showContext(input);
      return undefined;
    case 'doctor':
      await runDoctor(input, context);
      return undefined;
    case 'compact':
      await runCompact(input, context);
      return undefined;
    case 'review':
      await runReview(input, context, /security/i.test(input.rest));
      return undefined;
    case 'diff':
      await showDiff(input);
      return undefined;
    case 'export':
      await exportTranscript(input);
      return undefined;
    case 'init':
      await runInit(input, context);
      return undefined;
    case 'copy':
      await copyResponse(input);
      return undefined;
    case 'btw':
      await runBtw(input, context);
      return undefined;
    case 'feedback':
      await openFeedback(input);
      return undefined;
    case 'permissions':
      await managePermissions(input);
      return undefined;
  }
}

function buddyVersion(): string {
  return (
    vscode.extensions.getExtension('ishankrs.buddy-ai-coding-agent')?.packageJSON
      ?.version ?? 'dev'
  );
}

async function showStatus(input: AgentActionInput): Promise<void> {
  const turns = await input.memory.loadTurns();
  input.stream.markdown(
    [
      '**Buddy status**',
      '',
      `- Version: \`${buddyVersion()}\``,
      `- Provider: \`${formatProviderModelSummary()}\``,
      `- Workspace: \`${getWorkspacePath()}\``,
      `- Turns in memory: \`${turns.length}\``,
    ].join('\n')
  );
}

async function showContext(input: AgentActionInput): Promise<void> {
  const turns = await input.memory.loadTurns();
  const maxTurns = vscode.workspace.getConfiguration('buddy').get<number>('maxMemoryTurns', 20);
  const sizes = turns.map((t) => turnLength(t));
  const total = sizes.reduce((a, b) => a + b, 0);
  const lines = [
    '**Conversation context**',
    '',
    `- Turns remembered: \`${turns.length}\` / \`${maxTurns}\``,
    `- Approximate context size: \`~${total.toLocaleString()} chars\``,
  ];
  if (turns.length > 0) {
    lines.push('', 'Largest turns:');
    turns
      .map((t, i) => ({ i, len: sizes[i], label: t.userMessage.slice(0, 60) }))
      .sort((a, b) => b.len - a.len)
      .slice(0, 5)
      .forEach((t) => lines.push(`- #${t.i + 1} (~${t.len.toLocaleString()} chars): ${t.label}`));
    lines.push('', 'Run `/compact [focus]` to summarize and free space, or `/new` to start fresh.');
  } else {
    lines.push('', 'The conversation is empty — nothing is using context yet.');
  }
  input.stream.markdown(lines.join('\n'));
}

function turnLength(turn: StoredTurn): number {
  return (turn.userMessage?.length ?? 0) + (turn.assistantSummary?.length ?? 0);
}

function execFileAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr?.toString() || err.message).trim().slice(0, 500)));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

async function runDoctor(input: AgentActionInput, context: vscode.ExtensionContext): Promise<void> {
  const lines = ['**Buddy doctor**', ''];
  const ok = (label: string) => lines.push(`- ✓ ${label}`);
  const bad = (label: string, hint: string) => lines.push(`- ✗ ${label} — ${hint}`);

  // Provider + model.
  const providerId = getConfiguredProviderId();
  const def = getProviderDefinition(providerId);
  ok(`Provider: ${formatProviderModelSummary()}`);

  // API key where required.
  if (def.requiresApiKey) {
    const key = await getApiKey(context, providerId);
    if (key) {
      ok(`API key stored for ${def.label} (local SecretStorage)`);
    } else {
      bad(`No API key for ${def.label}`, 'run **Buddy: Set API Key**');
    }
  } else if (providerId === 'opencode') {
    const detection = await findOpencodeBinary(
      nodeManagerDeps(context).execDeps,
      vscode.workspace.getConfiguration('buddy').get<string>('opencodeBinary', '')
    );
    if (detection.ok) {
      ok(`OpenCode CLI detected (v${detection.version} at ${detection.path})`);
    } else {
      bad('OpenCode CLI not detected', 'install it, or run **Buddy: Check OpenCode (Local)**');
    }
  } else {
    ok(`${def.label} needs no API key`);
  }

  // ripgrep (workspace search).
  try {
    const version = (await execFileAsync('rg', ['--version'], getWorkspacePath())).split('\n')[0];
    ok(`ripgrep available (${version.trim().slice(0, 40)})`);
  } catch {
    bad('ripgrep (`rg`) not on PATH', 'workspace search falls back to slower scanning — install ripgrep');
  }

  // Node runtime.
  const major = Number(process.version.slice(1).split('.')[0]);
  if (major >= 20) {
    ok(`Node runtime ${process.version}`);
  } else {
    bad(`Node runtime ${process.version}`, 'Buddy development needs Node 20+');
  }

  // Workspace.
  if (vscode.workspace.workspaceFolders?.length) {
    ok(`Workspace open (${vscode.workspace.workspaceFolders.length} folder(s))`);
  } else {
    bad('No workspace folder open', 'file tools and @-tagging need an open folder');
  }

  input.stream.markdown(lines.join('\n'));
}

function abortLinked(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    const listener = token.onCancellationRequested(() => {
      controller.abort();
      listener.dispose();
    });
    void listener;
  }
  return controller.signal;
}

async function collectText(
  context: vscode.ExtensionContext,
  systemPrompt: string,
  userText: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<string> {
  const provider = await getProvider(context);
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    { role: 'user', content: [{ type: 'text', text: userText }] },
  ];
  let text = '';
  for await (const chunk of provider.chat({
    messages,
    tools: [],
    signal: abortLinked(token),
  })) {
    if (token.isCancellationRequested) {
      break;
    }
    if (chunk.type === 'text') {
      text += chunk.text;
      stream.markdown(chunk.text);
    }
  }
  return text;
}

async function runCompact(input: AgentActionInput, context: vscode.ExtensionContext): Promise<void> {
  const turns = await input.memory.loadTurns();
  if (turns.length === 0) {
    input.stream.markdown('Nothing to compact — the conversation is empty.');
    return;
  }
  const focus = input.rest ? ` Focus the summary on: ${input.rest}.` : '';
  const transcript = turns
    .map((t, i) => `### Turn ${i + 1}\nUser: ${t.userMessage}\nAssistant: ${t.assistantSummary}`)
    .join('\n\n');
  input.stream.markdown(`**Compacting ${turns.length} turns…**\n\n`);
  const summary = await collectText(
    context,
    `You summarize coding-assistant conversations into a compact handoff note. Preserve: files touched, decisions made, errors found, and open todos.${focus} Be concise but complete.`,
    transcript,
    input.stream,
    input.token
  );
  if (!summary.trim() || input.token.isCancellationRequested) {
    input.stream.markdown('\n\n*Compaction cancelled — history untouched.*');
    return;
  }
  await input.memory.clear();
  await input.memory.saveTurn({
    userMessage: '[Compacted conversation — summary of earlier turns]',
    assistantSummary: summary.slice(0, 4000),
    assistantFullText: summary,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: summary }] }],
    timestamp: Date.now(),
  });
  input.stream.markdown('\n\n*History replaced with the summary above.*');
}

async function workspaceGitDiff(): Promise<{ diff: string; root: string } | { error: string }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return { error: 'No workspace folder open.' };
  }
  const root = folders[0].uri.fsPath;
  try {
    const diff = await execFileAsync('git', ['diff', '--', '.', ':(exclude)package-lock.json'], root);
    return { diff, root };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: /not a git repository/i.test(message) ? 'This workspace is not a git repository.' : message };
  }
}

async function showDiff(input: AgentActionInput): Promise<void> {
  const result = await workspaceGitDiff();
  if ('error' in result) {
    input.stream.markdown(`**Error:** ${result.error}`);
    return;
  }
  if (!result.diff.trim()) {
    input.stream.markdown('Working tree is clean — no changes.');
    return;
  }
  const capped = result.diff.length > 20000 ? result.diff.slice(0, 20000) + '\n…(truncated)' : result.diff;
  input.stream.markdown(`**Working-tree changes** (${result.root}):\n\n\`\`\`diff\n${capped}\n\`\`\``);
}

async function runReview(
  input: AgentActionInput,
  context: vscode.ExtensionContext,
  securityOnly: boolean
): Promise<void> {
  const result = await workspaceGitDiff();
  if ('error' in result) {
    input.stream.markdown(`**Error:** ${result.error}`);
    return;
  }
  if (!result.diff.trim()) {
    input.stream.markdown('Nothing to review — working tree is clean.');
    return;
  }
  const diff = result.diff.length > 30000 ? result.diff.slice(0, 30000) + '\n…(truncated)' : result.diff;
  const system = securityOnly
    ? 'You are a security reviewer. Analyze the following diff for vulnerabilities (injection, auth, secrets exposure, unsafe execution, dependency risks). Report each finding with file:line, severity, and a concrete fix. Findings only — do not ask questions.'
    : 'You are a code reviewer. Analyze the following diff for correctness bugs and cleanup opportunities. Report each finding with file:line and a concrete fix. Findings only — do not ask questions.';
  input.stream.markdown(securityOnly ? '**Security review**\n\n' : '**Code review**\n\n');
  const text = await collectText(
    context,
    system,
    `Review this diff:\n\n\`\`\`diff\n${diff}\n\`\`\``,
    input.stream,
    input.token
  );
  if (text.trim() && !input.token.isCancellationRequested) {
    await input.memory.saveTurn({
      userMessage: `[/review${securityOnly ? ' security' : ''}]`,
      assistantSummary: text.slice(0, 4000),
      assistantFullText: text,
      messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
      timestamp: Date.now(),
    });
  }
}

async function exportTranscript(input: AgentActionInput): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    input.stream.markdown('**Error:** No workspace folder open — nowhere to save the file.');
    return;
  }
  const turns = await input.memory.loadTurns();
  if (turns.length === 0) {
    input.stream.markdown('Nothing to export — the conversation is empty.');
    return;
  }
  const fallback = `buddy-transcript-${new Date().toISOString().slice(0, 10)}.md`;
  const name = (input.rest.split(/\s+/)[0] || fallback).replace(/[/\\]/g, '-');
  const fileName = name.endsWith('.md') ? name : `${name}.md`;
  const body = [
    `# Buddy transcript (${new Date().toISOString()})`,
    '',
    ...turns.flatMap((t, i) => [
      `## Turn ${i + 1} — ${new Date(t.timestamp).toLocaleString()}`,
      '',
      `**User:** ${t.userMessage}`,
      '',
      `**Buddy:** ${t.assistantFullText ?? t.assistantSummary}`,
      '',
    ]),
  ].join('\n');
  const uri = vscode.Uri.joinPath(folders[0].uri, fileName);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
  input.stream.markdown(`Transcript saved to \`${fileName}\`.`);
}

async function runInit(input: AgentActionInput, context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    input.stream.markdown('**Error:** No workspace folder open.');
    return;
  }
  const target = vscode.Uri.joinPath(folders[0].uri, 'AGENTS.md');
  try {
    await vscode.workspace.fs.stat(target);
    const choice = await vscode.window.showWarningMessage(
      'AGENTS.md already exists. Overwrite it?',
      'Overwrite',
      'Cancel'
    );
    if (choice !== 'Overwrite') {
      return;
    }
  } catch {
    // Does not exist — proceed to create.
  }
  let listing = '';
  try {
    const entries = await vscode.workspace.fs.readDirectory(folders[0].uri);
    listing = entries
      .filter(([name]) => !name.startsWith('.') && name !== 'node_modules')
      .map(([name, type]) => `${type === vscode.FileType.Directory ? 'dir' : 'file'} ${name}`)
      .slice(0, 60)
      .join('\n');
  } catch {
    listing = '(could not list files)';
  }
  input.stream.markdown('**Drafting AGENTS.md…**\n\n');
  const text = await collectText(
    context,
    'You write AGENTS.md instruction files for coding agents. Given a repo listing, draft concise instructions: project identity, build/test commands (guess from files present, mark guesses), conventions, and a never-commit-secrets rule. Output ONLY the markdown file content.',
    `Repo root listing:\n${listing}`,
    input.stream,
    input.token
  );
  if (!text.trim() || input.token.isCancellationRequested) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  input.stream.markdown('\n\nWrote `AGENTS.md`.');
}

async function copyResponse(input: AgentActionInput): Promise<void> {
  const turns = await input.memory.loadTurns();
  if (turns.length === 0) {
    input.stream.markdown('Nothing to copy — the conversation is empty.');
    return;
  }
  const n = Math.max(1, parseInt(input.rest, 10) || 1);
  if (n > turns.length) {
    input.stream.markdown(`Only ${turns.length} turn(s) in history — try \`/copy ${turns.length}\` or lower.`);
    return;
  }
  const turn = turns[turns.length - n];
  const full = turn.assistantFullText ?? turn.assistantSummary;
  if (!full) {
    input.stream.markdown('That turn has no assistant text to copy.');
    return;
  }
  await vscode.env.clipboard.writeText(full);
  input.stream.markdown(n === 1 ? 'Latest response copied to clipboard.' : `Response ${n} back copied to clipboard.`);
}

async function runBtw(input: AgentActionInput, context: vscode.ExtensionContext): Promise<void> {
  if (!input.rest) {
    input.stream.markdown('Usage: `/btw <question>` — asks without saving to history.');
    return;
  }
  // Side question: answered directly, never written to memory.
  await collectText(
    context,
    'You answer a quick side question about the user’s codebase. Be brief.',
    input.rest,
    input.stream,
    input.token
  );
}

async function openFeedback(input: AgentActionInput): Promise<void> {
  const body = [
    '**Describe the problem**',
    '',
    input.rest || '<what happened>',
    '',
    '---',
    `Buddy ${buddyVersion()} · ${formatProviderModelSummary()}`,
  ].join('\n');
  const url = `${ISSUES_URL}?title=${encodeURIComponent(input.rest.slice(0, 80) || 'Feedback')}&body=${encodeURIComponent(body)}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
  input.stream.markdown('Opened the Buddy issue tracker — thanks for the feedback.');
}

async function managePermissions(input: AgentActionInput): Promise<void> {
  const config = vscode.workspace.getConfiguration('buddy');
  const autoApprove = config.get<boolean>('autoApproveReadOnly', true);
  const trusted = config.get<boolean>('trustedMode', false);
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `Auto-approve read-only tools: ${autoApprove ? 'ON' : 'OFF'}`,
        description: 'Run read/search tools without asking',
        key: 'autoApproveReadOnly' as const,
        value: !autoApprove,
      },
      {
        label: `Trusted mode (skip terminal approval): ${trusted ? 'ON' : 'OFF'}`,
        description: 'Not recommended — terminal runs without confirmation',
        key: 'trustedMode' as const,
        value: !trusted,
      },
    ],
    { title: 'Buddy tool approvals — pick one to toggle' }
  );
  if (!picked) {
    return;
  }
  await config.update(picked.key, picked.value, vscode.ConfigurationTarget.Global);
  input.stream.markdown(
    `**Tool approvals**\n\n- Auto-approve read-only: \`${picked.key === 'autoApproveReadOnly' ? picked.value : autoApprove}\`\n- Trusted mode: \`${picked.key === 'trustedMode' ? picked.value : trusted}\``
  );
}
