# Open SIP Phone — Roadmap · Plano de evolução

🇧🇷 [Ir para o português](#português)

## English

Open SIP Phone is a free, open source, multi-account SIP softphone for macOS, Windows
and Linux, built with Electron, React and TypeScript. This document says what exists
today, what does not, and the order in which the rest will be built. It is a plan to
decide from, not a promise: it contains **order and dependencies, not dates**, because a
date we cannot defend is worse than none.

### The principle that shapes the plan

**Every decision lives in `src/core` as a pure function.** State transitions, transport
ordering, message framing, digest responses, jitter-buffer policy, codec maths: all of it
is plain code with no Electron, no DOM and no sockets. `src/main` only owns the things
that cannot be pure (sockets, DNS, the audio device) and feeds events into the core. That
is why the protocol can be tested exhaustively without a PBX: 914 unit tests and 21
Gherkin scenarios, at 100% statement coverage of the core.

Every phase below is planned the same way: put the decisions in `src/core` first, write
the failing test, then add the thin adapter. Anything that cannot be tested that way is
called out as a risk.

One caution about that number: coverage proves the code is exercised, not that the server
agrees with it. The blocker below is exactly the kind of thing a green suite cannot show.

### MVP — make and receive calls with several accounts at once (in progress)

| Area | State |
| --- | --- |
| Multi-account registration over automatically discovered transport (SRV, then the default port ladder, probing TLS, WSS, TCP, WS, UDP in that order) | **Working**, verified against a live OpenSIPS 3.3.10 |
| Digest authentication, including retry when the server re-challenges with a new nonce | **Working**, verified live |
| NAT handling: `rport`, with the learned public address used in `Contact` | **Working**, verified live |
| Per-account on/off switching | **Working**, verified live |
| Diagnostics log that redacts credentials | **Working** |
| Two-way RTP audio: G.711 µ-law and A-law, jitter buffer, DTMF (RFC 4733), mute, hold and resume | **Implemented, not verified end to end.** Unit-tested; a UDP loopback test carried audio both ways with zero loss; **no real call has been heard yet** |
| Outbound call to an internal extension | The extension rings, but the caller saw only `100 Trying` (same cause as below); awaiting live confirmation |
| Outbound call to an external number | **Fix shipped, awaiting live confirmation — see below** |
| Published release | **None yet** |
| macOS signing | Ad-hoc signed, not Developer ID: the keychain prompts on each build and Gatekeeper warns on download |
| macOS 26 icon | Restyled by the system, because the app does not ship the new Icon Composer format |

#### The outbound-call blocker: cause found and fixed, not yet confirmed live

Outbound calls never completed. The INVITE was sent, the server answered `100 Trying`,
and then nothing at all arrived: no `180`, no `183`, no error, no final response. This
affected an external number and an internal extension alike.

**The cause was in the client, not the server.** The UDP socket was created with
`socket.connect(port, host)`. A connected datagram socket makes the kernel drop every
packet whose source does not exactly match the connected peer. SIP over UDP breaks that
assumption routinely: a proxy commonly sends later responses from a different port,
listener or interface than the one that received the request, and RFC 3261 matches a
response to its transaction by the Via branch precisely because the source address can
legitimately differ. The proxy's own `100 Trying` arrived; the relayed `180` and `200`
were discarded by the operating system before our code saw them. Registration and
inbound calls were unaffected, because those arrive at the bound port regardless.

The decisive evidence: across every captured trace, no outbound INVITE ever received any
response other than `100`, whether for an external number or for an internal extension
that demonstrably rings. A dialplan fault would not behave identically for both. The
roadmap previously said the evidence pointed at the server's dialplan or outbound trunk;
that was wrong.

The fix is in `src/main/sip/connection.ts`: the socket is bound and used with an explicit
destination, and accepts datagrams from any source.

What is and is not established:

- **Proven by unit tests** against a socket fake that mimics the kernel's filtering of a
  connected socket: the old behaviour loses the later responses, the new behaviour
  receives them.
- **Not yet verified against the real server.** That needs a call placed by the owner. Until
  then we cannot claim the MVP works, and it remains possible that the server has a
  second, independent problem that the lost responses were hiding.
- `+5555500000396` is rejected outright with `484 Address Incomplete`, so E.164 with a
  leading plus is the wrong form for this server. This finding stands.
- A 90-second call-setup guard cancels the call and reports it, instead of spinning
  forever.

The MVP is done when, and only when:

1. A call to an external number is answered and **a person on the far end is heard, and
   hears the user**, in a real call on at least one account.
2. An incoming call is answered and carries audio both ways.
3. Two accounts are registered and in use at once, with a call on each.
4. A first release is published.

Items 1 and 2 are what turn "implemented" into "verified" for the audio path. Item 1 is
also the live confirmation of the socket fix above; if that call still fails, the next
step is a fresh trace, not an assumption about the server.

Until the MVP is done, the four phases below are **ordered but not started.** They depend
on a working call path: history records calls, contacts identify and place them,
recording captures their audio, and MCP drives all of it.

### Phase 1 — Call history and redial

**What the user gets.** A list of every call, incoming, outgoing and missed, per account,
with the time it started, how long it lasted, the number or contact, which account carried
it, and how it ended (answered, rejected, missed, cancelled, failed, timed out). Selecting
an entry shows its details; one action redials it from the same account.

**What it touches.**

- `src/core/sip`: a pure history model on top of the existing call state machine in
  `call.ts`. A call reaching its end state yields one history record, including the end
  reason the engine already tracks (for example the 90-second setup guard). Retention rules
  (keep N entries, or N days) are pure functions here too.
- `src/main`: persistence next to `account-storage.ts`. History is a new store with its own
  file, not a field on the accounts.
- `src/shared/api.ts`: new IPC channels to list, delete and clear history, and a redial
  call that reuses `dial`.
- `src/renderer`: a history view and a redial control. New strings go in both locale
  files.

**Main risk.** Ending a call is messy: remote hang-up, CANCEL racing a final response,
transport loss and the setup guard are all different paths to "ended", and a record that
is written twice or never is a bug users see immediately. A second risk is privacy: call
history is personal data stored in plain form on disk, unlike credentials, which are
encrypted with `safeStorage`. Whether history should be encrypted too is a decision to
make before shipping it.

**Done looks like.** Place a call, hang up, and see exactly one entry with the right
direction, account, number, start time, duration and end reason. Miss an incoming call
and see it marked as missed. Restart the app and the history is still there. Redial
places a new call from the same account. Delete one entry and clear all both work. All
covered by Gherkin scenarios.

### Phase 2 — Computer contacts

**What the user gets.** The contacts already on the computer, readable inside the app. The
user can add and remove contacts, call a contact with one action, and see the contact's
name instead of a bare number when a call comes in (and in history).

**What it touches.**

- `src/core`: a new contacts module defining one interface (list, search, add, remove)
  and the **pure** parts: normalising numbers, and matching an incoming caller to a
  contact. Matching is where the product value is and where most of the tests belong. It
  must cope with `0`, `55` and `+55` forms of the same number and with SIP URIs.
- `src/main`: one adapter per platform behind that interface, plus the wiring that looks
  up the caller when an INVITE arrives, in `src/main/sip`.
- `src/shared/api.ts`: IPC channels for contacts and a permission status.
- `src/renderer`: a contacts view, a "call" action, and the caller name on the incoming
  call screen. The history view from Phase 1 gains names.

**Main risk: this is three integrations, not one.** The platforms have entirely different
address-book APIs, so the work is a per-platform adapter behind one core interface:

| Platform | Source | What it needs |
| --- | --- | --- |
| macOS | Contacts framework (`CNContactStore`) | The Contacts TCC permission, an entitlement and a usage-description string in the app bundle (the build already declares one for the microphone, in `build/entitlements.mac.plist` and `electron-builder.yml`). Requires a native module or helper, since Electron has no address-book API. A signed build matters here: an ad-hoc signature changes with each build and makes permissions harder to keep. |
| Windows | People / contacts store (WinRT) | A different permission model and a different API; reading it from Electron also needs native code. |
| Linux | Evolution Data Server, or a CardDAV or vCard source | No single address book exists. Which sources count is a product decision. |

It also has to behave when permission is denied: the app must work fully without contacts,
and explain how to grant access. Because adding and removing contacts writes to the user's
real address book, those operations need clear wording and a way to undo or confirm.

**Done looks like.** On each supported platform: grant access, see the real contacts, add
one and see it in the system address book, remove it, call a contact in one action, and
receive a call from a saved number and see the name. With access denied, the app still
makes calls and says why contacts are empty. Matching is covered by core unit tests across
number formats.

### Phase 3 — Call recording

**What the user gets.** Recording of specific calls or of all calls. A setting turns
automatic recording on or off. During a live call there is a record button to start and
stop recording. Recordings are files the user can find, play and delete.

**What it touches.**

- `src/core/rtp`: the pure side. Both directions of audio are already decoded to PCM
  (`g711.ts`) and passed through the jitter buffer (`jitter.ts`); recording means mixing or
  separating the two streams, aligning them in time, and deciding what happens when a call
  is held, muted or loses packets. A recording that drifts or contains gaps is a defect, so
  this belongs in `src/core` and gets unit-tested with synthetic audio.
- `src/main/media`: `rtp-session.ts` and the media window own the live audio and are where
  the samples are tapped. The file writer (WAV first; a compressed format is a later
  decision) and storage location live in `src/main`.
- `src/core/sip`: the recording state of a call (off, on, who decided and when) belongs
  in the call model, so consent and indicator rules can be pure functions.
- `src/shared/api.ts` and `src/renderer`: the setting, the in-call button, the visible
  indicator, and a list of recordings.

**Legal constraint — this is a design question, not an afterthought.** Recording a call
is regulated, and the rules differ by jurisdiction. Many places require the consent of
one party; many require **all** parties; and the rules for Brazil are not the same as
those of several US states. An open source application is used in all of those places. We
are **not giving legal advice** here; we are saying that the product needs a decision, made
deliberately before the feature ships. The options on the table, which can be combined:

| Option | What it means | Trade-off |
| --- | --- | --- |
| Audible notice | The other party hears a notice when recording starts (a tone or announcement). | Works with any law that requires notification, but the other party hears something and it needs mixing into the outgoing stream. |
| Explicit per-call consent | The user must confirm, for each call, that they have the other party's consent before recording starts. | Puts the responsibility on the user in a way that is recorded, but adds friction, especially for "record all calls". |
| Visible indicator | A persistent, unmistakable "recording" indicator for the user, always on screen while recording. | Does nothing for the other party on its own; it is the minimum, not a solution. |

"Record all calls" is the sharpest case, because no per-call moment exists to ask. It may
need to be gated behind an explicit acknowledgement, or restricted to a notice option.
Defaults matter too: recording should be **off** until the user turns it on.

Secondary risk: recordings are sensitive personal data on disk. Where they are stored,
whether they are encrypted, and how they are deleted need deciding. So does behaviour when
the disk is full mid-call, which must never disturb the call itself.

**Done looks like.** With recording off, nothing is written. Press record during a call
and a file appears whose two sides are both audible and in sync; press again and the file
is finalised. With "record all" on, every call produces a file. The recording indicator is
visible whenever recording is active, and the chosen consent behaviour is exercised by a
scenario. This phase **depends on audio being verified end to end** in the MVP: recording
silence is not a feature.

### Phase 4 — MCP tools

**What the user gets.** AI agents can make and receive calls through the application, by
way of a Model Context Protocol server: tools to list accounts, place a call, answer or
reject a call, hang up, send DTMF, and read call state and history.

**What it touches.**

- `src/core`: the **permission model**, as pure functions. Which agent may use which
  account, which actions it may take, with what limits (maximum number of calls, maximum
  duration, allowed destinations). This is the main piece of the phase, and it is entirely
  testable without a PBX.
- `src/main`: an MCP server running in the main process, a thin layer over the same
  engine in `src/main/sip` that the UI uses; it must not become a second code path to
  place calls. The audit log is persisted here.
- `src/shared/api.ts`: the existing call channels (`dial`, `answerCall`, `hangupCall` and
  the rest) are the surface to expose; the MCP tools should map onto them rather than
  invent new behaviour.
- `src/renderer`: a settings area to enable the server, grant and revoke permissions, and
  review the audit trail; a visible indicator while an agent is controlling a call.

**Main risk: the stakes are higher than in any other phase.** An AI agent that can place
calls from the user's account **can spend the user's money** (outbound minutes, premium
and international numbers) **and can speak to real people**. A mistaken or manipulated
agent is a real problem, not a hypothetical one. Treat this as a security feature that
happens to make calls:

- **Off by default.** Nothing listens until the user turns it on.
- **An explicit permission model**, per agent and per account: what it may do, which
  destinations it may reach, and limits on how many calls and how long. Placing a call
  should be able to require a confirmation from the user.
- **An audit trail** of every tool invocation: which agent, which account, what was
  asked, what happened, when. It must be readable by the user and must not be editable by
  the agent.
- **No credentials exposed.** The server must never return SIP passwords, and the
  diagnostics log's redaction applies to it.
- **A kill switch** that ends agent-controlled calls and disables the server at once.
- Interaction with Phase 3: whether an agent may start recording is itself a consent
  question and should default to no.
- Audio is out of scope for the first version: tools control calls, they do not stream
  audio to the model.

**Done looks like.** With the server off, nothing listens. With it on and no permission
granted, every tool call is refused and logged. With a permission granted, an agent
connected to the MCP server places a call, the user sees it in the UI marked as agent
controlled, and the audit trail shows exactly that. A call outside the permitted limits is
refused. The kill switch works mid-call. Covered by Gherkin scenarios.

### Order and dependencies

```
MVP: working call path (blocker resolved, audio heard)
 |
 +--> 1. History and redial ------+
 |                                +--> 2. Contacts (names in history, call from contact)
 |
 +--> 3. Recording  (needs verified audio; needs the consent decision)
 |
 +--> 4. MCP tools  (needs a stable call API; benefits from 1 and 3; needs the permission model)
```

The four phases are in the owner's priority order. Contacts are better after history
because history is the first place that shows names; recording needs verified audio;
MCP comes last because it exposes everything else and the permission model should protect
a feature set that is already stable.

### Not planned

Listed so that scope has an edge. Anything here can be reopened, but it is not on the
plan.

- Video calls.
- Conferencing and call transfer (attended or blind) in this roadmap's phases. Hold and
  resume exist; transfer does not.
- Voicemail (MWI and a voicemail UI), presence and instant messaging (SIMPLE).
- Codecs beyond G.711 (Opus, G.722 and others).
- SRTP and ZRTP media encryption. Signalling over TLS is supported; media is plain RTP
  today. This is a real gap and is worth stating, but it is not in these four phases.
- A hosted service, account provisioning or any server-side component. Open SIP Phone is
  a client.
- Mobile apps.
- Acting as a PBX or registrar.

### Decisions pending

| Decision | Why it is open | What it blocks |
| --- | --- | --- |
| **The outbound-call blocker** | Fix shipped, awaiting live confirmation. The cause was a connected UDP socket that made the kernel drop responses arriving from a different source than the server address we sent to; proven by unit tests, not yet by a real call. `+` E.164 is rejected with `484`. | The MVP, and therefore everything after it, until a real outbound call completes. |
| **Apple Developer ID certificate** | The macOS build is ad-hoc signed: the keychain asks for permission on each build and Gatekeeper warns on download. Signing and notarising needs a paid Apple Developer account. | A credible macOS release; also reliable TCC permissions for Contacts and the microphone. |
| **macOS 26 icon format** | The app does not ship the new Icon Composer format, so macOS 26 restyles the icon. | Cosmetic only; can wait. |
| **Recording consent model** | Audible notice, per-call consent, visible indicator, or a combination; and what "record all" means under it. | Phase 3. |
| **History and recordings at rest** | Whether history and recordings are encrypted like credentials. | Phases 1 and 3. |
| **Linux contacts source** | There is no single address book on Linux. | Phase 2 on Linux. |

---

## Português

O Open SIP Phone é um softphone SIP livre, de código aberto e com várias contas, para
macOS, Windows e Linux, feito com Electron, React e TypeScript. Este documento diz o que
existe hoje, o que não existe e a ordem em que o resto será construído. É um plano para
decidir a partir dele, não uma promessa: traz **ordem e dependências, não datas**, porque
uma data que não conseguimos defender é pior do que nenhuma.

### O princípio que molda o plano

**Toda decisão vive em `src/core` como função pura.** Transições de estado, ordenação de
transporte, enquadramento de mensagens, resposta digest, política do jitter buffer,
matemática de codecs: tudo é código simples, sem Electron, sem DOM e sem sockets. O
`src/main` cuida só do que não pode ser puro (sockets, DNS, o dispositivo de áudio) e
alimenta o núcleo com eventos. É por isso que o protocolo pode ser testado
exaustivamente sem nenhum PBX: 914 testes unitários e 21 cenários Gherkin, com 100% de
cobertura de comandos do núcleo.

Todas as fases abaixo são planejadas do mesmo jeito: primeiro as decisões em `src/core`,
depois o teste que falha, depois o adaptador fino. O que não puder ser testado assim é
apontado como risco.

Uma ressalva sobre esse número: cobertura prova que o código é executado, não que o
servidor concorda com ele. O bloqueio abaixo é exatamente o tipo de coisa que uma suíte
verde não mostra.

### MVP — fazer e receber chamadas com várias contas ao mesmo tempo (em andamento)

| Área | Estado |
| --- | --- |
| Registro de várias contas sobre transporte descoberto automaticamente (SRV, depois a escada de portas padrão, sondando TLS, WSS, TCP, WS e UDP nessa ordem) | **Funcionando**, verificado contra um OpenSIPS 3.3.10 real |
| Autenticação digest, inclusive nova tentativa quando o servidor desafia de novo com outro nonce | **Funcionando**, verificado ao vivo |
| NAT: `rport`, com o endereço público aprendido usado no `Contact` | **Funcionando**, verificado ao vivo |
| Liga/desliga por conta | **Funcionando**, verificado ao vivo |
| Log de diagnóstico que oculta credenciais | **Funcionando** |
| Áudio RTP bidirecional: G.711 µ-law e A-law, jitter buffer, DTMF (RFC 4733), mudo, espera e retomada | **Implementado, não verificado de ponta a ponta.** Testado por unidade; um teste de loopback UDP levou áudio nos dois sentidos sem perda; **nenhuma chamada real foi ouvida ainda** |
| Chamada de saída para um ramal interno | O ramal toca, mas quem ligou viu apenas `100 Trying` (mesma causa descrita abaixo); aguardando confirmação ao vivo |
| Chamada de saída para um número externo | **Correção entregue, aguardando confirmação ao vivo — veja abaixo** |
| Release publicada | **Nenhuma ainda** |
| Assinatura no macOS | Assinada ad-hoc, não com Developer ID: o chaveiro pergunta a cada build e o Gatekeeper avisa no download |
| Ícone no macOS 26 | Reestilizado pelo sistema, porque o app não traz o novo formato do Icon Composer |

#### O bloqueio da chamada de saída: causa encontrada e corrigida, ainda não confirmada ao vivo

As chamadas de saída nunca se completavam. O INVITE era enviado, o servidor respondia
`100 Trying` e depois não chegava absolutamente nada: nem `180`, nem `183`, nem erro, nem
resposta final. Isso valia tanto para um número externo quanto para um ramal interno.

**A causa estava no cliente, não no servidor.** O socket UDP era criado com
`socket.connect(port, host)`. Um socket de datagramas conectado faz o kernel descartar
todo pacote cuja origem não seja exatamente o par conectado. O SIP sobre UDP quebra essa
suposição com frequência: um proxy costuma enviar as respostas seguintes de outra porta,
outro listener ou outra interface, diferentes daqueles que receberam a requisição, e a
RFC 3261 associa a resposta à transação pelo branch do Via justamente porque o endereço de
origem pode legitimamente mudar. O `100 Trying` do próprio proxy chegava; os `180` e `200`
retransmitidos eram descartados pelo sistema operacional antes de o nosso código vê-los. O
registro e as chamadas recebidas não eram afetados, porque chegam à porta vinculada de
qualquer jeito.

A evidência decisiva: em todos os traces capturados, nenhum INVITE de saída recebeu
qualquer resposta além de `100`, fosse para um número externo ou para um ramal interno
que comprovadamente toca. Uma falha de plano de discagem não se comportaria de forma
idêntica nos dois casos. O plano de evolução dizia antes que a evidência apontava para o
plano de discagem ou o tronco de saída do servidor; isso estava errado.

A correção está em `src/main/sip/connection.ts`: o socket é vinculado (`bind`) e usado com
destino explícito, e aceita datagramas de qualquer origem.

O que está e o que não está estabelecido:

- **Provado por testes unitários** contra um socket falso que imita a filtragem do kernel
  em um socket conectado: o comportamento antigo perde as respostas seguintes, o novo as
  recebe.
- **Ainda não verificado contra o servidor real.** Isso exige uma chamada feita pelo dono.
  Até lá, não podemos afirmar que o MVP funciona, e continua possível que o servidor tenha
  um segundo problema, independente, que as respostas perdidas estavam escondendo.
- `+5555500000396` é rejeitado de imediato com `484 Address Incomplete`; portanto, E.164
  com o sinal de mais é a forma errada para este servidor. Esta conclusão se mantém.
- Uma proteção de 90 segundos na montagem da chamada a cancela e avisa, em vez de ficar
  girando para sempre.

O MVP está pronto quando, e somente quando:

1. Uma chamada para um número externo é atendida e **uma pessoa do outro lado é ouvida e
   ouve o usuário**, em uma chamada real e em pelo menos uma conta.
2. Uma chamada recebida é atendida e leva áudio nos dois sentidos.
3. Duas contas estão registradas e em uso ao mesmo tempo, com uma chamada em cada.
4. Uma primeira release é publicada.

Os itens 1 e 2 são o que transforma "implementado" em "verificado" para o caminho de
áudio. O item 1 é também a confirmação ao vivo da correção do socket acima; se essa
chamada ainda falhar, o próximo passo é um novo trace, não uma suposição sobre o servidor.

Enquanto o MVP não estiver pronto, as quatro fases abaixo estão **ordenadas, mas não
iniciadas.** Elas dependem de um caminho de chamada funcionando: o histórico registra
chamadas, os contatos as identificam e as originam, a gravação captura o áudio delas e o
MCP controla tudo isso.

### Fase 1 — Histórico de chamadas e rediscagem

**O que o usuário recebe.** Uma lista de todas as chamadas, recebidas, feitas e perdidas,
por conta, com o horário de início, a duração, o número ou contato, a conta que a
transportou e como terminou (atendida, rejeitada, perdida, cancelada, falhou, expirou).
Selecionar uma entrada mostra os detalhes; uma ação redisca a partir da mesma conta.

**O que toca.**

- `src/core/sip`: um modelo de histórico puro sobre a máquina de estados de chamada que já
  existe em `call.ts`. Uma chamada que chega ao estado final gera um registro de
  histórico, incluindo o motivo de término que o motor já acompanha (por exemplo, a
  proteção de 90 segundos). As regras de retenção (manter N entradas ou N dias) também são
  funções puras aqui.
- `src/main`: persistência ao lado de `account-storage.ts`. O histórico é um novo
  armazenamento, com arquivo próprio, e não um campo das contas.
- `src/shared/api.ts`: novos canais de IPC para listar, apagar e limpar o histórico, e uma
  chamada de rediscagem que reaproveita o `dial`.
- `src/renderer`: uma tela de histórico e um controle de rediscagem. Os textos novos vão
  nos dois arquivos de idioma.

**Principal risco.** Encerrar uma chamada é bagunçado: desligamento remoto, CANCEL em
corrida com uma resposta final, perda de transporte e a proteção de montagem são caminhos
diferentes até "encerrada", e um registro gravado duas vezes ou nenhuma é um defeito que o
usuário vê na hora. Um segundo risco é a privacidade: o histórico é dado pessoal gravado
em disco em texto simples, ao contrário das credenciais, criptografadas com `safeStorage`.
Se o histórico também deve ser criptografado é uma decisão a tomar antes de entregar.

**Pronto é assim.** Faça uma chamada, desligue e veja exatamente uma entrada com a
direção, a conta, o número, o horário, a duração e o motivo de término corretos. Perca uma
chamada recebida e veja-a marcada como perdida. Reinicie o app e o histórico continua lá.
A rediscagem faz uma nova chamada a partir da mesma conta. Apagar uma entrada e limpar
tudo funcionam. Tudo coberto por cenários Gherkin.

### Fase 2 — Contatos do computador

**O que o usuário recebe.** Os contatos que já estão no computador, legíveis dentro do
app. O usuário pode adicionar e remover contatos, ligar para um contato com uma única
ação e ver o nome do contato, em vez de um número solto, quando uma chamada chega (e no
histórico).

**O que toca.**

- `src/core`: um novo módulo de contatos que define uma única interface (listar, buscar,
  adicionar, remover) e as partes **puras**: normalizar números e casar quem está ligando
  com um contato. O casamento é onde está o valor do produto e onde ficam a maioria dos
  testes. Precisa lidar com as formas `0`, `55` e `+55` do mesmo número e com URIs SIP.
- `src/main`: um adaptador por plataforma atrás dessa interface, mais a ligação que
  consulta o chamador quando um INVITE chega, em `src/main/sip`.
- `src/shared/api.ts`: canais de IPC para contatos e para o estado da permissão.
- `src/renderer`: uma tela de contatos, uma ação "ligar" e o nome do chamador na tela de
  chamada recebida. A tela de histórico da Fase 1 passa a mostrar nomes.

**Principal risco: são três integrações, não uma.** As plataformas têm APIs de agenda
completamente diferentes, então o trabalho é um adaptador por plataforma atrás de uma
interface do núcleo:

| Plataforma | Fonte | O que exige |
| --- | --- | --- |
| macOS | Framework Contacts (`CNContactStore`) | A permissão TCC de Contatos, um entitlement e um texto de uso no pacote do app (o build já declara um para o microfone, em `build/entitlements.mac.plist` e `electron-builder.yml`). Exige módulo nativo ou helper, pois o Electron não tem API de agenda. Um build assinado importa aqui: a assinatura ad-hoc muda a cada build e dificulta manter as permissões. |
| Windows | Armazenamento de pessoas/contatos (WinRT) | Outro modelo de permissão e outra API; lê-la a partir do Electron também exige código nativo. |
| Linux | Evolution Data Server, ou uma fonte CardDAV ou vCard | Não existe uma agenda única. Quais fontes valem é uma decisão de produto. |

Também precisa se comportar bem quando a permissão é negada: o app deve funcionar por
completo sem contatos e explicar como conceder acesso. Como adicionar e remover contatos
escreve na agenda real do usuário, essas operações precisam de texto claro e de uma forma
de desfazer ou confirmar.

**Pronto é assim.** Em cada plataforma suportada: conceder o acesso, ver os contatos
reais, adicionar um e vê-lo na agenda do sistema, removê-lo, ligar para um contato com uma
ação e receber uma chamada de um número salvo vendo o nome. Com o acesso negado, o app
continua fazendo chamadas e diz por que a lista de contatos está vazia. O casamento é
coberto por testes unitários do núcleo em vários formatos de número.

### Fase 3 — Gravação de chamadas

**O que o usuário recebe.** Gravação de chamadas específicas ou de todas. Uma configuração
liga ou desliga a gravação automática. Durante uma chamada em andamento há um botão de
gravar para iniciar e parar. As gravações são arquivos que o usuário consegue encontrar,
ouvir e apagar.

**O que toca.**

- `src/core/rtp`: o lado puro. Os dois sentidos do áudio já são decodificados para PCM
  (`g711.ts`) e passam pelo jitter buffer (`jitter.ts`); gravar significa misturar ou
  separar os dois fluxos, alinhá-los no tempo e decidir o que acontece quando a chamada
  está em espera, em mudo ou perde pacotes. Uma gravação que deriva ou tem buracos é um
  defeito, então isto pertence ao `src/core` e é testado por unidade com áudio sintético.
- `src/main/media`: `rtp-session.ts` e a janela de mídia são donos do áudio ao vivo e
  são onde as amostras são capturadas. O gravador de arquivos (WAV primeiro; um formato
  comprimido é decisão posterior) e o local de armazenamento ficam em `src/main`.
- `src/core/sip`: o estado de gravação de uma chamada (desligada, ligada, quem decidiu e
  quando) pertence ao modelo da chamada, para que as regras de consentimento e de
  indicador sejam funções puras.
- `src/shared/api.ts` e `src/renderer`: a configuração, o botão na chamada, o indicador
  visível e a lista de gravações.

**Restrição legal — isto é uma questão de projeto, não um detalhe para depois.** Gravar
uma chamada é regulado, e as regras variam por jurisdição. Muitos lugares exigem o
consentimento de uma das partes; muitos exigem o de **todas**; e as regras do Brasil não
são as mesmas de vários estados dos EUA. Um aplicativo de código aberto é usado em todos
esses lugares. **Não damos aconselhamento jurídico** aqui; dizemos que o produto precisa
de uma decisão, tomada de propósito antes de a funcionalidade ser entregue. As opções em
mesa, que podem ser combinadas:

| Opção | O que significa | Contrapartida |
| --- | --- | --- |
| Aviso sonoro | A outra parte ouve um aviso quando a gravação começa (um tom ou uma locução). | Funciona com qualquer lei que exija notificação, mas a outra parte ouve algo e o aviso precisa ser misturado ao fluxo de saída. |
| Consentimento explícito por chamada | O usuário confirma, a cada chamada, que tem o consentimento da outra parte antes de a gravação começar. | Coloca a responsabilidade no usuário de forma registrada, mas adiciona atrito, sobretudo em "gravar todas". |
| Indicador visível | Um indicador de "gravando" permanente e inconfundível para o usuário, sempre na tela durante a gravação. | Sozinho não faz nada pela outra parte; é o mínimo, não uma solução. |

"Gravar todas as chamadas" é o caso mais delicado, porque não existe um momento por
chamada para perguntar. Pode ser preciso condicioná-lo a uma confirmação explícita ou
restringi-lo à opção de aviso. Os padrões também importam: a gravação deve vir
**desligada** até o usuário ligá-la.

Risco secundário: gravações são dados pessoais sensíveis em disco. Onde ficam, se são
criptografadas e como são apagadas precisa ser decidido. Também o comportamento com o
disco cheio no meio da chamada, que nunca pode perturbar a chamada em si.

**Pronto é assim.** Com a gravação desligada, nada é gravado. Aperte gravar durante uma
chamada e surge um arquivo em que os dois lados são audíveis e sincronizados; aperte de
novo e o arquivo é finalizado. Com "gravar todas" ligado, toda chamada gera um arquivo. O
indicador de gravação fica visível sempre que há gravação ativa, e o comportamento de
consentimento escolhido é exercitado por um cenário. Esta fase **depende de o áudio estar
verificado de ponta a ponta** no MVP: gravar silêncio não é funcionalidade.

### Fase 4 — Ferramentas MCP

**O que o usuário recebe.** Agentes de IA podem fazer e receber chamadas pelo aplicativo,
por meio de um servidor Model Context Protocol: ferramentas para listar contas, fazer uma
chamada, atender ou rejeitar, desligar, enviar DTMF e ler o estado das chamadas e o
histórico.

**O que toca.**

- `src/core`: o **modelo de permissões**, como funções puras. Qual agente pode usar qual
  conta, quais ações pode executar e com que limites (número máximo de chamadas, duração
  máxima, destinos permitidos). É a peça principal da fase e é totalmente testável sem
  PBX.
- `src/main`: um servidor MCP rodando no processo principal, uma camada fina sobre o mesmo
  motor em `src/main/sip` que a interface usa; não pode virar um segundo caminho para
  fazer chamadas. O registro de auditoria é persistido aqui.
- `src/shared/api.ts`: os canais de chamada existentes (`dial`, `answerCall`,
  `hangupCall` e os demais) são a superfície a expor; as ferramentas MCP devem mapear para
  eles em vez de inventar comportamento novo.
- `src/renderer`: uma área de configurações para ligar o servidor, conceder e revogar
  permissões e revisar a trilha de auditoria; um indicador visível enquanto um agente
  controla uma chamada.

**Principal risco: aqui o que está em jogo é maior que em qualquer outra fase.** Um agente
de IA que pode fazer chamadas a partir da conta do usuário **pode gastar o dinheiro dele**
(minutos de saída, números premium e internacionais) **e pode falar com pessoas reais**.
Um agente enganado ou manipulado é um problema real, não hipotético. Trate isto como um
recurso de segurança que por acaso faz chamadas:

- **Desligado por padrão.** Nada escuta até o usuário ligar.
- **Um modelo de permissões explícito**, por agente e por conta: o que pode fazer, quais
  destinos pode alcançar e limites de quantidade e duração das chamadas. Fazer uma chamada
  deve poder exigir confirmação do usuário.
- **Uma trilha de auditoria** de cada invocação de ferramenta: qual agente, qual conta, o
  que foi pedido, o que aconteceu, quando. Deve ser legível pelo usuário e não editável
  pelo agente.
- **Nenhuma credencial exposta.** O servidor nunca deve devolver senhas SIP, e a ocultação
  do log de diagnóstico vale para ele.
- **Um interruptor de emergência** que encerra as chamadas controladas por agentes e
  desativa o servidor de imediato.
- Interação com a Fase 3: se um agente pode iniciar uma gravação é, em si, uma questão de
  consentimento e deve ser "não" por padrão.
- Áudio fica fora da primeira versão: as ferramentas controlam chamadas, não transmitem
  áudio ao modelo.

**Pronto é assim.** Com o servidor desligado, nada escuta. Ligado e sem permissão
concedida, toda chamada de ferramenta é recusada e registrada. Com uma permissão
concedida, um agente conectado ao servidor MCP faz uma chamada, o usuário a vê na
interface marcada como controlada por agente e a trilha de auditoria mostra exatamente
isso. Uma chamada fora dos limites permitidos é recusada. O interruptor de emergência
funciona no meio da chamada. Coberto por cenários Gherkin.

### Ordem e dependências

```
MVP: caminho de chamada funcionando (bloqueio resolvido, áudio ouvido)
 |
 +--> 1. Histórico e rediscagem --+
 |                                +--> 2. Contatos (nomes no histórico, ligar a partir do contato)
 |
 +--> 3. Gravação  (exige áudio verificado; exige a decisão de consentimento)
 |
 +--> 4. Ferramentas MCP  (exige API de chamadas estável; se beneficia de 1 e 3; exige o modelo de permissões)
```

As quatro fases estão na ordem de prioridade do dono do produto. Contatos ficam melhor
depois do histórico, porque o histórico é o primeiro lugar que mostra nomes; a gravação
precisa de áudio verificado; o MCP vem por último porque expõe todo o resto, e o modelo de
permissões deve proteger um conjunto de funcionalidades já estável.

### Fora do plano

Listado para que o escopo tenha borda. Qualquer item pode ser reaberto, mas nenhum está no
plano.

- Chamadas de vídeo.
- Conferência e transferência de chamada (assistida ou cega) nas fases deste plano.
  Espera e retomada existem; transferência não.
- Correio de voz (MWI e uma interface de caixa postal), presença e mensagens instantâneas
  (SIMPLE).
- Codecs além do G.711 (Opus, G.722 e outros).
- Criptografia de mídia SRTP e ZRTP. A sinalização sobre TLS é suportada; a mídia hoje é
  RTP simples. É uma lacuna real e vale dizê-la, mas não está nestas quatro fases.
- Um serviço hospedado, provisionamento de contas ou qualquer componente de servidor. O
  Open SIP Phone é um cliente.
- Aplicativos para celular.
- Atuar como PBX ou registrar.

### Decisões pendentes

| Decisão | Por que está em aberto | O que bloqueia |
| --- | --- | --- |
| **O bloqueio da chamada de saída** | Correção entregue, aguardando confirmação ao vivo. A causa era um socket UDP conectado, que fazia o kernel descartar respostas vindas de origem diferente do endereço do servidor para o qual enviamos; provado por testes unitários, ainda não por uma chamada real. E.164 com `+` é rejeitado com `484`. | O MVP e, portanto, tudo o que vem depois, até que uma chamada de saída real se complete. |
| **Certificado Developer ID da Apple** | O build do macOS é assinado ad-hoc: o chaveiro pede permissão a cada build e o Gatekeeper avisa no download. Assinar e notarizar exige uma conta paga de desenvolvedor Apple. | Uma release crível para macOS; também permissões TCC confiáveis para Contatos e microfone. |
| **Formato do ícone no macOS 26** | O app não traz o novo formato do Icon Composer, então o macOS 26 reestiliza o ícone. | Apenas estético; pode esperar. |
| **Modelo de consentimento da gravação** | Aviso sonoro, consentimento por chamada, indicador visível ou uma combinação; e o que "gravar todas" significa sob ele. | Fase 3. |
| **Histórico e gravações em repouso** | Se histórico e gravações são criptografados como as credenciais. | Fases 1 e 3. |
| **Fonte de contatos no Linux** | Não existe uma agenda única no Linux. | Fase 2 no Linux. |
