/**
 * @file ChatInput.test.tsx
 * @description Unit tests for the ChatInput component
 *
 * Tests cover:
 * - Textarea rendering with placeholder text
 * - onChange callback when typing
 * - Enter key to submit (with non-empty value)
 * - Shift+Enter inserts newline, does not submit
 * - Guards: empty value, isLoading, disabled
 * - Send button disabled states
 * - File attachment button rendering
 * - Voice button visibility based on speech recognition support
 * - Exposed imperative ref: focus() and clear()
 */

import React, { createRef } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ChatInputRef } from '../ChatInput';

// ============================================================================
// Mocks
// ============================================================================

// framer-motion: strip animations so components render synchronously
jest.mock('framer-motion', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

// useSpeechRecognition: default to "not supported"
const mockStartListening = jest.fn();
const mockStopListening = jest.fn();
const mockResetTranscript = jest.fn();

const defaultSpeechRecognitionReturn = {
  isListening: false,
  transcript: '',
  interimTranscript: '',
  isSupported: false,
  startListening: mockStartListening,
  stopListening: mockStopListening,
  resetTranscript: mockResetTranscript,
  error: null,
};

const mockUseSpeechRecognition = jest.fn(
  () => defaultSpeechRecognitionReturn
);

jest.mock('@/hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: (...args: Parameters<typeof mockUseSpeechRecognition>) =>
    mockUseSpeechRecognition(...args),
}));

// shadcn/ui - Popover: render children directly (avoids Radix portal issues)
jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children, asChild }: React.PropsWithChildren<{ asChild?: boolean }>) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  PopoverContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

// shadcn/ui - Tooltip: render children and content inline
jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: React.PropsWithChildren<{ asChild?: boolean }>) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

// shadcn/ui - Checkbox: simple checkbox input
jest.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    className,
    disabled,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    className?: string;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      checked={checked ?? false}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      className={className}
      disabled={disabled}
      readOnly={!onCheckedChange}
      data-testid="checkbox"
    />
  ),
}));

// lucide-react: lightweight stub icons
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => (
          <svg data-testid={`icon-${prop}`} {...props} />
        );
        Icon.displayName = prop;
        return Icon;
      },
    }
  );
});

// Import the component AFTER all mocks are in place
import { ChatInput } from '../ChatInput';

// ============================================================================
// Helpers
// ============================================================================

/** Default props that satisfy all required fields. */
function buildDefaultProps(overrides?: Partial<Parameters<typeof ChatInput>[0]>) {
  return {
    value: '',
    onChange: jest.fn(),
    onSubmit: jest.fn(),
    isLoading: false,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ChatInput', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSpeechRecognition.mockReturnValue(defaultSpeechRecognitionReturn);
  });

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders the textarea with the default placeholder', () => {
      render(<ChatInput {...buildDefaultProps()} />);
      const textarea = screen.getByTestId('chat-input');
      expect(textarea).toBeInTheDocument();
      // When not listening the placeholder text shown is "How can I help you today?"
      expect(textarea).toHaveAttribute('placeholder', 'How can I help you today?');
    });

    it('renders the outer container with data-testid="chat-input-container"', () => {
      render(<ChatInput {...buildDefaultProps()} />);
      expect(screen.getByTestId('chat-input-container')).toBeInTheDocument();
    });

    it('renders the send button', () => {
      render(<ChatInput {...buildDefaultProps()} />);
      expect(screen.getByTestId('send-button')).toBeInTheDocument();
    });

    it('renders the file attachment button', () => {
      render(<ChatInput {...buildDefaultProps()} />);
      expect(screen.getByTestId('attachment-button')).toBeInTheDocument();
    });

    it('does NOT render the voice button when speech recognition is not supported', () => {
      mockUseSpeechRecognition.mockReturnValue({
        ...defaultSpeechRecognitionReturn,
        isSupported: false,
      });
      render(<ChatInput {...buildDefaultProps()} />);
      expect(screen.queryByTestId('voice-button')).not.toBeInTheDocument();
    });

    it('renders the voice button when speech recognition is supported', () => {
      mockUseSpeechRecognition.mockReturnValue({
        ...defaultSpeechRecognitionReturn,
        isSupported: true,
      });
      render(<ChatInput {...buildDefaultProps()} />);
      expect(screen.getByTestId('voice-button')).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // onChange
  // --------------------------------------------------------------------------

  describe('onChange', () => {
    it('calls onChange when the user types in the textarea', () => {
      const onChange = jest.fn();
      render(<ChatInput {...buildDefaultProps({ onChange })} />);

      const textarea = screen.getByTestId('chat-input');
      fireEvent.change(textarea, { target: { value: 'Hello' } });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('Hello');
    });
  });

  // --------------------------------------------------------------------------
  // Submit on Enter
  // --------------------------------------------------------------------------

  describe('Enter key submission', () => {
    it('calls onSubmit with trimmed message when Enter is pressed with a non-empty value', () => {
      const onSubmit = jest.fn();
      render(
        <ChatInput {...buildDefaultProps({ value: '  hello world  ', onSubmit })} />
      );

      const textarea = screen.getByTestId('chat-input');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith(
        'hello world',
        expect.objectContaining({})
      );
    });

    it('does NOT call onSubmit when Enter is pressed with an empty value', () => {
      const onSubmit = jest.fn();
      render(<ChatInput {...buildDefaultProps({ value: '', onSubmit })} />);

      const textarea = screen.getByTestId('chat-input');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does NOT call onSubmit when Enter is pressed with a whitespace-only value', () => {
      const onSubmit = jest.fn();
      render(<ChatInput {...buildDefaultProps({ value: '   ', onSubmit })} />);

      const textarea = screen.getByTestId('chat-input');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does NOT call onSubmit when Enter is pressed while isLoading is true', () => {
      const onSubmit = jest.fn();
      render(
        <ChatInput
          {...buildDefaultProps({ value: 'hello', isLoading: true, onSubmit })}
        />
      );

      const textarea = screen.getByTestId('chat-input');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does NOT call onSubmit when Enter is pressed while disabled is true', () => {
      const onSubmit = jest.fn();
      render(
        <ChatInput
          {...buildDefaultProps({ value: 'hello', disabled: true, onSubmit })}
        />
      );

      const textarea = screen.getByTestId('chat-input');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Shift+Enter (newline, no submit)
  // --------------------------------------------------------------------------

  describe('Shift+Enter newline behavior', () => {
    it('does NOT call onSubmit when Shift+Enter is pressed', () => {
      const onSubmit = jest.fn();
      render(
        <ChatInput {...buildDefaultProps({ value: 'hello', onSubmit })} />
      );

      const textarea = screen.getByTestId('chat-input');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Send button disabled states
  // --------------------------------------------------------------------------

  describe('send button disabled states', () => {
    it('send button is disabled when value is empty', () => {
      render(<ChatInput {...buildDefaultProps({ value: '' })} />);
      expect(screen.getByTestId('send-button')).toBeDisabled();
    });

    it('send button is disabled when value is whitespace only', () => {
      render(<ChatInput {...buildDefaultProps({ value: '   ' })} />);
      expect(screen.getByTestId('send-button')).toBeDisabled();
    });

    it('send button is disabled when isLoading is true (even with non-empty value)', () => {
      render(
        <ChatInput {...buildDefaultProps({ value: 'hello', isLoading: true })} />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
    });

    it('send button is disabled when disabled prop is true', () => {
      render(
        <ChatInput {...buildDefaultProps({ value: 'hello', disabled: true })} />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
    });

    it('send button is enabled when value is non-empty and not loading or disabled', () => {
      render(
        <ChatInput
          {...buildDefaultProps({ value: 'hello', isLoading: false, disabled: false })}
        />
      );
      expect(screen.getByTestId('send-button')).not.toBeDisabled();
    });
  });

  // --------------------------------------------------------------------------
  // Form submit (send button click)
  // --------------------------------------------------------------------------

  describe('form submit via send button', () => {
    it('calls onSubmit when the send button is clicked with a non-empty value', () => {
      const onSubmit = jest.fn();
      render(
        <ChatInput {...buildDefaultProps({ value: 'send this', onSubmit })} />
      );

      fireEvent.click(screen.getByTestId('send-button'));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith(
        'send this',
        expect.objectContaining({})
      );
    });

    it('does NOT call onSubmit when send button is clicked with empty value', () => {
      const onSubmit = jest.fn();
      render(<ChatInput {...buildDefaultProps({ value: '', onSubmit })} />);

      // Button is disabled, click should have no effect
      fireEvent.click(screen.getByTestId('send-button'));

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Imperative ref
  // --------------------------------------------------------------------------

  describe('imperative ref', () => {
    it('exposes a ref with a focus() method that focuses the textarea', () => {
      const ref = createRef<ChatInputRef>();
      render(<ChatInput {...buildDefaultProps()} ref={ref} />);

      const textarea = screen.getByTestId('chat-input');
      const focusSpy = jest.spyOn(textarea, 'focus');

      act(() => {
        ref.current?.focus();
      });

      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('exposes a ref with a clear() method that resets the value via onChange', () => {
      const onChange = jest.fn();
      const ref = createRef<ChatInputRef>();
      render(
        <ChatInput {...buildDefaultProps({ value: 'some text', onChange })} ref={ref} />
      );

      act(() => {
        ref.current?.clear();
      });

      // clear() calls onChange('') to reset the controlled value
      expect(onChange).toHaveBeenCalledWith('');
    });
  });

  // --------------------------------------------------------------------------
  // Voice button interaction
  // --------------------------------------------------------------------------

  describe('voice button interaction', () => {
    it('calls startListening when the voice button is clicked while not listening', () => {
      mockUseSpeechRecognition.mockReturnValue({
        ...defaultSpeechRecognitionReturn,
        isSupported: true,
        isListening: false,
      });
      render(<ChatInput {...buildDefaultProps()} />);

      fireEvent.click(screen.getByTestId('voice-button'));

      expect(mockStartListening).toHaveBeenCalledTimes(1);
    });

    it('calls stopListening when the voice button is clicked while listening', () => {
      mockUseSpeechRecognition.mockReturnValue({
        ...defaultSpeechRecognitionReturn,
        isSupported: true,
        isListening: true,
      });
      render(<ChatInput {...buildDefaultProps()} />);

      fireEvent.click(screen.getByTestId('voice-button'));

      expect(mockStopListening).toHaveBeenCalledTimes(1);
    });
  });
});
