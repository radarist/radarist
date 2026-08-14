import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InfographicDownloadButton } from '../InfographicDownloadButton';

jest.mock('lucide-react', () => ({
  Download: () => <span aria-hidden="true" />,
  Loader2: () => <span aria-hidden="true" />,
}));

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const CASES = [
  { mimeType: 'image/png', label: 'PNG', extension: 'png' },
  { mimeType: 'image/jpeg', label: 'JPEG', extension: 'jpg' },
  { mimeType: 'image/svg+xml', label: 'SVG', extension: 'svg' },
] as const;

const BODY_BY_MIME: Record<string, BlobPart> = {
  'image/png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
  'image/jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01]),
  'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
};

describe('InfographicDownloadButton', () => {
  const anchorDownloads: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    anchorDownloads.length = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn().mockReturnValue('blob:visualization'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    });
    jest.spyOn(window, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 1;
    }) as typeof window.setTimeout);
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchorDownloads.push(this.download);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(CASES)('labels and downloads $mimeType as .$extension', async ({ mimeType, label, extension }) => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': mimeType }),
      blob: jest.fn().mockResolvedValue(new Blob([BODY_BY_MIME[mimeType]], { type: mimeType })),
    });
    const user = userEvent.setup();
    render(<InfographicDownloadButton visualizationId="viz-exact-1" mimeType={mimeType} title="Chart" />);

    await user.click(screen.getByRole('button', { name: `Download ${label}` }));

    expect(anchorDownloads).toEqual([`Chart.${extension}`]);
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/visualizations/viz-exact-1/export');
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ size: expect.any(Number) }));
  });

  it('disables download for an unknown stored media type', () => {
    render(
      <InfographicDownloadButton
        visualizationId="viz-exact-1"
        mimeType="image/gif"
        title="Chart"
      />
    );

    expect(screen.getByRole('button', { name: 'Download unavailable' })).toBeDisabled();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows a failure without creating a download for a mismatched response type', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      blob: jest.fn().mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' })),
    });
    const user = userEvent.setup();
    render(
      <InfographicDownloadButton
        visualizationId="viz-exact-1"
        mimeType="image/png"
        title="Chart"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Download PNG' }));

    expect(anchorDownloads).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive', title: 'Download failed' })
    );
  });
});
