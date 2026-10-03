import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

export const unitFiles = new Set([
  'tests/core.test.ts',
  'tests/ai-plan.test.ts',
  'tests/presentation.test.ts',
  'tests/report-period.test.ts',
  'tests/api-response.test.ts',
  'tests/auth-web.test.ts',
  'tests/finance-contracts.test.ts',
  'tests/finance-tax.test.ts',
  'tests/finance-ui.test.ts',
  'tests/web-routing.test.ts',
  'tests/web-intent.test.ts',
  'tests/web-rewrite.test.ts',
]);

export function testFiles(): string[] {
  return readdirSync('tests')
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `tests/${name}`)
    .sort();
}

export function browserTestFiles(): string[] {
  return readdirSync('tests/browser')
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => `tests/browser/${name}`)
    .sort();
}

export function manifestLine(file: string, name: string): string {
  return `${relative(process.cwd(), resolve(file)).replaceAll('\\', '/')}\t${name}`;
}

// Parse registration calls rather than matching text: multiline and nested tests are included.
// JSON and literal-array fixtures are expanded without executing test code.
// An unresolvable dynamic name fails closed.
export function testInventory(files = [...testFiles(), ...browserTestFiles()]): string[] {
  const inventory: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const fixtures = new Map<string, unknown[]>();
    const registrations = new Set<string>();
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        ['node:test', '@playwright/test'].includes(statement.moduleSpecifier.text)
      ) {
        if (statement.importClause?.name) registrations.add(statement.importClause.name.text);
        const imports = statement.importClause?.namedBindings;
        if (imports && ts.isNamedImports(imports)) {
          for (const entry of imports.elements) {
            if ((entry.propertyName?.text ?? entry.name.text) === 'test')
              registrations.add(entry.name.text);
          }
        }
      }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.endsWith('.json') &&
        statement.importClause?.name
      ) {
        const values: unknown = JSON.parse(
          readFileSync(resolve(dirname(file), statement.moduleSpecifier.text), 'utf8'),
        );
        if (!Array.isArray(values)) throw new Error(`${file}: test fixture must be an array`);
        fixtures.set(statement.importClause.name.text, values);
      }
    }
    function evaluate(expression: ts.Expression, bindings: Map<string, unknown>): unknown {
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        return expression.text;
      }
      if (ts.isNumericLiteral(expression)) return Number(expression.text);
      if (ts.isIdentifier(expression))
        return bindings.get(expression.text) ?? fixtures.get(expression.text);
      if (ts.isArrayLiteralExpression(expression))
        return expression.elements.map((element) => evaluate(element, bindings));
      if (ts.isObjectLiteralExpression(expression)) {
        const value: Record<string, unknown> = {};
        for (const property of expression.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ) {
            value[property.name.text] = evaluate(property.initializer, bindings);
          }
        }
        return value;
      }
      if (ts.isPropertyAccessExpression(expression)) {
        const value = evaluate(expression.expression, bindings);
        return value && typeof value === 'object'
          ? (value as Record<string, unknown>)[expression.name.text]
          : undefined;
      }
      if (ts.isTemplateExpression(expression)) {
        let value = expression.head.text;
        for (const span of expression.templateSpans) {
          const part = evaluate(span.expression, bindings);
          if (typeof part !== 'string' && typeof part !== 'number') return undefined;
          value += String(part) + span.literal.text;
        }
        return value;
      }
      return undefined;
    }
    function visit(
      node: ts.Node,
      bindings: Map<string, unknown> = new Map(),
      contexts = new Set<string>(),
    ): void {
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        const declaration = node.initializer.declarations[0];
        const values = evaluate(node.expression, bindings);
        if (Array.isArray(values) && declaration && ts.isIdentifier(declaration.name)) {
          for (const value of values) {
            const inner = new Map(bindings);
            inner.set(declaration.name.text, value);
            visit(node.statement, inner, contexts);
          }
          return;
        }
      }
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && registrations.has(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'test' &&
            ts.isIdentifier(node.expression.expression) &&
            contexts.has(node.expression.expression.text)))
      ) {
        const argument = node.arguments[0];
        const name = argument ? evaluate(argument, bindings) : undefined;
        if (typeof name !== 'string' || /[\r\n\t]/u.test(name)) {
          throw new Error(`${file}: unresolved test name at ${node.getStart(source)}`);
        }
        inventory.push(manifestLine(file, name));
        const callback = node.arguments.at(-1);
        const inner = new Set(contexts);
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const parameter = callback.parameters[0];
          if (parameter && ts.isIdentifier(parameter.name)) inner.add(parameter.name.text);
        }
        ts.forEachChild(node, (child) =>
          visit(child, bindings, child === callback ? inner : contexts),
        );
        return;
      }
      ts.forEachChild(node, (child) => visit(child, bindings, contexts));
    }
    visit(source);
  }
  return inventory.sort();
}
