/**
 * Model license information for models included with Vapourkit
 * Update this file when adding, removing, or modifying included models
 */

export interface ModelLicense {
  name: string;
  category: 'Video Models (VSR)' | 'Image Based Models';
  license: string;
  description?: string;
  url?: string;
}

export const MODEL_LICENSES: ModelLicense[] = [
  // Video Models (VSR) - Temporally-aware models for video
  {
    name: 'AniRemaster TSPAN',
    category: 'Video Models (VSR)',
    license: 'CC BY-NC-SA 4.0',
    description: 'Classic Anime',
  },
  {
    name: 'AnimeUpV2 TSPAN',
    category: 'Video Models (VSR)',
    license: 'CC BY-NC-SA 4.0',
    description: 'Low Quality Anime',
  },
  {
    name: 'AniRestore TFDAT',
    category: 'Video Models (VSR)',
    license: 'CC BY-NC-SA 4.0',
    description: 'LQ Anime or Cartoons (Dot Crawl, Rainbows)',
  },
  // Image Based Models - Frame-by-frame processing
  {
    name: 'AnimeJaNai HD V3',
    category: 'Image Based Models',
    license: 'CC BY-NC-SA 4.0',
    description: 'Modern Anime',
  },
  {
    name: 'AnimeJaNai SD V1',
    category: 'Image Based Models',
    license: 'CC BY-NC-SA 4.0',
    description: 'Classic HQ Anime',
  },
  {
    name: 'AniSD AC/DC SPAN',
    category: 'Image Based Models',
    license: 'CC BY-NC 4.0',
    description: 'Classic SD Anime',
  },
  {
    name: 'AnimeSharpV4',
    category: 'Image Based Models',
    license: 'CC BY-NC-SA 4.0',
    description: 'Low Quality Anime',
  },
  {
    name: '2x_bndl_animefilm_v1.5',
    category: 'Image Based Models',
    license: 'CC BY 4.0',
    description: 'Low Quality SD Anime',
  },
];
