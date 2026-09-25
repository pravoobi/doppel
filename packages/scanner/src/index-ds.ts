/**
 * Build the design-system capability index (CLAUDE.md §5.1). Pure AST work via
 * ts-morph — no network, no model call. `description` and `aliases` are left
 * empty here; they are filled by one Nano call per component in M2.
 */

import path from "node:path"
import { Project, SyntaxKind, type SourceFile } from "ts-morph"
import type { DsComponent, DsIndex, PropSpec } from "@doppel/shared"

const SOURCE_EXCERPT_LINES = 80

export function buildDsIndex(project: Project, dsDirAbsPath: string, importAlias = "@/"): DsIndex {
  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => isUnder(sf.getFilePath(), dsDirAbsPath))
    .filter((sf) => !/\.(test|stories)\.tsx?$/.test(sf.getFilePath()))

  const components: DsComponent[] = []

  for (const sf of sourceFiles) {
    components.push(...extractComponentsFromFile(sf, dsDirAbsPath, importAlias))
  }

  return { path: dsDirAbsPath, components }
}

function isUnder(filePath: string, dirPath: string): boolean {
  const rel = path.relative(dirPath, filePath)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

function extractComponentsFromFile(
  sf: SourceFile,
  dsDirAbsPath: string,
  importAlias: string
): DsComponent[] {
  const variantsByCvaVar = extractCvaVariants(sf)
  const propsByInterfaceName = extractPropInterfaces(sf)
  const sourceExcerpt = sf.getFullText().split("\n").slice(0, SOURCE_EXCERPT_LINES).join("\n")
  const importPath = toImportPath(sf.getFilePath(), dsDirAbsPath, importAlias)

  const out: DsComponent[] = []
  const seen = new Set<string>()

  for (const [name, declarations] of sf.getExportedDeclarations()) {
    if (!/^[A-Z]/.test(name) || seen.has(name)) continue

    const isComponentValue = declarations.some(
      (d) =>
        d.getKind() === SyntaxKind.VariableDeclaration ||
        d.getKind() === SyntaxKind.FunctionDeclaration
    )
    if (!isComponentValue) continue

    seen.add(name)

    const propsInterfaceName = `${name}Props`
    const ownProps = propsByInterfaceName.get(propsInterfaceName) ?? []

    const cvaVarName = findCvaVariantsRefForComponent(sf, name)
    const variants = cvaVarName ? variantsByCvaVar.get(cvaVarName) ?? {} : {}

    const variantProps: PropSpec[] = Object.entries(variants).map(([propName, literals]) => ({
      name: propName,
      type: literals.map((l) => `"${l}"`).join(" | "),
      optional: true,
      literals,
    }))

    out.push({
      name,
      importPath,
      props: dedupeProps([...ownProps, ...variantProps]),
      variants,
      sourceExcerpt,
      description: "",
      aliases: [],
    })
  }

  return out
}

function dedupeProps(props: PropSpec[]): PropSpec[] {
  const byName = new Map<string, PropSpec>()
  for (const p of props) byName.set(p.name, p)
  return [...byName.values()]
}

/** Extracts `interfaceName -> own PropertySignature specs` for every `*Props` interface. */
function extractPropInterfaces(sf: SourceFile): Map<string, PropSpec[]> {
  const out = new Map<string, PropSpec[]>()
  for (const iface of sf.getInterfaces()) {
    if (!iface.getName().endsWith("Props")) continue
    const props: PropSpec[] = iface.getProperties().map((prop) => ({
      name: prop.getName(),
      type: prop.getTypeNode()?.getText() ?? "unknown",
      optional: prop.hasQuestionToken(),
    }))
    out.set(iface.getName(), props)
  }
  return out
}

/**
 * Extracts `cva(...)` variant configs: `cvaVariableName -> { propName: [literal, ...] }`.
 * Matches the shadcn/ui convention: `const buttonVariants = cva(base, { variants: {...} })`.
 */
function extractCvaVariants(sf: SourceFile): Map<string, Record<string, string[]>> {
  const out = new Map<string, Record<string, string[]>>()

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== "cva") continue

    const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
    if (!varDecl) continue

    const configArg = call.getArguments()[1]
    if (!configArg || configArg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue

    const variantsProp = configArg
      .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
      .getProperty("variants")
    if (!variantsProp || variantsProp.getKind() !== SyntaxKind.PropertyAssignment) continue

    const variantsObj = variantsProp
      .asKindOrThrow(SyntaxKind.PropertyAssignment)
      .getInitializerIfKind(SyntaxKind.ObjectLiteralExpression)
    if (!variantsObj) continue

    const variants: Record<string, string[]> = {}
    for (const variantProp of variantsObj.getProperties()) {
      if (variantProp.getKind() !== SyntaxKind.PropertyAssignment) continue
      const pa = variantProp.asKindOrThrow(SyntaxKind.PropertyAssignment)
      const optionsObj = pa.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression)
      if (!optionsObj) continue
      variants[pa.getName()] = optionsObj
        .getProperties()
        .filter((p) => p.getKind() === SyntaxKind.PropertyAssignment)
        .map((p) => p.asKindOrThrow(SyntaxKind.PropertyAssignment).getName().replace(/['"]/g, ""))
    }

    out.set(varDecl.getName(), variants)
  }

  return out
}

/**
 * Finds which `cva(...)` variable a component's props are typed against, by scanning
 * `VariantProps<typeof X>` in the matching `*Props` interface.
 */
function findCvaVariantsRefForComponent(sf: SourceFile, componentName: string): string | null {
  const iface = sf.getInterface(`${componentName}Props`)
  if (!iface) return null
  const text = iface.getText()
  const m = text.match(/VariantProps<typeof (\w+)>/)
  return m ? m[1] : null
}

function toImportPath(fileAbsPath: string, dsDirAbsPath: string, importAlias: string): string {
  const dsRootParent = path.dirname(dsDirAbsPath) // e.g. .../components
  const rel = path.relative(path.dirname(dsRootParent), fileAbsPath).replace(/\\/g, "/")
  const withoutExt = rel.replace(/\.tsx?$/, "")
  return `${importAlias}${withoutExt}`
}
