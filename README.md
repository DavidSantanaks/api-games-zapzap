# GG Report

Partidas de LoL viram um resumo com zoeira no grupo do WhatsApp. Projeto pessoal leve: **Node.js 24 + SQLite + HTML/CSS/JavaScript**, em **um container**. Sem Java, Chromium, Redis, banco separado ou serviço de IA.

Documentação do desenvolvimento: [memória do projeto](IA_MEMORY.md), [melhorias sugeridas](MELHORIAS.md) e [instruções para agentes](AGENTS.md).

## Rodar com Docker

Pré-requisito: Docker com Compose (por exemplo, Docker Desktop).

```powershell
Copy-Item .env.example .env
```

Edite `.env` e preencha `RIOT_API_KEY`. Obtenha a chave no [portal da Riot](https://developer.riotgames.com/). As [chaves de desenvolvimento expiram a cada 24 horas](https://support-developer.riotgames.com/hc/en-us/articles/22698431229203-Developer-Portal-Overview); para uso contínuo, solicite a modalidade adequada no portal.

```powershell
docker compose up -d --build
```

Abra **http://localhost:3000**. Sem chave, a interface e as prévias funcionam; o cadastro real e o monitor dependem da chave.

1. Cadastre o nick e a tag separadamente: `SeuAmigo` e `BR1`. Para o servidor brasileiro, use **Américas**.
2. Clique em **Conectar WhatsApp**. No celular, abra **Aparelhos conectados → Conectar aparelho** e leia o QR Code.
3. Atualize a lista de grupos, selecione o destino e salve.
4. Ajuste o intervalo de consulta (padrão: 120 segundos; mínimo: 30).
5. Ative o monitor. Agora partidas novas são consultadas e enviadas automaticamente.

O monitor começa pausado. As prévias de zoeira, obrigação, elogio e suporte são locais: **não gravam partidas nem enviam mensagens**. Nenhuma conta ou chave vem cadastrada.

Após alterar a chave ou outra variável do `.env`, recrie o container para aplicar:

```powershell
docker compose up -d --force-recreate
```

O Docker lê o `.env` ao criar o container. `docker compose restart` mantém as variáveis antigas; use o comando acima para carregar uma chave nova. O volume com jogadores, histórico e sessão do WhatsApp é preservado.

## Exemplo de mensagem

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

O KDA decide se o comentário será zoeira, obrigação ou elogio moderado. Você pode editar as frases e os textos pela interface; não há custo de IA. A classificação é uma brincadeira baseada no placar da partida, e não uma avaliação completa do desempenho.

## Montar mensagens com variáveis

Abra **Mensagens** na interface para editar o texto que o bot envia. Use campos entre chaves duplas, como `{{player}}`, `{{frag}}`, `{{lane}}` e `{{modo}}`; os botões de variáveis inserem o campo na posição do cursor. Encontre os campos pela busca ou pelos grupos, escreva na área de texto ampliada e acompanhe a prévia ao lado. As frases de zoeira ficam em uma seção própria, que pode ser recolhida durante a edição do texto.

```text
🎮 {{jogo}} · {{resultado}} {{resultado_emoji}}
Modo: {{modo}}
{{player}} jogou de {{personagem}} na {{lane}}
Frag: {{frag}} · Farm: {{farm}} · Gold: {{gold}}
KDA: {{kda}}
Tempo de jogo: {{duracao}}

{{zoeira}}
```

O editor já vem com três variações de mensagem completa e 28 frases distribuídas entre **Zoeira**, **Obrigação**, **Elogio** e **Elogio ao suporte**. Você pode criar, duplicar, renomear e editar variações, e marcar quais ficam ativas. Pelo menos uma precisa estar ativa. Entre as ativas, o bot seleciona uma variação e uma frase da categoria para cada partida; a escolha fica estável nas novas tentativas de envio.

`{{modo}}` mostra um nome legível, como **Ranqueada Solo/Duo**, **Ranqueada Flex** ou **ARAM**. O sistema usa primeiro a fila da partida e depois o modo informado pela Riot como alternativa; assim, `CLASSIC` não faz uma ranqueada aparecer como apenas “clássico”. Os identificadores seguem a [lista de filas da Riot](https://static.developer.riotgames.com/docs/lol/queues.json). Partidas antigas que já guardam o identificador da fila também podem preencher o campo.

`{{kda}}` mostra **(abates + assistências) ÷ máximo(1, mortes)**, calculado por partida. Quando o jogador não morreu, o divisor é 1. O texto usa duas casas decimais; a seleção da frase considera o valor completo, antes de arredondar.

| KDA da partida | Comentário escolhido |
| --- | --- |
| Menor que 1 | Zoeira |
| De 1 até abaixo de 2,5 | Obrigação: “NÃO FEZ MAIS QUE A OBRIGAÇÃO” |
| A partir de 2,5 | Elogio moderado |

Assistências entram no cálculo de todas as posições. Na faixa positiva, jogadores da lane `SUP` usam as frases de **Elogio ao suporte**; essa categoria não muda os limites de KDA. Por exemplo, `1/5/9` resulta em **2,00**, então recebe uma frase de obrigação, inclusive para suporte.

Edite as frases com **uma frase por linha**. Elas também aceitam variáveis; por exemplo, `{{nick}}, terminou {{frag}} de {{personagem}}? KKKKK`. A variável `{{zoeira}}` pertence ao texto completo e insere a frase escolhida; não pode ser usada dentro das próprias frases.

Enquanto você escreve, a prévia usa o rascunho sem salvar. Escolha entre os quatro exemplos de desempenho ou uma partida já existente no histórico para conferir os valores reais registrados. **A prévia não consulta a Riot nem envia mensagens ao WhatsApp.** Campos desconhecidos e expressões inválidas aparecem como erro para você corrigir antes de salvar. As variáveis são substituições simples de texto; não executam JavaScript nem expressões do n8n.

Clique em **Salvar mensagens** para aplicar às próximas partidas detectadas. **Carregar modelos originais** apenas carrega os modelos no rascunho; salve se quiser aplicá-los. As alterações ficam no SQLite e continuam após reiniciar o container. Mensagens que já estavam na fila mantêm o texto registrado quando foram criadas.

Ao atualizar esta versão, somente as listas de frases que ainda correspondem exatamente aos padrões antigos são adaptadas aos novos tons de KDA. Frases personalizadas são preservadas. A atualização não reescreve o texto de mensagens já na fila.

## Como funciona

- **Riot:** resolve `nick#tag` em PUUID por Account-v1, consulta Match-v5 e extrai resultado, campeão, kills/deaths/assists, CS, lane e gold. CS soma tropas e monstros neutros. A região corresponde ao servidor onde a partida foi jogada. [Documentação oficial](https://developer.riotgames.com/docs/lol).
- **Partidas novas:** o cadastro marca o histórico atual como referência. Partidas já encerradas antes do cadastro são ignoradas; uma partida em andamento pode ser detectada quando terminar. Partidas customizadas são ignoradas nesta versão.
- **Persistência:** SQLite guarda jogadores, configurações, histórico e fila. A sessão do WhatsApp fica no mesmo volume Docker `gg-data`. Reiniciar ou reconstruir o container preserva esses dados.
- **Consulta:** percorre jogadores em sequência, impede ciclos sobrepostos, pagina o histórico após períodos offline e respeita o tempo de espera indicado por respostas 429 da Riot. A API pode demorar a disponibilizar uma partida encerrada.
- **Envio:** uma entrada por partida e jogador evita repetição nas consultas, inclusive após reinício. Falhas têm até cinco tentativas, com espera crescente. O botão de repetir permite uma nova rodada de tentativas.
- **Destino:** cada mensagem guarda o grupo selecionado quando a partida foi detectada. Trocar o grupo afeta as próximas partidas; mensagens já na fila mantêm o destino original.
- **Pausas:** pausar o monitor interrompe consultas e novos envios; envios já iniciados podem terminar. Pausar um jogador segura os envios dele; ao reativá-lo, partidas do período pausado podem entrar na fila. Excluir o jogador cancela seus envios pendentes e preserva o histórico.
- **WhatsApp offline:** partidas ficam na fila. Uma sessão salva tenta reconectar automaticamente; depois de logout, conecte novamente pela interface. Desconectar pela interface também pausa o monitor.

A integração usa [Baileys](https://github.com/WhiskeySockets/Baileys), que se conecta ao WhatsApp Web por WebSocket, sem navegador. **É uma integração não oficial**, pode exigir novo QR Code ou ajustes quando o WhatsApp mudar e está sujeita às regras da plataforma. A dependência está fixada em `7.0.0-rc14`; atualizações devem ser testadas. Use com seu grupo ciente dos avisos automáticos. Uma confirmação de envio indica aceitação pelo serviço, não leitura de cada integrante. O ID da mensagem é reutilizado nas tentativas para reduzir duplicação; não há garantia de entrega exatamente uma vez em falhas de rede ou queda entre envio e gravação local.

## Configuração e acesso

| Variável | Padrão | Uso |
| --- | --- | --- |
| `RIOT_API_KEY` | vazio | Credencial Riot; fica apenas no servidor |
| `POLL_INTERVAL_SECONDS` | `120` | Intervalo inicial; a interface salva alterações no SQLite |
| `APP_PASSWORD` | vazio | Senha opcional HTTP Basic; usuário `admin` |
| `PORT` | `3000` | Porta ao executar sem Docker |
| `DATA_DIR` | `./data` | Diretório de dados sem Docker |

O Compose publica em `127.0.0.1:3000`, para acesso nesta máquina. Se for disponibilizar em rede, configure `APP_PASSWORD` e HTTPS por proxy. A sessão do WhatsApp equivale a um aparelho conectado: trate o volume de dados como privado. `.env` e dados locais estão ignorados no Git e no contexto de build do Docker.

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

Os testes usam respostas simuladas da Riot e do WhatsApp; não consomem sua chave nem enviam mensagens. O SQLite é o módulo nativo `node:sqlite` do Node 24; dependendo da versão, o Node pode exibir um aviso de recurso experimental.

## Estrutura

```text
public/             Interface responsiva, sem build
public/messages.js  Editor de mensagens e prévias do rascunho
src/app.js          Rotas HTTP e validação
src/server.js       Inicialização e encerramento
src/riot.js         Cliente da API Riot e normalização
src/game-mode.js    Nomes de filas e modos de jogo
src/message.js      Classificação, frases e prévias
src/monitor.js      Consultas periódicas e fila de envio
src/store.js        Persistência SQLite
src/whatsapp.js     QR Code, grupos e sessão Baileys
test/               Testes offline
```

Esta versão integra **League of Legends**. Outros jogos podem ganhar adaptadores próprios conforme a disponibilidade de API; ainda não estão implementados.

GG Report is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
