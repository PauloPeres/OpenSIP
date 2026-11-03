# OpenSIP

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
- **Interface bilíngue** — inglês e português do Brasil, alternáveis em tempo de
  execução. Nenhum texto visível ao usuário está escrito direto no código; a CI
  bloqueia quem tentar.
- **Atualização automática** — construída sobre `electron-updater`, então uma nova
  versão chega ao usuário sem download manual.
- **Credenciais criptografadas em repouso** com o `safeStorage` do Electron, quando a
  plataforma oferece suporte.
- **Qualidade verificada por máquina, não por opinião** — veja
  [Portões de qualidade](#portões-de-qualidade).

## Transporte: leia antes de abrir um bug

O OpenSIP fala **SIP sobre WebSocket** (`ws://` / `wss://`), o transporte que
navegadores e o Electron conseguem abrir de fato. Ele **não** fala SIP sobre UDP ou
TCP puros.

Seu PBX ou provedor precisa expor um endpoint SIP em WebSocket. Praticamente todos os
modernos expõem:

| Plataforma | Endpoint WebSocket típico |
| --- | --- |
| Asterisk (`res_http_websocket`) | `wss://pbx.exemplo.com:8089/ws` |
| FreeSWITCH (perfil WSS do `mod_sofia`) | `wss://pbx.exemplo.com:7443` |
| Kamailio / OpenSIPS (módulo `websocket`) | `wss://sip.exemplo.com:443` |

Se o seu provedor é só UDP, coloque na frente dele um proxy com suporte a WebSocket
(Kamailio, OpenSIPS ou Asterisk).

## Instalação

Baixe o instalador da sua plataforma na página de
[Releases](https://github.com/PauloPeres/OpenSIP/releases):

- **macOS** — `OpenSIP-<versão>-mac-<arch>.dmg` (Intel e Apple Silicon)
- **Windows** — `OpenSIP-<versão>-win-<arch>.exe`
- **Linux** — `OpenSIP-<versão>-linux-x64.AppImage` ou `.deb`

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
OPENSIP_ACCOUNT_1_WS_SERVER=wss://pbx.exemplo.com:8089/ws
OPENSIP_ACCOUNT_1_REGISTER_EXPIRES=600
```

São lidas até nove contas (`OPENSIP_ACCOUNT_1_*` … `OPENSIP_ACCOUNT_9_*`). Uma entrada
só é carregada quando `USERNAME`, `PASSWORD`, `DOMAIN` e `WS_SERVER` estão todos
preenchidos, então blocos vazios ou pela metade são simplesmente ignorados. A carga
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
               registro e de chamada
  config/      carga de contas de desenvolvimento a partir do ambiente
src/main/      processo principal do Electron: janelas, IPC, armazenamento,
               atualização automática, adaptador sip.js
src/preload/   superfície do contextBridge — o único caminho entre renderer e main
src/renderer/  UI em React; todo texto passa por t()
src/shared/    o contrato de IPC compartilhado pelos três processos
```

A regra que mantém isso testável: **toda transição de estado vive em `src/core` como
função pura.** O `src/main/sip-engine.ts` é um adaptador fino, que apenas traduz
eventos do sip.js em eventos do domínio — e é por isso que o domínio pode ser testado
de forma exaustiva sem nenhum PBX.

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

[MIT](LICENSE) © Contribuidores do OpenSIP
