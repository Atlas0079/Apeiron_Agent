import type * as vscode from "vscode";

export function renderHtml(webview: vscode.Webview): string {
  const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} file: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Apeiron</title>
  <style>
    :root { color-scheme: dark light; --border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent); --muted: color-mix(in srgb, var(--vscode-foreground) 62%, transparent); }
    html, body { height: 100%; overflow: hidden; }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    button, input, textarea, select { font: inherit; }
    .app { display: grid; grid-template-columns: minmax(360px, 1.2fr) minmax(320px, .8fr); height: 100vh; min-height: 0; min-width: 0; overflow: hidden; }
    .main, .side { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .main { border-right: 1px solid var(--border); }
    .side { border-right: 0; }
    .status { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); align-items: center; }
    .status strong { font-size: 13px; }
    .status small { color: var(--muted); display: block; margin-top: 2px; }
    .toolbar { display: flex; gap: 6px; flex-wrap: wrap; }
    .icon-btn, .text-btn { border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); min-height: 30px; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
    .text-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    .text-btn:disabled, .icon-btn:disabled { opacity: .55; cursor: not-allowed; }
    .messages { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .message { border: 1px solid var(--border); border-radius: 6px; padding: 9px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); }
    .message.user { border-left: 3px solid var(--vscode-button-background); }
    .message.assistant { border-left: 3px solid var(--vscode-charts-green); }
    .message-head { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .message-body { white-space: pre-wrap; line-height: 1.45; }
    .message-extra { margin-top: 8px; display: grid; gap: 6px; }
    .message-extra-row { border-top: 1px solid var(--border); padding-top: 6px; color: var(--muted); font-size: 12px; }
    .composer { flex: 0 0 auto; border-top: 1px solid var(--border); padding: 10px; display: grid; gap: 8px; }
    input, select, textarea { border: 1px solid var(--border); border-radius: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 8px; min-width: 0; }
    textarea { min-height: 76px; resize: vertical; }
    .tabs { flex: 0 0 auto; display: flex; border-bottom: 1px solid var(--border); }
    .tab { flex: 1; padding: 8px 6px; border: 0; background: transparent; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-button-background); }
    .panel { display: none; overflow: auto; padding: 10px; flex: 1 1 auto; min-height: 0; }
    .panel.active { display: block; }
    .item { border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 8px; }
    .item-head { display: flex; gap: 8px; align-items: start; justify-content: space-between; }
    .item-title { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
    .item-meta { color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
    .item-summary { margin-top: 7px; color: var(--muted); line-height: 1.35; font-size: 12px; white-space: pre-wrap; }
    .form-grid { display: grid; gap: 8px; margin-top: 10px; }
    .form-grid label { color: var(--muted); font-size: 12px; display: grid; gap: 4px; }
    .form-grid input, .form-grid select { width: 100%; box-sizing: border-box; }
    details { border: 1px solid var(--border); border-radius: 6px; padding: 7px; margin-bottom: 8px; }
    summary { cursor: pointer; }
    pre { overflow: auto; white-space: pre-wrap; font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; }
    .coverage-row { display: grid; grid-template-columns: 92px 74px 1fr; gap: 6px; padding: 5px 4px; border-bottom: 1px solid var(--border); cursor: pointer; align-items: center; }
    .coverage-row:hover { background: var(--vscode-list-hoverBackground); }
    .badge { border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; font-size: 11px; text-align: center; }
    .queue { color: var(--muted); font-size: 12px; }
    @media (max-width: 820px) { .app { grid-template-columns: 1fr; grid-template-rows: minmax(420px, 1fr) minmax(300px, .8fr); } .main { border-right: 0; border-bottom: 1px solid var(--border); } }
  </style>
</head>
<body>
  <div class="app">
    <section class="main">
      <div class="status">
        <div><strong id="phase">Idle</strong><small id="status">Starting...</small></div>
        <div class="toolbar">
          <button class="text-btn" id="refreshBtn" title="Refresh current blocked turn">Refresh</button>
          <button class="text-btn" id="scopedWarmupBtn" title="Run scoped warmup from the current input">Scoped Warmup</button>
          <button class="text-btn" id="fullWarmupBtn" title="Run full project warmup">Full Warmup</button>
          <button class="text-btn" id="contextBtn" title="Create context pack">Context</button>
          <button class="text-btn" id="stopBtn" title="Stop after the current in-flight action">Stop</button>
        </div>
      </div>
      <div class="messages" id="messages"></div>
      <div class="composer">
        <textarea id="input" placeholder="Ask Apeiron to work on this project"></textarea>
        <div class="toolbar">
          <button class="text-btn primary" id="sendBtn">Send</button>
          <button class="text-btn" id="addFileBtn" title="Add a repo file to context">Add File</button>
          <button class="text-btn" id="attachBtn" title="Attach external files or images">Attach</button>
          <button class="text-btn" id="steerBtn" title="Inject during a running work loop, otherwise queue for the next run">Queue Steering</button>
          <button class="text-btn" id="followBtn" title="Inject during a running work loop, otherwise queue for the next run">Queue Follow-up</button>
          <span class="queue" id="queue"></span>
        </div>
      </div>
    </section>
    <aside class="side">
      <div class="tabs">
        <button class="tab active" data-tab="events">Events</button>
        <button class="tab" data-tab="refresh">Refresh</button>
        <button class="tab" data-tab="context">Context</button>
        <button class="tab" data-tab="coverage">Memory Map</button>
        <button class="tab" data-tab="attachments">Files</button>
        <button class="tab" data-tab="sessions">Sessions</button>
        <button class="tab" data-tab="settings">Settings</button>
      </div>
      <div class="panel active" id="events"></div>
      <div class="panel" id="refresh"></div>
      <div class="panel" id="context"></div>
      <div class="panel" id="coverage"></div>
      <div class="panel" id="attachments"></div>
      <div class="panel" id="sessions"></div>
      <div class="panel" id="settings"></div>
    </aside>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = null;
    let activeTab = 'events';
    const el = (id) => document.getElementById(id);
    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', (event) => {
      if (event.data.type === 'state') {
        state = event.data.state;
        render();
      }
      if (event.data.type === 'editMessage') {
        el('input').value = event.data.text;
        el('input').focus();
      }
    });

    document.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => {
        activeTab = button.dataset.tab;
        render();
      });
    });
    el('sendBtn').addEventListener('click', () => send());
    el('scopedWarmupBtn').addEventListener('click', () => warmup('scoped'));
    el('fullWarmupBtn').addEventListener('click', () => warmup('full'));
    el('contextBtn').addEventListener('click', () => vscode.postMessage({ type: 'createContext', task: el('input').value }));
    el('stopBtn').addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
    el('addFileBtn').addEventListener('click', () => vscode.postMessage({ type: 'addFileToContext' }));
    el('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refreshTurn' }));
    el('attachBtn').addEventListener('click', () => vscode.postMessage({ type: 'uploadAttachment' }));
    el('steerBtn').addEventListener('click', () => queue('steering'));
    el('followBtn').addEventListener('click', () => queue('follow-up'));
    el('input').addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') send();
    });

    function send() {
      const text = el('input').value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'send', text });
      el('input').value = '';
    }
    function queue(mode) {
      const text = el('input').value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'queue', text, mode });
      el('input').value = '';
    }
    function warmup(mode) {
      const text = mode === 'full' ? 'Build a full project memory map.' : (el('input').value.trim() || 'Build a useful project map for the next work task.');
      vscode.postMessage({ type: 'warmup', mode, goal: text });
    }
    function render() {
      if (!state) return;
      el('phase').textContent = state.phase.toUpperCase();
      el('status').textContent = [state.statusText, state.turnId ? 'turn ' + state.turnId : '', state.sessionId ? 'session ' + state.sessionId : ''].filter(Boolean).join(' | ');
      el('refreshBtn').disabled = state.phase !== 'blocked';
      const busy = ['warmup', 'work', 'refresh', 'context'].includes(state.phase);
      el('sendBtn').disabled = busy;
      el('scopedWarmupBtn').disabled = busy;
      el('fullWarmupBtn').disabled = busy;
      el('contextBtn').disabled = busy;
      el('stopBtn').disabled = !['warmup', 'work', 'refresh'].includes(state.phase) || state.abortRequested;
      el('stopBtn').textContent = state.abortRequested ? 'Stopping' : 'Stop';
      el('steerBtn').disabled = false;
      el('followBtn').disabled = false;
      el('queue').textContent = state.queue.length ? state.queue.length + ' queued' : '';
      renderMessages();
      renderTabs();
    }
    function renderMessages() {
      el('messages').innerHTML = state.messages.map(renderMessage).join('');
      document.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'editMessage', id: button.dataset.edit })));
      document.querySelectorAll('[data-message-diff]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', path: button.dataset.messageDiff })));
      document.querySelectorAll('[data-message-source]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openSource', path: button.dataset.messageSource })));
    }
    function renderMessage(message) {
      const edit = message.role === 'user' ? '<button class="icon-btn" data-edit="' + esc(message.id) + '">Edit</button>' : '';
      const attachments = (message.attachments || []).map((file) => '<div class="message-extra-row">File: ' + esc(file.name) + '<div class="item-meta">' + esc(file.kind) + ' | ' + esc(file.path) + '</div><div class="toolbar"><button class="text-btn" data-message-source="' + esc(file.path) + '">Open File</button></div></div>').join('');
      const tools = renderToolStrip(message.tools || []);
      const code = renderChangeLinks('Code changes', message.codeChanges || []);
      const memory = renderChangeLinks('Memory changes', message.memoryChanges || []);
      const extras = attachments || tools || code || memory ? '<div class="message-extra">' + attachments + tools + code + memory + '</div>' : '';
      return '<div class="message ' + message.role + '"><div class="message-head"><span>' + esc(message.role) + '</span>' + edit + '</div><div class="message-body">' + esc(message.content) + '</div>' + extras + '</div>';
    }
    function renderToolStrip(tools) {
      if (!tools.length) return '';
      return '<div class="message-extra-row"><strong>Tools</strong>' + tools.map((tool) => '<div class="item-meta"><span class="badge">' + esc(tool.status) + '</span> ' + esc(tool.label) + (tool.detail ? ' | ' + esc(tool.detail) : '') + '</div>').join('') + '</div>';
    }
    function renderChangeLinks(title, paths) {
      if (!paths.length) return '';
      return '<div class="message-extra-row"><strong>' + esc(title) + '</strong>' + paths.map((file) => '<div class="toolbar"><span class="item-meta">' + esc(file) + '</span><button class="text-btn" data-message-diff="' + esc(file) + '">Open Diff</button></div>').join('') + '</div>';
    }
    function renderTabs() {
      document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === activeTab));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === activeTab));
      renderEvents(); renderRefresh(); renderContext(); renderCoverage(); renderAttachments(); renderSessions(); renderSettings();
    }
    function renderEvents() {
      const warmup = renderWarmupStatus();
      el('events').innerHTML = warmup + (state.events.slice().reverse().map((event) => {
        const failed = event.detail && typeof event.detail === 'object' && (event.detail.ok === false || event.detail.exitCode);
        const open = failed || event.kind === 'error';
        const path = eventPath(event.detail);
        const actions = path ? '<div class="toolbar"><button class="text-btn" data-open-source="' + esc(path) + '">Open File</button><button class="text-btn" data-open-diff="' + esc(path) + '">Open Diff</button></div>' : '';
        return '<details' + (open ? ' open' : '') + '><summary><span class="badge">' + esc(event.kind) + '</span> ' + esc(event.summary) + '</summary>' + actions + '<pre>' + esc(JSON.stringify(event.detail, null, 2)) + '</pre></details>';
      }).join('') || '<div class="item-meta">No events yet.</div>');
      document.querySelectorAll('[data-open-source]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openSource', path: button.dataset.openSource })));
      document.querySelectorAll('[data-open-diff]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', path: button.dataset.openDiff })));
    }
    function renderWarmupStatus() {
      const status = state.warmupStatus;
      if (!status) return '';
      const error = status.lastError ? ' | ' + status.lastError.category + ': ' + status.lastError.message : '';
      const resume = status.phase === 'interrupted' ? ' | click warmup again to continue' : '';
      return '<div class="item"><div class="item-title">Warmup ' + esc(status.phase) + '</div><div class="item-meta">' + esc(status.mode) + ' | completed ' + esc((status.completedFiles || []).length) + ' | pending ' + esc((status.pendingFiles || []).length) + resume + '</div><div class="item-summary">' + esc(status.goal || '') + esc(error) + '</div></div>';
    }
    function renderContext() {
      const enabled = state.contextItems.filter((item) => item.enabled).length;
      const header = state.contextItems.length
        ? '<div class="item"><div class="item-title">Context loaded</div><div class="item-meta">' + enabled + ' enabled / ' + state.contextItems.length + ' items | ~' + (state.contextTokensEstimate || 0) + ' / ' + (state.contextBudgetTokens || 0) + ' tokens</div></div>'
        : '';
      const rows = state.contextItems.map((item) => {
        const unavailable = item.excludedReason || item.validity === 'missing' || item.validity === 'stale';
        return '<div class="item"><div class="item-head"><div><div class="item-title">' + esc(item.title) + (item.pinned ? ' [pinned]' : '') + '</div><div class="item-meta"><span class="badge">' + esc(item.validity || 'unvalidated') + '</span> ' + esc(item.type) + ' | ' + esc(item.addedBy || 'system') + ' | ~' + esc(item.tokensEstimate || 0) + ' tokens | ' + esc(item.source) + (item.excludedReason ? ' | unavailable: ' + esc(item.excludedReason) : '') + '</div></div><input type="checkbox" data-context="' + esc(item.id) + '"' + (item.enabled ? ' checked' : '') + (unavailable ? ' disabled' : '') + '></div><div class="item-summary">' + esc(item.summary) + '</div><div class="item-meta">' + esc(item.reason || '') + '</div></div>';
      }).join('');
      el('context').innerHTML = header + rows || '<div class="item-meta">Create a context pack to inspect hidden context.</div>';
      document.querySelectorAll('[data-context]').forEach((input) => input.addEventListener('change', () => vscode.postMessage({ type: 'toggleContext', id: input.dataset.context, included: input.checked })));
    }
    function renderRefresh() {
      const summary = state.latestRefreshSummary;
      if (!summary) {
        el('refresh').innerHTML = '<div class="item-meta">No refresh result yet.</div>';
        return;
      }
      const updated = (summary.updatedMemoryFiles || []).concat(summary.updatedSummaries || []);
      const blocked = summary.blocked && summary.blocked.length
        ? '<div class="item"><div class="item-title">Blocked</div>' + summary.blocked.map((item) => '<div class="item-meta">' + esc(item.path) + ': ' + esc(item.reason) + '</div>').join('') + '</div>'
        : '';
      el('refresh').innerHTML =
        '<div class="item"><div class="item-title">Refresh summary</div><div class="item-meta">' + esc(summary.checked) + ' checked | ' + esc(updated.length) + ' memory updates | ' + esc((summary.blocked || []).length) + ' blocked</div><div class="toolbar"><button class="text-btn" id="openMemoryChanges">Open Memory Changes</button></div></div>' +
        (updated.length ? '<div class="item"><div class="item-title">Updated memory</div>' + updated.map((file) => '<div class="item-meta">' + esc(file) + '</div>').join('') + '</div>' : '') +
        blocked;
      const openMemory = document.getElementById('openMemoryChanges');
      if (openMemory) openMemory.addEventListener('click', () => vscode.postMessage({ type: 'openChanges', scope: 'memory' }));
    }
    function renderCoverage() {
      const detail = state.selectedCoverage ? '<div class="item"><div class="item-title">' + esc(state.selectedCoverage.path) + '</div><div class="item-meta">' + esc(JSON.stringify(state.selectedCoverage, null, 2)) + '</div><div class="toolbar"><button class="text-btn" id="openSelected">Open</button><button class="text-btn" id="openSelectedSummary">Open Summary</button><button class="text-btn" id="addSelectedContext">Add Context</button></div></div>' : '';
      const filter = (state.coverageFilter || '').toLowerCase();
      const rows = state.coverage.filter((row) => !filter || row.path.toLowerCase().includes(filter) || row.status.toLowerCase().includes(filter) || row.kind.toLowerCase().includes(filter));
      const counts = state.coverage.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
      const summary = '<div class="item"><div class="item-title">Memory Map</div><div class="item-meta">' + Object.keys(counts).sort().map((status) => esc(status) + ': ' + esc(counts[status])).join(' | ') + '</div></div>';
      const filterBox = '<div class="item"><input id="coverageFilter" value="' + esc(state.coverageFilter || '') + '" placeholder="Filter memory map by path, status, or kind"></div>';
      el('coverage').innerHTML = detail + summary + filterBox + renderMemoryMapGroups(rows);
      const coverageFilter = document.getElementById('coverageFilter');
      if (coverageFilter) coverageFilter.addEventListener('input', () => vscode.postMessage({ type: 'setCoverageFilter', filter: coverageFilter.value }));
      document.querySelectorAll('[data-coverage]').forEach((row) => row.addEventListener('click', () => vscode.postMessage({ type: 'selectCoverage', path: row.dataset.coverage })));
      const open = document.getElementById('openSelected');
      if (open && state.selectedCoverage) open.addEventListener('click', () => vscode.postMessage({ type: 'openSource', path: state.selectedCoverage.path }));
      const openSummary = document.getElementById('openSelectedSummary');
      if (openSummary && state.selectedCoverage) openSummary.addEventListener('click', () => vscode.postMessage({ type: 'openSummary', path: state.selectedCoverage.path }));
      const add = document.getElementById('addSelectedContext');
      if (add && state.selectedCoverage) add.addEventListener('click', () => vscode.postMessage({ type: 'addCoverageToContext', path: state.selectedCoverage.path }));
    }
    function renderMemoryMapGroups(rows) {
      const order = ['missing-ref', 'stale', 'unread', 'documented', 'grouped', 'ignored'];
      const groups = new Map();
      rows.forEach((row) => {
        const key = row.status || 'unknown';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      });
      return order.concat(Array.from(groups.keys()).filter((key) => !order.includes(key)).sort()).filter((key) => groups.has(key)).map((key) => {
        const groupRows = groups.get(key).sort((a, b) => a.path.localeCompare(b.path));
        const open = key === 'missing-ref' || key === 'stale' || key === 'unread';
        return '<details' + (open ? ' open' : '') + '><summary><span class="badge">' + esc(key) + '</span> ' + esc(groupRows.length) + ' file(s)</summary>' + groupRows.map((row) => '<div class="coverage-row" data-coverage="' + esc(row.path) + '"><span class="badge">' + esc(row.status) + '</span><span class="badge">' + esc(row.kind) + '</span><span>' + esc(row.path) + '</span></div>').join('') + '</details>';
      }).join('') || '<div class="item-meta">No files in memory map.</div>';
    }
    function renderAttachments() {
      el('attachments').innerHTML = state.attachments.map((file) => '<div class="item"><div class="item-title">' + esc(file.name) + '</div><div class="item-meta">' + esc(file.kind) + ' | ' + esc(file.path) + '</div><div class="item-summary">' + esc(file.preview || '') + '</div></div>').join('') || '<div class="item-meta">No attachments.</div>';
    }
    function renderSessions() {
      const sessionRows = (state.sessions || []).map((session) => '<div class="item"><div class="item-head"><div><div class="item-title">' + esc(session.title || session.id) + '</div><div class="item-meta">' + esc(session.id) + ' | ' + esc(session.checkpointCount || 0) + ' checkpoints | ' + esc(session.updatedAt) + '</div></div><button class="text-btn" data-session="' + esc(session.id) + '">Open</button></div></div>').join('');
      const checkpointRows = (state.checkpoints || []).map((checkpoint) => '<div class="item"><div class="item-head"><div><div class="item-title">' + esc(checkpoint.label) + '</div><div class="item-meta">' + esc(checkpoint.id) + ' | message ' + esc(checkpoint.messageIndex) + (checkpoint.hasSnapshot ? ' | snapshot' : '') + ' | ' + esc(checkpoint.createdAt) + '</div></div><button class="text-btn" data-checkpoint="' + esc(checkpoint.id) + '" data-checkpoint-session="' + esc(checkpoint.sessionId) + '">Restore</button></div><div class="item-summary">' + esc(checkpoint.summary) + '</div></div>').join('');
      el('sessions').innerHTML = '<div class="item"><div class="item-title">Sessions</div><div class="item-meta">' + esc((state.sessions || []).length) + ' saved sessions</div></div>' + (sessionRows || '<div class="item-meta">No sessions yet.</div>') + '<div class="item"><div class="item-title">Checkpoints</div><div class="item-meta">' + esc((state.checkpoints || []).length) + ' in current session</div></div>' + (checkpointRows || '<div class="item-meta">Open a session with checkpoints.</div>');
      document.querySelectorAll('[data-session]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'selectSession', id: button.dataset.session })));
      document.querySelectorAll('[data-checkpoint]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'selectCheckpoint', sessionId: button.dataset.checkpointSession, checkpointId: button.dataset.checkpoint })));
    }
    function renderSettings() {
      const settings = state.providerSettings || {};
      el('settings').innerHTML =
        '<div class="item"><div class="item-title">Test provider</div><div class="item-meta">Stored in VS Code SecretStorage/globalState. API key is not written to repo memory or sessions.</div>' +
        '<div class="item-summary">' + esc(state.providerSettingsStatus || '') + '</div>' +
        '<div class="form-grid">' +
        '<label>Format<select id="providerFormat"><option value="openai-completions">OpenAI-compatible</option><option value="anthropic-messages">Claude-compatible (not wired)</option><option value="google-generative-ai">Google-compatible (not wired)</option></select></label>' +
        '<label>Base URL<input id="providerBaseUrl" value="' + esc(settings.baseUrl || '') + '" placeholder="https://api.example.com/v1"></label>' +
        '<label>Model<input id="providerModel" value="' + esc(settings.model || '') + '" placeholder="model-name"></label>' +
        '<label>Provider label<input id="providerName" value="' + esc(settings.provider || '') + '" placeholder="apeiron-openai-compatible"></label>' +
        '<label>Reasoning<select id="providerReasoning"><option value="">Off/default</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>' +
        '<label>Retry attempts<input id="providerRetryAttempts" type="number" min="1" max="10" step="1" value="' + esc(settings.retryAttempts || 3) + '"></label>' +
        '<label>Retry delay ms<input id="providerRetryDelayMs" type="number" min="0" max="60000" step="100" value="' + esc(settings.retryDelayMs || 1000) + '"></label>' +
        '<label>Retry backoff<input id="providerRetryBackoff" type="number" min="1" max="10" step="0.1" value="' + esc(settings.retryBackoff || 2) + '"></label>' +
        '<label>API Key<input id="providerApiKey" type="password" value="" placeholder="' + (settings.hasApiKey ? 'Stored key present; leave blank to keep' : 'Paste test API key') + '"></label>' +
        '<div class="toolbar"><button class="text-btn primary" id="saveProviderSettings">Save</button><button class="text-btn" id="testProviderSettings">Test</button><button class="text-btn" id="clearProviderApiKey">Clear Key</button></div></div></div>';
      const format = document.getElementById('providerFormat');
      const reasoning = document.getElementById('providerReasoning');
      if (format) format.value = settings.format || 'openai-completions';
      if (reasoning) reasoning.value = settings.reasoning || '';
      const readSettings = () => ({
        format: document.getElementById('providerFormat').value,
        baseUrl: document.getElementById('providerBaseUrl').value,
        model: document.getElementById('providerModel').value,
        provider: document.getElementById('providerName').value,
        reasoning: document.getElementById('providerReasoning').value || undefined,
        retryAttempts: Number(document.getElementById('providerRetryAttempts').value || 3),
        retryDelayMs: Number(document.getElementById('providerRetryDelayMs').value || 1000),
        retryBackoff: Number(document.getElementById('providerRetryBackoff').value || 2),
        apiKey: document.getElementById('providerApiKey').value || undefined
      });
      document.getElementById('saveProviderSettings').addEventListener('click', () => vscode.postMessage({ type: 'saveProviderSettings', settings: readSettings() }));
      document.getElementById('testProviderSettings').addEventListener('click', () => vscode.postMessage({ type: 'testProviderSettings' }));
      document.getElementById('clearProviderApiKey').addEventListener('click', () => vscode.postMessage({ type: 'clearProviderApiKey' }));
    }
    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function eventPath(detail) {
      if (!detail || typeof detail !== 'object') return '';
      if (typeof detail.path === 'string') return detail.path;
      if (detail.event && typeof detail.event.path === 'string') return detail.event.path;
      if (detail.turn && Array.isArray(detail.turn.modifiedFiles) && detail.turn.modifiedFiles.length) return detail.turn.modifiedFiles[0];
      return '';
    }
  </script>
</body>
</html>`;
}
