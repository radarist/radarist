/**
 * Pure, environment-independent contract for the checksum-pinned Neo4j GDS
 * artifact. Keep this module free of runtime initialization so publication and
 * local launchers can bind the same bytes without reading operator state.
 */

export const SUPPORTED_NEO4J_PLUGINS = ['apoc'] as const;
export const LEGACY_NEO4J_AUTO_PLUGINS = ['apoc', 'graph-data-science'] as const;
export const PINNED_NEO4J_GDS_VERSION = '2.6.9';
export const PINNED_NEO4J_GDS_URL =
  `https://graphdatascience.ninja/neo4j-graph-data-science-${PINNED_NEO4J_GDS_VERSION}.jar`;
export const PINNED_NEO4J_GDS_SHA256 =
  '9462a31555e8dfc7d3342d9d0d02a11bcb17e99b9c811648748a1e2b4f4fcbe5';
export const PINNED_NEO4J_GDS_SIZE_BYTES = 60_135_088;
export const PINNED_NEO4J_GDS_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const PINNED_NEO4J_GDS_CONTAINER_PATH = '/plugins/graph-data-science.jar';
export const PINNED_NEO4J_GDS_HOST_FILE_NAME = 'graph-data-science.jar';
export const PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE = 42;
export const PINNED_NEO4J_GDS_MIN_CURL_VERSION = '8.4.0';
