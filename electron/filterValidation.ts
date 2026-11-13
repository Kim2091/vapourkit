/** Validate template data without executing imported Python or installing dependencies. */
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value));
export function validateFilterTemplate(value: unknown): void {
  if (!record(value)) throw new Error('The filter must be a TOML table with name and code fields.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('Give the filter a non-empty name of at most 200 characters.');
  if (typeof value.code !== 'string' || !value.code.trim() || value.code.length > 1024 * 1024) throw new Error(`Filter "${value.name}" needs non-empty Python code (maximum 1 MiB).`);
  if (value.category !== undefined && !(typeof value.category === 'string' || (Array.isArray(value.category) && value.category.every(v => typeof v === 'string')))) throw new Error('Filter category must be text or a list of text values.');
  if (value.description !== undefined && typeof value.description !== 'string') throw new Error('Filter description must be text.');
  if (value.variables !== undefined) {
    if (!record(value.variables)) throw new Error('Filter variables must use [variables.name] TOML tables.');
    for (const [name, variable] of Object.entries(value.variables)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !record(variable)) throw new Error(`Invalid variable "${name}". Use a Python identifier and a [variables.${name}] table.`);
      if (variable.type !== undefined && !['number', 'string', 'boolean'].includes(String(variable.type))) throw new Error(`Variable "${name}" has an unsupported type. Use number, string or boolean.`);
      if (variable.default !== undefined && (!scalar(variable.default) || (variable.type !== undefined && typeof variable.default !== variable.type))) throw new Error(`The default of "${name}" must match its declared type and numbers must be finite.`);
    }
  }
  if (value.parameters !== undefined) {
    if (!record(value.parameters)) throw new Error('Filter parameters must be a table of values.');
    for (const [name, parameter] of Object.entries(value.parameters)) {
      const variable = record(value.variables) ? value.variables[name] : undefined;
      if (!record(variable) || !scalar(parameter) || (variable.type !== undefined && typeof parameter !== variable.type)) throw new Error(`Parameter "${name}" must name a declared variable and match its type.`);
    }
  }
  if (value.editor !== undefined) {
    if (!record(value.editor) || !['crop', 'colorGrade', 'createLut', 'lutSource', 'stageSource'].includes(String(value.editor.type))) throw new Error('This filter uses an unsupported visual editor. Update Vapourkit or ask the filter author for a compatible .vkfilter.');
    if (!record(value.editor.variables)) throw new Error('The visual editor must declare its variable names in [editor.variables].');
    const refs = Object.values(value.editor.variables).flat();
    for (const name of refs) {
      if (typeof name !== 'string' || !record(value.variables) || !record(value.variables[name])) throw new Error(`The editor references undeclared variable "${name}". Add its [variables.${name}] table or correct the editor mapping.`);
    }
  }
}

/** Preserve the saved settings of a filter imported from a workflow or [parameters]. */
export function variablesWithParameters<T extends { default?: string | number | boolean }>(
  variables: Record<string, T> | undefined, parameters: Record<string, string | number | boolean> | undefined,
): Record<string, T> | undefined {
  if (!variables) return undefined;
  return Object.fromEntries(Object.entries(variables).map(([name, variable]) => [name,
    parameters?.[name] !== undefined ? { ...variable, default: parameters[name] } : { ...variable },
  ]));
}
