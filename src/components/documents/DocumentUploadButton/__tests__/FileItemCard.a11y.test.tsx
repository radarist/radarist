/**
 * @file FileItemCard.a11y.test.tsx
 * @description Accessible-name regression for the upload file list
 * (UX-040/ACCESS-001): the icon-only remove-from-list control must carry a
 * contextual accessible name including the file name.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    }
  );
});

jest.mock('../EntityLinkingSection', () => ({
  EntityLinkingSection: () => null,
}));

jest.mock('../utils', () => ({
  getFileIcon: () => (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

import { FileItemCard } from '../FileItemCard';
import type { FileUploadItem } from '../types';

const fileItem: FileUploadItem = {
  id: 'file-1',
  file: { name: 'whitepaper.pdf', size: 2048 } as File,
  status: 'pending',
  progress: 0,
  title: 'Whitepaper',
  description: '',
  tags: '',
  entitySelection: { companies: [], technologies: [], useCases: [], prototypes: [] },
} as unknown as FileUploadItem;

describe('FileItemCard accessible names (UX-040)', () => {
  it('names the remove-from-upload-list button with the file name', () => {
    render(
      <FileItemCard
        fileItem={fileItem}
        isUploading={false}
        onRemove={jest.fn()}
        onMetadataChange={jest.fn()}
        onEntitySelectionChange={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /remove whitepaper\.pdf/i })).toBeInTheDocument();
  });
});
