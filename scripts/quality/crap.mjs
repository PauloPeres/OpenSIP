#!/usr/bin/env node
// CRAP gate: complexity^2 * (1 - coverage)^3 + complexity, per function.
// Usage: node scripts/quality/crap.mjs [--threshold=10] [--coverage=coverage/coverage-final.json]
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const DEFAULT_THRESHOLD = 10;
const WORST_COUNT = 15;

function parseArgs(argv) {
  const opts = { threshold: DEFAULT_THRESHOLD, coverage: 'coverage/coverage-final.json' };
  for (const arg of argv) {
    if (arg.startsWith('--threshold=')) opts.threshold = Number(arg.slice(12));
    else if (arg.startsWith('--coverage=')) opts.coverage = arg.slice(11);
  }
  if (!Number.isFinite(opts.threshold)) throw new Error('Invalid --threshold value');
  return opts;
}

function loadCoverage(path) {
  const full = resolve(path);
  if (!existsSync(full)) {
    console.error(`Coverage file not found: ${full}\nRun \`npm run test:coverage\` first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(full, 'utf8'));
}

const isFunctionLike = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken
]);

/** Number of decision points contributed by this single node. */
function decisionPoints(node) {
  if (
    ts.isIfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCaseClause(node)
  ) {
    return 1;
  }
  if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) return 1;
  return 0;
}

function scriptKindFor(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function functionName(node, sf) {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (node.name) return node.name.getText(sf);
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  return `<anonymous>@${line}`;
}

/** Collect every function with its complexity (innermost attribution). */
function collectFunctions(sf) {
  const found = [];
  const visit = (node, owner) => {
    let current = owner;
    if (isFunctionLike(node)) {
      current = {
        name: functionName(node, sf),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        start: node.getStart(sf),
        end: node.end,
        complexity: 1,
        statements: 0,
        covered: 0
      };
      found.push(current);
    } else if (current) {
      current.complexity += decisionPoints(node);
    }
    ts.forEachChild(node, (child) => visit(child, current));
  };
  visit(sf, null);
  return found;
}

function innermost(functions, offset) {
  let best = null;
  for (const fn of functions) {
    if (offset > fn.start && offset < fn.end && (!best || fn.start >= best.start)) best = fn;
  }
  return best;
}

function attributeStatements(functions, fileCov, sf) {
  for (const [id, loc] of Object.entries(fileCov.statementMap)) {
    const offset = sf.getPositionOfLineAndCharacter(loc.start.line - 1, loc.start.column);
    const fn = innermost(functions, offset);
    if (!fn) continue;
    fn.statements += 1;
    if (fileCov.s[id] > 0) fn.covered += 1;
  }
}

export const crap = (complexity, coverage) => complexity ** 2 * (1 - coverage) ** 3 + complexity;

function analyseFile(path, fileCov) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const functions = collectFunctions(sf);
  attributeStatements(functions, fileCov, sf);
  return functions.map((fn) => {
    const coverage = fn.statements === 0 ? 1 : fn.covered / fn.statements;
    return { file: path, line: fn.line, name: fn.name, complexity: fn.complexity, coverage, crap: crap(fn.complexity, coverage) };
  });
}

function rel(path) {
  return path.startsWith(process.cwd() + '/') ? path.slice(process.cwd().length + 1) : path;
}

const fmt = (r) =>
  `${rel(r.file)}:${r.line}`.padEnd(48) +
  r.name.padEnd(28) +
  String(r.complexity).padStart(5) +
  `${(r.coverage * 100).toFixed(1)}%`.padStart(10) +
  r.crap.toFixed(2).padStart(10);

function report(results, threshold) {
  const header = 'file:line'.padEnd(48) + 'function'.padEnd(28) + 'cc'.padStart(5) + 'cov'.padStart(10) + 'CRAP'.padStart(10);
  console.log(`Worst ${WORST_COUNT} functions by CRAP (threshold < ${threshold}):`);
  console.log(header);
  const sorted = [...results].sort((a, b) => b.crap - a.crap);
  for (const r of sorted.slice(0, WORST_COUNT)) console.log(fmt(r));
  const violations = sorted.filter((r) => r.crap >= threshold);
  if (violations.length === 0) {
    console.log('\nCRAP gate passed');
    return 0;
  }
  console.error(`\nCRAP gate FAILED: ${violations.length} function(s) with CRAP >= ${threshold}`);
  for (const r of violations) console.error(`  ${rel(r.file)}:${r.line} ${r.name} (cc=${r.complexity}, cov=${(r.coverage * 100).toFixed(1)}%, CRAP=${r.crap.toFixed(2)})`);
  return 1;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const coverage = loadCoverage(opts.coverage);
  const results = Object.values(coverage).flatMap((fileCov) => analyseFile(fileCov.path, fileCov));
  process.exit(report(results, opts.threshold));
}

main();
