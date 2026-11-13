import fs from 'fs';
import path from 'path';
import {
  ProposalDependencyGraph,
  UnresolvedReference,
  VbAstFile,
  VbAstMethod,
  VbAstType,
} from './types.ts';

function joinVbContinuations(raw: string): string[] {
  const rawLines = raw.split(/\r?\n/);
  const result: string[] = [];
  let buffer = '';

  for (const line of rawLines) {
    const trimmedRight = line.replace(/\s+$/, '');
    if (trimmedRight.endsWith(' _')) {
      buffer += trimmedRight.slice(0, -1) + ' ';
    } else {
      result.push(buffer + line);
      buffer = '';
    }
  }
  if (buffer) result.push(buffer);
  return result;
}

function stripVbCommentAndStrings(line: string): string {
  let inStr = false;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inStr && line[i + 1] === '"') {
        i++;
        continue;
      }
      inStr = !inStr;
      out += '"';
      continue;
    }
    if (!inStr && ch === "'") break;
    if (!inStr) out += ch;
  }
  return out;
}

export class VbAstAnalyzer {
  public parseFile(filePath: string, sourceOverride?: string): VbAstFile {
    const source = sourceOverride ?? fs.readFileSync(filePath, 'utf-8');
    const lines = joinVbContinuations(source);

    const imports: string[] = [];
    const namespaces = new Set<string>();
    const types: VbAstType[] = [];
    const planCodes = new Set<string>();
    const datasetNames = new Set<string>();
    const rdlcReferences = new Set<string>();
    const productEngineCalls = new Set<string>();

    let currentNamespace = '';
    let currentType: VbAstType | null = null;
    let currentMethod: {
      name: string;
      kind: VbAstMethod['kind'];
      signature: string;
      startLine: number;
      lines: string[];
    } | null = null;

    const finalizeMethod = (endLine: number) => {
      if (!currentMethod || !currentType) return;
      const bodyText = currentMethod.lines.join('\n');
      const instantiations = Array.from(
        new Set(Array.from(bodyText.matchAll(/\bNew\s+([A-Za-z0-9_.]+)\s*\(/gi)).map((m) => m[1]))
      );
      const methodRdlcs = Array.from(
        new Set(Array.from(bodyText.matchAll(/"([^"\n]+\.rdlc)"/gi)).map((m) => m[1]))
      );
      const methodEngine = Array.from(
        new Set(
          Array.from(bodyText.matchAll(/\b(?:ProductEngine|_?engine)\.[A-Za-z0-9_]+/gi)).map((m) => m[0])
        )
      );
      const elementCalls = Array.from(
        new Set(
          Array.from(bodyText.matchAll(/\b([A-Za-z0-9_]+Element(?:\.[A-Za-z0-9_]+)?)\s*\(/gi)).map(
            (m) => m[1]
          )
        )
      );
      const referencedFields = Array.from(
        new Set(
          Array.from(bodyText.matchAll(/(?:Fields!|row\("|dr\("|dto\.)([A-Za-z0-9_]+)/gi)).map(
            (m) => m[1]
          )
        )
      );
      const tableColumns = Array.from(
        new Set(
          Array.from(bodyText.matchAll(/\.Columns\.Add\(\s*"([A-Za-z0-9_]+)"/gi)).map((m) => m[1])
        )
      );

      for (const r of methodRdlcs) rdlcReferences.add(r);
      for (const pe of methodEngine) productEngineCalls.add(pe);

      currentType.methods.push({
        name: currentMethod.name,
        kind: currentMethod.kind,
        signature: currentMethod.signature,
        startLine: currentMethod.startLine,
        endLine,
        bodyText,
        instantiations,
        rdlcReferences: methodRdlcs,
        productEngineCalls: methodEngine,
        elementCalls,
        referencedFields,
        tableColumns,
      });
      currentMethod = null;
    };

    for (let idx = 0; idx < lines.length; idx++) {
      const rawLine = lines[idx];
      const lineNum = idx + 1;
      const code = stripVbCommentAndStrings(rawLine).trim();

      // Collect string literals directly from rawLine for .rdlc, PlanCode, DataTable/DataSet names
      for (const m of rawLine.matchAll(/"([^"\n]+\.rdlc)"/gi)) {
        rdlcReferences.add(m[1]);
      }
      for (const m of rawLine.matchAll(/PlanCode[^=]*=\s*"([A-Za-z0-9_-]+)"/gi)) {
        planCodes.add(m[1]);
      }
      for (const m of rawLine.matchAll(/New\s+(?:DataTable|DataSet)\(\s*"([A-Za-z0-9_]+)"/gi)) {
        datasetNames.add(m[1]);
      }
      for (const m of rawLine.matchAll(/\b(?:ProductEngine|_?engine)\.[A-Za-z0-9_]+/gi)) {
        productEngineCalls.add(m[0]);
      }

      if (/^Imports\s+([A-Za-z0-9_.]+)/i.test(code)) {
        imports.push(code.replace(/^Imports\s+/i, '').trim());
        continue;
      }

      const nsMatch = code.match(/^Namespace\s+([A-Za-z0-9_.]+)/i);
      if (nsMatch) {
        currentNamespace = nsMatch[1];
        namespaces.add(currentNamespace);
        continue;
      }
      if (/^End\s+Namespace\b/i.test(code)) {
        currentNamespace = '';
        continue;
      }

      const typeMatch = code.match(
        /^(?:Public|Friend|Private|Protected)?\s*(?:Partial\s+|MustInherit\s+|NotInheritable\s+)?(Class|Module|Interface)\s+([A-Za-z0-9_]+)/i
      );
      if (typeMatch) {
        currentType = {
          name: typeMatch[2],
          kind: (typeMatch[1].charAt(0).toUpperCase() + typeMatch[1].slice(1).toLowerCase()) as VbAstType['kind'],
          namespaceName: currentNamespace,
          inherits: [],
          implementsList: [],
          methods: [],
        };
        types.push(currentType);
        continue;
      }

      if (/^End\s+(?:Class|Module|Interface)\b/i.test(code)) {
        finalizeMethod(lineNum);
        currentType = null;
        continue;
      }

      if (currentType && !currentMethod) {
        const inhMatch = code.match(/^Inherits\s+([A-Za-z0-9_.]+)/i);
        if (inhMatch) {
          currentType.inherits.push(inhMatch[1]);
          continue;
        }
        const impMatch = code.match(/^Implements\s+(.+)/i);
        if (impMatch) {
          currentType.implementsList.push(
            ...impMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
          );
          continue;
        }
      }

      const methodMatch = code.match(
        /^(?:Public|Friend|Private|Protected)?\s*(?:Shared\s+|Overrides\s+|Overridable\s+|Async\s+)?(Function|Sub|Property)\s+([A-Za-z0-9_]+)\s*\(/i
      );
      if (methodMatch && currentType) {
        finalizeMethod(lineNum - 1);
        currentMethod = {
          name: methodMatch[2],
          kind: (methodMatch[1].charAt(0).toUpperCase() + methodMatch[1].slice(1).toLowerCase()) as VbAstMethod['kind'],
          signature: rawLine.trim(),
          startLine: lineNum,
          lines: [rawLine],
        };
        continue;
      }

      if (currentMethod) {
        currentMethod.lines.push(rawLine);
        if (/^End\s+(?:Function|Sub|Property)\b/i.test(code)) {
          finalizeMethod(lineNum);
        }
      }
    }

    finalizeMethod(lines.length);

    return {
      filePath,
      fileName: path.basename(filePath),
      imports,
      namespaces: Array.from(namespaces),
      types,
      planCodes: Array.from(planCodes),
      datasetNames: Array.from(datasetNames),
      rdlcReferences: Array.from(rdlcReferences),
      productEngineCalls: Array.from(productEngineCalls),
    };
  }

  public buildDependencyGraph(input: {
    productCode: string;
    builderAst: VbAstFile;
    allVbAsts: VbAstFile[];
    allRdlcFiles: string[];
  }): ProposalDependencyGraph {
    const builderClass =
      input.builderAst.types.find((t) => /Builder/i.test(t.name))?.name ??
      input.builderAst.types[0]?.name ??
      `${input.productCode}ProposalBuilder`;

    const allMethods = input.builderAst.types.flatMap((t) => t.methods);
    const elementTypeMap = new Map<string, { ast: VbAstFile; type: VbAstType }>();
    for (const ast of input.allVbAsts) {
      for (const t of ast.types) {
        elementTypeMap.set(t.name.toLowerCase(), { ast, type: t });
      }
    }

    const elementsMap = new Map<
      string,
      ProposalDependencyGraph['elements'][number]
    >();
    const rdlcEntries = new Map<string, ProposalDependencyGraph['rdlcFiles'][number]>();
    const unresolvedReferences: UnresolvedReference[] = [];
    const seenUnresolved = new Set<string>();

    const addUnresolved = (
      kind: UnresolvedReference['kind'],
      symbolOrName: string,
      referencedFrom: string,
      reason: string
    ) => {
      const key = `${kind}:${symbolOrName.toLowerCase()}:${referencedFrom.toLowerCase()}`;
      if (seenUnresolved.has(key)) return;
      seenUnresolved.add(key);
      unresolvedReferences.push({
        productCode: input.productCode,
        kind,
        symbolOrName,
        referencedFrom,
        reason,
      });
    };

    const registerRdlcRef = (
      refName: string,
      referencedFrom: string,
      classification: 'direct' | 'indirect'
    ) => {
      const cleanName = path.basename(refName);
      const resolvedPath = input.allRdlcFiles.find(
        (f) => path.basename(f).toLowerCase() === cleanName.toLowerCase()
      );
      if (!resolvedPath && classification === 'direct') {
        addUnresolved(
          'RDLC',
          cleanName,
          referencedFrom,
          `Referenced RDLC "${cleanName}" was not found in the target project.`
        );
      }
      const existing = rdlcEntries.get(cleanName.toLowerCase());
      if (existing) {
        if (classification === 'direct') existing.classification = 'direct';
        return;
      }
      rdlcEntries.set(cleanName.toLowerCase(), {
        name: cleanName,
        resolvedPath,
        referencedFrom,
        classification,
        datasets: [],
      });
    };

    for (const r of input.builderAst.rdlcReferences) {
      registerRdlcRef(r, input.builderAst.fileName, 'direct');
    }

    for (const m of allMethods) {
      const referencedClasses = new Map<string, string>();
      for (const inst of m.instantiations) {
        const clsName = inst.split('.').pop()!;
        referencedClasses.set(clsName.toLowerCase(), clsName);
      }
      for (const ec of m.elementCalls) {
        const cls = ec.includes('.') ? ec.split('.')[0] : '';
        if (cls) referencedClasses.set(cls.toLowerCase(), cls);
      }

      for (const [clsLower, rawClsName] of referencedClasses.entries()) {
        const match = elementTypeMap.get(clsLower);
        if (!match) {
          if (/Element$/i.test(rawClsName)) {
            addUnresolved(
              'Element',
              rawClsName,
              `${input.builderAst.fileName} (${m.name})`,
              `ProposalElement class "${rawClsName}" referenced by ${m.name}() does not exist in target project.`
            );
          }
          continue;
        }
        if (match.ast.filePath === input.builderAst.filePath) continue;

        const existing = elementsMap.get(match.type.name) ?? {
          className: match.type.name,
          filePath: match.ast.filePath,
          usedByMethods: [],
          rdlcFiles: match.ast.rdlcReferences,
          methods: match.type.methods.map((tm) => tm.name),
          productEngineCalls: match.ast.productEngineCalls,
        };
        if (!existing.usedByMethods.includes(m.name)) {
          existing.usedByMethods.push(m.name);
        }
        elementsMap.set(match.type.name, existing);

        for (const r of match.ast.rdlcReferences) {
          registerRdlcRef(r, match.ast.fileName, 'direct');
        }
      }
    }

    // Fallback: include co-located <ProductCode>*Element.vb or <ProductCode>*.rdlc if builder referenced dynamically
    for (const ast of input.allVbAsts) {
      if (ast.filePath === input.builderAst.filePath) continue;
      if (new RegExp(`^${input.productCode}`, 'i').test(ast.fileName)) {
        for (const t of ast.types) {
          if (!elementsMap.has(t.name)) {
            elementsMap.set(t.name, {
              className: t.name,
              filePath: ast.filePath,
              usedByMethods: [],
              rdlcFiles: ast.rdlcReferences,
              methods: t.methods.map((tm) => tm.name),
              productEngineCalls: ast.productEngineCalls,
            });
            for (const r of ast.rdlcReferences) {
              registerRdlcRef(r, ast.fileName, 'indirect');
            }
          }
        }
      }
    }

    for (const rPath of input.allRdlcFiles) {
      const base = path.basename(rPath);
      if (new RegExp(`^${input.productCode}`, 'i').test(base)) {
        registerRdlcRef(base, 'co-located', 'indirect');
      }
    }

    return {
      productCode: input.productCode,
      builderFile: input.builderAst.filePath,
      builderClass,
      elements: Array.from(elementsMap.values()),
      rdlcFiles: Array.from(rdlcEntries.values()),
      datasets: Array.from(new Set(input.builderAst.datasetNames)),
      parameters: [],
      productEngineCalls: Array.from(
        new Set([
          ...input.builderAst.productEngineCalls,
          ...Array.from(elementsMap.values()).flatMap((e) => e.productEngineCalls),
        ])
      ),
      unresolvedReferences,
    };
  }
}
