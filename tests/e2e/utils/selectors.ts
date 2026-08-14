/**
 * @file selectors.ts
 * @description Shared data-testid selector contracts for E2E tests.
 *
 * Centralizes all data-testid selectors so that changes to component
 * test IDs only need to be updated in one place.
 *
 * @author Radarist Team
 * @created 2026-02-21
 */

export const SELECTORS = {
  // Page structure
  pageTitle: '[data-testid="page-title"]',
  sidebar: '[data-testid="sidebar"]',
  breadcrumbs: '[data-testid="breadcrumbs"]',

  // Entity list pages
  createButton: (entity: string) => `[data-testid="create-${entity}-button"]`,
  searchInput: '[data-testid="search-input"]',
  dataTable: '[data-testid="data-table"]',
  emptyState: '[data-testid="empty-state"]',
  viewToggle: '[data-testid="view-toggle"]',

  // Entity sheets
  entitySheet: '[data-testid="entity-sheet"]',
  sheetTab: (name: string) => `[data-testid="sheet-tab-${name}"]`,
  sheetClose: '[data-testid="sheet-close"]',

  // Common UI
  skeleton: '[data-testid="skeleton"]',
  loading: '[data-testid="loading"]',
  errorBoundary: '[data-testid="error-boundary"]',

  // AI
  aiChat: '[data-testid="ai-chat"]',
  chatInput: '[data-testid="chat-input"]',
  sendButton: '[data-testid="send-button"]',

  // Radar
  radarVisualization: '[data-testid="radar-visualization"]',
  radarSidebar: '[data-testid="radar-sidebar"]',

  // Dashboard
  kpiCard: '[data-testid="kpi-card"]',
  statCard: '[data-testid="stat-card"]',

  // Impulse - Missions
  missionInput: '[data-testid="mission-input"]',
  missionCard: (id: string) => `[data-testid="mission-card-${id}"]`,
  missionCards: '[data-testid^="mission-card-"]',

  // Impulse - Reports
  reportIframe: '[data-testid="report-iframe"]',

} as const;
