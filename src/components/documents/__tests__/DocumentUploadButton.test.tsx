/**
 * @file DocumentUploadButton.test.tsx
 * @description Regression test for the icon-only accessible-name a11y fix.
 *
 * The icon-only trigger (showIcon + no label, e.g. the Documents library header)
 * lost its `title="Upload Documents"` attribute when it was wrapped in a Radix
 * Tooltip — a Tooltip alone provides no accessible name. This pins
 * `aria-label="Upload documents"` on the trigger `Button` so the regression
 * can't silently return.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { DocumentUploadButton } from '../DocumentUploadButton';

jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop;
        return IconComponent;
      },
    }
  );
});

jest.mock('@/components/providers/AuthProvider', () => ({
  __esModule: true,
  useAuth: () => ({ user: { uid: 'user-1' } }),
}));

jest.mock('@/lib/entity-document-link-service', () => ({
  createEntityDocumentLink: jest.fn(),
}));

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('DocumentUploadButton', () => {
  it('exposes an accessible name on the icon-only trigger (Tooltip alone provides none)', () => {
    renderWithClient(<DocumentUploadButton label="" showIcon />);

    const button = screen.getByRole('button', { name: /upload documents/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-label', 'Upload documents');
  });

  it('still renders the lucide Upload icon used by the e2e selector fallback', () => {
    renderWithClient(<DocumentUploadButton label="" showIcon />);

    expect(screen.getByTestId('icon-Upload')).toBeInTheDocument();
  });

  it('keeps the labeled variant working (no aria-label needed — visible text names it)', () => {
    renderWithClient(<DocumentUploadButton label="Upload Document" showIcon />);

    expect(screen.getByRole('button', { name: /upload document/i })).toBeInTheDocument();
  });
});
