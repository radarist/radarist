'use strict';

const DISPOSABLE_CONFIRMATION = 'true';
const DEFAULT_BOLT_PORT = '7687';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const NEO4J_PROTOCOLS = new Set(['bolt:', 'bolt+s:', 'bolt+ssc:', 'neo4j:', 'neo4j+s:', 'neo4j+ssc:']);

function assertDisposableNeo4jIntegrationTarget(env = process.env) {
  if (env.NEO4J_INTEGRATION_DISPOSABLE !== DISPOSABLE_CONFIRMATION) {
    throw new Error(
      'Set NEO4J_INTEGRATION_DISPOSABLE=true only after selecting an isolated disposable Neo4j clone'
    );
  }

  const rawUri = env.NEO4J_URI?.trim();
  if (!rawUri) {
    throw new Error('NEO4J_URI is required and must identify an isolated disposable Neo4j clone');
  }

  let uri;
  try {
    uri = new URL(rawUri);
  } catch {
    throw new Error('NEO4J_URI must be a valid Bolt or Neo4j URL');
  }

  if (!NEO4J_PROTOCOLS.has(uri.protocol)) {
    throw new Error('NEO4J_URI must use a Bolt or Neo4j protocol');
  }
  if (!LOOPBACK_HOSTS.has(uri.hostname)) {
    throw new Error('NEO4J_URI must use localhost or 127.0.0.1 for a disposable local graph');
  }
  if (!uri.port) {
    throw new Error('NEO4J_URI must include the disposable clone\'s published Bolt port');
  }
  if (uri.port === DEFAULT_BOLT_PORT) {
    throw new Error(`NEO4J_URI must not use protected default Bolt port ${DEFAULT_BOLT_PORT}`);
  }
  if (uri.username || uri.password) {
    throw new Error('NEO4J_URI must not embed credentials; use NEO4J_USER and NEO4J_PASSWORD');
  }

  return {
    uri: rawUri,
    hostname: uri.hostname,
    port: Number(uri.port),
  };
}

function isDisposableNeo4jIntegrationSuiteEnabled(env = process.env) {
  return env.NEO4J_INTEGRATION_TESTS === '1' && env.NEO4J_INTEGRATION_DISPOSABLE === DISPOSABLE_CONFIRMATION;
}

function assertDisposableNeo4jIntegrationSuiteTarget(env = process.env) {
  if (env.NEO4J_INTEGRATION_TESTS !== '1') {
    throw new Error('Set NEO4J_INTEGRATION_TESTS=1 only through the guarded disposable Neo4j integration lane');
  }
  return assertDisposableNeo4jIntegrationTarget(env);
}

module.exports = {
  assertDisposableNeo4jIntegrationTarget,
  assertDisposableNeo4jIntegrationSuiteTarget,
  isDisposableNeo4jIntegrationSuiteEnabled,
};
