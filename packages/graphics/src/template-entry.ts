import ts from 'typescript';
import { templatePropSchemas } from './template-props.js';
import type { GraphicTemplate } from './template-props.js';

const templateModules = new Set([
  '@opencut/graphics/templates',
  '@dantea/opencut/graphics/templates',
]);
function isTemplateModule(node: ts.Expression | undefined) {
  return node && ts.isStringLiteral(node) && templateModules.has(node.text);
}
function templateName(key: string) {
  return Object.hasOwn(templatePropSchemas, key)
    ? (key as GraphicTemplate)
    : undefined;
}

/** Recognize direct template entries without executing authored modules in Node. */
export function templateEntry(
  path: string,
  content: string,
): GraphicTemplate | undefined {
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    false,
  );
  const imports = new Map<string, GraphicTemplate>();
  let defaultIdentifier: string | undefined;
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const member of statement.exportClause.elements) {
        if (member.isTypeOnly || member.name.text !== 'default') continue;
        const name = member.propertyName?.text ?? member.name.text;
        if (!statement.moduleSpecifier) defaultIdentifier = name;
        else if (isTemplateModule(statement.moduleSpecifier))
          return templateName(name);
      }
    }
    if (
      ts.isImportDeclaration(statement) &&
      isTemplateModule(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;
      if (
        clause &&
        !clause.isTypeOnly &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings)
      )
        for (const member of clause.namedBindings.elements) {
          const name = templateName(
            member.propertyName?.text ?? member.name.text,
          );
          if (name && !member.isTypeOnly) imports.set(member.name.text, name);
        }
    }
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    )
      defaultIdentifier = statement.expression.text;
  }
  return (defaultIdentifier && imports.get(defaultIdentifier)) || undefined;
}
