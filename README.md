# GG Report

Partidas de **League of Legends** e **Counter-Strike 2 (Premier e Competitivo)** viram um resumo com estatísticas e zoeira no grupo do WhatsApp. Projeto pessoal leve: **Node.js 24 + SQLite + HTML/CSS/JavaScript**, em **um container**. Sem Java, Chromium, Redis, banco separado ou serviço de IA.

Documentação do desenvolvimento: [memória do projeto](IA_MEMORY.md), [melhorias sugeridas](MELHORIAS.md) e [instruções para agentes](AGENTS.md).

## Rodar com Docker

Pré-requisito: Docker com Compose (por exemplo, Docker Desktop).

```powershell
Copy-Item .env.example .env
```

Edite `.env` e preencha as credenciais dos jogos que deseja monitorar:

- **`RIOT_API_KEY`** (League of Legends): obtenha no [portal da Riot](https://developer.riotgames.com/). As [chaves de desenvolvimento expiram a cada 24 horas](https://support-developer.riotgames.com/hc/en-us/articles/22698431229203-Developer-Portal-Overview); para uso contínuo, solicite a modalidade adequada no portal.
- **`STEAM_API_KEY`** (Counter-Strike 2): obtenha na [Steam Web API](https://steamcommunity.com/dev/apikey). Resolve perfis por `SteamID64` e consulta novos códigos de partida pela Valve (`GetNextMatchSharingCode`).
- **`LEETIFY_API_KEY`** (opcional, Counter-Strike 2): obtenha em [Leetify Developers](https://leetify.com/app/developer) para ampliar o limite de consultas das estatísticas extraídas das demos `.dem`.

```powershell
docker compose up -d --build
```

Abra **http://localhost:3000**. Sem chaves, a interface e as prévias funcionam normalmente; o cadastro real e o monitor dependem da credencial do respectivo jogo.

1. Escolha a aba **League of Legends** ou **Counter-Strike 2**:
   - **LoL:** cadastre o nick e a tag separadamente (`SeuAmigo` e `BR1`). Para o servidor brasileiro, use **Américas**.
   - **CS2:** informe o **SteamID64** de 17 dígitos (ou a URL `https://steamcommunity.com/profiles/...`) e, opcionalmente, a autorização de partidas da Steam (veja abaixo).
2. Clique em **Conectar WhatsApp**. No celular, abra **Aparelhos conectados → Conectar aparelho** e leia o QR Code.
3. Atualize a lista de grupos, selecione o destino e salve (a conexão e o grupo são compartilhados entre os dois jogos).
4. Ajuste o intervalo de consulta (padrão: 120 segundos; mínimo: 30).
5. Ative o monitor. Agora partidas novas de LoL e CS2 são consultadas e enviadas automaticamente.

O monitor começa pausado. As prévias do painel e do editor são locais: **não gravam partidas nem enviam mensagens**. Nenhuma conta ou chave vem cadastrada.

Após alterar qualquer chave ou variável do `.env`, recrie o container para aplicar:

```powershell
docker compose up -d --force-recreate
```

O Docker lê o `.env` ao criar o container. `docker compose restart` mantém as variáveis antigas; use o comando acima para carregar chaves novas. O volume `gg-data` com jogadores, histórico, modelos personalizados e sessão do WhatsApp é preservado.

## Exemplos de mensagem

League of Legends:

```text
🎮 Jogo: LOL
Resultado: DERROTA 🔴
Modo: Ranqueada Solo/Duo
Player: SeuAmigo#BR1
Frag: 1/5/9
KDA: 2,00
Personagem: Yasuo
Farm: 124 CS
Lane: MID
GOLD: 10.000

NÃO FEZ MAIS QUE A OBRIGAÇÃO
```

Counter-Strike 2:

```text
🎮 Jogo: CS2
Modo: Premier
Resultado: VITÓRIA 🟢
Mapa: Mirage
Placar: 13 x 11
Player: SeuAmigo
Frag: 15/14/4
KDA: 1,36
ADR: 78,2

NÃO FEZ MAIS QUE A OBRIGAÇÃO
```

O KDA decide se o comentário será zoeira, obrigação ou elogio moderado. Você pode editar as frases e os textos de cada jogo separadamente pela interface; não há custo de IA. A classificação é uma brincadeira baseada no placar da partida, e não uma avaliação completa do desempenho.

## Counter-Strike 2: detecção pela Steam e limites da Valve

O monitoramento de CS2 acompanha exclusivamente partidas oficiais **Premier** e **Competitivo** da Valve, sem depender de o jogo estar aberto, de Game State Integration (GSI) local, de FACEIT ou de senha da conta Steam.

### Formas de cadastrar um jogador

1. **Com autorização oficial da Steam (recomendado):** informe o `SteamID64`, o **Código de autenticação da partida** (`AAAA-AAAAA-AAAA`) e o **Código de uma partida recente** (`CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`). Ambos são gerados pelo próprio jogador na [página oficial de dados pessoais do CS2 na Steam](https://help.steampowered.com/pt-br/wizard/HelpWithGameIssue/?appid=730&issueid=128) (*Authentication Codes* / *Match Sharing Codes*) — são códigos somente de leitura de histórico e **nunca pedem login ou senha da Steam**. Você também pode adicioná-los ou atualizá-los depois pelo botão **Código Steam** na lista de jogadores.
2. **Somente pelo `SteamID64`:** se os campos de código ficarem em branco, o cadastro consulta diretamente o histórico público do jogador no [Leetify](https://leetify.com/) (requer que a conta tenha partidas públicas indexadas lá).

### Limitações da API da Valve e análise de demos `.dem`

- O endpoint oficial `ICSGOPlayers_730/GetNextMatchSharingCode/v1` da Steam Web API informa apenas o próximo código `CSGO-...` jogado pela conta (que codifica `matchId`, `reservationId` e `tvPort`), **sem retornar mapa, placar, resultado, K/D/A, ADR nem a URL da demo `.dem`**.
- Obter a URL do arquivo `.dem.bz2` diretamente na Valve exige autenticar uma conta Steam real (usuário, senha e Steam Guard) conectada ao *Game Coordinator* do CS2 (`appid 730`) e baixar dezenas de megabytes por partida — incompatível com a segurança (sem senha Steam) e com a proposta leve de um único container.
- Por isso, o GG Report usa `GetNextMatchSharingCode` para descobrir cada nova partida oficial na Steam e consulta a API pública do **Leetify** (`api-public.cs-prod.leetify.com`, Data Provided by Leetify) para ler as estatísticas já extraídas da demo `.dem`: **mapa, placar, vitória/derrota/empate, kills, deaths, assists, KDA, ADR, dano total, rounds, MVPs e % de headshots**.
- Partidas de FACEIT, Braço Direito (*Wingman*) ou outras fontes são ignoradas automaticamente.
- Como a análise da demo `.dem` pode levar alguns minutos após o fim da partida, códigos recém-detectados ficam aguardando consolidação sem avançar o cursor nem duplicar mensagens (após 45 minutos sem demo disponível na Valve, o cursor avança para não bloquear partidas seguintes).
- Nenhuma estatística é inventada ou estimada: caso algum campo opcional não venha na fonte, ele aparece como `N/A`.

## Montar mensagens com variáveis

Cada aba (**League of Legends** e **Counter-Strike 2**) tem seu próprio editor em **Mensagens**, com rascunho, modelos, frases e prévias independentes. Use campos entre chaves duplas, como `{{player}}`, `{{frag}}` e `{{modo}}`; os botões de variáveis inserem o campo na posição do cursor. Encontre os campos pela busca ou pelos grupos, escreva na área de texto ampliada e acompanhe a prévia ao lado.

- **League of Legends:** 22 variáveis (`jogo`, `modo`, `resultado`, `resultado_emoji`, `player`, `nick`, `tag`, `frag`, `kills`, `deaths`, `assists`, `kda`, `personagem`, `farm`, `lane`, `gold`, `gold_bruto`, `duracao`, `duracao_segundos`, `data`, `partida_id`, `zoeira`), três variações iniciais e 28 frases entre **Zoeira**, **Obrigação**, **Elogio** e **Elogio ao suporte**.
- **Counter-Strike 2:** 21 variáveis (`jogo`, `modo`, `resultado`, `resultado_emoji`, `player`, `nick`, `frag`, `kills`, `deaths`, `assists`, `kda`, `mapa`, `placar`, `adr`, `dano`, `rounds`, `mvps`, `hs`, `data`, `partida_id`, `zoeira`), três variações iniciais e 22 frases entre **Zoeira**, **Obrigação** e **Elogio**. Em empates (`12 x 12` no Competitivo ou `15 x 15` no Premier), `{{resultado}}` exibe `EMPATE` com `🟡`.

No LoL, `{{modo}}` usa primeiro a fila da partida ([lista de filas da Riot](https://static.developer.riotgames.com/docs/lol/queues.json)) e depois o modo bruto como alternativa, diferenciando **Ranqueada Solo/Duo**, **Ranqueada Flex**, **Normal** e **ARAM**. No CS2, `{{modo}}` distingue **Premier** e **Competitivo**, e `{{mapa}}` formata nomes internos como `de_mirage` para `Mirage`.

`{{kda}}` mostra **(abates + assistências) ÷ máximo(1, mortes)** nos dois jogos. Quando o jogador não morreu, o divisor é 1. O texto usa duas casas decimais; a seleção da frase considera o valor completo, antes de arredondar.

| KDA da partida | Comentário escolhido |
| --- | --- |
| Menor que 1 | Zoeira |
| De 1 até abaixo de 2,5 | Obrigação: “NÃO FEZ MAIS QUE A OBRIGAÇÃO” |
| A partir de 2,5 | Elogio moderado |

No LoL, jogadores da lane `SUP` na faixa positiva (`KDA ≥ 2,5`) usam as frases de **Elogio ao suporte**; por exemplo, `1/5/9` resulta em **2,00**, então recebe obrigação inclusive para suporte.

Edite as frases com **uma frase por linha**. Elas também aceitam variáveis; a variável `{{zoeira}}` pertence apenas ao modelo completo. Enquanto você escreve, a prévia usa o rascunho sem salvar e permanece preservada ao alternar entre as abas de LoL e CS2. **A prévia não consulta APIs externas, não grava partidas e não envia mensagens ao WhatsApp.**

Clique em **Salvar mensagens** para aplicar às próximas partidas detectadas do jogo selecionado. **Carregar modelos originais** apenas preenche o rascunho; salve se quiser aplicá-los. Mensagens que já estavam na fila mantêm o texto registrado quando foram criadas.

## Como funciona

- **League of Legends (Riot):** resolve `nick#tag` em PUUID por Account-v1, consulta Match-v5 e extrai resultado, campeão, kills/deaths/assists, CS (tropas + monstros neutros), lane e gold. [Documentação oficial](https://developer.riotgames.com/docs/lol).
- **Counter-Strike 2 (Steam + Leetify):** valida `SteamID64`, avança códigos `CSGO-...` via `GetNextMatchSharingCode` (ou consulta o histórico público por `SteamID64`) e coleta estatísticas de Premier e Competitivo processadas a partir das demos `.dem`. Nos detalhes do histórico, partidas com ID público exibem link direto para conferência no Leetify.
- **Partidas novas:** o cadastro marca o histórico atual como referência (baseline). Partidas encerradas antes do cadastro são ignoradas; partidas em andamento ou com demo ainda em processamento entram quando concluídas.
- **Persistência:** SQLite guarda jogadores, configurações, modelos por jogo, histórico e fila. A sessão do WhatsApp fica no mesmo volume Docker `gg-data`. Reiniciar ou reconstruir o container preserva todos os dados e evita notificações duplicadas.
- **Consulta:** percorre jogadores ativos em sequência, impede ciclos sobrepostos e isola limites `Retry-After` por jogo — um limite `429` da Riot não bloqueia consultas de CS2 nem a fila do WhatsApp, e códigos Steam inválidos (`403`/`412`) ficam em cache até serem corrigidos para evitar bloqueios `503` na Valve.
- **Envio:** uma entrada única por partida e jogador evita repetição nas consultas, inclusive após reiniciar o Docker. Falhas têm até cinco tentativas automáticas com espera crescente, além de botão para repetir manualmente.
- **Destino:** cada mensagem guarda o grupo selecionado quando a partida foi detectada. Trocar o grupo afeta as próximas partidas; mensagens já na fila mantêm o destino original.
- **Pausas:** pausar o monitor interrompe consultas e novos envios; envios já iniciados podem terminar. Pausar um jogador segura os envios dele; excluí-lo cancela seus envios pendentes e preserva o histórico.
- **WhatsApp offline:** partidas ficam na fila. Uma sessão salva tenta reconectar automaticamente; desconectar pela interface encerra a sessão e pausa o monitor.

A integração usa [Baileys](https://github.com/WhiskeySockets/Baileys), que se conecta ao WhatsApp Web por WebSocket, sem navegador. **É uma integração não oficial**, pode exigir novo QR Code ou ajustes quando o WhatsApp mudar e está sujeita às regras da plataforma. A dependência está fixada em `7.0.0-rc14`; atualizações devem ser testadas. O ID da mensagem é reutilizado nas tentativas para reduzir duplicação; não há garantia de entrega exatamente uma vez em falhas de rede ou queda entre envio e gravação local.

## Configuração e acesso

| Variável | Padrão | Uso |
| --- | --- | --- |
| `RIOT_API_KEY` | vazio | Credencial Riot para League of Legends; fica apenas no servidor |
| `STEAM_API_KEY` | vazio | Credencial Steam Web API para perfis e `GetNextMatchSharingCode` no CS2 |
| `LEETIFY_API_KEY` | vazio | Credencial opcional do Leetify para estatísticas de CS2 |
| `POLL_INTERVAL_SECONDS` | `120` | Intervalo inicial; a interface salva alterações no SQLite |
| `APP_PASSWORD` | vazio | Senha opcional HTTP Basic; usuário `admin` |
| `PORT` | `3000` | Porta ao executar sem Docker |
| `DATA_DIR` | `./data` | Diretório de dados sem Docker |

O Compose publica em `127.0.0.1:3000`, para acesso nesta máquina. Se for disponibilizar em rede, configure `APP_PASSWORD` e HTTPS por proxy. Chaves de API, PUUIDs e códigos de autenticação de partidas ficam restritos ao servidor e redigidos nos logs. A sessão do WhatsApp equivale a um aparelho conectado: trate o volume `gg-data` como privado. `.env` e dados locais estão ignorados no Git e no contexto de build do Docker.

## Operação

```powershell
docker compose ps
docker compose logs -f app
docker compose stop
docker compose start
```

`docker compose down` remove o container e mantém o volume. Adicionar `-v` apaga o banco e a sessão; use apenas para zerar a instalação. Para backup consistente, pare o container e faça uma cópia do volume `gg-data` antes de iniciar de novo.

## Desenvolvimento sem Docker

Com Node.js **24.13 ou superior, na linha 24**:

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

```powershell
npm test
npm run check
```

Os testes usam respostas simuladas da Riot, da Steam, do Leetify e do WhatsApp; não consomem chaves reais nem enviam mensagens. O SQLite é o módulo nativo `node:sqlite` do Node 24; dependendo da versão, o Node pode exibir um aviso de recurso experimental.

## Estrutura

```text
public/              Interface responsiva com abas LoL e CS2, sem build
public/messages.js   Editor de mensagens e prévias do rascunho por jogo
src/app.js           Rotas HTTP, validação e isolamento por jogo
src/server.js        Inicialização, redaction de logs e encerramento
src/games.js         Registro dos jogos suportados (lol e cs2)
src/http.js          Utilitários compartilhados de normalização e Retry-After
src/riot.js          Cliente da API Riot e normalização (LoL)
src/game-mode.js     Nomes de filas e modos de jogo (LoL)
src/cs2.js           Cliente Steam Web API + Leetify, códigos CSGO-... e normalização (CS2)
src/message.js       Motor comum de mensagens e perfil do League of Legends
src/cs2-message.js   Variáveis, modelos, faixas de KDA e prévias do Counter-Strike 2
src/monitor.js       Consultas periódicas multi-jogo e fila compartilhada
src/store.js         Persistência SQLite e migrações aditivas
src/whatsapp.js      QR Code, grupos e sessão Baileys
test/                Testes offline de domínio, HTTP, monitor, sessão e migrações
```

GG Report is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc. Counter-Strike and Steam are trademarks and/or registered trademarks of Valve Corporation. CS2 match statistics powered by Leetify (Data Provided by Leetify, https://leetify.com).
