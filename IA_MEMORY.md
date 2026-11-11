# Memória do projeto — GG Report

Atualizada em **10/11/2026**. Leia este arquivo e o [README](README.md) antes de continuar o desenvolvimento. Registre decisões e entregas novas aqui, sem incluir credenciais ou dados da instalação do usuário.

## Objetivo e preferências

- Acompanhar partidas de jogos competitivos (**League of Legends**, **Counter-Strike 2** e **Rainbow Six Siege**) e publicar um resumo com zoeira em um grupo do WhatsApp.
- Manter o projeto leve, simples, com interface e execução em Docker; **sem Java**.
- Stack atual: Node.js 24, Express, SQLite nativo (`node:sqlite`) e HTML/CSS/JavaScript sem build ou CDN, sem novas dependências de runtime.
- Um único container, sem Chromium, Redis, banco separado ou serviço de IA. As frases usam regras locais.
- A interface e as mensagens são em português brasileiro.
- Repositório indicado pelo usuário: https://github.com/DavidSantanaks/api-games-zapzap.

## Entregas concluídas

### Infraestrutura compartilhada e League of Legends

- Duas abas independentes na interface (**League of Legends**, **Counter-Strike 2** e **Rainbow Six Siege**), cada uma com seus jogadores, contadores, histórico, prévias e editor de mensagens, compartilhando WhatsApp, grupo selecionado, intervalo, monitor e fila persistente.
- Integração com **League of Legends**: Riot ID → PUUID → histórico e detalhes da Match-v5.
- Cadastro, pausa e remoção de jogadores; região Américas para o servidor brasileiro.
- Monitor periódico configurável: padrão de 120 segundos, mínimo de 30; começa pausado na instalação nova.
- Baseline no cadastro para não enviar o histórico anterior; partidas em andamento podem aparecer depois de encerradas.
- Histórico paginado após períodos offline, consultas sequenciais, ciclos sem sobreposição e tratamento isolado de `Retry-After` por jogo (um `429` na Riot não bloqueia CS2 nem envios pendentes no WhatsApp).
- Estatísticas normalizadas de LoL: resultado, campeão, K/D/A, farm (`farm` soma tropas e monstros neutros), lane, ouro, duração e modo de jogo. Partidas customizadas são ignoradas nesta versão.
- WhatsApp por QR Code, lista de grupos, sessão persistente, reconexão e desconexão pela interface.
- Fila persistente com uma entrada por partida/jogador, tentativas com espera crescente e até cinco tentativas automáticas.
- Repetição manual de envios com falha e ID estável de mensagem para reduzir duplicação nas tentativas.
- Histórico de partidas por jogo, status de envio, detalhes e cópia do texto.
- Docker Compose com volume persistente (`gg-data`), healthcheck e porta publicada apenas em `127.0.0.1:3000`.

### Counter-Strike 2 (Premier e Competitivo)

- Cadastro por **SteamID64** (17 dígitos ou URL `/profiles/<id>`), com apelido opcional, sem exigir jogo aberto, GSI local, FACEIT ou senha Steam.
- Suporte a duas formas de acompanhamento:
  1. **Autorização oficial de partidas da Steam (`STEAM_API_KEY` + `authCode` `AAAA-AAAAA-AAAA` + `knownCode` `CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`):** percorre `ICSGOPlayers_730/GetNextMatchSharingCode/v1` até `HTTP 202` / `"n/a"` e permite atualizar os códigos depois via `PATCH /api/players/:id` (modal **Código Steam**).
  2. **Apenas `SteamID64`:** consulta `/v3/profile/matches?steam64_id=...` quando o jogador possui histórico público no Leetify.
- **Decisão técnica sobre `GetNextMatchSharingCode` e demos `.dem`:** a API da Valve devolve apenas códigos base57 `CSGO-...` (`matchId`, `reservationId`, `tvPort`), sem placar, mapa, estatísticas nem link de download da demo `.dem`. Obter a URL do `.dem.bz2` direto na Valve exige login em conta de usuário Steam + conexão ao Game Coordinator (`appid 730`), o que exigiria credenciais de conta Steam e download/parsing pesado. A solução validada combina `GetNextMatchSharingCode` com a API pública do **Leetify** (`https://api-public.cs-prod.leetify.com`, `LEETIFY_API_KEY` opcional), que já processa as demos `.dem` oficiais da Valve (`/v2/matches/matchmaking/{shareCode}`) para **Premier** (`matchmaking`) e **Competitivo** (`matchmaking_competitive`).
- Fontes fora do escopo (`faceit`, Wingman, HLTV etc.) são ignoradas na normalização.
- Estatísticas coletadas no CS2: mapa (`de_mirage` → `Mirage`), placar (`13 x 11`, `12 x 12` etc.), resultado (`VITÓRIA 🟢`, `DERROTA 🔴`, `EMPATE 🟡`), kills, deaths, assists, KDA, ADR (`dpr`), dano total, rounds, MVPs e percentual de headshots. Campos opcionais ausentes retornam `null` e renderizam `N/A`, sem estimar valores inexistentes.
- **Case-sensitivity do código `CSGO-...`:** o alfabeto base57 da Valve diferencia maiúsculas e minúsculas; apenas o prefixo `CSGO-` é normalizado em maiúsculas, e o decodificador puro em `src/cs2.js` valida os 18 bytes antes de consultar a API.
- **Proteção contra bloqueio `503` da Valve e demos pendentes:** respostas `403`/`412` em `GetNextMatchSharingCode` ficam em cache (`invalidShareAuth`) até os códigos mudarem. Quando uma partida recém-detectada na Steam ainda não teve a demo `.dem` indexada (`404`/`5xx` no Leetify), o monitor mantém o cursor e aguarda por até 45 minutos (`pendingGraceMs`) antes de avançar, evitando perder a partida ou travar a fila indefinidamente se a demo expirar na Valve.
- Atribuição exigida pelo provedor incluída na aba e no diálogo de detalhes do CS2 (`Data Provided by Leetify` + link `View on Leetify` quando há `leetifyMatchId`).
- Segredos protegidos: `STEAM_API_KEY`, `LEETIFY_API_KEY`, `authCode` e `knownCode` nunca vão para `/api/state` (que expõe apenas `hasShareAuth`) e estão na lista `redact` do Pino em `src/server.js`.

### Rainbow Six Siege (10/11/2026)

- Fonte: API da **stats.cc** (`https://api.stats.cc/siege`, OpenAPI v3.27.0), chave `STATS_CC_API_KEY` no header `x-api-key`, escopos `profiles` + `matches`. A stats.cc liberou o acesso gratuito para o grupo privado com estas condições: **crédito "Data by Stats.cc" nos resumos**, **respeitar perfis ocultos**, **chave só no servidor**, **sem scraping/backfill** (só partidas recentes), seguir os cabeçalhos de limite.
- Decisões do usuário: playlists `ranked` (Ranqueada), `unranked` (Padrão) e `legend-division` (Legend Division); elogio só com **KDA ≥ 4 e vitória** (`R6_PRAISE_MIN_KDA`), frases ácidas; **só polling**, sem `POST /update`; crédito como **rodapé fixo automático** (`R6_CREDIT = '📊 Data by Stats.cc'`) em toda mensagem do R6 e no resumo semanal do R6, fora do editor.
- `src/r6.js`: `R6Client` (cadastro por plataforma + nick → `profile_id` UUID; `unknown_profile` tenta de novo uma vez após 4 s; `hidden_profile` com mensagem clara; `403 missing_scope`; `429`/`503` com `retryAfterMs`; `RateLimit-Remaining: 0` bloqueia até `RateLimit-Reset`). `/v2/config` (sem chave) com cache de 12 h para plataformas, mapas e ranks; sem config, slugs viram nomes legíveis. `newMatches` usa `after=<último id>` e pagina só para frente (nunca `before`). Item malformado é pulado sem travar os outros.
- Normalização: resultado `win`/`loss`/`draw`, com `outcome` original (`abandon`, `surrender`, `forfeit` contam como derrota); cancelamentos (`*-cancel`, `end_reason: canceled`) e outras playlists são ignorados. Placar pelo índice `team` em `scores`. HS% = headshots ÷ kills. Rank/pontos só em ranqueadas (`ranked_session`/`legend_session`); ausente → `N/A`.
- Monitor: `checkR6Player` avança o cursor partida a partida; `hidden_profile` durante o polling **pausa o player** (segura envios pendentes). Limite da stats.cc só pula os players de R6 no ciclo.
- Store: `identity = r6:<profile_id>` (sem mudar schema); config em `game_message_config` (`INSERT OR IGNORE`). Motor comum ganhou a opção `footer` em `createMessageEngine`.
- Rotas: `GET /api/r6/platforms`; `POST /api/players` com `game: 'r6', platform, username`; `/api/state` expõe `games.r6` e `r6Configured`. Interface: 3º botão (badge **R6**), select de plataforma vindo do config, aviso de chave ausente e crédito "Data by Stats.cc" no rodapé.

Variáveis do R6:

```text
jogo, modo, resultado, resultado_emoji, player, nick, plataforma, mapa, placar,
frag, kills, deaths, assists, kda, rounds, hs, aberturas, clutches, rank, pontos,
data, partida_id, zoeira
```

### Resumo semanal (09/11/2026)

- Pedido do usuário: todo domingo, contar vitórias e derrotas e mandar zoeira ou quase elogio; **elogio só em casos raros**.
- `src/weekly.js`: janela semanal no fuso `America/Sao_Paulo` (padrão domingo 21h, `weeklyDay`/`weeklyHour` nas configurações, `weeklyEnabled` padrão `true`). Semanas contíguas: (agendamento anterior, agendamento atual]. Chave da semana = data local do envio (`2026-11-08`).
- Conta partidas pela **data de detecção** (`createdAt` do payload em `matches`), não pelo `endedAt`, para não perder nem duplicar partidas detectadas depois do horário (demo do CS2 atrasada).
- Faixas: sumido (< 3 partidas), bagre (< 40%), mediano (40–54%), obrigação (≥ 55%), elogio contido (≥ 70% **e** ≥ 15 partidas **e** KDA da semana ≥ 3,0; endurecido a pedido do usuário). Taxa ignora empates; KDA da semana soma tudo antes de dividir. Limites em `WEEKLY_RULES`.
- Frases padrão mais ácidas (v2, 09/11/2026). `WEEKLY_CONFIG_V1` fica só como snapshot: na inicialização, se `weekly_config` for exatamente a v1, vira a v2; qualquer edição do usuário é preservada.
- Uma mensagem por jogo com ranking (🥇🥈🥉, depois 4º…; sumidos com 💤 no fim), destaque e bagre (este só com 2+ jogadores ativos). Frase escolhida de forma determinística por semana e jogador.
- Persistência aditiva: tabelas `weekly_config` (modelo, linhas e frases compartilhados entre LoL e CS2) e `weekly_reports` (`UNIQUE(game, week_key)`, status `pending`/`sent`/`failed`/`skipped`). Semana sem partidas vira `skipped` e não envia.
- **Destaque e bagre com motivo (10/11/2026, a pedido do usuário):** linha mostra partidas, placar, taxa e KDA da semana. Ranking, destaque e bagre usam `weeklyScore` = taxa/2 + min(KDA, 4)/4/2 (empate-only = 50%), para que um jogador com mais derrotas e KDA alto possa ser destaque. `highlightReason` define 4 casos para cada um (vitórias ≥ 50% × KDA ≥ 1): `destaque_completo`, `destaque_kda`, `destaque_carregado`, `destaque_menos_pior`, `bagre_lanterna`, `bagre_derrotas`, `bagre_carona`, `bagre_completo`, com frases ácidas editáveis no mesmo `phrases` do `weekly_config` (abas extras no editor via `phraseGroups`). Variáveis novas: `destaque_motivo`, `destaque_resumo`, `bagre_motivo`, `bagre_resumo`. `upgradeWeeklyConfig`: v1/v2 nunca editadas viram a v3; configuração editada só ganha as frases que faltam.
- `Monitor.generateWeeklyReports()` roda em cada ciclo (monitor ativo), até 24h após o horário; `deliverWeeklyReports()` envia depois das partidas, com até 5 tentativas e ID de mensagem estável. Jogadores pausados ficam fora do resumo.
- Rotas: `GET /api/weekly`, `GET /api/weekly/defaults`, `PUT /api/weekly/settings`, `PUT /api/weekly/config`, `POST /api/weekly/preview` (`current`/`last`/`example`, nunca envia), `POST /api/weekly/reports/:id/retry`.
- Interface: seção **Resumo semanal** (`public/weekly.js`) com liga/desliga, dia e hora, faixas, editor com variáveis clicáveis, prévia pela aba ativa e histórico de resumos.
- **Visual (10/11/2026, a pedido do usuário):** tema roxo (o usuário gosta de roxo) e layout reorganizado em menu lateral com seções separadas — Painel (contadores, monitor, últimas partidas, amostra), Players, Mensagens, Resumo semanal e WhatsApp. Vitória/conexão continuam em verde e derrota em vermelho. Abaixo de 1180px o menu vai para o topo com rolagem horizontal. O modo "Ampliar" do editor torna inerte tudo fora do estúdio em qualquer nível (`setFocusMode` em `public/messages.js`). Textos pequenos foram aumentados para leitura.

## Editor de mensagens (motor comum em `src/message.js`)

- Motor reutilizável `createMessageEngine(profile)` compartilhado entre `lolMessages` (`src/message.js`) e `cs2Messages` (`src/cs2-message.js`), mantendo 100% das exportações originais do LoL compatíveis.
- **League of Legends:** **22 variáveis**, três modelos completos e 28 frases iniciais em quatro grupos: zoeira (`feed`), obrigação (`normal`), elogio (`carry`) e elogio ao suporte (`support`).
- **Counter-Strike 2:** **21 variáveis**, três modelos completos e 22 frases iniciais em três grupos: zoeira (`feed`), obrigação (`normal`) e elogio (`carry`).
- Até dez modelos por jogo; é necessário manter ao menos um ativo. A escolha de modelo/frase é determinística por partida.
- Criar, duplicar, renomear, ativar, remover e editar modelos; frases com uma por linha.
- Campos com busca, filtros por grupo, valores de exemplo/da prévia e inserção por clique ou arrastar.
- Editor em três colunas: campos, texto e prévia com aparência de conversa do WhatsApp.
- Rascunhos independentes por aba em `public/messages.js`: alternar entre LoL e CS2 preserva edições não salvas na memória da página.
- Prévia do rascunho com exemplos ou partidas salvas do próprio jogo: **não consulta APIs externas, não grava partidas e não envia mensagens**.
- Texto e frases aceitam substituições simples (`{{mapa}}`, `{{lane}}`); não executam JavaScript nem expressões do n8n. A interpolação ocorre uma única vez e valida tamanho máximo antes de salvar.

Variáveis do LoL:

```text
jogo, modo, resultado, resultado_emoji, player, nick, tag, frag,
kills, deaths, assists, kda, personagem, farm, lane, gold, gold_bruto,
duracao, duracao_segundos, data, partida_id, zoeira
```

Variáveis do CS2:

```text
jogo, modo, resultado, resultado_emoji, player, nick, frag,
kills, deaths, assists, kda, mapa, placar, adr, dano,
rounds, mvps, hs, data, partida_id, zoeira
```

No LoL, `{{modo}}` usa primeiro `queueId`, diferenciando Ranqueada Solo/Duo, Flex, Normal, ARAM e outras filas conhecidas, com fallback para registros antigos. No CS2, `{{modo}}` exibe `Premier` ou `Competitivo`.

### Seleção de frases pelo KDA

- O cálculo único nos dois jogos é `(abates + assistências) / máximo(1, mortes)`, por partida, sem arredondar na comparação de limites:
  - **KDA < 1:** `feed`, zoeira.
  - **KDA ≥ 1 sem elogio:** `normal`, obrigação. O padrão começa com “NÃO FEZ MAIS QUE A OBRIGAÇÃO”.
  - **Elogio (`carry`) endurecido em 10/11/2026 a pedido do usuário:** LoL exige KDA ≥ 4 **e** vitória (`LOL_PRAISE_MIN_KDA`); CS2 exige KDA ≥ 3 **e** vitória (`CS2_PRAISE_MIN_KDA`). Derrota ou empate com KDA alto cai em `normal`. No LoL, na lane `SUP`, usa `support` com o mesmo limite.
- Frases padrão mais ácidas e em maior número (10/11/2026): LoL 51 (feed 15, carry 12, support 10, normal 14) e CS2 39 (feed 14, normal 13, carry 12). Snapshots antigos ficam em `LOL_PHRASES_KDA_V1`, `LEGACY_PHRASE_POOLS` e `CS2_PHRASES_V1`, expostos por `previousPhrasePools()`. A migração única `message-acid-phrases-v1` troca só categorias idênticas a um snapshot, em cada jogo, e pula a categoria se a validação de tamanho falhar.
- O valor exibido tem duas casas decimais em pt-BR. Prévias retornam `performance` com KDA numérico, faixa, rótulo e intervalo.

## Regras de preservação importantes

- **Migração aditiva multi-jogo em `src/store.js`:** adiciona `game TEXT NOT NULL DEFAULT 'lol'` em `players` e `matches`, cria o índice `matches_by_game` e a tabela `game_message_config` para jogos novos (`cs2`), mantendo os modelos de LoL intactos na tabela original `message_config`.
- Cada entrada da fila guarda o texto e o grupo de destino no momento em que a partida é detectada.
- Editar mensagens ou trocar o grupo afeta as próximas entradas; não reescrever mensagens já na fila.
- Pausar o monitor impede novas consultas/envios, mas um envio já iniciado pode terminar.
- Pausar um jogador segura seus envios; reativá-lo pode recuperar partidas do período pausado.
- Remover um jogador cancela seus envios pendentes e preserva o histórico.
- As migrações `message-presets-mode-v1` e `message-kda-bands-v1` do LoL rodam uma única vez e preservam textos personalizados, ativações, frases editadas e mensagens na fila.
- Encerrar o processo preserva a sessão do WhatsApp. Desconectar pela interface encerra a sessão e pausa o monitor.
- Baileys é uma integração **não oficial**, atualmente fixada em `7.0.0-rc14`. Não há garantia de entrega exatamente uma vez após falhas de rede/processo.

## Mapa do código

| Arquivo | Responsabilidade |
| --- | --- |
| `src/server.js` | Inicialização, ambiente, redaction de segredos, sessão existente e encerramento |
| `src/app.js` | Rotas HTTP multi-jogo, validação, autenticação opcional e prévias |
| `src/games.js` | Registro dos jogos suportados (`lol`, `cs2` e `r6`) e campos de prévia |
| `src/http.js` | Utilitários compartilhados (`nonempty`, `number`, `retryDelay`) |
| `src/riot.js` | API Riot, autenticação, limites e normalização (LoL) |
| `src/game-mode.js` | Rótulos de filas/modos do LoL com fallback para registros antigos |
| `src/cs2.js` | Steam Web API (`GetPlayerSummaries`, `GetNextMatchSharingCode`), decodificador base57 `CSGO-...`, Leetify e normalização (CS2) |
| `src/message.js` | Motor comum `createMessageEngine` + variáveis, modelos, frases e classificação do LoL |
| `src/cs2-message.js` | Variáveis, modelos, frases, faixas de KDA, `mapLabel` e prévias do CS2 |
| `src/r6.js` | Cliente da stats.cc (perfil, histórico com `after`, config em cache, limites) e normalização (R6) |
| `src/r6-message.js` | Variáveis, modelos, frases, crédito `R6_CREDIT` e prévias do R6 |
| `src/monitor.js` | Polling multi-jogo (`lol`, `cs2` e `r6`), espera de demo `.dem` e envio da fila |
| `src/store.js` | SQLite, configurações, migrações aditivas, modelos por jogo, jogadores e fila |
| `src/whatsapp.js` | Baileys, QR, grupos, reconexão e sessão |
| `src/weekly.js` | Janela semanal no fuso de São Paulo, faixas, ranking e mensagem do resumo semanal |
| `public/app.js` | Abas de jogo, dashboard, jogadores, modal de código Steam, WhatsApp e histórico |
| `public/messages.js` | Editor por jogo, rascunhos isolados por aba, busca, inserção e prévia |
| `public/weekly.js` | Seção do resumo semanal: agenda, editor, prévia e histórico |
| `public/nav.js` | Navegação por seções via hash (`#painel`, `#players`, `#mensagens`, `#resumo-semanal`, `#whatsapp`; `#setup` vira painel) e espelho dos status do monitor/WhatsApp no menu |
| `public/index.html`, `public/style.css` | Estrutura e apresentação da interface |
| `test/` | Testes offline de domínio, HTTP, CS2, monitor, sessão e migrações |

## Operação e problema já resolvido

O volume `gg-data` guarda banco, configurações e autenticação do WhatsApp. Não apagar nem substituir os dados para atualizar a aplicação.

**`docker compose restart` não recarrega o `.env`.** Aplicar alterações de chaves (`RIOT_API_KEY`, `STEAM_API_KEY`, `LEETIFY_API_KEY`, `STATS_CC_API_KEY`, `APP_PASSWORD`) com:

```powershell
docker compose up -d --force-recreate
```

Para atualizar código e interface:

```powershell
docker compose up -d --build --wait
```

Credenciais ficam no ambiente (ou protegidas no SQLite no caso de `authCode`/`knownCode`), nunca expostas no frontend. `APP_PASSWORD` oferece HTTP Basic opcional com usuário `admin`.

## Validação conhecida

- Resumo semanal com motivos (10/11/2026): **114 testes passando** (nota, oito motivos, destaque com mais derrotas pelo KDA, migração aditiva do modelo salvo); editor verificado no navegador.
- Rainbow Six Siege (10/11/2026): **112 testes passando** (13 novos em `test/r6*.test.js` com `fetch` simulado: perfil, histórico, 404 `unknown_profile`/`hidden_profile`, 403 `missing_scope`, 401, 429/`Retry-After`, `RateLimit-Remaining`, 503, empate/abandono, playlists ignoradas, deduplicação após reinício, isolamento LoL × R6 e migração). `npm run check` passou; aba R6 verificada no navegador (desktop 1400px e celular 390px sem rolagem horizontal) numa instância local isolada sem chave.

- Frases por partida (10/11/2026): 99 testes passando, incluindo `test/phrases-migration.test.js`.
- Resumo semanal (09/11/2026): **99 testes passando** (9 novos em `test/weekly.test.js`: janela e fuso, faixas e raridade do elogio, empates, ranking, validação, envio único por semana, tolerância de 24h, reenvio e rotas). `npm run check` passou; seção verificada em Chrome headless (desktop 1400px e celular 390px, sem rolagem horizontal).

- Entrega atual (LoL + CS2): **89 testes passando** tanto no Windows quanto dentro do container Linux (`node:24-bookworm-slim`), cobrindo LoL, decodificação base57 `CSGO-...`, `GetNextMatchSharingCode`, espera de demo `.dem`, empates, `N/A` sem inventar dados, isolamento entre abas/rotas, deduplicação após reinício e migração aditiva do SQLite preservando dados anteriores.
- `npm run check` passou; container reconstruído com `gg-data` preservado, healthcheck saudável (`healthy`) e imagem de produção verificada por HTTP em ambiente isolado.
- Interações do editor e alternância entre as abas LoL e CS2 verificadas em DOM simulado (incluindo preservação de rascunhos por aba, modal de código Steam, empate e link do Leetify).
- Testes usam integrações simuladas. Não enviar mensagens reais nem consultar contas reais como parte de testes automáticos.

## Expansão para outros jogos e pendências

**League of Legends**, **Counter-Strike 2 (Premier e Competitivo)** e **Rainbow Six Siege (stats.cc)** estão implementados. Outros candidatos anteriormente pesquisados (Dota 2/OpenDota, Deadlock, FC) seguem apenas como referência e dependem de pedido explícito do usuário e revalidação de API.

Consulte [MELHORIAS.md](MELHORIAS.md) antes de definir novas prioridades. Os itens pendentes (como M-001 sobre jogadores pausados no limite de 20 entregas e M-002 sobre desconexão durante lote de envio) não devem ser implementados sem solicitação explícita.

## Orientação para próximas alterações

- Preservar a arquitetura leve, as configurações existentes e os rascunhos/textos personalizados de ambos os jogos.
- Nunca registrar ou versionar `.env`, tokens, códigos de autenticação Steam, QR Codes, banco, sessão do WhatsApp ou dados pessoais da instalação.
- Manter `.env`, `data/`, `.qa/` e `node_modules/` fora do Git; `.env.example` deve conter apenas exemplos sem segredos.
- Antes de concluir uma alteração, executar os testes relevantes e `npm run check`; mudanças funcionais devem ser verificadas no Docker.
- Atualizar README e esta memória quando o comportamento ou a operação mudarem.
- Usar commits semânticos, por exemplo `feat(cs2): ...`, `feat(messages): ...`, `fix(monitor): ...` e `docs: ...`.
- Separar commits por mudança coerente, sem inventar uma cronologia que não esteja no histórico Git.
- Verificar branch, remoto e conteúdo a publicar antes do push. Não sobrescrever histórico remoto com force push.
