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

## Transporte: você dá o domínio, ele descobre o resto

Não se pede porta, protocolo nem URL de WebSocket. Informe usuário, senha e domínio, e
o OpenSIP acha o caminho:

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
  config/      carga de contas de desenvolvimento a partir do ambiente
src/main/      processo principal do Electron: janelas, IPC, armazenamento,
               atualização automática
  sip/         pilha SIP nativa: sonda de transporte, sockets, transações REGISTER
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
| **Áudio bidirecional (RTP/G.711)** | **ainda não — próximo marco** |

Atender uma chamada hoje conclui apenas a sinalização SIP. O caminho de mídia RTP é o
próximo marco, e está declarado abertamente em vez de insinuado.

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
