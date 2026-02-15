/**
 * Script to update docs/Models.md based on src/data/modelLicenses.ts
 * Run with: npm run update-docs or node --loader tsx scripts/updateModelsDocs.ts
 */

import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { MODEL_LICENSES, ModelLicense } from '../src/data/modelLicenses';

// Group models by category
const videoModels = MODEL_LICENSES.filter(m => m.category === 'Video Models (VSR)');
const imageModels = MODEL_LICENSES.filter(m => m.category === 'Image Based Models');

// Format a model entry with license annotation if different from default
function formatModelEntry(model: ModelLicense): string {
  const defaultLicense = 'CC BY-NC-SA 4.0';
  let entry = `  - ${model.name}`;
  
  // Add description if available
  if (model.description) {
    entry += ` (${model.description})`;
  }
  
  // Add license annotation if different from default
  if (model.license !== defaultLicense) {
    entry += ` (License: ${model.license})`;
  }
  
  return entry;
}

// Generate the markdown content
const markdownContent = `## Included Models
<!-- This section is auto-generated. Run 'npm run update-docs' to update it. -->
<!-- Source: src/data/modelLicenses.ts -->
__Please note:__ All included models follow the original licenses they were published with! Most are licensed as CC BY-NC-SA 4.0, unless stated otherwise!

Ships with pre-configured upscaling models:
- **Video Models (VSR)**: Temporally-aware models for video
${videoModels.map(formatModelEntry).join('\n')}
- **Image Based Models**: Frame-by-frame processing (still works on videos, but is not temporally stable/will shimmer)
${imageModels.map(formatModelEntry).join('\n')}

### Model Support
Vapourkit supports any model that vs-mlrt supports. Refer here for more information: https://github.com/AmusementClub/vs-mlrt/wiki  

A great place to find supported models is: https://openmodeldb.info/

### Model Location
- **Location**: \`data/models/\`
`;

// Write to docs/Models.md
const docsPath = join(__dirname, '..', 'docs', 'Models.md');
writeFileSync(docsPath, markdownContent, 'utf-8');

console.log('✓ docs/Models.md updated successfully!');
console.log(`  - ${videoModels.length} video models`);
console.log(`  - ${imageModels.length} image-based models`);
