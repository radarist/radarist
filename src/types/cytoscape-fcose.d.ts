// Ambient type for cytoscape-fcose (MIT) — the package ships no bundled types
// and there is no @types/cytoscape-fcose. It is a Cytoscape layout extension
// registered via `cytoscape.use(fcose)`.
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const fcose: Ext;
  export default fcose;
}
