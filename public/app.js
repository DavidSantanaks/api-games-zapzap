(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let state = null;
  let filter = 'all';
  let intervalDirty = false;
  let groupsLoaded = false;
  let groupsLoading = false;
  let groups = [];
  let lastPlayerRender = '';
  let lastMatchRender = '';
  let refreshing = false;
  let selectedScenario = 'feed';
  let dialogMatch = null;
  const busyButtons = new WeakSet();
  const regions = { americas: 'Américas', europe: 'Europa', asia: 'Ásia', sea: 'Sudeste Asiático / Oceania' };
  const statusLabels = { pending: 'Na fila', sent: 'Enviada', failed: 'Falha no envio' };
  const dates = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function date(value) {
    if (!value) return 'Ainda não verificado';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Data indisponível' : dates.format(parsed);
  }
  function toast(message, error = false) {
    const node = el('div', `toast${error ? ' error' : ''}`, message);
    $('toast-container').append(node);
    setTimeout(() => node.remove(), error ? 7000 : 4500);
  }
  async function api(path, method = 'GET', body) {
    method = method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && body === undefined) body = {};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Não foi possível concluir a ação (${response.status}).`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('A operação demorou mais que o esperado. Confira o estado antes de tentar novamente.');
      if (error instanceof TypeError) throw new Error('Não foi possível conectar ao servidor. Confira se o app está rodando.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function action(button, fn) {
    if (button.disabled || busyButtons.has(button)) return;
    busyButtons.add(button);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try { await fn(); }
    catch (error) { toast(error.message, true); }
    finally {
      busyButtons.delete(button);
      button.disabled = false;
      button.removeAttribute('aria-busy');
      syncDisabledStates();
      if (state && button.id === 'monitor-toggle') button.checked = !!state.settings.monitoringEnabled;
    }
  }
  function syncDisabledStates() {
    const connect = $('connect-whatsapp');
    const check = $('check-now');
    connect.disabled = busyButtons.has(connect) || state?.whatsapp.state === 'connecting';
    check.disabled = busyButtons.has(check) || !!state?.monitor.running;
    $('refresh-groups').disabled = groupsLoading;
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      state = await api('/api/state');
      $('connection-alert').hidden = true;
      render();
    } catch { $('connection-alert').hidden = false; }
    finally { refreshing = false; }
  }
  function render() {
    for (const key of ['players', 'matches', 'sent', 'pending']) $('stat-' + key).textContent = state.stats[key] ?? 0;
    $('riot-notice').hidden = state.riotConfigured;
    const active = !!state.settings.monitoringEnabled;
    const monitor = state.monitor || {};
    if (!busyButtons.has($('monitor-toggle'))) $('monitor-toggle').checked = active;
    $('toggle-label').textContent = active ? 'Ativo' : 'Ativar';
    $('monitor-badge').textContent = monitor.running ? 'Verificando' : active ? 'Ativo' : 'Pausado';
    $('monitor-badge').className = 'badge ' + (active ? 'badge-lime' : 'badge-neutral');
    const last = monitor.lastCheckAt ? `Última verificação: ${date(monitor.lastCheckAt)}` : 'Aguardando a primeira verificação';
    $('monitor-detail').textContent = monitor.running ? 'Consultando novas partidas…' : active ? `${last}. Intervalo: ${state.settings.pollIntervalSeconds}s.` : 'Ative para detectar partidas e enviar os resumos ao grupo.';
    $('monitor-error').hidden = !monitor.lastError;
    $('monitor-error').textContent = monitor.lastError || '';
    if (!intervalDirty && document.activeElement !== $('poll-interval')) $('poll-interval').value = state.settings.pollIntervalSeconds;
    renderPlayers();
    renderMatches();
    renderWhatsApp();
    syncDisabledStates();
  }
  function emptyList(title, copy, symbol = '◎', compact = false) {
    const node = el('div', `empty-state${compact ? ' compact' : ''}`);
    const icon = el('span', 'empty-symbol', symbol);
    icon.setAttribute('aria-hidden', 'true');
    node.append(icon);
    if (title) node.append(el('h3', '', title));
    node.append(el('p', '', copy));
    return node;
  }
  function renderPlayers() {
    const signature = JSON.stringify(state.players);
    if (signature === lastPlayerRender) return;
    lastPlayerRender = signature;
    const list = $('players-list');
    list.replaceChildren();
    if (!state.players.length) {
      list.append(emptyList('Quem vai ser o primeiro?', 'Adicione o Riot ID de um player para começar.', '◎', true));
      return;
    }
    for (const player of state.players) {
      const row = el('div', 'player-row' + (player.enabled ? '' : ' player-paused'));
      row.append(el('div', 'player-avatar', player.gameName.slice(0, 2).toUpperCase()));
      const info = el('div', 'player-info');
      const name = el('span', 'player-name', player.gameName);
      name.append(el('small', '', '#' + player.tagLine));
      name.title = `${player.gameName}#${player.tagLine}`;
      const region = el('span', 'player-region');
      const dot = el('span', 'player-status-dot');
      dot.setAttribute('aria-hidden', 'true');
      region.append(dot, document.createTextNode(`${player.enabled ? 'Monitorando' : 'Pausado'} · ${regions[player.region] || player.region}`));
      info.append(name, region);
      if (player.lastError) info.append(el('span', 'player-error', player.lastError));
      info.title = player.lastCheckedAt ? 'Última consulta: ' + date(player.lastCheckedAt) : 'Aguardando consulta';
      row.append(info);
      const actions = el('div', 'player-actions');
      const toggle = el('button', 'player-action', player.enabled ? 'Pausar' : 'Retomar');
      toggle.type = 'button';
      toggle.setAttribute('aria-label', `${player.enabled ? 'Pausar' : 'Retomar'} ${player.gameName}`);
      toggle.addEventListener('click', () => action(toggle, async () => {
        await api('/api/players/' + encodeURIComponent(player.id), 'PATCH', { enabled: !player.enabled });
        await refresh();
      }));
      const remove = el('button', 'player-action remove', '×');
      remove.type = 'button';
      remove.title = 'Remover player';
      remove.setAttribute('aria-label', 'Remover ' + player.gameName);
      remove.addEventListener('click', () => action(remove, async () => {
        await api('/api/players/' + encodeURIComponent(player.id), 'DELETE');
        toast('Player removido do acompanhamento.');
        await refresh();
      }));
      actions.append(toggle, remove);
      row.append(actions);
      list.append(row);
    }
  }
  function renderMatches() {
    const signature = filter + JSON.stringify(state.matches);
    if (signature === lastMatchRender) return;
    lastMatchRender = signature;
    $('history-count').textContent = `${state.matches.length} ${state.matches.length === 1 ? 'partida' : 'partidas'}`;
    const list = $('matches-list');
    const matches = state.matches.filter(match => filter === 'all' || match.status === filter);
    list.replaceChildren();
    if (!matches.length) {
      list.append(filter === 'all' ? emptyList('A próxima partida já tem plateia.', 'Cadastre um player e ative o monitor. As novas partidas aparecem aqui.', '▤') : emptyList('Nenhuma partida por aqui.', 'As partidas com esse status aparecerão nesta lista.', '▤'));
      return;
    }
    for (const match of matches) {
      const row = el('div', 'match-row');
      row.append(el('span', 'result-stripe' + (match.win ? '' : ' loss')), el('div', 'champion-tile', (match.champion || '?').slice(0, 2).toUpperCase()));
      const main = el('button', 'match-main match-info-button');
      main.type = 'button';
      main.setAttribute('aria-label', 'Ver mensagem da partida de ' + match.playerName);
      const top = el('div', 'match-topline');
      const name = el('span', 'match-name', match.playerName);
      name.title = match.playerName;
      top.append(name, el('span', 'match-result' + (match.win ? '' : ' loss'), match.win ? 'VITÓRIA' : 'DERROTA'));
      const mode = match.mode ? `${match.mode} · ` : '';
      const sub = el('div', 'match-subline', `${mode}${match.champion} · ${match.lane || '—'} · ${date(match.endedAt)}`);
      sub.title = sub.textContent;
      main.append(top, sub);
      main.addEventListener('click', () => openMatch(match));
      row.append(main, el('strong', 'match-kda', `${match.kills}/${match.deaths}/${match.assists}`));
      const right = el('div', 'match-right');
      right.append(el('span', 'badge ' + (match.status === 'sent' ? 'badge-lime' : match.status === 'failed' ? 'badge-error' : 'badge-pending'), statusLabels[match.status] || match.status));
      const detail = el('button', 'text-link', match.status === 'failed' ? 'Tentar de novo ↻' : 'Ver mensagem ↗');
      detail.type = 'button';
      if (match.status === 'failed') {
        detail.title = match.error || 'Recolocar mensagem na fila';
        detail.addEventListener('click', () => action(detail, async () => {
          await api('/api/matches/' + encodeURIComponent(match.id) + '/retry', 'POST');
          toast('Mensagem recolocada na fila.');
          await refresh();
        }));
      } else detail.addEventListener('click', () => openMatch(match));
      right.append(detail);
      row.append(right);
      list.append(row);
    }
  }
  function renderWhatsApp() {
    const wa = state.whatsapp;
    const connected = wa.state === 'connected';
    const qr = wa.state === 'qr' && !!wa.qrDataUrl;
    const labels = { disconnected: 'Desconectado', connecting: 'Conectando', qr: 'Escaneie o QR', connected: 'Conectado', error: 'Erro de conexão' };
    $('whatsapp-badge').textContent = labels[wa.state] || 'Desconectado';
    $('whatsapp-badge').className = 'badge ' + (connected ? 'badge-lime' : wa.state === 'error' ? 'badge-error' : 'badge-neutral');
    $('whatsapp-offline').hidden = connected || qr;
    $('qr-container').hidden = !qr;
    if (qr && $('whatsapp-qr').getAttribute('src') !== wa.qrDataUrl) $('whatsapp-qr').src = wa.qrDataUrl;
    if (!qr) $('whatsapp-qr').removeAttribute('src');
    $('whatsapp-connected').hidden = !connected;
    $('whatsapp-phone').textContent = wa.phone || 'Pronto para escolher um grupo';
    $('whatsapp-error').hidden = !wa.error;
    $('whatsapp-error').textContent = wa.error || '';
    $('group-controls').hidden = !connected;
    $('connect-whatsapp').hidden = connected || qr;
    $('connect-whatsapp').textContent = wa.state === 'connecting' ? 'Aguardando conexão…' : 'Conectar com QR Code ↗';
    $('disconnect-whatsapp').hidden = !(connected || qr || wa.state === 'connecting');
    $('disconnect-whatsapp').textContent = connected ? 'Desconectar conta' : 'Cancelar conexão';
    $('saved-group').textContent = state.settings.whatsappGroupId ? `Destino salvo: ${state.settings.whatsappGroupName || state.settings.whatsappGroupId}` : 'Nenhum grupo salvo. Escolha o destino acima.';
    if (connected && !groupsLoaded && !groupsLoading) loadGroups(false);
    if (!connected) groupsLoaded = false;
  }
  async function loadGroups(notify = true) {
    if (groupsLoading) return;
    groupsLoading = true;
    $('refresh-groups').disabled = true;
    try {
      const response = await api('/api/whatsapp/groups');
      groups = response.groups || [];
      groupsLoaded = true;
      const select = $('whatsapp-group');
      const current = select.value || state.settings.whatsappGroupId;
      const placeholder = el('option', '', groups.length ? 'Selecione um grupo' : 'Nenhum grupo encontrado');
      placeholder.value = '';
      select.replaceChildren(placeholder);
      for (const group of groups) {
        const option = el('option', '', group.name);
        option.value = group.id;
        select.append(option);
      }
      if (groups.some(group => group.id === current)) select.value = current;
      if (notify) toast(groups.length ? 'Lista de grupos atualizada.' : 'Nenhum grupo encontrado nesta conta.');
    } catch (error) {
      groupsLoaded = true;
      toast(error.message, true);
    } finally {
      groupsLoading = false;
      $('refresh-groups').disabled = false;
    }
  }
  async function loadPreview(scenario) {
    selectedScenario = scenario;
    document.querySelectorAll('[data-scenario]').forEach(button => {
      const active = button.dataset.scenario === scenario;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('preview-message').textContent = 'Gerando exemplo…';
    try {
      const data = await api('/api/preview', 'POST', { scenario });
      if (selectedScenario === scenario) $('preview-message').textContent = data.message;
    } catch (error) {
      if (selectedScenario === scenario) $('preview-message').textContent = 'Não foi possível carregar a prévia. Escolha um exemplo para tentar novamente.';
      toast(error.message, true);
    }
  }
  function openMatch(match) {
    dialogMatch = match;
    $('dialog-title').textContent = match.playerName;
    $('dialog-message').textContent = match.message;
    $('dialog-meta').textContent = `${statusLabels[match.status] || match.status}${match.mode ? ' · ' + match.mode : ''} · ${date(match.endedAt)}${match.error ? ' · ' + match.error : ''}`;
    $('message-dialog').showModal();
  }

  $('poll-interval').addEventListener('input', () => { intervalDirty = true; });
  $('interval-form').addEventListener('submit', event => {
    event.preventDefault();
    action($('save-interval'), async () => {
      await api('/api/settings', 'PUT', { pollIntervalSeconds: Number($('poll-interval').value) });
      intervalDirty = false;
      toast('Intervalo atualizado.');
      await refresh();
    });
  });
  $('monitor-toggle').addEventListener('change', event => {
    const enabled = event.target.checked;
    action(event.target, async () => {
      try {
        await api('/api/settings', 'PUT', { monitoringEnabled: enabled });
        toast(enabled ? 'Monitor ativo. Novas partidas poderão ser enviadas ao grupo salvo.' : 'Monitor pausado.');
      } finally { await refresh(); }
    });
  });
  $('check-now').addEventListener('click', () => action($('check-now'), async () => {
    await api('/api/check', 'POST');
    toast('Verificação solicitada. Acompanhe o resultado no painel.');
    await refresh();
  }));
  $('player-form').addEventListener('submit', event => {
    event.preventDefault();
    action($('add-player'), async () => {
      await api('/api/players', 'POST', { gameName: $('game-name').value.trim(), tagLine: $('tag-line').value.trim().replace(/^#/, ''), region: $('region').value });
      $('game-name').value = '';
      $('tag-line').value = '';
      toast('Player cadastrado. O histórico anterior será usado como referência.');
      await refresh();
      $('game-name').focus();
    });
  });
  $('connect-whatsapp').addEventListener('click', () => action($('connect-whatsapp'), async () => {
    await api('/api/whatsapp/connect', 'POST');
    await refresh();
  }));
  $('disconnect-whatsapp').addEventListener('click', () => action($('disconnect-whatsapp'), async () => {
    await api('/api/whatsapp/disconnect', 'POST');
    groupsLoaded = false;
    toast('Conta desconectada.');
    await refresh();
  }));
  $('refresh-groups').addEventListener('click', () => loadGroups());
  $('group-form').addEventListener('submit', event => {
    event.preventDefault();
    action($('save-group'), async () => {
      const group = groups.find(item => item.id === $('whatsapp-group').value);
      if (!group) throw new Error('Escolha um grupo da lista.');
      await api('/api/settings', 'PUT', { whatsappGroupId: group.id, whatsappGroupName: group.name });
      toast('Grupo de destino salvo.');
      await refresh();
    });
  });
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(tab => {
      tab.classList.toggle('active', tab === button);
      tab.setAttribute('aria-pressed', String(tab === button));
    });
    if (state) renderMatches();
  }));
  document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => loadPreview(button.dataset.scenario)));
  $('close-dialog').addEventListener('click', () => $('message-dialog').close());
  $('message-dialog').addEventListener('click', event => {
    if (event.target === $('message-dialog')) {
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
    }
  });
  $('copy-message').addEventListener('click', () => action($('copy-message'), async () => {
    if (!dialogMatch) return;
    try { await navigator.clipboard.writeText(dialogMatch.message); }
    catch { throw new Error('Não foi possível copiar automaticamente. Selecione e copie o texto da mensagem.'); }
    toast('Mensagem copiada.');
  }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  document.addEventListener('message-config-saved', () => loadPreview(selectedScenario));
  refresh();
  loadPreview('feed');
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
})();
