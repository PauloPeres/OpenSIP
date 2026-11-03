# Contributing to OpenSIP · Como contribuir

## English

### The workflow is test-first

1. **Write a failing test.** A unit spec in `tests/unit/*.spec.ts` or a Gherkin
   scenario in `tests/features/*.feature`.
2. **Run it and read the failure.** It must fail because the behaviour is missing, not
   because of a typo or a config error. A test that passes before you write the code
   proves nothing.
3. **Write the smallest production change that makes it pass.** Empty `catch` blocks,
   blind guards and assertions weakened to fit the implementation are rejected in
   review.
4. **Refactor until every gate is green:** `npm run verify`.

### Non-negotiable rules

- **No user-facing string in code.** Every label, placeholder, error and tooltip goes
  through `t('some.key')`, and both `src/core/i18n/locales/en.json` and `pt-BR.json`
  are updated in the same commit. Domain validation returns i18n *keys*, never prose.
- **Pure domain.** New state transitions belong in `src/core` as pure functions.
  `src/main/sip-engine.ts` is an adapter: it may translate sip.js events into core
  events and nothing else.
- **Small functions.** 20 lines maximum, cyclomatic complexity 8 maximum, nesting
  depth 3 maximum. Prefer a lookup table over a `switch`: a table has complexity 1 and
  costs nothing in CRAP.
- **Tests that kill mutants.** Assert real values and the exact boundaries. If
  flipping `>` to `>=` or inverting a boolean leaves your suite green, the mutation
  gate will fail the build.
- **No duplication.** No clone of 5 lines / 40 tokens or more, anywhere in `src`.

### Commit messages

Every commit is small, atomic and ordered, and states three things:

```
<type>(<scope>): <imperative summary>

WHY: the reason the change exists.
WHAT: what actually changed.
HOW PROVEN: the deterministic evidence it works — which test was written first,
how it failed, and the numbers it reports now.
```

### Before opening a pull request

```bash
npm run verify
```

This runs, in order: typecheck, lint, the i18n gate, unit tests with coverage
thresholds, the Gherkin suite, the CRAP gate and the duplication gate. CI additionally
runs mutation testing and builds on Linux, macOS and Windows.

---

## Português

### O fluxo é teste primeiro

1. **Escreva um teste que falhe.** Um spec unitário em `tests/unit/*.spec.ts` ou um
   cenário Gherkin em `tests/features/*.feature`.
2. **Rode e leia a falha.** Ela precisa acontecer porque o comportamento não existe, e
   não por erro de digitação ou de configuração. Um teste que passa antes do código
   não prova nada.
3. **Faça a menor mudança de produção que o faça passar.** `catch` vazio, guardas
   cegas e asserções enfraquecidas para caber na implementação são rejeitadas na
   revisão.
4. **Refatore até todos os portões ficarem verdes:** `npm run verify`.

### Regras não negociáveis

- **Nenhum texto de usuário no código.** Todo rótulo, placeholder, erro e dica passa
  por `t('alguma.chave')`, e tanto `src/core/i18n/locales/en.json` quanto `pt-BR.json`
  são atualizados no mesmo commit. A validação de domínio devolve *chaves* de i18n,
  nunca frases.
- **Domínio puro.** Novas transições de estado vivem em `src/core`, como funções
  puras. O `src/main/sip-engine.ts` é um adaptador: pode traduzir eventos do sip.js em
  eventos do domínio e nada mais.
- **Funções pequenas.** No máximo 20 linhas, complexidade ciclomática 8 e profundidade
  de aninhamento 3. Prefira tabela de consulta a `switch`: a tabela tem complexidade 1
  e não custa nada no CRAP.
- **Testes que matam mutantes.** Afirme valores reais e os limites exatos. Se trocar
  `>` por `>=` ou inverter um booleano mantiver a sua suíte verde, o portão de mutação
  vai derrubar o build.
- **Nenhuma duplicação.** Nenhum clone de 5 linhas / 40 tokens ou mais em `src`.

### Mensagens de commit

Todo commit é pequeno, atômico, ordenado e diz três coisas:

```
<tipo>(<escopo>): <resumo no imperativo>

WHY: o motivo da mudança existir.
WHAT: o que mudou de fato.
HOW PROVEN: a prova determinística de que funciona — qual teste foi escrito
primeiro, como ele falhou e os números que ele reporta agora.
```

### Antes de abrir um pull request

```bash
npm run verify
```

Isso roda, em ordem: typecheck, lint, portão de i18n, testes unitários com limites de
cobertura, suíte Gherkin, portão CRAP e portão de duplicação. A CI roda, além disso,
testes de mutação e builds em Linux, macOS e Windows.
