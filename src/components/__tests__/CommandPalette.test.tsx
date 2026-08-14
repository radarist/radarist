/**
 * @file CommandPalette.test.tsx
 * @description Tests for the CommandPalette and CommandPaletteTrigger components
 *
 * Tests rendering of command groups, navigation items, quick actions,
 * keyboard shortcut triggering, search results, and the trigger button.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette, CommandPaletteTrigger } from '../CommandPalette';

// ============================================================================
// Mocks
// ============================================================================

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
  }),
}));

const mockAddRecentItem = jest.fn();
// Configurable per-test: push entries here to render the Recent group.
let mockRecentItems: Array<{ id: string; name: string; type: string; path: string; timestamp: number }> = [];
jest.mock('@/hooks/useRecentItems', () => ({
  useRecentItems: () => ({
    recentItems: mockRecentItems,
    addRecentItem: mockAddRecentItem,
  }),
}));

jest.mock('@/lib/companies', () => ({
  getCompanies: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/prototypes', () => ({
  getPrototypes: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/use-cases', () => ({
  getUseCases: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/strategies', () => ({
  getStrategies: jest.fn().mockResolvedValue([]),
}));

// Mock lucide-react icons
jest.mock('lucide-react', () => {
  const createIcon = (name: string) => {
    const IconComponent = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    IconComponent.displayName = name;
    return IconComponent;
  };

  return {
    LayoutDashboard: createIcon('layout-dashboard'),
    Radar: createIcon('radar'),
    Network: createIcon('network'),
    Library: createIcon('library'),
    Building2: createIcon('building2'),
    Cpu: createIcon('cpu'),
    Lightbulb: createIcon('lightbulb'),
    FlaskConical: createIcon('flask-conical'),
    Target: createIcon('target'),
    Radio: createIcon('radio'),
    Bot: createIcon('bot'),
    Settings: createIcon('settings'),
    Plus: createIcon('plus'),
    Search: createIcon('search'),
    Sparkles: createIcon('sparkles'),
    FileText: createIcon('file-text'),
    ArrowRight: createIcon('arrow-right'),
    Clock: createIcon('clock'),
    Loader2: createIcon('loader2'),
    ShieldCheck: createIcon('shield-check'),
  };
});

// Mock shadcn CommandDialog components to be simple divs for testing
jest.mock('@/components/ui/command', () => ({
  CommandDialog: ({
    children,
    open,
    onOpenChange: _onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (open ? <div data-testid="command-dialog">{children}</div> : null),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div data-testid="command-empty">{children}</div>,
  CommandGroup: ({ children, heading }: { children: React.ReactNode; heading: string }) => (
    <div data-testid={`command-group-${heading.toLowerCase().replace(/\s+/g, '-')}`}>
      <span data-testid="group-heading">{heading}</span>
      {children}
    </div>
  ),
  CommandInput: ({
    placeholder,
    value,
    onValueChange,
  }: {
    placeholder: string;
    value: string;
    onValueChange: (val: string) => void;
  }) => (
    <input
      data-testid="command-input"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    />
  ),
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    value?: string;
  }) => (
    <div data-testid="command-item" data-value={value} role="option" onClick={onSelect}>
      {children}
    </div>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div data-testid="command-list">{children}</div>,
  CommandSeparator: () => <hr data-testid="command-separator" />,
  CommandShortcut: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="command-shortcut">{children}</span>
  ),
}));

describe('CommandPalette', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecentItems = [];
  });

  // ================================================================
  // Recent items — canonical URL re-derivation
  // ================================================================

  it('navigates a recent item via the canonical entity URL, not the stored stale path', () => {
    // Legacy localStorage entries carry the dead generic `?open=` param that
    // no list page listens to. Clicking must re-derive the canonical sheet
    // URL from (type, id) instead of replaying the stale stored path.
    mockRecentItems = [
      {
        id: 'company-123',
        name: 'Acme Corp',
        type: 'company',
        path: '/library/companies?open=company-123',
        timestamp: Date.now(),
      },
    ];
    const onOpenChange = jest.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText('Acme Corp'));

    expect(mockPush).toHaveBeenCalledWith('/library/companies?company=company-123');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends recent signal items to the signals page (no sheet param), ignoring stale stored params', () => {
    // Signals have no URL-driven sheet — the canonical URL is the bare list
    // page. A stale `?open=` stored path must not leak through.
    mockRecentItems = [
      {
        id: 'signal-9',
        name: 'Quantum breakthrough',
        type: 'signal',
        path: '/triage/signals?open=signal-9',
        timestamp: Date.now(),
      },
    ];
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);

    fireEvent.click(screen.getByText('Quantum breakthrough'));

    expect(mockPush).toHaveBeenCalledWith('/triage/signals');
  });

  // ================================================================
  // Open/close behavior
  // ================================================================

  it('should not render dialog when open is false', () => {
    render(<CommandPalette open={false} onOpenChange={jest.fn()} />);
    expect(screen.queryByTestId('command-dialog')).not.toBeInTheDocument();
  });

  it('should render dialog when open is true', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);
    expect(screen.getByTestId('command-dialog')).toBeInTheDocument();
  });

  // ================================================================
  // Command groups
  // ================================================================

  it('should render navigation + library command groups', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByTestId('command-group-navigation')).toBeInTheDocument();
    expect(screen.getByTestId('command-group-library')).toBeInTheDocument();
    // Quick Actions + AI groups were removed because their items were unwired
    // (just logged and closed). When those flows are implemented they can
    // come back here.
    expect(screen.queryByTestId('command-group-quick-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('command-group-ai')).not.toBeInTheDocument();
  });

  // ================================================================
  // Navigation items
  // ================================================================

  it('should render navigation items', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Go to Radar')).toBeInTheDocument();
    expect(screen.getByText('Go to Relations Graph')).toBeInTheDocument();
    expect(screen.getByText('Go to Library')).toBeInTheDocument();
    expect(screen.getByText('Go to Signals')).toBeInTheDocument();
    expect(screen.getByText('Go to Agents')).toBeInTheDocument();
    // UX-068: background verification jobs are their own Activity surface.
    expect(screen.getByText('Go to Jobs')).toBeInTheDocument();
    expect(screen.getByText('Go to Settings')).toBeInTheDocument();
  });

  it('should navigate to the Jobs page when clicking Go to Jobs', () => {
    const onOpenChange = jest.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText('Go to Jobs'));
    expect(mockPush).toHaveBeenCalledWith('/agents/jobs');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('should navigate to Dashboard when clicking Dashboard item', () => {
    const onOpenChange = jest.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText('Go to Dashboard'));
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('should navigate to Radar when clicking Radar item', () => {
    const onOpenChange = jest.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText('Go to Radar'));
    expect(mockPush).toHaveBeenCalledWith('/visualizations/radar');
  });

  // ================================================================
  // Library items
  // ================================================================

  it('should render library items', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByText('Browse Companies')).toBeInTheDocument();
    expect(screen.getByText('Browse Technologies')).toBeInTheDocument();
    expect(screen.getByText('Browse Use Cases')).toBeInTheDocument();
    expect(screen.getByText('Browse Prototypes')).toBeInTheDocument();
    expect(screen.getByText('Browse Strategies')).toBeInTheDocument();
  });

  it('should navigate to companies page when clicking Browse Companies', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);
    fireEvent.click(screen.getByText('Browse Companies'));
    expect(mockPush).toHaveBeenCalledWith('/library/companies');
  });

  // ================================================================
  // Search input
  // ================================================================

  it('should render search input with correct placeholder', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);

    const input = screen.getByTestId('command-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Type a command or search...');
  });

  // ================================================================
  // Keyboard shortcut (Cmd+K)
  // ================================================================

  it('should toggle open state on Cmd+K', () => {
    const onOpenChange = jest.fn();
    render(<CommandPalette open={false} onOpenChange={onOpenChange} />);

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('should toggle open state on Ctrl+K', () => {
    const onOpenChange = jest.fn();
    render(<CommandPalette open={false} onOpenChange={onOpenChange} />);

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  // ================================================================
  // Uncontrolled mode
  // ================================================================

  it('should work in uncontrolled mode without open/onOpenChange props', () => {
    render(<CommandPalette />);
    // Dialog should start closed (internal state defaults to false)
    expect(screen.queryByTestId('command-dialog')).not.toBeInTheDocument();

    // Cmd+K should open it
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByTestId('command-dialog')).toBeInTheDocument();
  });

  // ================================================================
  // CommandEmpty
  // ================================================================

  it('should render empty state text', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);
    expect(screen.getByText('No results found.')).toBeInTheDocument();
  });

  // ================================================================
  // Command separators
  // ================================================================

  it('should render separators between groups', () => {
    render(<CommandPalette open={true} onOpenChange={jest.fn()} />);
    const separators = screen.getAllByTestId('command-separator');
    // At least one separator between Navigation and Library groups.
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// CommandPaletteTrigger Tests
// ============================================================================

describe('CommandPaletteTrigger', () => {
  it('should render the trigger button', () => {
    render(<CommandPaletteTrigger />);
    expect(screen.getByText('Search...')).toBeInTheDocument();
  });

  it('should render the search icon', () => {
    render(<CommandPaletteTrigger />);
    expect(screen.getByTestId('icon-search')).toBeInTheDocument();
  });

  it('should render the keyboard shortcut hint', () => {
    render(<CommandPaletteTrigger />);
    expect(screen.getByText('K')).toBeInTheDocument();
  });

  it('should call onClick when clicked', () => {
    const onClick = jest.fn();
    render(<CommandPaletteTrigger onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('should render without onClick prop', () => {
    render(<CommandPaletteTrigger />);
    const button = screen.getByRole('button');
    // Should not throw when clicked
    fireEvent.click(button);
  });
});
