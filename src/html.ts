/**
 * Converts a Conversation snapshot into a self-contained HTML page.
 * No external dependencies — all CSS is inlined.
 */

export interface HtmlMessage {
  id: string;
  role: string;
  content: string;
  thinking?: string;
  timestamp: number;
  model?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
  }>;
}

export interface HtmlConversation {
  id: string;
  title: string;
  messages: HtmlMessage[];
  createdAt: number;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Minimal inline markdown: code fences, inline code, bold, italics. */
function renderContent(raw: string): string {
  const escaped = escHtml(raw);

  const withFences = escaped.replace(
    /```([a-z]*)\n?([\s\S]*?)```/g,
    (_m, lang: string, code: string) =>
      `<pre class="code-block"><code class="${lang ? `language-${lang}` : ''}">${code.trim()}</code></pre>`,
  );

  const withInline = withFences.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  const withBold = withInline.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const withItalic = withBold.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  const lines = withItalic.split('\n');
  const result: string[] = [];
  let inPre = false;
  for (const line of lines) {
    if (line.includes('<pre')) inPre = true;
    if (line.includes('</pre>')) { inPre = false; result.push(line); continue; }
    result.push(inPre ? line : line + (inPre ? '\n' : '<br>'));
  }
  return result.join('\n');
}

function renderMessage(msg: HtmlMessage): string {
  const isUser = msg.role === 'user';
  const isAssistant = msg.role === 'assistant';
  const roleLabel = isUser ? 'User' : isAssistant ? 'Assistant' : msg.role.replace(/_/g, ' ');
  const roleClass = isUser ? 'user' : isAssistant ? 'assistant' : 'other';

  let inner = '';

  if (msg.thinking) {
    inner += `
      <details class="thinking-block">
        <summary>Thinking…</summary>
        <div class="thinking-content">${renderContent(msg.thinking)}</div>
      </details>`;
  }

  if (msg.content) {
    inner += `<div class="message-content">${renderContent(msg.content)}</div>`;
  }

  if (msg.toolCalls?.length) {
    for (const tc of msg.toolCalls) {
      const inputJson = escHtml(JSON.stringify(tc.input, null, 2));
      const resultStr = tc.result !== undefined ? escHtml(String(tc.result)) : '';
      const isErr = tc.isError ? ' tool-error' : '';
      inner += `
        <details class="tool-call${isErr}">
          <summary class="tool-call-summary">
            <span class="tool-icon">⚙</span>
            <code>${escHtml(tc.name)}</code>
          </summary>
          <div class="tool-call-body">
            <div class="tool-section-label">Input</div>
            <pre class="code-block"><code>${inputJson}</code></pre>
            ${resultStr ? `<div class="tool-section-label">Result</div><pre class="code-block"><code>${resultStr}</code></pre>` : ''}
          </div>
        </details>`;
    }
  }

  const modelBadge = msg.model ? `<span class="model-badge">${escHtml(msg.model)}</span>` : '';

  return `
    <div class="message ${roleClass}">
      <div class="message-header">
        <span class="role-label">${roleLabel}</span>
        ${modelBadge}
        <span class="timestamp">${fmtTime(msg.timestamp)}</span>
      </div>
      <div class="message-body">${inner}</div>
    </div>`;
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f172a;
    --surface: #1e293b;
    --surface2: #263349;
    --border: #334155;
    --text: #f8fafc;
    --muted: #94a3b8;
    --primary: #3b82f6;
    --secondary: #8b5cf6;
    --accent: #06b6d4;
    --user-bg: #1d3a5f;
    --assistant-bg: #1e293b;
    --code-bg: #0f172a;
    --tool-bg: #1a2744;
    --thinking-bg: #231c3d;
    --error: #ef4444;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace;
  }
  html { font-size: 16px; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    line-height: 1.6;
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .page-header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 20px 24px;
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo {
    font-size: 14px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--primary), var(--secondary));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: 0.02em;
  }
  .sep { color: var(--border); }
  .conv-title { font-size: 15px; font-weight: 600; color: var(--text); }
  .conv-meta { font-size: 13px; color: var(--muted); margin-left: auto; }

  main {
    max-width: 820px;
    margin: 0 auto;
    padding: 24px 16px 80px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .message { border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
  .message.user { background: var(--user-bg); border-color: #2d4a7a; }
  .message.assistant { background: var(--assistant-bg); }
  .message.other { background: var(--surface); opacity: 0.75; }

  .message-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .role-label { font-weight: 600; }
  .message.user .role-label { color: #60a5fa; }
  .message.assistant .role-label { color: #a78bfa; }
  .model-badge {
    font-size: 11px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .timestamp { margin-left: auto; color: var(--muted); font-size: 12px; }
  .message-body { padding: 14px; }
  .message-content { white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.7; }

  .code-block {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.6;
    margin: 8px 0;
    white-space: pre;
  }
  .inline-code {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    font-family: var(--mono);
    font-size: 13px;
  }

  .thinking-block {
    background: var(--thinking-bg);
    border: 1px solid #3b2d6e;
    border-radius: 8px;
    margin-bottom: 10px;
    overflow: hidden;
  }
  .thinking-block > summary {
    padding: 8px 12px;
    cursor: pointer;
    font-size: 13px;
    font-style: italic;
    color: #c4b5fd;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .thinking-block > summary::before { content: '▶'; font-size: 10px; transition: transform 0.15s; }
  .thinking-block[open] > summary::before { transform: rotate(90deg); }
  .thinking-content {
    padding: 10px 12px;
    border-top: 1px solid #3b2d6e;
    font-size: 13px;
    color: #c4b5fd;
    white-space: pre-wrap;
  }

  .tool-call {
    background: var(--tool-bg);
    border: 1px solid #2d4a7a;
    border-radius: 8px;
    margin: 6px 0;
    overflow: hidden;
  }
  .tool-call.tool-error { border-color: #7f1d1d; background: #1f0e0e; }
  .tool-call-summary {
    padding: 8px 12px;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
    list-style: none;
    color: var(--accent);
  }
  .tool-call-summary::before { content: '▶'; font-size: 10px; }
  .tool-call[open] .tool-call-summary::before { transform: rotate(90deg); }
  .tool-icon { font-size: 14px; }
  .tool-call-body { padding: 10px 12px; border-top: 1px solid #2d4a7a; }
  .tool-section-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }

  footer {
    text-align: center;
    padding: 24px;
    font-size: 13px;
    color: var(--muted);
    border-top: 1px solid var(--border);
  }
  footer a { color: var(--primary); }
`;

export function renderConversationHtml(conv: HtmlConversation): string {
  const messageCount = conv.messages.filter((m) => m.role !== 'system').length;
  const messagesHtml = conv.messages
    .filter((m) => m.role !== 'system')
    .map(renderMessage)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(conv.title)} — OpenConduit</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="page-header">
    <span class="logo">OpenConduit</span>
    <span class="sep">/</span>
    <span class="conv-title">${escHtml(conv.title)}</span>
    <span class="conv-meta">${messageCount} message${messageCount === 1 ? '' : 's'} · Shared ${fmtTime(Date.now())}</span>
  </header>
  <main>
    ${messagesHtml}
  </main>
  <footer>
    Shared from <a href="https://openconduit.ai" rel="noopener noreferrer">OpenConduit</a>
    · <a href="https://github.com/OpenConduit/Client" rel="noopener noreferrer">Open source</a>
  </footer>
</body>
</html>`;
}
