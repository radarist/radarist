/**
 * @file DocumentUploadDialog.test.tsx
 * @description Tests for the DocumentUploadDialog component
 *
 * Tests the dialog rendering, tabs (file upload / URL import),
 * drag-and-drop interactions, URL validation, processing states,
 * results display, and entity import flow.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentUploadDialog } from '../DocumentUploadDialog';
import type { IngestionResult } from '@/hooks/useDocumentIngest';

// ============================================================================
// Mocks
// ============================================================================

const mockProcessDocument = jest.fn();
const mockReset = jest.fn();
let mockHookState = {
  isProcessing: false,
  progress: 0,
  status: '',
  error: null as string | null,
  result: null as IngestionResult | null,
};

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

jest.mock('@/hooks/useDocumentIngest', () => ({
  useDocumentIngest: () => ({
    ...mockHookState,
    processDocument: mockProcessDocument,
    reset: mockReset,
  }),
  SUPPORTED_EXTENSIONS: ['.pdf', '.docx', '.pptx'],
  MAX_FILE_SIZE: 10 * 1024 * 1024,
}));

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}));

jest.mock('@/lib/relations', () => ({
  createRelation: jest.fn().mockResolvedValue({ id: 'rel-1' }),
}));

jest.mock('@/lib/auto-linker-utils', () => ({
  createSnapshotFromSuggestion: jest.fn().mockReturnValue({
    id: 'target-1',
    name: 'Target Entity',
    type: 'technology',
    snapshotAt: Date.now(),
  }),
}));

// Mock lucide-react icons
jest.mock('lucide-react', () => {
  const createIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };

  return {
    Upload: createIcon('upload'),
    FileText: createIcon('file-text'),
    Loader2: createIcon('loader2'),
    CheckCircle2: createIcon('check-circle-2'),
    XCircle: createIcon('x-circle'),
    Cpu: createIcon('cpu'),
    Building2: createIcon('building2'),
    Target: createIcon('target'),
    Link2: createIcon('link2'),
    FileUp: createIcon('file-up'),
    Sparkles: createIcon('sparkles'),
    Globe: createIcon('globe'),
    AlertCircle: createIcon('alert-circle'),
  };
});

// Mock cn utility
jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Mock shadcn/ui components
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
    onOpenChange: _onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="dialog" data-open={open}>
        {children}
      </div>
    ) : null,
  DialogContent: ({
    children,
    className: _className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div data-testid="dialog-content">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({
    children,
    className: _className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <h2 data-testid="dialog-title">{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-testid="dialog-description">{children}</p>
  ),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    size,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
  }) => (
    <button
      data-testid={`button${variant ? `-${variant}` : ''}${size ? `-${size}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      {children}
    </button>
  ),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({
    children,
    variant,
    className,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => (
    <span data-testid="badge" data-variant={variant} className={className}>
      {children}
    </span>
  ),
}));

jest.mock('@/components/ui/progress', () => ({
  Progress: ({ value, className }: { value: number; className?: string }) => (
    <div data-testid="progress-bar" data-value={value} className={className} />
  ),
}));

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}));

jest.mock('@/components/ui/input', () => ({
  Input: ({
    id,
    type,
    placeholder,
    value,
    onChange,
    onKeyDown,
    disabled,
    className,
  }: {
    id?: string;
    type?: string;
    placeholder?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <input
      id={id}
      type={type}
      data-testid="input"
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      disabled={disabled}
      className={className}
    />
  ),
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{children}</label>,
}));

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({
    children,
    value,
    onValueChange: _onValueChange,
    className: _tabsClassName,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (val: string) => void;
    className?: string;
  }) => (
    <div data-testid="tabs" data-value={value}>
      {children}
    </div>
  ),
  TabsList: ({
    children,
    className: _className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div data-testid="tabs-list">{children}</div>,
  TabsTrigger: ({
    children,
    value,
    className: _className,
  }: {
    children: React.ReactNode;
    value: string;
    className?: string;
  }) => (
    <button data-testid={`tab-trigger-${value}`} data-value={value}>
      {children}
    </button>
  ),
  TabsContent: ({
    children,
    value,
    className: _className,
  }: {
    children: React.ReactNode;
    value: string;
    className?: string;
  }) => (
    <div data-testid={`tab-content-${value}`} data-value={value}>
      {children}
    </div>
  ),
}));

// ============================================================================
// Tests
// ============================================================================

describe('DocumentUploadDialog', () => {
  const defaultProps = {
    isOpen: true,
    onOpenChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockHookState = {
      isProcessing: false,
      progress: 0,
      status: '',
      error: null,
      result: null,
    };
  });

  // ================================================================
  // Rendering
  // ================================================================

  it('should not render when isOpen is false', () => {
    render(<DocumentUploadDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
  });

  it('should render when isOpen is true', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
  });

  it('should render dialog header with title', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('Import Document')).toBeInTheDocument();
  });

  it('should render dialog description', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(
      screen.getByText('Upload a file or add a web page URL. AI will extract entities and knowledge.')
    ).toBeInTheDocument();
  });

  // ================================================================
  // Tabs
  // ================================================================

  it('should render file and URL tabs', () => {
    render(<DocumentUploadDialog {...defaultProps} />);

    expect(screen.getByTestId('tab-trigger-file')).toBeInTheDocument();
    expect(screen.getByTestId('tab-trigger-url')).toBeInTheDocument();
    expect(screen.getByText('Upload File')).toBeInTheDocument();
    expect(screen.getByText('From URL')).toBeInTheDocument();
  });

  it('should default to file tab', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    const tabs = screen.getByTestId('tabs');
    expect(tabs).toHaveAttribute('data-value', 'file');
  });

  // ================================================================
  // File upload area
  // ================================================================

  it('should render file drop zone with instructions', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('Drag & drop a document here')).toBeInTheDocument();
    expect(screen.getByText('or click to browse')).toBeInTheDocument();
  });

  it('should display supported file types', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
    expect(screen.getByText('PPTX')).toBeInTheDocument();
  });

  it('should display max file size', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText(/Max 10MB/)).toBeInTheDocument();
  });

  it('should call processDocument when a file is dropped', () => {
    render(<DocumentUploadDialog {...defaultProps} />);

    const dropZone = screen.getByText('Drag & drop a document here').closest('div')!;
    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' });

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    });

    expect(mockProcessDocument).toHaveBeenCalledWith(file);
  });

  it('should handle dragOver event', () => {
    render(<DocumentUploadDialog {...defaultProps} />);

    const dropZone = screen.getByText('Drag & drop a document here').closest('div')!;

    // Should not throw
    fireEvent.dragOver(dropZone, {
      dataTransfer: { files: [] },
    });
  });

  it('should handle dragLeave event', () => {
    render(<DocumentUploadDialog {...defaultProps} />);

    const dropZone = screen.getByText('Drag & drop a document here').closest('div')!;

    // Should not throw
    fireEvent.dragLeave(dropZone, {
      dataTransfer: { files: [] },
    });
  });

  // ================================================================
  // URL tab
  // ================================================================

  it('should render URL input in URL tab', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('Web Page URL')).toBeInTheDocument();
    expect(screen.getByTestId('input')).toBeInTheDocument();
  });

  it('should render Import from URL button', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('Import from URL')).toBeInTheDocument();
  });

  it('should disable Import from URL button when URL input is empty', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    // Find the button that contains "Import from URL"
    const importButton = screen.getByText('Import from URL').closest('button');
    expect(importButton).toBeDisabled();
  });

  // ================================================================
  // Error state (file)
  // ================================================================

  it('should display file error message when present', () => {
    mockHookState = {
      ...mockHookState,
      error: 'File too large',
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('File too large')).toBeInTheDocument();
    expect(screen.getByTestId('icon-x-circle')).toBeInTheDocument();
  });

  // ================================================================
  // Processing state
  // ================================================================

  it('should show processing indicator when isProcessing is true', () => {
    mockHookState = {
      ...mockHookState,
      isProcessing: true,
      progress: 50,
      status: 'Extracting text...',
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByTestId('icon-loader2')).toBeInTheDocument();
    expect(screen.getByText('Extracting text...')).toBeInTheDocument();
    expect(screen.getByTestId('progress-bar')).toHaveAttribute('data-value', '50');
  });

  it('should hide tabs during processing', () => {
    mockHookState = {
      ...mockHookState,
      isProcessing: true,
      progress: 25,
      status: 'Processing...',
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.queryByTestId('tabs')).not.toBeInTheDocument();
  });

  // ================================================================
  // Results state
  // ================================================================

  it('should display results when processing completes', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'test-doc.pdf',
        fileSize: 1024 * 500, // 500 KB
        mimeType: 'application/pdf',
        pageCount: 10,
        textLength: 5000,
        extractedText: 'Some text...',
        suggestions: [],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('test-doc.pdf')).toBeInTheDocument();
    expect(screen.getByText(/10 pages/)).toBeInTheDocument();
    expect(screen.getByText(/500\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/5,000 characters extracted/)).toBeInTheDocument();
  });

  it('should display entity count when suggestions exist', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [
          {
            entityId: 'tech-1',
            entityName: 'React',
            entityType: 'technology',
            relationType: 'uses',
            confidence: 90,
            context: 'Uses React for frontend',
          },
          {
            entityId: 'comp-1',
            entityName: 'Acme Corp',
            entityType: 'company',
            relationType: 'partner',
            confidence: 75,
            context: 'Partnership with Acme',
          },
        ],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('2 Entities Found')).toBeInTheDocument();
  });

  it('should show "Found" badge for suggestions without source entity', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [
          {
            entityId: 'tech-1',
            entityName: 'React',
            entityType: 'technology',
            relationType: 'uses',
            confidence: 90,
          },
        ],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('Found')).toBeInTheDocument();
  });

  it('should show empty state when no suggestions found', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'empty.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        textLength: 100,
        extractedText: 'Empty...',
        suggestions: [],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(
      screen.getByText('No matching entities found in this document.')
    ).toBeInTheDocument();
  });

  it('should hide tabs when results are displayed', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.queryByTestId('tabs')).not.toBeInTheDocument();
  });

  // ================================================================
  // Upload Another button
  // ================================================================

  it('should show "Upload Another Document" button in results state', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('Upload Another Document')).toBeInTheDocument();
  });

  it('should call reset when "Upload Another Document" is clicked', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Upload Another Document'));
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  // ================================================================
  // Source entity and import flow
  // ================================================================

  it('should show "Link" button for suggestions when sourceEntity is provided', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [
          {
            entityId: 'tech-1',
            entityName: 'React',
            entityType: 'technology',
            relationType: 'uses',
            confidence: 90,
          },
        ],
      },
    };

    render(
      <DocumentUploadDialog
        {...defaultProps}
        sourceEntity={{
          type: 'company',
          id: 'comp-1',
          name: 'Test Company',
        }}
      />
    );

    expect(screen.getByText('Link')).toBeInTheDocument();
  });

  it('should show "Import All" button when sourceEntity is provided and unimported suggestions exist', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [
          {
            entityId: 'tech-1',
            entityName: 'React',
            entityType: 'technology',
            relationType: 'uses',
            confidence: 90,
          },
        ],
      },
    };

    render(
      <DocumentUploadDialog
        {...defaultProps}
        sourceEntity={{
          type: 'company',
          id: 'comp-1',
          name: 'Test Company',
        }}
      />
    );

    expect(screen.getByText('Import All')).toBeInTheDocument();
  });

  // ================================================================
  // Suggestion details
  // ================================================================

  it('should display entity name and type in suggestion', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [
          {
            entityId: 'tech-1',
            entityName: 'React Framework',
            entityType: 'technology',
            relationType: 'uses',
            confidence: 85,
            context: 'Mentions React for UI',
          },
        ],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText('React Framework')).toBeInTheDocument();
    expect(screen.getByText('technology')).toBeInTheDocument();
    expect(screen.getByText('85% match')).toBeInTheDocument();
  });

  it('should display context from suggestions', () => {
    mockHookState = {
      ...mockHookState,
      result: {
        fileName: 'report.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        textLength: 1000,
        extractedText: 'Text...',
        suggestions: [
          {
            entityId: 'tech-1',
            entityName: 'React',
            entityType: 'technology',
            relationType: 'uses',
            confidence: 90,
            context: 'Frontend framework used',
          },
        ],
      },
    };

    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByText(/"Frontend framework used"/)).toBeInTheDocument();
  });

  // ================================================================
  // FileUp icon in header
  // ================================================================

  it('should display the FileUp icon in the dialog title', () => {
    render(<DocumentUploadDialog {...defaultProps} />);
    expect(screen.getByTestId('icon-file-up')).toBeInTheDocument();
  });
});
