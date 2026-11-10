(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  const STATUS = {
    pending: ['Na fila', 'badge-pending'], sent: ['Enviado', 'badge-lime'],
    failed: ['Falha no envio', 'badge-error'], skipped: ['Sem partidas', 'badge-neutral'],
  };
  let game = window.ggActiveGame || 'lol';
  let state = null;
  let saved = null;
  let draft = null;
  let band = 'sumido';
  let focusedInput = null;
  let previewTimer = null;
  let previewRequest = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function toast(message, error = false) {
    const container = $('toast-container');
    if (!container) return;
    const node = el('div', `toast${error ? ' error' : ''}`, message);
    container.append(node);
    setTimeout(() => node.remove(), error ? 7000 : 4500);
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Não foi possível concluir a ação (${response.status}).`);
    return data;
  }
  const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
  const gameLabel = value => ({ cs2: 'CS2', r6: 'R6' })[value] || 'LOL';

  function setSaveState() {
    const badge = $('weekly-save-state');
    const changed = draft && dirty();
    badge.textContent = changed ? 'Rascunho não salvo' : 'Salvo';
    badge.className = `badge ${changed ? 'badge-pending' : 'badge-neutral'}`;
    $('weekly-save-config').disabled = !changed;
  }

  function renderSchedule() {
    const { settings, next } = state;
    $('weekly-toggle').checked = settings.enabled;
    $('weekly-toggle-label').textContent = settings.enabled ? 'Ativo' : 'Desativado';
    $('weekly-day').value = String(settings.day);
    $('weekly-hour').value = String(settings.hour);
    const when = new Date(next.scheduledAt);
    const date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(when);
    $('weekly-next').textContent = settings.enabled
      ? `Próximo resumo: ${DAYS[settings.day].toLowerCase()} ${date} às ${String(settings.hour).padStart(2, '0')}h · semana de ${next.period}`
      : 'Resumo semanal desativado. Nenhuma mensagem semanal será enviada.';
  }

  function renderBands() {
    const strip = $('weekly-bands');
    strip.replaceChildren(...state.bands.map(entry => {
      const node = el('span', `weekly-band weekly-band-${entry.key}`);
      node.append(el('strong', '', entry.label), el('small', '', entry.range));
      return node;
    }));
    const tabs = $('weekly-band-tabs');
    tabs.replaceChildren(...state.bands.map(entry => {
      const button = el('button', `preview-tab${entry.key === band ? ' active' : ''}`, entry.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(entry.key === band));
      button.addEventListener('click', () => { band = entry.key; renderBands(); renderPhrases(); });
      return button;
    }));
  }

  function renderVariables() {
    const list = $('weekly-variable-list');
    const templateFocused = focusedInput === $('weekly-template');
    const variables = templateFocused ? state.templateVariables : state.lineVariables
      .filter(variable => focusedInput !== $('weekly-phrases') || variable.key !== 'zoeira');
    list.replaceChildren(...variables.map(variable => {
      const button = el('button', 'weekly-variable', `{{${variable.key}}}`);
      button.type = 'button';
      button.title = `${variable.label}: ${variable.description}`;
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => insert(`{{${variable.key}}}`));
      return button;
    }));
  }

  function renderPhrases() {
    const entry = state.bands.find(item => item.key === band);
    $('weekly-band-range').textContent = `${entry.label}: ${entry.range}.`;
    $('weekly-phrases').value = draft.phrases[band].join('\n');
  }

  function renderEditor() {
    $('weekly-template').value = draft.template;
    $('weekly-line').value = draft.line;
    $('weekly-inactive-line').value = draft.inactiveLine;
    renderPhrases();
    setSaveState();
  }

  function renderHistory() {
    const list = $('weekly-history-list');
    if (!state.reports.length) {
      list.replaceChildren(el('p', 'count-label', 'Nenhum resumo gerado ainda.'));
      return;
    }
    list.replaceChildren(...state.reports.map(report => {
      const item = el('details', 'weekly-report');
      const summary = el('summary');
      const [label, badgeClass] = STATUS[report.status] || [report.status, 'badge-neutral'];
      summary.append(el('span', 'weekly-report-game', gameLabel(report.game)), el('span', 'weekly-report-period', report.period), el('span', `badge ${badgeClass}`, label));
      item.append(summary);
      if (report.error) item.append(el('p', 'inline-error weekly-error', report.error));
      if (report.message) item.append(el('pre', 'weekly-report-message', report.message));
      else item.append(el('p', 'count-label', 'Ninguém jogou nesta semana, então nada foi enviado.'));
      if (report.status === 'failed') {
        const retry = el('button', 'text-link', 'Tentar enviar de novo ↻');
        retry.type = 'button';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          try {
            await api(`/api/weekly/reports/${encodeURIComponent(report.id)}/retry`, 'POST', {});
            toast('Resumo colocado na fila de novo.');
            await load({ keepDraft: true });
          } catch (error) { toast(error.message, true); retry.disabled = false; }
        });
        item.append(retry);
      }
      return item;
    }));
  }

  function insert(text) {
    const input = focusedInput || $('weekly-template');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(text, start, end, 'end');
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function readEditor() {
    draft.template = $('weekly-template').value;
    draft.line = $('weekly-line').value;
    draft.inactiveLine = $('weekly-inactive-line').value;
    draft.phrases[band] = $('weekly-phrases').value.split('\n').map(line => line.trim()).filter(Boolean);
    setSaveState();
    schedulePreview();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 350);
  }
  async function preview() {
    if (!draft) return;
    const id = ++previewRequest;
    const source = $('weekly-preview-source').value;
    $('weekly-preview-tag').textContent = `${gameLabel(game)} · PRÉVIA`;
    try {
      const result = await api('/api/weekly/preview', 'POST', { game, source, config: draft });
      if (id !== previewRequest) return;
      $('weekly-preview-error').hidden = true;
      $('weekly-preview').textContent = result.message || (source === 'last'
        ? `Nenhuma partida de ${gameLabel(game)} na semana de ${result.period}. Nada seria enviado.`
        : `Ainda não há partidas de ${gameLabel(game)} nesta semana (${result.period}). Escolha “Exemplo fictício” para ver o formato.`);
    } catch (error) {
      if (id !== previewRequest) return;
      $('weekly-preview-error').textContent = error.message;
      $('weekly-preview-error').hidden = false;
    }
  }

  async function load({ keepDraft = false } = {}) {
    try {
      state = await api('/api/weekly');
      saved = structuredClone(state.config);
      const firstLoad = !keepDraft || !draft;
      if (firstLoad) draft = structuredClone(state.config);
      $('weekly-load-error').hidden = true;
      $('weekly-fields').disabled = false;
      $('weekly-toggle').disabled = false;
      renderSchedule();
      renderHistory();
      if (firstLoad) {
        renderBands();
        renderVariables();
        renderEditor();
        schedulePreview();
      } else setSaveState();
    } catch (error) {
      $('weekly-load-error').hidden = false;
      $('weekly-save-state').textContent = 'Erro';
    }
  }

  function setGame(value) {
    game = value === 'cs2' || value === 'r6' ? value : 'lol';
    $('weekly-eyebrow').textContent = `O BALANÇO DA SEMANA · ${gameLabel(game)}`;
    schedulePreview();
  }

  function bind() {
    const hours = $('weekly-hour');
    hours.replaceChildren(...Array.from({ length: 24 }, (_, hour) => {
      const option = el('option', '', `${String(hour).padStart(2, '0')}h`);
      option.value = String(hour);
      return option;
    }));
    for (const id of ['weekly-template', 'weekly-line', 'weekly-inactive-line', 'weekly-phrases']) {
      const input = $(id);
      input.addEventListener('input', readEditor);
      input.addEventListener('focus', () => { focusedInput = input; if (state) renderVariables(); });
    }
    $('weekly-preview-source').addEventListener('change', preview);
    $('weekly-toggle').addEventListener('change', async event => {
      const toggle = event.currentTarget;
      toggle.disabled = true;
      try {
        state = { ...state, ...(await api('/api/weekly/settings', 'PUT', { enabled: toggle.checked })) };
        renderSchedule();
        toast(toggle.checked ? 'Resumo semanal ativado.' : 'Resumo semanal desativado.');
      } catch (error) { toggle.checked = !toggle.checked; toast(error.message, true); }
      finally { toggle.disabled = false; }
    });
    $('weekly-schedule-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = $('weekly-save-schedule');
      button.disabled = true;
      try {
        const result = await api('/api/weekly/settings', 'PUT', { day: Number($('weekly-day').value), hour: Number($('weekly-hour').value) });
        state = { ...state, ...result };
        renderSchedule();
        schedulePreview();
        toast('Horário do resumo salvo.');
      } catch (error) { toast(error.message, true); }
      finally { button.disabled = false; }
    });
    $('weekly-save-config').addEventListener('click', async () => {
      const button = $('weekly-save-config');
      button.disabled = true;
      try {
        const result = await api('/api/weekly/config', 'PUT', { config: draft });
        state = result;
        saved = structuredClone(result.config);
        draft = structuredClone(result.config);
        renderEditor();
        toast('Resumo semanal salvo. Vale a partir do próximo envio.');
      } catch (error) { toast(error.message, true); setSaveState(); }
    });
    $('weekly-restore').addEventListener('click', async () => {
      try {
        const defaults = await api('/api/weekly/defaults');
        draft = structuredClone(defaults.config);
        renderEditor();
        schedulePreview();
        toast('Modelo original carregado no rascunho. Salve para aplicar.');
      } catch (error) { toast(error.message, true); }
    });
    $('weekly-refresh').addEventListener('click', () => load({ keepDraft: true }));
    $('weekly-retry-load').addEventListener('click', () => load());
    document.addEventListener('game-tab-changed', event => setGame(event.detail?.game));
    setInterval(() => { if (!document.hidden) load({ keepDraft: true }); }, 60_000);
  }

  bind();
  setGame(game);
  load();
})();
