# Scripts

This directory contains utility scripts for maintaining the Vapourkit project.

## updateModelsDocs.ts

Automatically generates [docs/Models.md](../docs/Models.md) based on the model license data in [src/data/modelLicenses.ts](../src/data/modelLicenses.ts).

**Usage:**
```bash
npm run update-docs
```

**When to run:**
- After adding or removing models in `src/data/modelLicenses.ts`
- After updating model descriptions or licenses
- Before committing changes that affect included models

This ensures the documentation stays in sync with the actual model data used by the application.
