# Open SIP Phone

[![ci](https://github.com/PauloPeres/OpenSIP/actions/workflows/ci.yml/badge.svg)](https://github.com/PauloPeres/OpenSIP/actions/workflows/ci.yml)
[![licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

**Um softphone SIP livre, de código aberto e radicalmente simples.** Configure várias
contas SIP, acompanhe o registro de cada uma e atenda as chamadas recebidas — no
macOS, Windows e Linux, a partir de uma única base de código e com atualização
automática.

🇺🇸 [Read in English](README.md)

---

## Funcionalidades

- **Múltiplas contas SIP** — registre várias contas ao mesmo tempo e veja o estado de
  registro de cada uma em tempo real.
- **Atendimento de chamadas** — tocar, atender, rejeitar, colocar em espera, retomar e
  encerrar, com limite configurável de chamadas simultâneas.
- **Fazer chamadas** — um discador com uma linha por chamada, verificado em uma chamada
  real com áudio ouvido nos dois sentidos.
- **Histórico de chamadas e rediscagem** — toda chamada encerrada é listada com o horário,
  a direção (recebida ou feita), o número ou endereço remoto, a conta que a transportou, o
  resultado (atendida, perdida, recusada, cancelada ou falhou) e, quando completou, a
  duração. As entradas são agrupadas por dia, com "Hoje" e "Ontem" escritos no idioma da
  interface. Um filtro **Perdidas** mostra apenas as chamadas recebidas sem resposta,
  qualquer entrada pode ser removida isoladamente, e **Limpar histórico** apaga a lista
  depois de uma confirmação. Clicar em uma entrada a redisca pelo mesmo caminho do
  discador; o histórico guarda as 500 chamadas mais recentes e sobrevive a uma
  reinicialização.
- **User-Agent SIP configurável** — em **Configurações**, para provedores que só aceitam
  clientes que reconhecem; veja [Solução de problemas](#solução-de-problemas).
- **Interface bilíngue** — inglês e português do Brasil, alternáveis em tempo de
  execução. Nenhum texto visível ao usuário está escrito direto no código; a CI
  bloqueia quem tentar.
- **Atualização automática** — construída sobre `electron-updater`, então uma nova
  versão chega ao usuário sem download manual.
- **Credenciais criptografadas em repouso** com o `safeStorage` do Electron, quando a
  plataforma oferece suporte.
- **Qualidade verificada por máquina, não por opinião** — veja
  [Portões de qualidade](#portões-de-qualidade).

## Transporte: você dá o domínio, ele descobre o resto

Não se pede porta, protocolo nem URL de WebSocket. Informe usuário, senha e domínio, e
o Open SIP Phone acha o caminho:

1. Consulta os registros SRV definidos pelas RFC 3263 e RFC 7118 — `_sips._tcp`,
   `_sips._wss`, `_sip._tcp`, `_sip._ws`, `_sip._udp`.
2. Se o domínio não publica nenhum, cai para a escada de portas padrão
   (TLS 5061, TCP 5060, UDP 5060, WSS 443, WS 80).
3. Sonda os candidatos por ordem de preferência — **TLS, WSS, TCP, WS, UDP**,
   criptografado primeiro, depois confiável — e fica com o primeiro que responder,
   respeitando prioridade e peso do SRV.

**Transportes suportados: TLS, TCP, UDP, WSS e WS.** SIP sobre TCP e UDP é falado por
uma pilha nativa no processo principal do Electron, então um Asterisk, FreeSWITCH,
Kamailio ou OpenSIPS comum funciona sem nenhum módulo de WebSocket.

Se precisar fixar um caminho específico, preencha o campo opcional de servidor em
**Avançado** (ou `OPENSIP_ACCOUNT_<N>_SERVER_URI`) com algo como
`tcp://pbx.exemplo.com:5060`.

## Solução de problemas

### As chamadas somem: sem toque, sem erro, sem nada

Se o registro funciona e as chamadas recebidas chegam, mas uma chamada de saída nunca
avança e o servidor não dá resposta alguma — nem uma recusa, nem sequer um desafio de
autenticação `407` — o seu provedor pode estar filtrando pelo cabeçalho SIP `User-Agent`.

Esta é uma restrição do mundo real, não uma peculiaridade de um servidor. Operadoras e
controladores de borda de sessão costumam aceitar apenas clientes que reconhecem, como
medida antifraude, e alguns **descartam em silêncio** o INVITE de qualquer outro cliente
em vez de recusá-lo. Um softphone que não pode ser instruído sobre como se identificar fica
inutilizável atrás de um deles.

Foi descoberto assim: um servidor OpenSIPS 3.3.10 nunca desafiou um INVITE que levava o
`User-Agent` padrão do Open SIP Phone (`OpenSIPPhone/0.1.0`). Um segundo softphone, já
reconhecido, fez a mesma chamada a partir da mesma máquina, e o servidor o respondeu com
`407 Proxy Authentication Required`; a chamada então tocou e completou. Todo o resto das
duas requisições era equivalente, então o cabeçalho era a diferença.

**O que fazer.**

- A correção certa está no lado do provedor: peça que ele libere o Open SIP Phone, ou que
  informe quais valores de `User-Agent` aceita.
- Enquanto isso se resolve, preencha **Configurações → User-Agent SIP**. O valor é salvo, e
  a próxima mensagem enviada o leva. Novas chamadas o usam de imediato; um registro o usa na
  próxima renovação, então desligue e ligue a conta para aplicar na hora. Deixe o campo
  vazio para voltar ao padrão. A variável de ambiente `OPENSIP_USER_AGENT` fornece o valor
  inicial antes de você escolher um.
- Trate isso como um paliativo, não como o jeito normal de usar o app. Use um valor que o
  seu provedor tenha indicado, não um palpite sobre o que outro produto envia.

### Um número discado precisa do prefixo completo

No mesmo servidor, `55500000396` foi respondido com `404 UNALLOCATED_NUMBER`, enquanto
`055500000396` completou. Isso é o plano de discagem do provedor, não o app: o número deve
ser discado exatamente como o plano de discagem espera, incluindo qualquer prefixo de
tronco ou internacional. É o tipo de coisa que faz alguém perder uma tarde, então confira
isso primeiro. Um `+` no início (E.164) também foi recusado por esse servidor, com
`484 Address Incomplete`.

## Instalação

Baixe o instalador da sua plataforma na página de
[Releases](https://github.com/PauloPeres/OpenSIP/releases):

- **macOS** — `Open SIP Phone-<versão>-mac-<arch>.dmg` (Intel e Apple Silicon)
- **Windows** — `Open SIP Phone-<versão>-win-<arch>.exe`
- **Linux** — `Open SIP Phone-<versão>-linux-x64.AppImage` ou `.deb`

O aplicativo procura atualizações ao iniciar e a cada seis horas, e as instala ao sair.

## Rodando a partir do código

```bash
git clone https://github.com/PauloPeres/OpenSIP.git
cd OpenSIP
npm install
npm run dev
```

### Contas de desenvolvimento

Copie o modelo e preencha as credenciais reais — o `.env.local` é ignorado pelo Git:

```bash
cp .env.example .env.local
```

```dotenv
OPENSIP_ACCOUNT_1_DISPLAY_NAME=Suporte
OPENSIP_ACCOUNT_1_USERNAME=1001
OPENSIP_ACCOUNT_1_PASSWORD=segredo
OPENSIP_ACCOUNT_1_DOMAIN=pbx.exemplo.com
OPENSIP_ACCOUNT_1_SERVER_URI=tcp://pbx.exemplo.com:5060
OPENSIP_ACCOUNT_1_REGISTER_EXPIRES=600
```

São lidas até nove contas (`OPENSIP_ACCOUNT_1_*` … `OPENSIP_ACCOUNT_9_*`). Uma entrada
só é carregada quando `USERNAME`, `PASSWORD` e `DOMAIN` estão preenchidos, então
blocos vazios ou pela metade são simplesmente ignorados. O `SERVER_URI` é opcional —
deixe vazio para descoberta automática; o nome antigo `WS_SERVER` continua aceito. A carga
acontece **somente em desenvolvimento** (`!app.isPackaged`) e **somente quando nenhuma
conta foi salva ainda**; builds empacotados ignoram o arquivo por completo.

### Gerando os instaladores

```bash
npm run dist
```

## Arquitetura

```
src/core/      domínio puro, sem framework — sem Electron, sem DOM, 100% testado
  i18n/        tradutor + dicionários en/pt-BR
  sip/         validação de conta, repositório de contas, máquinas de estado de
               registro e de chamada, descoberta de transporte, codec SIP e
               autenticação digest
  rtp/         codecs G.711, pacotes RTP, jitter buffer
  diagnostics/ log de diagnóstico e ocultação de credenciais
  config/      carga de contas de desenvolvimento a partir do ambiente
src/main/      processo principal do Electron: janelas, IPC, armazenamento,
               atualização automática
  sip/         pilha SIP nativa: sonda de transporte, sockets, registro e chamadas
  media/       sessão RTP e a janela de áudio oculta (microfone e alto-falante)
src/preload/   superfície do contextBridge — o único caminho entre renderer e main
src/renderer/  UI em React; todo texto passa por t()
src/shared/    o contrato de IPC compartilhado pelos três processos
```

A regra que mantém isso testável: **toda decisão vive em `src/core` como função
pura** — transições de estado, ordenação de transporte, enquadramento de mensagens,
resposta digest. O `src/main/sip` só cuida de sockets e DNS, alimentando os redutores
do núcleo — e é por isso que o protocolo inteiro pode ser testado sem nenhum PBX.

### Situação atual

| Capacidade | Estado |
| --- | --- |
| Múltiplas contas, validação, persistência | funcionando |
| Descoberta automática de transporte (SRV + sonda) | funcionando |
| Registro sobre TCP, TLS, UDP, WS, WSS | funcionando |
| Sinalização de chamada recebida: tocar, atender, rejeitar, encerrar | funcionando |
| Fazer chamadas: discador, uma linha por chamada | funcionando — uma chamada de saída completou em uma conta real |
| Histórico de chamadas e rediscagem | funcionando, testado por unidade; ainda não exercitado de ponta a ponta em uma chamada real |
| Liga/desliga por conta | funcionando |
| Log de diagnóstico com ocultação de credenciais | funcionando |
| Primeiros passos: permissões de microfone e notificações, primeira conta | funcionando |
| User-Agent SIP configurável (Configurações) | funcionando |
| **Áudio bidirecional (RTP/G.711)** | **verificado em uma chamada de saída real, ouvido nos dois sentidos** |

O MVP — fazer e receber chamadas com várias contas — está funcionalmente completo, e o
último item não verificado era o áudio: o dono fez uma chamada de saída real que completou
com áudio nos dois sentidos. O caminho
de áudio também é testado de forma isolada: `src/core/rtp` (G.711 µ-law e A-law, pacotes
RFC 3550, jitter buffer) e `src/main/media` (a sessão RTP e a janela de áudio oculta) têm
testes unitários, e um teste de loopback UDP levou áudio nos dois sentidos sem perda.

O que essa única chamada **não** prova, e o que não foi confirmado separadamente: atender
uma chamada recebida e ouvir áudio nos dois sentidos, e duas contas em uso ao mesmo tempo,
com uma chamada em cada. Nenhuma release foi publicada ainda. O [plano de evolução](ROADMAP.md#português) lista
cada um desses itens como cumprido ou não. A chamada só completou quando o `User-Agent` SIP
era um que o provedor reconhece; veja [Solução de problemas](#solução-de-problemas).

O que vem depois, em ordem, está no [plano de evolução](ROADMAP.md#português).

## Portões de qualidade

Todos rodam na CI em cada push e pull request. Para rodar todos localmente:

```bash
npm run verify
```

| Portão | Limite | Comando |
| --- | --- | --- |
| Tipos | nenhum erro, `strict` + `exactOptionalPropertyTypes` | `npm run typecheck` |
| Lint | complexidade ≤ 8, ≤ 20 linhas por função, profundidade ≤ 3 | `npm run lint` |
| i18n | zero texto fixo na UI, dicionários sincronizados | `npm run gate:i18n` |
| Cobertura | ≥ 95% linhas/funções/comandos, ≥ 90% ramos | `npm run test:coverage` |
| Comportamento (Gherkin) | todos os cenários passam | `npm run test:bdd` |
| CRAP | toda função < 10 | `npm run gate:crap` |
| Duplicação | nenhum clone ≥ 5 linhas / 40 tokens | `npm run gate:dry` |
| Mutação | escore de mutação ≥ 90% | `npm run gate:mutation` |

Veja [docs/quality-gates.md](docs/quality-gates.md) para o que cada um verifica e como
corrigir uma falha.

## Como contribuir

Pull requests são bem-vindos. O fluxo é teste primeiro: escreva um teste unitário ou
cenário Gherkin que falhe, confirme que ele falha pelo motivo certo e só então faça-o
passar. Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE) © Contribuidores do Open SIP Phone
