#!/usr/bin/env node
// i18n gate: dictionary parity, hardcoded UI strings, unknown t('key') usages.
// Usage: node scripts/quality/i18n-gate.mjs [--root=<repo root>]   (default: cwd)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const LOCALES = ['en', 'pt-BR'];
const TECHNICAL_ATTRS = new Set(['classname', 'id', 'type', 'role', 'href', 'src', 'key', 'name', 'htmlfor', 'aria-hidden']);
const IDENTIFIER = /^[a-z0-9._-]+$/;
const HAS_LETTER = /\p{L}/u;
const EXEMPT_MARKER = 'i18n-exempt';

const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = resolve(rootArg ? rootArg.slice(7) : process.cwd());
const errors = [];

// ---------- dictionaries ----------
function loadLocale(code) {
  const path = join(ROOT, 'src/core/i18n/locales', `${code}.json`);
  if (!existsSync(path)) {
    errors.push(`Missing locale file: ${relative(ROOT, path)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    errors.push(`Invalid JSON in ${relative(ROOT, path)}: ${e.message}`);
    return null;
  }
}

const placeholders = (s) => new Set([...String(s).matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]));

function checkParity(a, b, nameA, nameB) {
  for (const key of Object.keys(a)) {
    if (!(key in b)) errors.push(`Key "${key}" present in ${nameA} but missing in ${nameB}`);
  }
}

function checkValues(dict, name) {
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value !== 'string' || value.trim() === '') errors.push(`Empty or non-string value for "${key}" in ${name}`);
  }
}

function checkPlaceholders(a, b, nameA, nameB) {
  for (const key of Object.keys(a)) {
    if (!(key in b)) continue;
    const other = placeholders(b[key]);
    for (const p of placeholders(a[key])) {
      if (!other.has(p)) errors.push(`Placeholder {${p}} of "${key}" in ${nameA} is missing in ${nameB}`);
    }
  }
}

function checkDictionaries(dicts) {
  const [en, pt] = dicts;
  if (!en || !pt) return;
  checkParity(en, pt, 'en', 'pt-BR');
  checkParity(pt, en, 'pt-BR', 'en');
  checkValues(en, 'en');
  checkValues(pt, 'pt-BR');
  checkPlaceholders(en, pt, 'en', 'pt-BR');
  checkPlaceholders(pt, en, 'pt-BR', 'en');
}

// ---------- source scanning ----------
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const parse = (file) =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const isStringLike = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

function isTCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const c = node.expression;
  return (ts.isIdentifier(c) && c.text === 't') || (ts.isPropertyAccessExpression(c) && c.name.text === 't');
}

function hasExemptComment(sf, node) {
  const lines = sf.text.split('\n');
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  return lines[line].includes(EXEMPT_MARKER) || (line > 0 && lines[line - 1].includes(EXEMPT_MARKER));
}

function inTechnicalAttr(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return TECHNICAL_ATTRS.has(p.name.getText().toLowerCase()) || /^data-/i.test(p.name.getText());
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

/** True when the literal is a technical use rather than user-facing text. */
function isExemptLiteral(node) {
  const p = node.parent;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) || ts.isImportTypeNode(p) || ts.isLiteralTypeNode(p.parent ?? p)) return true;
  if (ts.isExpressionStatement(p)) return true; // "use strict"
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) || ts.isEnumMember(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isCallExpression(p) && isTCall(p) && p.arguments[0] === node) return true;
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'require') return true;
  return inTechnicalAttr(node);
}

function isUserFacingText(text) {
  const trimmed = text.trim();
  return trimmed !== '' && HAS_LETTER.test(trimmed) && !IDENTIFIER.test(trimmed);
}

function reportAt(sf, node, text) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  errors.push(`${relative(ROOT, sf.fileName)}:${line + 1}:${character + 1} hardcoded UI string: ${JSON.stringify(text.trim())}`);
}

function scanHardcoded(sf) {
  const visit = (node) => {
    if (isStringLike(node) && !isExemptLiteral(node) && isUserFacingText(node.text) && !hasExemptComment(sf, node)) {
      reportAt(sf, node, node.text);
    } else if (ts.isJsxText(node) && HAS_LETTER.test(node.text) && !hasExemptComment(sf, node)) {
      reportAt(sf, node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function collectKeys(sf, used) {
  const visit = (node) => {
    if (isTCall(node) && node.arguments[0] && isStringLike(node.arguments[0])) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.arguments[0].getStart(sf));
      used.push({ key: node.arguments[0].text, where: `${relative(ROOT, sf.fileName)}:${line + 1}:${character + 1}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function checkKeys(used, dicts) {
  const [en, pt] = dicts;
  if (!en || !pt) return;
  for (const { key, where } of used) {
    if (!(key in en)) errors.push(`${where} unknown i18n key "${key}" (missing in en)`);
    if (!(key in pt)) errors.push(`${where} unknown i18n key "${key}" (missing in pt-BR)`);
  }
}

function main() {
  const dicts = LOCALES.map(loadLocale);
  checkDictionaries(dicts);
  for (const file of walk(join(ROOT, 'src/renderer'))) scanHardcoded(parse(file));
  const used = [];
  for (const file of walk(join(ROOT, 'src'))) collectKeys(parse(file), used);
  checkKeys(used, dicts);
  if (errors.length === 0) {
    console.log('i18n gate passed');
    return;
  }
  console.error(errors.join('\n'));
  console.error(`\ni18n gate FAILED: ${errors.length} problem(s)`);
  process.exit(1);
}

main();
