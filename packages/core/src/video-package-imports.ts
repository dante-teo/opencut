import { readFile } from 'node:fs/promises';
import type { ScriptImport } from './video-script.js';
import { videoInputIdentity } from './video-input.js';
import { VideoDefinitionError } from './video-definition.js';

/** The runtime trace misses erased type imports and inactive literal imports. */
export async function scanPackageImports(path: string, signal?: AbortSignal) {
  if (!/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(path)) return [];
  signal?.throwIfAborted();
  const ts = await import('typescript');
  const identity = videoInputIdentity(path);
  const text = await readFile(path, { encoding: 'utf8', signal });
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  if (!identity || videoInputIdentity(path) !== identity)
    throw new VideoDefinitionError(
      `Package module '${path}' changed during discovery.`,
    );
  const imports: ScriptImport[] = [];
  const add = (specifier: string) => imports.push({ parent: path, specifier });
  for (const { fileName } of source.referencedFiles)
    add(/^(?:\.{1,2}\/|\/)/.test(fileName) ? fileName : './' + fileName);
  const visit = (node: import('typescript').Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
        add(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node)) {
      if (
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        add(node.argument.literal.text);
    } else if (ts.isExternalModuleReference(node)) {
      if (node.expression && ts.isStringLiteralLike(node.expression))
        add(node.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) add(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}
