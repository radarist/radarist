import { fireEvent, render, screen } from '@testing-library/react';
import type { Visualization } from '@/lib/schemas/visualization';

jest.mock('lucide-react', () => ({
  ImageOff: () => null,
  RotateCcw: () => null,
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}));

jest.mock('@/lib/visualizations', () => ({
  readVisualizationById: jest.fn(),
}));

import SharedVisualizationPage, { generateMetadata } from '../page';
import { readVisualizationById } from '@/lib/visualizations';

const mockReadVisualizationById = readVisualizationById as jest.MockedFunction<typeof readVisualizationById>;

const SHARED_VISUALIZATION: Visualization = {
  id: 'viz-shared',
  title: 'Shared technology landscape',
  prompt: 'Render the approved landscape.',
  refinedPrompt: 'Render the approved landscape.',
  imageUrl: 'https://example.test/landscape.png',
  mimeType: 'image/png',
  style: 'professional',
  dataSnapshot: {
    description: 'A bounded public summary.',
    entities: [
      {
        id: 'company-private',
        name: 'Confidential Company Name',
        type: 'company',
      },
    ],
  },
  createdAt: '2026-07-17T12:00:00.000Z',
  createdBy: 'local-operator',
  shared: true,
  userId: 'local-operator',
  metadata: {
    model: 'test-image-model',
    width: 1200,
    height: 675,
    sizeBytes: 1024,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('public visualization reference privacy', () => {
  it('exposes the public summary but not stored entity-reference names', async () => {
    mockReadVisualizationById.mockResolvedValue({ status: 'found', visualization: SHARED_VISUALIZATION });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: SHARED_VISUALIZATION.id }) });
    expect(JSON.stringify(metadata)).toContain('A bounded public summary.');
    expect(JSON.stringify(metadata)).not.toContain('Confidential Company Name');

    mockReadVisualizationById.mockResolvedValue({ status: 'found', visualization: SHARED_VISUALIZATION });
    const { container } = render(
      await SharedVisualizationPage({ params: Promise.resolve({ id: SHARED_VISUALIZATION.id }) })
    );

    expect(screen.getByText('A bounded public summary.')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Confidential Company Name');
    expect(container.innerHTML).not.toContain('company-private');
    expect(screen.queryByText('Referenced entities')).not.toBeInTheDocument();
  });

  it('keeps safe public metadata visible when the shared media cannot be read', async () => {
    mockReadVisualizationById.mockResolvedValue({ status: 'found', visualization: SHARED_VISUALIZATION });
    render(await SharedVisualizationPage({ params: Promise.resolve({ id: SHARED_VISUALIZATION.id }) }));

    fireEvent.error(screen.getByTestId('shared-visualization-media'));

    expect(screen.getByText(SHARED_VISUALIZATION.title)).toBeInTheDocument();
    expect(screen.getByText('A bounded public summary.')).toBeInTheDocument();
    expect(screen.getByText('Media unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('shared-visualization-media')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry media' })).not.toBeInTheDocument();
  });

  it('renders confirmed absence separately from a metadata outage', async () => {
    mockReadVisualizationById.mockResolvedValueOnce({ status: 'not-found' });
    render(await SharedVisualizationPage({ params: Promise.resolve({ id: 'viz-missing' }) }));
    expect(screen.getByText('Visualization Not Found')).toBeInTheDocument();

    mockReadVisualizationById.mockRejectedValueOnce(new Error('Firestore unavailable'));
    render(await SharedVisualizationPage({ params: Promise.resolve({ id: 'viz-outage' }) }));
    expect(screen.getByText('Visualization Temporarily Unavailable')).toBeInTheDocument();
  });

  it('fails closed before exposing public metadata when share state cannot be verified', async () => {
    mockReadVisualizationById.mockRejectedValue(new Error('Firestore unavailable'));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: SHARED_VISUALIZATION.id }) });

    expect(metadata.title).toBe('Visualization Temporarily Unavailable');
    expect(JSON.stringify(metadata)).not.toContain(SHARED_VISUALIZATION.title);
    expect(JSON.stringify(metadata)).not.toContain('A bounded public summary.');
  });

  it('requires persisted shared to be the literal boolean true', async () => {
    mockReadVisualizationById.mockResolvedValue({
      status: 'found',
      visualization: { ...SHARED_VISUALIZATION, shared: 'true' } as unknown as Visualization,
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: SHARED_VISUALIZATION.id }) });

    expect(metadata.title).toBe('Visualization Not Shared');
    expect(JSON.stringify(metadata)).not.toContain(SHARED_VISUALIZATION.title);
  });
});
