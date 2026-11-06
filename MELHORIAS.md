# Melhorias sugeridas — GG Report

Lista criada em **06/11/2026**, a pedido do usuário. Os itens abaixo são sugestões para priorização e **ainda não foram implementados**. As entregas existentes estão em [IA_MEMORY.md](IA_MEMORY.md).

## Prioridade alta — fila e entrega

### M-001 — Evitar que jogadores pausados bloqueiem a fila

- **Situação confirmada em teste offline:** a consulta de mensagens pendentes limita os primeiros 20 registros antes de o monitor filtrar os jogadores pausados. Vinte mensagens antigas de um jogador pausado podem impedir o envio de mensagens de jogadores ativos.
- **Proposta:** selecionar entradas elegíveis antes de aplicar o limite, preservando a ordem e os envios pausados.
- **Aceite:** com mais de 20 entradas de jogador pausado e uma de jogador ativo, a mensagem ativa é processada; nenhuma mensagem pausada é enviada ou perde tentativas.
- **Referência:** `Store.dueDeliveries()` em `src/store.js` e `Monitor.deliver()` em `src/monitor.js`.

### M-002 — Suspender a rodada de envios quando o WhatsApp desconectar

- **Situação confirmada em teste offline:** a conexão é verificada apenas antes do loop. Se o primeiro envio desconecta a sessão, as próximas entradas ainda podem consumir tentativas sem conexão.
- **Proposta:** reavaliar a conexão antes de cada envio e encerrar a rodada ao desconectar.
- **Aceite:** após a primeira falha que derruba a conexão, as mensagens seguintes mantêm suas tentativas intactas e continuam disponíveis após reconectar.
- **Referência:** `Monitor.deliver()` em `src/monitor.js`.

### M-003 — Conferir o grupo ao conectar outra conta

- **Situação:** o grupo fica salvo entre sessões. Ao trocar a conta do WhatsApp, ele pode não pertencer à nova conta.
- **Proposta:** validar o destino salvo na reconexão ou antes de ativar o monitor, orientando o usuário a selecionar um grupo quando necessário.
- **Aceite:** a interface identifica um grupo indisponível sem gastar tentativas de envio. Destinos de mensagens já na fila não são alterados silenciosamente.

## Prioridade média — uso e operação

### M-004 — Recuperar rascunhos do editor após recarregar

- **Situação:** o rascunho é preservado durante as atualizações do painel, mas fica apenas na memória da página.
- **Proposta:** salvar o rascunho localmente, com opção de recuperar ou descartar e distinção clara entre rascunho e configuração salva no servidor.
- **Aceite:** recarregar a página permite recuperar alterações sem aplicar modelos nem enviar mensagens automaticamente.

### M-005 — Conferir o novo editor em navegador real

- **Situação:** o editor passou por testes de DOM simulado e verificações HTTP; a revisão visual real ficou indisponível por falha da ferramenta de navegador da sessão.
- **Proposta:** revisar desktop e celular, navegação por teclado, modo ampliado, busca e arrastar campos no navegador.
- **Aceite:** sem sobreposição ou rolagem horizontal indevida; foco visível e saída por Escape funcionam; salvar e pré-visualizar continuam claros.

### M-006 — Criar verificação automática no GitHub

- **Proposta:** executar `npm ci`, `npm test`, `npm run check` e build Docker em pull requests e alterações da branch principal.
- **Aceite:** o fluxo roda sem credenciais Riot ou WhatsApp, usa integrações simuladas e não publica imagens ou envia mensagens por padrão.

### M-007 — Adicionar diagnóstico da conexão Riot

- **Proposta:** botão para testar a credencial do servidor e mostrar um diagnóstico legível de autenticação, rede e limites de consulta.
- **Aceite:** a chave nunca aparece na resposta ou nos logs. O diagnóstico orienta recriar o container depois de mudar o `.env` e respeita os limites da Riot.

### M-008 — Facilitar backup e restauração

- **Proposta:** documentar um procedimento reproduzível para copiar e restaurar o volume com SQLite e sessão, com a aplicação parada para consistência.
- **Aceite:** uma instalação de teste recupera configurações e histórico; arquivos de backup permanecem privados e fora do Git.

## Dependentes de escolha — novos jogos

### M-009 — Escolher e integrar o próximo jogo

- **Entrega parcial concluída (06/11/2026):** **Counter-Strike 2 (Premier e Competitivo)** integrado a pedido do usuário (`src/cs2.js`, `src/cs2-message.js`, `src/games.js`), usando Steam Web API (`GetNextMatchSharingCode`) + Leetify, migração aditiva no SQLite e abas independentes na interface.
- Outros candidatos pesquisados continuam dependentes de escolha do usuário: Dota 2/OpenDota, CS2 na FACEIT e Deadlock por API comunitária. R6 e EA Sports FC exigem avaliação própria de acesso e cobertura.
- **Antes de implementar outro jogo:** revalidar a API, os modos atendidos, limites, credenciais e dados disponíveis; para futebol, confirmar a edição e o modo.
- **Aceite:** adaptador separado, dados normalizados, templates compatíveis, deduplicação e testes offline, mantendo o projeto leve.

## Como manter esta lista

Ao iniciar um item aprovado, registre responsável e escopo. Ao concluir, marque a entrega aqui e atualize a memória com o comportamento final, validação realizada e commit correspondente. Novos pedidos do usuário têm prioridade sobre a ordem sugerida.
