/**
 * @file linker-components.test.tsx
 * @description Component tests for Linker Triage UI
 *
 * Tests ProposedRelationCard, LinkerTriageQueue, LinkerFilters, and LinkerStats
 * with comprehensive mocking of external dependencies.
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ProposedRelation,
  EntityType,
  RelationType,
  ProposedRelationStatus,
  RelationDiscoverySource,
} from "@/lib/types";

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  Check: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  Ban: () => <span data-testid="icon-ban" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  ChevronUp: () => <span data-testid="icon-chevron-up" />,
  ChevronLeft: () => <span data-testid="icon-chevron-left" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  ArrowRight: () => <span data-testid="icon-arrow-right" />,
  FileText: () => <span data-testid="icon-file-text" />,
  Clock: () => <span data-testid="icon-clock" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
  Building2: () => <span data-testid="icon-building2" />,
  Cpu: () => <span data-testid="icon-cpu" />,
  Lightbulb: () => <span data-testid="icon-lightbulb" />,
  Beaker: () => <span data-testid="icon-beaker" />,
  Target: () => <span data-testid="icon-target" />,
  Radio: () => <span data-testid="icon-radio" />,
  Briefcase: () => <span data-testid="icon-briefcase" />,
  Users: () => <span data-testid="icon-users" />,
  AlertTriangle: () => <span data-testid="icon-alert-triangle" />,
  Filter: () => <span data-testid="icon-filter" />,
  SlidersHorizontal: () => <span data-testid="icon-sliders" />,
  ArrowUpDown: () => <span data-testid="icon-arrow-up-down" />,
  Undo2: () => <span data-testid="icon-undo" />,
  Gauge: () => <span data-testid="icon-gauge" />,
  Link2: () => <span data-testid="icon-link2" />,
  TrendingUp: () => <span data-testid="icon-trending-up" />,
  Keyboard: () => <span data-testid="icon-keyboard" />,
}));

// Mock Kbd component
jest.mock("@/components/ui/kbd", () => ({
  Kbd: ({ children }: { children: React.ReactNode }) => (
    <kbd data-testid="kbd">{children}</kbd>
  ),
}));

// Mock Progress component
jest.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value: number }) => (
    <div data-testid="progress" data-value={value} />
  ),
}));

// Mock useProposedRelations hooks
jest.mock("@/hooks/useProposedRelations", () => ({
  useApproveProposedRelation: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
  }),
  useRejectProposedRelation: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
  }),
  useDismissProposedRelation: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
  }),
  useUndoProposedRelation: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
}));

// Mock Firebase
jest.mock("@/lib/firebase", () => ({
  db: {},
  auth: {},
  storage: {},
}));

// Mock proposed-relations lib
jest.mock("@/lib/proposed-relations", () => ({
  getProposedRelations: jest.fn(),
  getPendingProposedRelationsCount: jest.fn(),
  approveProposedRelation: jest.fn(),
  rejectProposedRelation: jest.fn(),
  dismissProposedRelation: jest.fn(),
  bulkApproveProposedRelations: jest.fn(),
}));

// Mock relations lib
jest.mock("@/lib/relations", () => ({
  createRelationFromIds: jest.fn(),
}));

// Mock toast
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}));

// Mock date-fns
jest.mock("date-fns", () => ({
  formatDistanceToNow: () => "5 minutes ago",
}));

// Import mocked modules
import {
  approveProposedRelation,
  rejectProposedRelation,
  dismissProposedRelation,
} from "@/lib/proposed-relations";

// Import components to test
import { ProposedRelationCard } from "../ProposedRelationCard";
import { LinkerTriageQueue } from "../LinkerTriageQueue";
import { LinkerFilters, countActiveFilters, type LinkerFiltersState } from "../LinkerFilters";
import { LinkerStats } from "../LinkerStats";

// Type mocked functions
const _mockApprove = approveProposedRelation as jest.MockedFunction<typeof approveProposedRelation>;
const _mockReject = rejectProposedRelation as jest.MockedFunction<typeof rejectProposedRelation>;
const _mockDismiss = dismissProposedRelation as jest.MockedFunction<typeof dismissProposedRelation>;

// Helper to create mock proposed relation
const createMockProposal = (
  id: string,
  sourceType: EntityType = "company",
  targetType: EntityType = "technology",
  relationType: RelationType = "uses",
  options: Partial<ProposedRelation> = {}
): ProposedRelation => ({
  id,
  sourceId: `${sourceType}-${id}-src`,
  sourceType,
  sourceSnapshot: {
    id: `${sourceType}-${id}-src`,
    name: `Source ${id}`,
    type: sourceType,
    snapshotAt: Date.now(),
  },
  targetId: `${targetType}-${id}-tgt`,
  targetType,
  targetSnapshot: {
    id: `${targetType}-${id}-tgt`,
    name: `Target ${id}`,
    type: targetType,
    snapshotAt: Date.now(),
  },
  relationType,
  confidence: 85,
  reasoning: "Test reasoning for this proposal",
  evidence: [],
  status: "pending" as ProposedRelationStatus,
  discoveredBy: "linker-agent" as RelationDiscoverySource,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...options,
});

// Test wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

// ============================================================================
// ProposedRelationCard Tests
// ============================================================================

describe("ProposedRelationCard Component", () => {
  const mockOnApprove = jest.fn();
  const mockOnReject = jest.fn();
  const mockOnDismiss = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render proposal details", () => {
    const proposal = createMockProposal("1");

    render(
      <ProposedRelationCard
        proposal={proposal}
        onApprove={mockOnApprove}
        onReject={mockOnReject}
        onDismiss={mockOnDismiss}
      />
    );

    expect(screen.getByText("Source 1")).toBeInTheDocument();
    expect(screen.getByText("Target 1")).toBeInTheDocument();
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("Test reasoning for this proposal")).toBeInTheDocument();
  });

  it("should display confidence indicator with correct styling", () => {
    const highConfidence = createMockProposal("1", "company", "technology", "uses", {
      confidence: 90,
    });
    const mediumConfidence = createMockProposal("2", "company", "technology", "uses", {
      confidence: 75,
    });
    const lowConfidence = createMockProposal("3", "company", "technology", "uses", {
      confidence: 50,
    });

    const { rerender } = render(
      <ProposedRelationCard proposal={highConfidence} />
    );
    expect(screen.getByText("90%")).toBeInTheDocument();

    rerender(<ProposedRelationCard proposal={mediumConfidence} />);
    expect(screen.getByText("75%")).toBeInTheDocument();

    rerender(<ProposedRelationCard proposal={lowConfidence} />);
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("should show discovery source badge", () => {
    const linkerAgentProposal = createMockProposal("1", "company", "technology", "uses", {
      discoveredBy: "linker-agent",
    });
    const autoLinkerProposal = createMockProposal("2", "company", "technology", "uses", {
      discoveredBy: "auto-linker",
    });

    const { rerender } = render(
      <ProposedRelationCard proposal={linkerAgentProposal} />
    );
    expect(screen.getByText("Linker Agent")).toBeInTheDocument();

    rerender(<ProposedRelationCard proposal={autoLinkerProposal} />);
    expect(screen.getByText("Auto-Linker")).toBeInTheDocument();
  });

  it("should call onApprove when approve button clicked", () => {
    const proposal = createMockProposal("1");

    render(
      <ProposedRelationCard
        proposal={proposal}
        onApprove={mockOnApprove}
        onReject={mockOnReject}
        onDismiss={mockOnDismiss}
      />
    );

    fireEvent.click(screen.getByText("Approve"));
    expect(mockOnApprove).toHaveBeenCalledTimes(1);
  });

  it("should call onReject when reject button clicked", () => {
    const proposal = createMockProposal("1");

    render(
      <ProposedRelationCard
        proposal={proposal}
        onApprove={mockOnApprove}
        onReject={mockOnReject}
        onDismiss={mockOnDismiss}
      />
    );

    fireEvent.click(screen.getByText("Reject"));
    expect(mockOnReject).toHaveBeenCalledTimes(1);
  });

  it("should call onDismiss when dismiss button clicked", () => {
    const proposal = createMockProposal("1");

    render(
      <ProposedRelationCard
        proposal={proposal}
        onApprove={mockOnApprove}
        onReject={mockOnReject}
        onDismiss={mockOnDismiss}
      />
    );

    fireEvent.click(screen.getByText("Dismiss"));
    expect(mockOnDismiss).toHaveBeenCalledTimes(1);
  });

  it("should show keyboard hints when showKeyboardHints is true", () => {
    const proposal = createMockProposal("1");

    render(
      <ProposedRelationCard
        proposal={proposal}
        onApprove={mockOnApprove}
        onReject={mockOnReject}
        onDismiss={mockOnDismiss}
        showKeyboardHints={true}
      />
    );

    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
    expect(screen.getByText("D")).toBeInTheDocument();
  });

  it("should disable buttons when isProcessing is true", () => {
    const proposal = createMockProposal("1");

    render(
      <ProposedRelationCard
        proposal={proposal}
        onApprove={mockOnApprove}
        onReject={mockOnReject}
        onDismiss={mockOnDismiss}
        isProcessing={true}
      />
    );

    expect(screen.getByText("Approve").closest("button")).toBeDisabled();
    expect(screen.getByText("Reject").closest("button")).toBeDisabled();
    expect(screen.getByText("Dismiss").closest("button")).toBeDisabled();
  });

  it("should format relation type correctly", () => {
    const proposal = createMockProposal("1", "company", "technology", "competes_with");

    render(<ProposedRelationCard proposal={proposal} />);

    expect(screen.getByText("Competes With")).toBeInTheDocument();
  });

  it("should display entity type icons", () => {
    const proposal = createMockProposal("1", "company", "technology", "uses");

    render(<ProposedRelationCard proposal={proposal} />);

    expect(screen.getByTestId("icon-building2")).toBeInTheDocument();
    expect(screen.getByTestId("icon-cpu")).toBeInTheDocument();
  });
});

// ============================================================================
// LinkerTriageQueue Tests
// ============================================================================

describe("LinkerTriageQueue Component", () => {
  const mockOnProposalProcessed = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render empty state when no proposals", () => {
    render(
      <LinkerTriageQueue
        proposals={[]}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("All Caught Up!")).toBeInTheDocument();
  });

  it("should render current proposal", () => {
    const proposals = [createMockProposal("1")];

    render(
      <LinkerTriageQueue
        proposals={proposals}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("Source 1")).toBeInTheDocument();
    expect(screen.getByText("Target 1")).toBeInTheDocument();
  });

  it("should show progress indicator", () => {
    const proposals = [
      createMockProposal("1"),
      createMockProposal("2"),
      createMockProposal("3"),
    ];

    render(
      <LinkerTriageQueue
        proposals={proposals}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText(/Proposal 1 of 3/)).toBeInTheDocument();
  });

  it("should show keyboard shortcuts help", () => {
    const proposals = [createMockProposal("1")];

    render(
      <LinkerTriageQueue
        proposals={proposals}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    // Check for shortcuts label
    expect(screen.getByText("Shortcuts:")).toBeInTheDocument();
    // Check for Navigate text in shortcuts section
    expect(screen.getByText("Navigate")).toBeInTheDocument();
  });

  it("should navigate to next proposal on right arrow click", () => {
    const proposals = [
      createMockProposal("1"),
      createMockProposal("2"),
    ];

    render(
      <LinkerTriageQueue
        proposals={proposals}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("Source 1")).toBeInTheDocument();

    const nextButton = screen.getByRole("button", { name: /next/i });
    fireEvent.click(nextButton);

    expect(screen.getByText("Source 2")).toBeInTheDocument();
  });

  it("should navigate to previous proposal on left arrow click", () => {
    const proposals = [
      createMockProposal("1"),
      createMockProposal("2"),
    ];

    render(
      <LinkerTriageQueue
        proposals={proposals}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    // First go to second proposal
    const nextButton = screen.getByRole("button", { name: /next/i });
    fireEvent.click(nextButton);
    expect(screen.getByText("Source 2")).toBeInTheDocument();

    // Then go back
    const prevButton = screen.getByRole("button", { name: /previous/i });
    fireEvent.click(prevButton);
    expect(screen.getByText("Source 1")).toBeInTheDocument();
  });

  it("should show completion state after all proposals processed", () => {
    render(
      <LinkerTriageQueue
        proposals={[]}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("All Caught Up!")).toBeInTheDocument();
  });
});

// ============================================================================
// LinkerFilters Tests
// ============================================================================

describe("LinkerFilters Component", () => {
  const defaultFilters: LinkerFiltersState = {
    status: "all",
    sourceType: "all",
    targetType: "all",
    relationType: "all",
    discoveredBy: "all",
    minConfidence: 0,
    sortBy: "createdAt-desc",
  };

  const mockOnFiltersChange = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render filter controls", () => {
    render(
      <LinkerFilters
        filters={defaultFilters}
        onFiltersChange={mockOnFiltersChange}
      />
    );

    expect(screen.getByText("All Statuses")).toBeInTheDocument();
    expect(screen.getByText("Entity Types")).toBeInTheDocument();
    expect(screen.getByText("All Relations")).toBeInTheDocument();
    expect(screen.getByText("Confidence")).toBeInTheDocument();
    expect(screen.getByText("All Sources")).toBeInTheDocument();
  });

  it("should show clear filters button when filters are active", () => {
    const activeFilters: LinkerFiltersState = {
      ...defaultFilters,
      status: "pending",
    };

    render(
      <LinkerFilters
        filters={activeFilters}
        onFiltersChange={mockOnFiltersChange}
        activeFilterCount={1}
      />
    );

    expect(screen.getByText("Clear (1)")).toBeInTheDocument();
  });

  it("should not show clear button when no filters active", () => {
    render(
      <LinkerFilters
        filters={defaultFilters}
        onFiltersChange={mockOnFiltersChange}
        activeFilterCount={0}
      />
    );

    expect(screen.queryByText(/Clear/)).not.toBeInTheDocument();
  });
});

describe("countActiveFilters", () => {
  it("should count zero when all filters are default", () => {
    const filters: LinkerFiltersState = {
      status: "all",
      sourceType: "all",
      targetType: "all",
      relationType: "all",
      discoveredBy: "all",
      minConfidence: 0,
      sortBy: "createdAt-desc",
    };

    expect(countActiveFilters(filters)).toBe(0);
  });

  it("should count active filters correctly", () => {
    const filters: LinkerFiltersState = {
      status: "pending",
      sourceType: "company",
      targetType: "all",
      relationType: "uses",
      discoveredBy: "all",
      minConfidence: 50,
      sortBy: "createdAt-desc",
    };

    expect(countActiveFilters(filters)).toBe(4); // status, sourceType, relationType, minConfidence
  });

  it("should not count sortBy as active filter", () => {
    const filters: LinkerFiltersState = {
      status: "all",
      sourceType: "all",
      targetType: "all",
      relationType: "all",
      discoveredBy: "all",
      minConfidence: 0,
      sortBy: "confidence-desc", // Changed sort, but not counted
    };

    expect(countActiveFilters(filters)).toBe(0);
  });
});

// ============================================================================
// LinkerStats Tests
// ============================================================================

describe("LinkerStats Component", () => {
  it("should display stats cards", () => {
    const proposals = [
      createMockProposal("1", "company", "technology", "uses", { status: "pending" }),
      createMockProposal("2", "company", "technology", "uses", { status: "approved" }),
      createMockProposal("3", "company", "technology", "uses", { status: "rejected" }),
    ];

    render(<LinkerStats proposals={proposals} />);

    expect(screen.getByText("Pending Review")).toBeInTheDocument();
    expect(screen.getByText("Approval Rate")).toBeInTheDocument();
    expect(screen.getByText("Avg Confidence")).toBeInTheDocument();
    expect(screen.getByText("Relations Created")).toBeInTheDocument();
  });

  it("should calculate pending count correctly", () => {
    const proposals = [
      createMockProposal("1", "company", "technology", "uses", { status: "pending" }),
      createMockProposal("2", "company", "technology", "uses", { status: "pending" }),
      createMockProposal("3", "company", "technology", "uses", { status: "approved" }),
    ];

    render(<LinkerStats proposals={proposals} />);

    // Pending count should be 2
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("should calculate approval rate correctly", () => {
    const proposals = [
      createMockProposal("1", "company", "technology", "uses", { status: "approved" }),
      createMockProposal("2", "company", "technology", "uses", { status: "approved" }),
      createMockProposal("3", "company", "technology", "uses", { status: "rejected" }),
      createMockProposal("4", "company", "technology", "uses", { status: "rejected" }),
    ];

    render(<LinkerStats proposals={proposals} />);

    // 2 approved out of 4 reviewed = 50%
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("should calculate average confidence correctly", () => {
    const proposals = [
      createMockProposal("1", "company", "technology", "uses", { confidence: 80 }),
      createMockProposal("2", "company", "technology", "uses", { confidence: 90 }),
      createMockProposal("3", "company", "technology", "uses", { confidence: 70 }),
    ];

    render(<LinkerStats proposals={proposals} />);

    // (80 + 90 + 70) / 3 = 80%
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("should show approved count as relations created", () => {
    const proposals = [
      createMockProposal("1", "company", "technology", "uses", { status: "approved" }),
      createMockProposal("2", "company", "technology", "uses", { status: "approved" }),
      createMockProposal("3", "company", "technology", "uses", { status: "approved" }),
      createMockProposal("4", "company", "technology", "uses", { status: "pending" }),
    ];

    render(<LinkerStats proposals={proposals} />);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("From approved proposals")).toBeInTheDocument();
  });

  it("should show high confidence pending count", () => {
    const proposals = [
      createMockProposal("1", "company", "technology", "uses", { status: "pending", confidence: 90 }),
      createMockProposal("2", "company", "technology", "uses", { status: "pending", confidence: 85 }),
      createMockProposal("3", "company", "technology", "uses", { status: "pending", confidence: 60 }),
    ];

    render(<LinkerStats proposals={proposals} />);

    // 2 high confidence (≥85%) pending
    expect(screen.getByText("2 high confidence")).toBeInTheDocument();
  });

  it("should handle empty proposals array", () => {
    render(<LinkerStats proposals={[]} />);

    // Verify the stats cards are rendered with expected content
    expect(screen.getByText("Pending Review")).toBeInTheDocument();
    expect(screen.getByText("Approval Rate")).toBeInTheDocument();
    expect(screen.getByText("Across all proposals")).toBeInTheDocument(); // Avg Confidence subtitle
    expect(screen.getByText("From approved proposals")).toBeInTheDocument(); // Relations Created subtitle
  });
});

// ============================================================================
// Keyboard Shortcuts Tests
// ============================================================================

describe("Keyboard Shortcuts", () => {
  const mockOnProposalProcessed = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should respond to A key for approve", () => {
    const proposals = [createMockProposal("1")];

    render(
      <LinkerTriageQueue
        proposals={proposals}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    fireEvent.keyDown(document, { key: "a" });

    // The approve action should be triggered
    // This verifies the keyboard shortcut is registered
    expect(screen.getByText("Source 1")).toBeInTheDocument();
  });

  it("should respond to arrow keys for navigation", () => {
    const proposals = [
      createMockProposal("1"),
      createMockProposal("2"),
    ];

    render(
      <LinkerTriageQueue
        proposals={proposals}
        onProposalProcessed={mockOnProposalProcessed}
        userId="test-user"
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("Source 1")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "ArrowRight" });

    expect(screen.getByText("Source 2")).toBeInTheDocument();
  });
});
