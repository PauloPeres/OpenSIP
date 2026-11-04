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
is why the protocol can be tested exhaustively without a PBX: more than 1,400 unit tests and
21 Gherkin scenarios, at 100% statement coverage of the core.

Every phase below is planned the same way: put the decisions in `src/core` first, write
the failing test, then add the thin adapter. Anything that cannot be tested that way is
called out as a risk.

One caution about that number: coverage proves the code is exercised, not that the server
agrees with it. The outbound-call problem below is exactly the kind of thing a green suite
cannot show: every test passed while a real server silently ignored the calls.

### MVP — make and receive calls with several accounts at once (functionally complete; exit criteria not all met)

The owner placed a real outbound call that connected with **two-way audio**, and
confirmed it. That was the last unverified item, so the MVP as defined here — making and
receiving calls with multiple accounts — works. Its exit criteria, listed below, are not
all met, and this document does not round them up.

| Area | State |
| --- | --- |
| Registration over automatically discovered transport (SRV, then the default port ladder, probing TLS, WSS, TCP, WS, UDP in that order) | **Working**, verified against a live OpenSIPS 3.3.10. Two accounts registering at the same time were only tried in a throwaway test harness (3 November), not in the app — see exit criterion 3 |
| Digest authentication, including retry when the server re-challenges with a new nonce | **Working**, verified live |
| NAT handling: `rport`, with the learned public address used in `Contact` | **Working**, verified live |
| Per-account on/off switching | **Working**, verified live |
| Diagnostics log that redacts credentials | **Working** |
| Two-way RTP audio: G.711 µ-law and A-law, jitter buffer, DTMF (RFC 4733), mute, hold and resume | **Verified on a real outbound call, heard in both directions.** Also unit-tested, and a UDP loopback test carried audio both ways with zero loss |
| Outbound call | **Working**: a real call connected. It needs a `User-Agent` the provider recognises and a number with its full prefix — see below |
| Configurable SIP `User-Agent` | **Working**: **Settings → SIP User-Agent**, persisted, applied to the next message sent |
| Call history and redial | **Delivered** — see Phase 1 |
| Published release | **v0.1.0**, published 4 November. Its macOS binaries were built locally, not in CI (see [docs/releasing.md](docs/releasing.md)) |
| macOS signing | Ad-hoc signed, not Developer ID: the keychain prompts on each build and Gatekeeper warns on download |
| macOS 26 icon | Restyled by the system, because the app does not ship the new Icon Composer format |

#### The outbound-call blocker: resolved, and the cause was the User-Agent

Outbound calls never completed. The INVITE went out, the server answered `100 Trying`
twice, and then nothing: no ringing, no `180`, no error, no final response. This affected an
external number and an internal extension alike, while registration worked.

**The cause was the SIP `User-Agent`, and the server was discarding the request.** The
owner's OpenSIPS 3.3.10 **silently discards INVITEs from a User-Agent it does not
recognise**: no `407`, no error, no final response. With `OpenSIPPhone/0.1.0` it answered
`100 Trying` twice and then nothing, ever — not even a reply to our CANCEL. The two `100`s
prove the request was accepted and a transaction created (the second comes from the
OpenSIPS `tm` module, which only emits it once the transaction exists), so this was not a
packet lost on the network; the server simply produced no final answer. With the `User-Agent` of a softphone it recognises, it answered `407 Proxy
Authentication Required`, and the call rang and connected. This was established by capturing
both clients placing the same call from the same machine; everything else in the request
was byte-for-byte equivalent.

This is a constraint users will meet, not a quirk of one server. Carriers and session
border controllers commonly filter on `User-Agent` as an anti-fraud measure, and a softphone
that cannot be told what to identify as is unusable behind one. So the value is now a
setting, **Settings → SIP User-Agent**, persisted and used for the next message sent
(a registration picks it up when it next renews). The README's
[Troubleshooting](README.md#troubleshooting) section is where a user is told about it.

What this does and does not mean:

- **The right fix is on the provider's side**: it should allow the client. Setting the
  header is the workaround while that is arranged. It is not a recommendation to present the
  app as some other product as the normal way to use it, and the app does not offer a list of
  other products to choose from.
- **A dialled number needs its full prefix.** On the same server `55500000396` was answered
  `404 UNALLOCATED_NUMBER` and `055500000396` connected. That is a dialplan matter, not an
  app one, but it is exactly the kind of thing that wastes someone's afternoon. A leading
  `+` (E.164) was refused by that server with `484 Address Incomplete`.
- **The earlier diagnosis was wrong.** This roadmap previously blamed a connected UDP
  socket, which makes the kernel drop datagrams whose source differs from the connected
  peer. The socket is now bound and used with an explicit destination
  (`src/main/sip/connection.ts`), covered by unit tests, and that is the correct behaviour
  for SIP over UDP under RFC 3261. But it was **not** what stopped the calls, and we have no
  evidence it changed any outcome on the real server. Before that, the roadmap blamed the
  server's dialplan or outbound trunk; that was wrong too. What exposed the real cause was a
  side-by-side capture of two clients placing the same call.
- A 90-second call-setup guard cancels a call that is never answered and reports it,
  instead of spinning forever.

#### MVP exit criteria

The MVP is done when, and only when, all four hold. Today:

| # | Criterion | State |
| --- | --- | --- |
| 1 | A call to an external number is answered and **a person on the far end is heard, and hears the user**, in a real call on at least one account | **Met.** A real outbound call connected, with audio heard in both directions |
| 2 | An incoming call is answered and carries audio both ways | **Not confirmed.** Inbound INVITEs have been received and answered with `180` in a test harness; no incoming call has been taken in the app with audio |
| 3 | Two accounts are registered and in use at once, with a call on each | **Not confirmed.** Two accounts were registered simultaneously only in a throwaway test harness (3 November), not in the app; two simultaneous calls, one on each, have not been tried |
| 4 | A first release is published | **Met.** v0.1.0 is published, with macOS, Windows and Linux installers and the three updater manifests |

So criteria 1 and 4 are met, and criteria 2 and 3 are unconfirmed rather than failing. The MVP
is therefore functionally complete but not yet closed.

The phases below are ordered, and Phase 1 is delivered. Phase 2 is the current one. Phases 3
and 4 are **ordered but not started**. Recording (Phase 3) depends on audio that is now
verified on an outbound call; it would also want incoming-call audio confirmed, since a
recording of one direction is not a feature.

### Phase 1 — Call history and redial (delivered)

**What the user gets.** A list of every finished call, with the time, the direction
(incoming or outgoing), the remote number or address, the account that carried it, the
outcome and, when the call connected, how long it lasted. Calls are grouped by day, with
"Today" and "Yesterday" produced by `Intl` in the interface language and older days written
as a date. A **Missed** filter (with a count) shows only unanswered incoming calls. Any
entry can be removed on its own, **Clear history** empties the list after a confirmation,
and clicking an entry redials it through the same dial path the dialer uses. The history
survives a restart.

**How it is built.**

- `src/core/history/`: the pure model. `CallJournal` follows a call from its first moment to
  its last and yields exactly one `CallRecord` when it ends; `classifyOutcome` decides the
  outcome; `store.ts` appends, removes and clears, derives the duration from the timestamps
  (it is not a stored field, so it cannot disagree with them), and filters; `redial.ts`
  decides whether an identity can be dialled and from which account; `parse.ts` validates what
  is read back from disk.
- Outcomes are `answered`, `missed`, `rejected` (shown as "Declined"), `cancelled` and
  `failed`. A call that reached the active state counts as answered however it ended.
- Retention is a cap: the most recent **500** entries are kept, and the oldest fall off.
- `src/main`: the engine feeds the journal, and persistence is in the same file as the
  accounts, handled by `account-storage.ts`.
- `src/renderer`: a **History** view (`HistoryPanel.tsx`, `HistoryRow.tsx`) and the redial
  logic.

**Where it differs from the plan above.** The plan said the model would sit in
`src/core/sip`, that history would be a separate file, that selecting an entry would open a
detail view, that retention might be by days, and that "timed out" would be an outcome.
What shipped: the model is in its own `src/core/history/` module; history shares the
accounts file; selecting a row redials it and there is no detail view; retention is the
500-entry cap only, with no age-based rule; and a setup timeout is recorded as `failed` with
its reason.

**Redial.** The call goes out from the account the original call used when that account is
still registered; if it is not, from the first registered account. An identity that cannot be
dialled — a bare display name, an anonymous caller — has its redial disabled with a note,
rather than guessing a number. Redial is refused while an outbound call on that account is
still being set up.

**At rest.** History is stored unencrypted, deliberately, and the reason is written down in
`account-storage.ts`: it is bounded by the cap and by **Clear history**, and encrypting it
with the OS keychain would add prompts and failure modes without protecting it from a process
already running as the user. Credentials remain encrypted with `safeStorage`.

**Not yet exercised end to end.** The history is unit-tested, but no confirmation against
real calls of every outcome is recorded here. Ending a call is messy — remote hang-up,
CANCEL racing a final response, transport loss and the setup guard are all different paths to
"ended" — and a record written twice or never is a bug users see immediately.

### Phase 2 — Computer contacts (current)

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
MVP: working call path (blocker resolved, outbound audio heard; first release published)
 |
 +--> 1. History and redial  [delivered] --+
 |                                         +--> 2. Contacts  [current]
 |                                              (names in history, call from contact)
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
| **MVP exit criteria 2 and 3** | A real outbound call connected and the first release is published, but answering a real incoming call with audio both ways and two accounts in simultaneous use are not yet confirmed. | Calling the MVP closed. |
| **Apple Developer ID certificate** | The macOS build is ad-hoc signed: the keychain asks for permission on each build and Gatekeeper warns on download. Signing and notarising needs a paid Apple Developer account. | A credible macOS release; also reliable TCC permissions for Contacts and the microphone. Also macOS auto-update (the app only notifies today). Costs 99 USD/year. TODO and steps in [docs/releasing.md](docs/releasing.md#todo-apple-developer-id-certificate). |
| **macOS 26 icon format** | The app does not ship the new Icon Composer format, so macOS 26 restyles the icon. | Cosmetic only; can wait. |
| **Recording consent model** | Audible notice, per-call consent, visible indicator, or a combination; and what "record all" means under it. | Phase 3. |
| **Recordings at rest** | Whether recordings are encrypted like credentials. History was decided: stored unencrypted, capped at 500 entries, clearable. | Phase 3. |
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
exaustivamente sem nenhum PBX: mais de 1.400 testes unitários e 21 cenários Gherkin, com 100% de
cobertura de comandos do núcleo.

Todas as fases abaixo são planejadas do mesmo jeito: primeiro as decisões em `src/core`,
depois o teste que falha, depois o adaptador fino. O que não puder ser testado assim é
apontado como risco.

Uma ressalva sobre esse número: cobertura prova que o código é executado, não que o
servidor concorda com ele. O problema da chamada de saída abaixo é exatamente o tipo de
coisa que uma suíte verde não mostra: todos os testes passavam enquanto um servidor real
ignorava as chamadas em silêncio.

### MVP — fazer e receber chamadas com várias contas ao mesmo tempo (funcionalmente completo; critérios de saída nem todos cumpridos)

O dono fez uma chamada de saída real que completou com **áudio nos dois sentidos** e
confirmou. Esse era o último item não verificado; portanto o MVP como definido aqui —
fazer e receber chamadas com várias contas — funciona. Os critérios de saída, listados
abaixo, nem todos foram cumpridos, e este documento não os arredonda para cima.

| Área | Estado |
| --- | --- |
| Registro sobre transporte descoberto automaticamente (SRV, depois a escada de portas padrão, sondando TLS, WSS, TCP, WS e UDP nessa ordem) | **Funcionando**, verificado contra um OpenSIPS 3.3.10 real. Duas contas registrando ao mesmo tempo foram testadas apenas em um ambiente de teste descartável (3 de novembro), não no app — veja o critério de saída 3 |
| Autenticação digest, inclusive nova tentativa quando o servidor desafia de novo com outro nonce | **Funcionando**, verificado ao vivo |
| NAT: `rport`, com o endereço público aprendido usado no `Contact` | **Funcionando**, verificado ao vivo |
| Liga/desliga por conta | **Funcionando**, verificado ao vivo |
| Log de diagnóstico que oculta credenciais | **Funcionando** |
| Áudio RTP bidirecional: G.711 µ-law e A-law, jitter buffer, DTMF (RFC 4733), mudo, espera e retomada | **Verificado em uma chamada de saída real, ouvido nos dois sentidos.** Também testado por unidade, e um teste de loopback UDP levou áudio nos dois sentidos sem perda |
| Chamada de saída | **Funcionando**: uma chamada real completou. Exige um `User-Agent` que o provedor reconheça e um número com o prefixo completo — veja abaixo |
| `User-Agent` SIP configurável | **Funcionando**: **Configurações → User-Agent SIP**, persistido e aplicado à próxima mensagem enviada |
| Histórico de chamadas e rediscagem | **Entregue** — veja a Fase 1 |
| Release publicada | **v0.1.0**, publicada em 4 de novembro. Os binários de macOS foram compilados localmente, não no CI (veja [docs/releasing.md](docs/releasing.md)) |
| Assinatura no macOS | Assinada ad-hoc, não com Developer ID: o chaveiro pergunta a cada build e o Gatekeeper avisa no download |
| Ícone no macOS 26 | Reestilizado pelo sistema, porque o app não traz o novo formato do Icon Composer |

#### O bloqueio da chamada de saída: resolvido, e a causa era o User-Agent

As chamadas de saída nunca se completavam. O INVITE saía, o servidor respondia `100 Trying`
duas vezes e depois nada: nem toque, nem `180`, nem erro, nem resposta final. Isso valia
tanto para um número externo quanto para um ramal interno, enquanto o registro funcionava.

**A causa era o `User-Agent` SIP, e o servidor descartava a requisição.** O OpenSIPS 3.3.10
do dono **descarta em silêncio os INVITEs de um User-Agent que não reconhece**: sem `407`,
sem erro, sem resposta final. Com `OpenSIPPhone/0.1.0` ele respondeu `100 Trying` duas
vezes e depois nada, nunca — nem mesmo uma resposta ao nosso CANCEL. Os dois `100` provam
que a requisição foi aceita e uma transação criada (o segundo vem do módulo `tm` do
OpenSIPS, que só o emite depois que a transação existe), então não foi um pacote perdido
na rede; o servidor simplesmente não produziu resposta final. Com o
`User-Agent` de um softphone que ele reconhece, respondeu `407 Proxy Authentication
Required`, e a chamada tocou e completou. Isso foi estabelecido capturando os dois clientes
fazendo a mesma chamada a partir da mesma máquina; todo o resto da requisição era
equivalente byte a byte.

É uma restrição que os usuários vão encontrar, não uma peculiaridade de um servidor.
Operadoras e controladores de borda de sessão costumam filtrar pelo `User-Agent` como
medida antifraude, e um softphone que não pode ser instruído sobre como se identificar fica
inutilizável atrás de um deles. Por isso o valor agora é uma configuração, **Configurações →
User-Agent SIP**, persistida e usada na próxima mensagem enviada (um registro a adota na
próxima renovação). É na seção
[Solução de problemas](README.pt-BR.md#solução-de-problemas) do README que o usuário é
avisado.

O que isso significa e o que não significa:

- **A correção certa está no lado do provedor**: ele deve liberar o cliente. Definir o
  cabeçalho é o paliativo enquanto isso é providenciado. Não é uma recomendação de
  apresentar o app como outro produto como jeito normal de usá-lo, e o app não oferece uma
  lista de outros produtos para escolher.
- **Um número discado precisa do prefixo completo.** No mesmo servidor, `55500000396` foi
  respondido com `404 UNALLOCATED_NUMBER` e `055500000396` completou. É uma questão de plano
  de discagem, não do app, mas é exatamente o tipo de coisa que faz alguém perder uma tarde.
  Um `+` no início (E.164) foi recusado por esse servidor com `484 Address Incomplete`.
- **O diagnóstico anterior estava errado.** Este plano culpava antes um socket UDP
  conectado, que faz o kernel descartar datagramas cuja origem difere do par conectado. O
  socket agora é vinculado (`bind`) e usado com destino explícito
  (`src/main/sip/connection.ts`), coberto por testes unitários, e esse é o comportamento
  correto para SIP sobre UDP segundo a RFC 3261. Mas **não** foi isso que impedia as
  chamadas, e não temos evidência de que tenha mudado algum resultado no servidor real.
  Antes disso, o plano culpava o plano de discagem ou o tronco de saída do servidor; isso
  também estava errado. O que expôs a causa real foi uma captura lado a lado de dois
  clientes fazendo a mesma chamada.
- Uma proteção de 90 segundos na montagem da chamada cancela uma chamada que nunca é
  atendida e avisa, em vez de ficar girando para sempre.

#### Critérios de saída do MVP

O MVP está pronto quando, e somente quando, os quatro valem. Hoje:

| # | Critério | Estado |
| --- | --- | --- |
| 1 | Uma chamada para um número externo é atendida e **uma pessoa do outro lado é ouvida e ouve o usuário**, em uma chamada real e em pelo menos uma conta | **Cumprido.** Uma chamada de saída real completou, com áudio ouvido nos dois sentidos |
| 2 | Uma chamada recebida é atendida e leva áudio nos dois sentidos | **Não confirmado.** INVITEs recebidos foram atendidos com `180` em um ambiente de teste; nenhuma chamada recebida foi atendida no app com áudio |
| 3 | Duas contas estão registradas e em uso ao mesmo tempo, com uma chamada em cada | **Não confirmado.** Duas contas foram registradas simultaneamente apenas em um ambiente de teste descartável (3 de novembro), não no app; duas chamadas simultâneas, uma em cada, não foram tentadas |
| 4 | Uma primeira release é publicada | **Cumprido.** A v0.1.0 está publicada, com instaladores para macOS, Windows e Linux e os três manifestos de atualização |

Assim, os critérios 1 e 4 estão cumpridos, e os critérios 2 e 3 estão não confirmados em
vez de falhando. O MVP está, portanto, funcionalmente completo, mas ainda não encerrado.

As fases abaixo estão ordenadas, e a Fase 1 está entregue. A Fase 2 é a atual. As Fases 3 e
4 estão **ordenadas, mas não iniciadas**. A gravação (Fase 3) depende de áudio que agora
está verificado em uma chamada de saída; ela também pediria o áudio da chamada recebida
confirmado, já que gravar um só sentido não é funcionalidade.

### Fase 1 — Histórico de chamadas e rediscagem (entregue)

**O que o usuário recebe.** Uma lista de toda chamada encerrada, com o horário, a direção
(recebida ou feita), o número ou endereço remoto, a conta que a transportou, o resultado e,
quando a chamada completou, a duração. As chamadas são agrupadas por dia, com "Hoje" e
"Ontem" produzidos pelo `Intl` no idioma da interface e os dias mais antigos escritos como
data. Um filtro **Perdidas** (com contagem) mostra apenas as chamadas recebidas sem
resposta. Qualquer entrada pode ser removida isoladamente, **Limpar histórico** esvazia a
lista depois de uma confirmação, e clicar em uma entrada a redisca pelo mesmo caminho de
discagem do discador. O histórico sobrevive a uma reinicialização.

**Como é construído.**

- `src/core/history/`: o modelo puro. O `CallJournal` acompanha uma chamada do primeiro ao
  último momento e produz exatamente um `CallRecord` quando ela termina; o `classifyOutcome`
  decide o resultado; o `store.ts` acrescenta, remove e limpa, deriva a duração dos
  horários (ela não é um campo gravado, então não pode discordar deles) e filtra; o
  `redial.ts` decide se uma identidade pode ser discada e a partir de qual conta; o
  `parse.ts` valida o que é lido de volta do disco.
- Os resultados são `answered`, `missed`, `rejected` (exibido como "Recusada"), `cancelled`
  e `failed`. Uma chamada que chegou ao estado ativo conta como atendida, seja qual for o
  jeito de terminar.
- A retenção é um teto: as **500** entradas mais recentes são mantidas, e as mais antigas
  saem.
- `src/main`: o motor alimenta o journal, e a persistência fica no mesmo arquivo das contas,
  tratada pelo `account-storage.ts`.
- `src/renderer`: uma tela **Histórico** (`HistoryPanel.tsx`, `HistoryRow.tsx`) e a lógica
  de rediscagem.

**Onde difere do plano acima.** O plano dizia que o modelo ficaria em `src/core/sip`, que o
histórico seria um arquivo separado, que selecionar uma entrada abriria uma tela de
detalhes, que a retenção poderia ser por dias e que "expirou" seria um resultado. O que foi
entregue: o modelo está em seu próprio módulo `src/core/history/`; o histórico divide o
arquivo das contas; selecionar uma linha a redisca e não há tela de detalhes; a retenção é
só o teto de 500 entradas, sem regra por idade; e uma expiração na montagem é registrada
como `failed`, com o seu motivo.

**Rediscagem.** A chamada sai da conta que a chamada original usou, quando essa conta
continua registrada; se não, da primeira conta registrada. Uma identidade que não pode ser
discada — um nome de exibição solto, um chamador anônimo — tem a rediscagem desativada com
uma nota, em vez de adivinhar um número. A rediscagem é recusada enquanto uma chamada de
saída dessa conta ainda está sendo montada.

**Em repouso.** O histórico é gravado sem criptografia, de propósito, e o motivo está
escrito em `account-storage.ts`: ele é limitado pelo teto e por **Limpar histórico**, e
criptografá-lo com o chaveiro do sistema acrescentaria pedidos de permissão e modos de
falha sem protegê-lo de um processo que já roda como o usuário. As credenciais continuam
criptografadas com o `safeStorage`.

**Ainda não exercitado de ponta a ponta.** O histórico tem testes unitários, mas não há
aqui registro de confirmação contra chamadas reais de todos os resultados. Encerrar uma
chamada é bagunçado — desligamento remoto, CANCEL em corrida com uma resposta final, perda
de transporte e a proteção de montagem são caminhos diferentes até "encerrada" — e um
registro gravado duas vezes ou nenhuma é um defeito que o usuário vê na hora.

### Fase 2 — Contatos do computador (atual)

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
MVP: caminho de chamada funcionando (bloqueio resolvido, áudio de saída ouvido; primeira release publicada)
 |
 +--> 1. Histórico e rediscagem  [entregue] --+
 |                                            +--> 2. Contatos  [atual]
 |                                                 (nomes no histórico, ligar a partir do contato)
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
| **Critérios de saída 2 e 3 do MVP** | Uma chamada de saída real completou e a primeira release está publicada, mas atender uma chamada recebida real com áudio nos dois sentidos e duas contas em uso simultâneo ainda não estão confirmados. | Dar o MVP por encerrado. |
| **Certificado Developer ID da Apple** | O build do macOS é assinado ad-hoc: o chaveiro pede permissão a cada build e o Gatekeeper avisa no download. Assinar e notarizar exige uma conta paga de desenvolvedor Apple. | Uma release crível para macOS; também permissões TCC confiáveis para Contatos e microfone. E a atualização automática no macOS (hoje o app apenas avisa). Custa 99 USD/ano. TODO e passos em [docs/releasing.md](docs/releasing.md#todo-apple-developer-id-certificate). |
| **Formato do ícone no macOS 26** | O app não traz o novo formato do Icon Composer, então o macOS 26 reestiliza o ícone. | Apenas estético; pode esperar. |
| **Modelo de consentimento da gravação** | Aviso sonoro, consentimento por chamada, indicador visível ou uma combinação; e o que "gravar todas" significa sob ele. | Fase 3. |
| **Gravações em repouso** | Se as gravações são criptografadas como as credenciais. O histórico foi decidido: sem criptografia, limitado a 500 entradas, com opção de limpar. | Fase 3. |
| **Fonte de contatos no Linux** | Não existe uma agenda única no Linux. | Fase 2 no Linux. |
