/**
 * Minimal type declarations for `@citation-js/core` + `@citation-js/plugin-csl`.
 * Neither package ships its own `.d.ts` nor has a `@types/*` package on npm.
 * Only the surface `src/lib/research/citation.ts` actually uses is typed here.
 * @see https://citation.js.org/api/
 */

declare module '@citation-js/core' {
  export interface CslJson {
    type?: string;
    title?: string;
    author?: Array<{ literal?: string; given?: string; family?: string }>;
    issued?: { 'date-parts': number[][] };
    URL?: string;
    DOI?: string;
    [key: string]: unknown;
  }

  export interface CiteFormatOptions {
    format?: string;
    template?: string;
    lang?: string;
    [key: string]: unknown;
  }

  export class Cite {
    constructor(data: CslJson | CslJson[] | string);
    format(type: string, options?: CiteFormatOptions): string;
  }

  export interface CslTemplateRegister {
    has(key: string): boolean;
    add(key: string, cslXml: string): unknown;
    get(key: string): string | undefined;
  }

  export interface CslPluginConfig {
    templates: CslTemplateRegister;
    [key: string]: unknown;
  }

  export interface PluginsConfig {
    get(pluginName: string): CslPluginConfig;
  }

  export const plugins: {
    config: PluginsConfig;
    add: (name: string, plugin: unknown) => void;
  };
}

declare module '@citation-js/plugin-csl';
