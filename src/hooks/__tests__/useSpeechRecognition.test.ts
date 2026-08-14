/**
 * Unit Tests for useSpeechRecognition Hook
 *
 * Tests the Web Speech API wrapper hook:
 * - Browser support detection (SpeechRecognition / webkitSpeechRecognition)
 * - startListening / stopListening control
 * - Transcript updates (final vs interim)
 * - Error handling (no-speech ignored, specific messages for known codes)
 * - Auto-restart on onend when shouldBeListeningRef is true
 * - resetTranscript clears all text state
 * - Cleanup (abort called on unmount)
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';

// ============================================================================
// MOCK FACTORY
// ============================================================================

/**
 * Create a fresh mock SpeechRecognition instance.
 * All event handlers are null until assigned by the hook's useEffect.
 */
function createMockSpeechRecognition() {
  const instance = {
    continuous: false,
    interimResults: false,
    lang: '',
    maxAlternatives: 1,
    onresult: null as ((e: unknown) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    onend: null as (() => void) | null,
    onstart: null as (() => void) | null,
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  };
  return instance;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build a SpeechRecognitionEvent-like object with the given results.
 * Each element of `results` has { transcript, isFinal }.
 */
function buildSpeechEvent(
  results: Array<{ transcript: string; isFinal: boolean }>,
  resultIndex = 0
) {
  const resultList = results.map((r) => ({
    isFinal: r.isFinal,
    0: { transcript: r.transcript, confidence: 1 },
    length: 1,
    item: (i: number) => ({ transcript: r.transcript, confidence: 1 })[i],
  }));

  return {
    results: {
      item: (i: number) => resultList[i],
      ...resultList,
      length: resultList.length,
    },
    resultIndex,
  };
}

/**
 * Build a SpeechRecognitionErrorEvent-like object.
 */
function buildErrorEvent(error: string, message?: string) {
  return { error, message };
}

// ============================================================================
// TESTS
// ============================================================================

describe('useSpeechRecognition', () => {
  let mockInstance: ReturnType<typeof createMockSpeechRecognition>;
  let MockSpeechRecognition: jest.Mock;

  beforeEach(() => {
    mockInstance = createMockSpeechRecognition();
    MockSpeechRecognition = jest.fn(() => mockInstance);
  });

  afterEach(() => {
    // Clean up window globals set in each test
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    jest.clearAllMocks();
  });

  // ==========================================================================
  // SUPPORT DETECTION
  // ==========================================================================

  describe('isSupported detection', () => {
    it('returns isSupported=false when neither SpeechRecognition API exists', () => {
      // Neither API is defined on window
      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      expect(result.current.isSupported).toBe(false);
    });

    it('returns isSupported=true when window.SpeechRecognition is available', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      expect(result.current.isSupported).toBe(true);
    });

    it('returns isSupported=true when window.webkitSpeechRecognition is available', () => {
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      expect(result.current.isSupported).toBe(true);
    });
  });

  // ==========================================================================
  // INITIAL STATE
  // ==========================================================================

  describe('initial state', () => {
    it('starts with all text fields empty and isListening=false', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      expect(result.current.isListening).toBe(false);
      expect(result.current.transcript).toBe('');
      expect(result.current.interimTranscript).toBe('');
      expect(result.current.error).toBeNull();
    });
  });

  // ==========================================================================
  // RECOGNITION INSTANCE CONFIGURATION
  // ==========================================================================

  describe('recognition instance configuration', () => {
    it('configures continuous=true, interimResults=true, lang=en-US on the instance', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      renderHook(() => useSpeechRecognition());

      expect(mockInstance.continuous).toBe(true);
      expect(mockInstance.interimResults).toBe(true);
      expect(mockInstance.lang).toBe('en-US');
    });
  });

  // ==========================================================================
  // startListening
  // ==========================================================================

  describe('startListening', () => {
    it('sets isListening=true and calls recognition.start()', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });

      expect(result.current.isListening).toBe(true);
      expect(mockInstance.start).toHaveBeenCalledTimes(1);
    });

    it('clears any existing error before starting', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      // Trigger an error first
      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onerror) {
          mockInstance.onerror(buildErrorEvent('not-allowed'));
        }
      });
      expect(result.current.error).not.toBeNull();

      // Starting again should clear the error
      act(() => {
        result.current.startListening();
      });

      expect(result.current.error).toBeNull();
    });

    it('sets error message and keeps isListening=false when recognition is not supported', () => {
      // No API on window → recognitionRef.current is null
      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });

      expect(result.current.isListening).toBe(false);
      expect(result.current.error).toBe('Speech recognition not supported');
    });

    it('rolls back isListening to false when recognition.start() throws', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;
      mockInstance.start.mockImplementation(() => {
        throw new Error('already started');
      });

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });

      expect(result.current.isListening).toBe(false);
    });
  });

  // ==========================================================================
  // stopListening
  // ==========================================================================

  describe('stopListening', () => {
    it('sets isListening=false and calls recognition.stop()', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        result.current.stopListening();
      });

      expect(result.current.isListening).toBe(false);
      expect(mockInstance.stop).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // onresult - TRANSCRIPT UPDATES
  // ==========================================================================

  describe('onresult event handling', () => {
    it('appends to transcript when result is final', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onresult) {
          mockInstance.onresult(
            buildSpeechEvent([{ transcript: 'Hello world', isFinal: true }])
          );
        }
      });

      expect(result.current.transcript).toBe('Hello world');
      expect(result.current.interimTranscript).toBe('');
    });

    it('sets interimTranscript and does not update transcript when result is interim', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onresult) {
          mockInstance.onresult(
            buildSpeechEvent([{ transcript: 'typing...', isFinal: false }])
          );
        }
      });

      expect(result.current.interimTranscript).toBe('typing...');
      expect(result.current.transcript).toBe('');
    });

    it('clears interimTranscript when a final result arrives', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      // First an interim result
      act(() => {
        if (mockInstance.onresult) {
          mockInstance.onresult(
            buildSpeechEvent([{ transcript: 'interim text', isFinal: false }])
          );
        }
      });
      expect(result.current.interimTranscript).toBe('interim text');

      // Then a final result
      act(() => {
        if (mockInstance.onresult) {
          mockInstance.onresult(
            buildSpeechEvent([{ transcript: 'final text', isFinal: true }])
          );
        }
      });

      expect(result.current.transcript).toBe('final text');
      expect(result.current.interimTranscript).toBe('');
    });
  });

  // ==========================================================================
  // onerror - ERROR HANDLING
  // ==========================================================================

  describe('onerror event handling', () => {
    it('ignores no-speech errors (does not set error state)', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onerror) {
          mockInstance.onerror(buildErrorEvent('no-speech'));
        }
      });

      expect(result.current.error).toBeNull();
      // isListening stays true (no-speech doesn't stop listening)
      expect(result.current.isListening).toBe(true);
    });

    it('sets specific error message for not-allowed and sets isListening=false', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onerror) {
          mockInstance.onerror(buildErrorEvent('not-allowed'));
        }
      });

      expect(result.current.error).toBe(
        'Microphone access denied. Please allow microphone access.'
      );
      expect(result.current.isListening).toBe(false);
    });

    it('sets specific error message for audio-capture and sets isListening=false', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onerror) {
          mockInstance.onerror(buildErrorEvent('audio-capture'));
        }
      });

      expect(result.current.error).toBe(
        'No microphone found. Please check your microphone.'
      );
      expect(result.current.isListening).toBe(false);
    });

    it('sets specific error message for network errors and sets isListening=false', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onerror) {
          mockInstance.onerror(buildErrorEvent('network'));
        }
      });

      expect(result.current.error).toBe(
        'Network error. Please check your connection.'
      );
      expect(result.current.isListening).toBe(false);
    });

    it('sets a generic error message for unknown error codes', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onerror) {
          mockInstance.onerror(buildErrorEvent('service-not-allowed'));
        }
      });

      expect(result.current.error).toBe(
        'Speech recognition error: service-not-allowed'
      );
      expect(result.current.isListening).toBe(false);
    });
  });

  // ==========================================================================
  // onend - AUTO-RESTART
  // ==========================================================================

  describe('onend auto-restart', () => {
    it('auto-restarts recognition when shouldBeListening is true', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });

      // recognition.start() was called once
      expect(mockInstance.start).toHaveBeenCalledTimes(1);

      // Simulate the browser firing onend while user still wants to listen
      act(() => {
        if (mockInstance.onend) {
          mockInstance.onend();
        }
      });

      // Should have called start() again to auto-restart
      expect(mockInstance.start).toHaveBeenCalledTimes(2);
    });

    it('does NOT auto-restart when stopListening was called before onend fires', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      act(() => {
        result.current.startListening();
      });
      act(() => {
        result.current.stopListening();
      });

      const startCallCount = mockInstance.start.mock.calls.length;

      act(() => {
        if (mockInstance.onend) {
          mockInstance.onend();
        }
      });

      // start() count should not have increased
      expect(mockInstance.start).toHaveBeenCalledTimes(startCallCount);
    });

    it('sets isListening=false when onend fires without user intending to listen', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      // Never called startListening, so shouldBeListeningRef is false
      act(() => {
        if (mockInstance.onend) {
          mockInstance.onend();
        }
      });

      expect(result.current.isListening).toBe(false);
    });
  });

  // ==========================================================================
  // resetTranscript
  // ==========================================================================

  describe('resetTranscript', () => {
    it('clears transcript, interimTranscript, and error', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { result } = renderHook(() => useSpeechRecognition());

      // Build up state
      act(() => {
        result.current.startListening();
      });
      act(() => {
        if (mockInstance.onresult) {
          mockInstance.onresult(
            buildSpeechEvent([{ transcript: 'some text', isFinal: true }])
          );
        }
      });
      act(() => {
        if (mockInstance.onerror) {
          mockInstance.onerror(buildErrorEvent('network'));
        }
      });

      // Sanity: state is populated
      expect(result.current.transcript).not.toBe('');
      expect(result.current.error).not.toBeNull();

      // Reset
      act(() => {
        result.current.resetTranscript();
      });

      expect(result.current.transcript).toBe('');
      expect(result.current.interimTranscript).toBe('');
      expect(result.current.error).toBeNull();
    });
  });

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  describe('cleanup on unmount', () => {
    it('calls recognition.abort() on unmount', () => {
      (window as unknown as Record<string, unknown>).SpeechRecognition =
        MockSpeechRecognition;

      const { useSpeechRecognition } = require('../useSpeechRecognition');
      const { unmount } = renderHook(() => useSpeechRecognition());

      unmount();

      expect(mockInstance.abort).toHaveBeenCalledTimes(1);
    });
  });
});
