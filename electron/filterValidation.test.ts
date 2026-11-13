import * as fs from 'node:fs';
import * as path from 'node:path';
import TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';
import { validateFilterTemplate, variablesWithParameters } from './filterValidation';
import { filterFailureHint } from './filterDiagnostics';

describe('imported filters', () => {
  const template = { name: 'Sharpen', code: 'clip = sharpen(clip, amount={{amount}})', variables: { amount: { type: 'number', default: 1 } } };
  it('accepts every shipped template so stricter imports do not break built-in filters', () => {
    let count = 0;
    for (const dir of ['include/filter_templates', 'include/plugins/plugin_filters']) {
      for (const name of fs.readdirSync(path.resolve(__dirname, '..', dir)).filter(file => file.endsWith('.vkfilter'))) {
        const data = TOML.parse(fs.readFileSync(path.resolve(__dirname, '..', dir, name), 'utf8'));
        expect(() => validateFilterTemplate(data), name).not.toThrow(); count++;
      }
    }
    expect(count).toBeGreaterThan(150);
  });
  it('rejects malformed code and variable declarations with a repair instruction', () => {
    expect(() => validateFilterTemplate({ name: 'Broken', code: 3 })).toThrow('Python code');
    expect(() => validateFilterTemplate({ ...template, variables: { amount: { type: 'number', default: 'wrong' } } })).toThrow('must match');
    expect(() => validateFilterTemplate({ ...template, editor: { type: 'crop', variables: { left: 'missing' } } })).toThrow('undeclared variable "missing"');
    expect(() => validateFilterTemplate({ ...template, parameters: { amount: 'wrong' } })).toThrow('match its type');
  });
  it('accepts compatible templates and preserves configured values without mutating defaults', () => {
    expect(() => validateFilterTemplate(template)).not.toThrow();
    const variables = variablesWithParameters(template.variables, { amount: 2 });
    expect(variables?.amount.default).toBe(2);
    expect(template.variables.amount.default).toBe(1);
  });
  it('provides distinct repair guidance for missing modules, native plugins and bad Python', () => {
    expect(filterFailureHint("ModuleNotFoundError: No module named 'vs_undistort'")).toContain('Partial reinstall');
    expect(filterFailureHint("ModuleNotFoundError: No module named 'outside_tool'")).toContain('private Python environment');
    expect(filterFailureHint('No attribute with the name mv exists')).toContain('VS Plugins');
    expect(filterFailureHint('ImportError: DLL load failed')).toContain('operating system');
    expect(filterFailureHint('SyntaxError: invalid syntax')).toContain('Edit the filter');
    expect(filterFailureHint('Unrelated warning')).toBeNull();
  });
});
