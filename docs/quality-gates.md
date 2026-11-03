# Quality gates

Run everything with `npm run verify`. CI (`.github/workflows/ci.yml`) runs the same steps on Node 20 and 22, plus mutation tests on Node 22 only.

## English

| Gate | Command | Threshold | How to fix a failure |
|---|---|---|---|
| Typecheck | `npm run typecheck` | `tsc --noEmit` must report zero errors | Fix the reported type errors. |
| Lint | `npm run lint` | ESLint must report no errors | Fix the code; do not disable rules to silence them. |
| i18n | `npm run gate:i18n` | See below | See below. |
| Unit tests + coverage | `npm run test:coverage` | Vitest (v8) over `src/core/**`: lines 95%, functions 95%, branches 90%, statements 95% | Add tests for uncovered code. Writes `coverage/coverage-final.json`. |
| BDD | `npm run test:bdd` | All Cucumber scenarios pass | Fix the behaviour or the scenario. |
| CRAP | `npm run gate:crap` | Every function must have CRAP **< 10** | Split complex functions and/or add tests. Needs `npm run test:coverage` first. |
| Duplication | `npm run gate:dry` | `jscpd src` (minTokens 40, minLines 5, threshold 0%): no duplicated blocks | Extract the shared code into a function or module. |
| Mutation | `npm run gate:mutation` | Stryker over `src/core/**/*.ts`: mutation score must be >= 90 (break) | Add assertions that kill surviving mutants (see the clear-text report). Slow; CI runs it on Node 22 only. |

### CRAP gate details
`scripts/quality/crap.mjs` reads `coverage/coverage-final.json`, parses each file with the TypeScript compiler API and computes per function:

- Cyclomatic complexity = 1 + `if`, non-default `case`, `while`, `do`, `for`/`for-in`/`for-of`, `catch`, `?:`, `&&`, `||`, `??`. Nested functions are counted separately.
- Statement coverage = covered / total statements inside the function (innermost function; no statements means 100%).
- CRAP = complexity^2 * (1 - coverage)^3 + complexity.

It prints the 15 worst functions and exits 1 if any has CRAP >= 10. Options: `--threshold=<n>`, `--coverage=<path>`.

### i18n gate details
`scripts/quality/i18n-gate.mjs` fails when:

- `src/core/i18n/locales/en.json` or `pt-BR.json` is missing, their key sets differ, a value is empty, or a `{placeholder}` exists in one locale but not in the other for the same key.
- A string literal or JSX text containing a letter in `src/renderer/**/*.{ts,tsx}` is not passed through `t(...)`. Not flagged: import specifiers, `t(...)` arguments, object keys, type literals, technical JSX attributes (`className`, `id`, `type`, `role`, `href`, `src`, `key`, `name`, `htmlFor`, `data-*`, `aria-hidden`; `alt` IS checked), identifier-like strings (`/^[a-z0-9._-]+$/`), and lines marked with `// i18n-exempt` (same line or the line above).
- A literal `t('key')` anywhere in `src/**` uses a key missing from either dictionary.

Fix: move the text to both JSON files and use `t('key')`.

## Português

Execute tudo com `npm run verify`. O CI (`.github/workflows/ci.yml`) roda os mesmos passos em Node 20 e 22, e os testes de mutação apenas em Node 22.

| Gate | Comando | Limite | Como corrigir |
|---|---|---|---|
| Typecheck | `npm run typecheck` | `tsc --noEmit` sem erros | Corrija os erros de tipo. |
| Lint | `npm run lint` | ESLint sem erros | Corrija o código; não desative regras para silenciar. |
| i18n | `npm run gate:i18n` | Veja abaixo | Veja abaixo. |
| Testes unitários + cobertura | `npm run test:coverage` | Vitest (v8) em `src/core/**`: linhas 95%, funções 95%, branches 90%, statements 95% | Adicione testes ao código não coberto. Gera `coverage/coverage-final.json`. |
| BDD | `npm run test:bdd` | Todos os cenários Cucumber passam | Corrija o comportamento ou o cenário. |
| CRAP | `npm run gate:crap` | Toda função deve ter CRAP **< 10** | Divida funções complexas e/ou adicione testes. Requer `npm run test:coverage` antes. |
| Duplicação | `npm run gate:dry` | `jscpd src` (minTokens 40, minLines 5, limite 0%): nenhum bloco duplicado | Extraia o código comum para uma função ou módulo. |
| Mutação | `npm run gate:mutation` | Stryker em `src/core/**/*.ts`: score de mutação >= 90 (break) | Adicione asserções que matem os mutantes sobreviventes (veja o relatório). Lento; o CI roda apenas em Node 22. |

### Detalhes do gate CRAP
`scripts/quality/crap.mjs` lê `coverage/coverage-final.json`, analisa cada arquivo com a API do compilador TypeScript e calcula por função:

- Complexidade ciclomática = 1 + `if`, `case` (exceto `default`), `while`, `do`, `for`/`for-in`/`for-of`, `catch`, `?:`, `&&`, `||`, `??`. Funções aninhadas são contadas separadamente.
- Cobertura de statements = statements cobertos / total dentro da função (função mais interna; sem statements = 100%).
- CRAP = complexidade^2 * (1 - cobertura)^3 + complexidade.

Imprime as 15 piores funções e sai com código 1 se alguma tiver CRAP >= 10. Opções: `--threshold=<n>`, `--coverage=<caminho>`.

### Detalhes do gate i18n
`scripts/quality/i18n-gate.mjs` falha quando:

- `src/core/i18n/locales/en.json` ou `pt-BR.json` não existe, os conjuntos de chaves diferem, um valor está vazio, ou um `{placeholder}` existe em um idioma e não no outro para a mesma chave.
- Uma string literal ou texto JSX com letras em `src/renderer/**/*.{ts,tsx}` não passa por `t(...)`. Não são sinalizados: especificadores de import, argumentos de `t(...)`, chaves de objeto, tipos literais, atributos JSX técnicos (`className`, `id`, `type`, `role`, `href`, `src`, `key`, `name`, `htmlFor`, `data-*`, `aria-hidden`; `alt` É verificado), strings tipo identificador (`/^[a-z0-9._-]+$/`) e linhas marcadas com `// i18n-exempt` (na mesma linha ou na anterior).
- Um `t('chave')` literal em `src/**` usa uma chave ausente em algum dos dicionários.

Correção: mova o texto para os dois arquivos JSON e use `t('chave')`.
