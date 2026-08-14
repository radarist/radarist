/**
 * @file infographics/[id]/__tests__/page.test.tsx
 * @description Referenced-entities section on the infographic detail page
 * (AI-025): live names render live, deleted entities keep their stored
 * snapshot name, never-resolved references get a neutral label, and legacy
 * records without references show no section at all.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react is ESM; stub icons as null-rendering components.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

jest.mock('@/components/layout/AppLayoutV2', () => ({
  __esModule: true,
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));
jest.mock('@/components/layout/PageShell', () => ({
  __esModule: true,
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('@/components/ai/AIDisclosureBadge', () => ({
  __esModule: true,
  AIDisclosureBadge: () => null,
}));
jest.mock('@/components/infographics/InfographicDownloadButton', () => ({
  __esModule: true,
  InfographicDownloadButton: () => null,
}));
jest.mock('@/components/ui/alert-dialog', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    __esModule: true,
    AlertDialog: Passthrough,
    AlertDialogAction: Passthrough,
    AlertDialogCancel: Passthrough,
    AlertDialogContent: Passthrough,
    AlertDialogDescription: Passthrough,
    AlertDialogFooter: Passthrough,
    AlertDialogHeader: Passthrough,
    AlertDialogTitle: Passthrough,
  };
});

const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({ push: mockRouterPush }),
  useParams: () => ({ id: 'viz-1' }),
}));

const mockUseVisualization = jest.fn();
jest.mock('@/hooks/useVisualizations', () => ({
  __esModule: true,
  useVisualization: () => mockUseVisualization(),
  useUpdateVisualization: () => ({ mutate: jest.fn() }),
  useDeleteVisualization: () => ({ mutate: jest.fn() }),
}));

jest.mock('@/hooks/use-toast', () => ({
  __esModule: true,
  useToast: () => ({ toast: jest.fn() }),
}));

import VisualizationDetailPage from '../page';

const baseViz = {
  id: 'viz-1',
  title: 'Stack Overview',
  prompt: 'render the stack',
  imageUrl: 'https://example.com/viz.png',
  mimeType: 'image/png' as const,
  style: 'professional' as const,
  createdAt: '2026-07-01T00:00:00.000Z',
  shared: false,
  dataSnapshot: { entities: [], description: 'the stack' },
  metadata: { model: 'test', width: 1600, height: 900, sizeBytes: 1024 },
};

describe('infographic detail — referenced entities section', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders live, snapshot, and neutral-unresolved references', () => {
    mockUseVisualization.mockReturnValue({
      isLoading: false,
      data: {
        status: 'found',
        visualization: {
          ...baseViz,
          referencedEntities: [
            { id: 'tech-1', type: 'technology', name: 'React 19', resolution: 'live' },
            { id: 'company-gone', type: 'company', name: 'Acme Corp', resolution: 'snapshot' },
            { id: 'ghost-1', type: 'unknown', name: null, resolution: 'unresolved' },
          ],
        },
      },
    });

    render(<VisualizationDetailPage />);

    const section = screen.getByTestId('viz-referenced-entities');
    expect(section).toBeInTheDocument();
    // Renamed entity shows its CURRENT name.
    expect(screen.getByText('React 19')).toBeInTheDocument();
    // Deleted entity retains its stored snapshot name.
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    // Never-resolved reference gets a neutral label, not an invented name.
    expect(screen.getByText('Unresolved entity')).toBeInTheDocument();
  });

  it('renders no section when the record has no referenced entities', () => {
    mockUseVisualization.mockReturnValue({
      isLoading: false,
      data: { status: 'found', visualization: { ...baseViz, referencedEntities: [] } },
    });

    render(<VisualizationDetailPage />);

    expect(screen.queryByTestId('viz-referenced-entities')).not.toBeInTheDocument();
  });

  it('renders no section for a legacy payload without the referencedEntities field', () => {
    mockUseVisualization.mockReturnValue({
      isLoading: false,
      data: { status: 'found', visualization: baseViz },
    });

    render(<VisualizationDetailPage />);

    expect(screen.queryByTestId('viz-referenced-entities')).not.toBeInTheDocument();
  });

  it('renders not-found only for a confirmed absent record', () => {
    mockUseVisualization.mockReturnValue({
      isLoading: false,
      data: { status: 'not-found' },
      error: null,
    });

    render(<VisualizationDetailPage />);

    expect(screen.getByText('Visualization not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load visualization')).not.toBeInTheDocument();
  });

  it('preserves an Auth/service outage as unavailable and offers a retry', async () => {
    const user = userEvent.setup();
    const refetch = jest.fn();
    mockUseVisualization.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('Authentication unavailable'),
      refetch,
    });

    render(<VisualizationDetailPage />);

    expect(screen.getByText('Could not load visualization')).toBeInTheDocument();
    expect(screen.queryByText('Visualization not found')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps owner metadata and offers bounded media retry when Storage is unavailable', () => {
    mockUseVisualization.mockReturnValue({
      isLoading: false,
      data: { status: 'found', visualization: baseViz },
      error: null,
    });

    render(<VisualizationDetailPage />);
    fireEvent.error(screen.getByTestId('viz-full-image'));

    expect(screen.getByText(baseViz.title)).toBeInTheDocument();
    expect(screen.getByTestId('viz-prompt')).toHaveTextContent(baseViz.prompt);
    expect(screen.getByText('Media unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry media' })).toBeInTheDocument();
    expect(screen.queryByTestId('viz-full-image')).not.toBeInTheDocument();
  });
});
