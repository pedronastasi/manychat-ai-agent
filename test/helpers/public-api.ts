import ts from 'typescript';

/**
 * The shape of everything a tenant can import, one line per member, read from
 * the TypeScript sources so no build is needed (specs/033 § Entry points,
 * through an exports map).
 *
 * Each export is printed down to its members. A type an entry point exports is
 * printed by its name wherever it is used, since a tenant can name it too.
 * Every other type of this package's own is printed by its shape: a tenant
 * cannot name it, so extracting or renaming one leaves the text alone, and a
 * change to its shape shows up wherever a tenant meets it.
 *
 * A type from a dependency is printed by name and type arguments, and a zod
 * schema by the type it parses to, which is what a tenant's code depends on,
 * so a dependency bump that changes neither leaves the text alone. Private
 * class members are left out: nothing outside the class can use them.
 */
export function publicApi(entries: Record<string, string>): string {
  const config = ts.readConfigFile('tsconfig.json', path => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
  const program = ts.createProgram(Object.values(entries), { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;

  const fileOf = (symbol: ts.Symbol | undefined) =>
    symbol?.declarations?.[0]?.getSourceFile().fileName ?? '';
  const inDependency = (symbol: ts.Symbol | undefined) => fileOf(symbol).includes('node_modules');
  const inZod = (symbol: ts.Symbol | undefined) => fileOf(symbol).includes('node_modules/zod/');
  const anonymous = (symbol: ts.Symbol) => symbol.name.startsWith('__');
  const aliasOf = (symbol: ts.Symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const atomic =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Never |
    ts.TypeFlags.Void |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.TypeParameter;
  const typeFlags = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class;

  const modules = Object.entries(entries).map(([specifier, file]) => {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`entry point not found: ${file}`);
    const exports = checker
      .getExportsOfModule(checker.getSymbolAtLocation(source)!)
      .sort((left, right) => left.name.localeCompare(right.name));
    return { specifier, exports };
  });

  // The types a tenant can name, by the name an entry point gives them. An
  // alias of an alias, as `type Tools = z.infer<typeof ToolsSchema>` is, loses
  // its name on the type it resolves to, so each is matched by that type too.
  const exportedNames = new Map<ts.Symbol, string>();
  const exportedTypes = new Map<ts.Type, string>();
  for (const { exports } of modules) {
    for (const symbol of exports) {
      const target = aliasOf(symbol);
      if (!(target.flags & typeFlags) || exportedNames.has(target)) continue;
      exportedNames.set(target, symbol.name);
      const declared = checker.getDeclaredTypeOfSymbol(target);
      if (!(declared.flags & atomic) && !exportedTypes.has(declared)) {
        exportedTypes.set(declared, symbol.name);
      }
    }
  }
  /** The exported name a tenant knows the type by, with the arguments it was given. */
  const exportedName = (type: ts.Type): { name: string; args: readonly ts.Type[] } | undefined => {
    // A non-generic alias, matched by what it resolves to: it takes no arguments.
    const matched = exportedTypes.get(type);
    if (matched) return { name: matched, args: [] };
    const alias = type.aliasSymbol && exportedNames.get(type.aliasSymbol);
    if (alias) return { name: alias, args: type.aliasTypeArguments ?? [] };
    const symbol = type.getSymbol();
    const name =
      symbol && symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)
        ? exportedNames.get(symbol)
        : undefined;
    return name ? { name, args: referenceArguments(type) } : undefined;
  };

  /**
   * The type arguments of a reference to a generic interface or class, as
   * `PluginTool<S>`, without the implicit `this` TypeScript appends to them.
   */
  const referenceArguments = (type: ts.Type): readonly ts.Type[] => {
    if (!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return [];
    const symbol = type.getSymbol();
    const declared = symbol && (checker.getDeclaredTypeOfSymbol(symbol) as ts.InterfaceType);
    const count = declared?.typeParameters?.length ?? 0;
    return checker.getTypeArguments(type as ts.TypeReference).slice(0, count);
  };

  /**
   * The name a dependency gives the type, as `Promise`, `ZodObject` or the AI
   * SDK's `ToolSet` alias, with its type arguments. None for an anonymous type
   * a dependency builds, or for zod's inference aliases: what `z.infer`
   * returns is the shape a tenant's code depends on, so it is expanded.
   */
  const dependencyName = (type: ts.Type) => {
    const alias = type.aliasSymbol;
    if (alias && inDependency(alias) && !inZod(alias)) {
      return { name: alias.name, args: type.aliasTypeArguments ?? [] };
    }
    const symbol = type.getSymbol();
    if (!symbol || anonymous(symbol) || !inDependency(symbol)) return undefined;
    return { name: symbol.name, args: referenceArguments(type) };
  };

  const isPrivate = (symbol: ts.Symbol) =>
    (symbol.declarations ?? []).some(
      declaration =>
        (ts.getCombinedModifierFlags(declaration) &
          (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
          0 ||
        ((ts.isPropertyDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
          ts.isPrivateIdentifier(declaration.name)),
    );
  const propertyType = (type: ts.Type, name: string) => {
    const property = type.getProperty(name);
    return property && checker.getTypeOfSymbol(property);
  };

  /**
   * `expand` is printed by its members rather than its name: it is the type
   * being defined. `seen` stops a type that contains itself.
   */
  function format(
    type: ts.Type,
    indent: string,
    expand?: ts.Type,
    seen: ReadonlySet<ts.Type> = new Set(),
  ): string {
    if (type.flags & atomic && !type.isUnion()) return checker.typeToString(type, undefined, flags);
    const exported = type === expand ? undefined : exportedName(type);
    if (exported) {
      const { name, args } = exported;
      return args.length > 0
        ? `${name}<${args.map(arg => format(arg, indent, undefined, seen)).join(', ')}>`
        : name;
    }
    if (seen.has(type)) return `<recursive ${checker.typeToString(type, undefined, flags)}>`;
    const inner = new Set(seen).add(type);
    const sub = (part: ts.Type, at = indent) => format(part, at, undefined, inner);

    if (type.isUnion() || type.isIntersection()) {
      const parts = [...new Set(type.types.map(part => sub(part)))].sort();
      return parts.join(type.isUnion() ? ' | ' : ' & ');
    }
    const element = (item: ts.Type) => {
      const text = sub(item);
      return / [|&] /.test(text) && !text.startsWith('{') ? `(${text})` : text;
    };
    if (checker.isTupleType(type)) {
      // Each element by its kind, so `[string, ...string[]]` is not `[string, string]`.
      const { target } = type as ts.TupleTypeReference;
      const items = checker.getTypeArguments(type as ts.TypeReference).map((item, at) => {
        const kind = target.elementFlags[at] ?? ts.ElementFlags.Required;
        if (kind & ts.ElementFlags.Rest) return `...${element(item)}[]`;
        if (kind & ts.ElementFlags.Variadic) return `...${element(item)}`;
        return kind & ts.ElementFlags.Optional ? `${element(item)}?` : sub(item);
      });
      return `${target.readonly ? 'readonly ' : ''}[${items.join(', ')}]`;
    }
    if (checker.isArrayType(type)) {
      const readonly = type.getSymbol()?.name === 'ReadonlyArray' ? 'readonly ' : '';
      return `${readonly}${element(checker.getTypeArguments(type as ts.TypeReference)[0]!)}[]`;
    }

    // A zod schema: what parsing it returns.
    const zod = propertyType(type, '_zod');
    const output = zod && inZod(type.getSymbol()) ? propertyType(zod, 'output') : undefined;
    if (output) return `zod schema of ${sub(output)}`;
    const dependency = dependencyName(type);
    if (dependency) {
      const { name: dependencyType, args } = dependency;
      return args.length > 0
        ? `${dependencyType}<${args.map(arg => sub(arg)).join(', ')}>`
        : dependencyType;
    }

    const next = `${indent}  `;
    const signature = (sig: ts.Signature, prefix: string) => {
      const params = sig.parameters.map(param => {
        const declaration = param.valueDeclaration as ts.ParameterDeclaration | undefined;
        const optional = declaration && checker.isOptionalParameter(declaration) ? '?' : '';
        const rest = declaration?.dotDotDotToken ? '...' : '';
        return `${rest}${param.name}${optional}: ${sub(checker.getTypeOfSymbol(param), next)}`;
      });
      // A generic's parameters, with `const`, constraint and default: narrowing
      // one changes what a tenant may pass.
      const generics = (sig.typeParameters ?? []).map(parameter => {
        const declaration = parameter.getSymbol()?.declarations?.[0];
        const isConst =
          declaration &&
          ts.isTypeParameterDeclaration(declaration) &&
          declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ConstKeyword);
        const constraint = parameter.getConstraint();
        const fallback = parameter.getDefault();
        return [
          `${isConst ? 'const ' : ''}${parameter.getSymbol()?.name ?? '?'}`,
          constraint ? ` extends ${sub(constraint, next)}` : '',
          fallback ? ` = ${sub(fallback, next)}` : '',
        ].join('');
      });
      const typeParams = generics.length > 0 ? `<${generics.join(', ')}>` : '';
      return `${prefix}${typeParams}(${params.join(', ')}) => ${sub(sig.getReturnType(), next)}`;
    };
    const index = [ts.IndexKind.String, ts.IndexKind.Number].flatMap(kind => {
      const info = checker.getIndexInfoOfType(type, kind);
      const key = kind === ts.IndexKind.String ? 'string' : 'number';
      return info ? [`[key: ${key}]: ${sub(info.type, next)}`] : [];
    });
    const members = [
      ...type.getConstructSignatures().map(sig => signature(sig, 'new ')),
      ...type.getCallSignatures().map(sig => signature(sig, '')),
      ...index,
      ...checker
        .getPropertiesOfType(type)
        .filter(property => property.name !== 'prototype' && !isPrivate(property))
        .map(property => {
          const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
          const declaration = property.declarations?.[0];
          const readonly =
            declaration && ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly
              ? 'readonly '
              : '';
          return `${readonly}${property.name}${optional}: ${sub(checker.getTypeOfSymbol(property), next)}`;
        })
        .sort(),
    ];
    if (members.length === 0) return '{}';
    return `{\n${members.map(member => `${next}${member}`).join('\n')}\n${indent}}`;
  }

  /** A declaration's own text, comments and layout removed: a generic's shape. */
  const declarationText = (declaration: ts.Node) =>
    declaration
      .getText()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\s+/g, ' ')
      .replace(/^export (declare )?/, '');

  /**
   * Internal types a generic's declaration names, in the order first met. Its
   * text names them rather than showing their shape, so each is defined too:
   * `ParamsOf` is only as stable as the `ValueOf` it is written with.
   */
  const internals = new Map<ts.Symbol, string>();
  function nameInternals(node: ts.Node): void {
    if (ts.isTypeReferenceNode(node)) {
      const found = checker.getSymbolAtLocation(node.typeName);
      const target = found && aliasOf(found);
      if (
        target &&
        target.flags & typeFlags &&
        !inDependency(target) &&
        !exportedNames.has(target) &&
        !internals.has(target)
      ) {
        const taken = [...internals.values()].includes(target.name);
        const file = fileOf(target).replace(/^.*?\/src\//, 'src/');
        internals.set(target, taken ? `${target.name} (${file})` : target.name);
      }
    }
    ts.forEachChild(node, nameInternals);
  }

  /** An exported type's definition: its declaration when generic, else its members. */
  function definition(symbol: ts.Symbol, name: string): string {
    const generic = symbol.declarations?.find(
      declaration =>
        (ts.isTypeAliasDeclaration(declaration) ||
          ts.isInterfaceDeclaration(declaration) ||
          ts.isClassDeclaration(declaration)) &&
        declaration.typeParameters !== undefined,
    );
    if (generic) {
      nameInternals(generic);
      return declarationText(generic);
    }
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    return `type ${name} = ${format(type, '', type)}`;
  }

  const sections = modules
    .map(({ specifier, exports }) => {
      const printed = exports.flatMap(symbol => {
        const target = aliasOf(symbol);
        const lines: string[] = [];
        if (target.flags & ts.SymbolFlags.Value) {
          // A class's static side carries the class's name: its constructor is shown.
          const type = checker.getTypeOfSymbol(target);
          lines.push(`${symbol.name}: ${format(type, '', type)}`);
        }
        if (target.flags & typeFlags) lines.push(definition(target, symbol.name));
        return lines;
      });
      return `# ${specifier}\n\n${printed.join('\n\n')}\n`;
    })
    .join('\n');

  // Defining one internal type can name another, so this runs until none is new.
  const named: string[] = [];
  for (let done = 0; done < internals.size; done += 1) {
    const [symbol, name] = [...internals][done]!;
    named.push(definition(symbol, name));
  }
  return named.length > 0
    ? `${sections}\n# Internal types named by the generics above\n\n${named.join('\n\n')}\n`
    : sections;
}
