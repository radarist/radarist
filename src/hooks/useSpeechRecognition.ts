/**
 * @file useSpeechRecognition.ts
 * @description Custom hook for speech-to-text using Web Speech API
 *
 * Features:
 * - Browser support detection
 * - Start/stop recording control
 * - Real-time transcript updates
 * - Error handling
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useSpeechRecognition');

/**
 * Web Speech API type declarations
 * These are not included in standard TypeScript libs
 */
interface SpeechRecognitionResultItem {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionResultItem;
  [index: number]: SpeechRecognitionResultItem;
  isFinal: boolean;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface ISpeechRecognitionConstructor {
  new (): ISpeechRecognition;
}

/**
 * Extended window interface for Web Speech API
 */
interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: ISpeechRecognitionConstructor;
  webkitSpeechRecognition?: ISpeechRecognitionConstructor;
}

/**
 * Speech recognition event with results
 */
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

/**
 * Speech recognition error event
 */
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

/**
 * Return type for useSpeechRecognition hook
 */
export interface UseSpeechRecognitionReturn {
  /** Whether speech recognition is currently active */
  isListening: boolean;
  /** Final confirmed transcript (only updates when speech is finalized) */
  transcript: string;
  /** Interim transcript shown while speaking (preview, not final) */
  interimTranscript: string;
  /** Whether the browser supports speech recognition */
  isSupported: boolean;
  /** Start listening */
  startListening: () => void;
  /** Stop listening */
  stopListening: () => void;
  /** Reset transcript */
  resetTranscript: () => void;
  /** Error message if any */
  error: string | null;
}

/**
 * Custom hook for speech-to-text using Web Speech API.
 *
 * @example
 * ```tsx
 * const { isListening, transcript, startListening, stopListening, isSupported } = useSpeechRecognition();
 *
 * return (
 *   <Button onClick={isListening ? stopListening : startListening} disabled={!isSupported}>
 *     {isListening ? <MicOff /> : <Mic />}
 *   </Button>
 * );
 * ```
 */
export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const shouldBeListeningRef = useRef(false); // Track if user wants to be listening

  // Check browser support on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const speechWindow = window as SpeechRecognitionWindow;
      const SpeechRecognitionAPI =
        speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
      setIsSupported(!!SpeechRecognitionAPI);
    }
  }, []);

  // Initialize speech recognition
  useEffect(() => {
    if (typeof window === "undefined") return;

    const speechWindow = window as SpeechRecognitionWindow;
    const SpeechRecognitionAPI =
      speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) return;

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true; // Keep listening until manually stopped
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      // Only update final transcript when speech is confirmed
      // This prevents duplicate text from interim results
      if (finalText) {
        setTranscript((prev) => prev + finalText);
        setInterimTranscript(""); // Clear interim when we have final
      } else {
        // Show interim as preview (this gets replaced, not appended)
        setInterimTranscript(interimText);
      }
    };

    recognition.onend = () => {
      // Auto-restart if user hasn't manually stopped
      if (shouldBeListeningRef.current && recognitionRef.current) {
        log.debug('Auto-restarting');
        try {
          recognitionRef.current.start();
        } catch {
          // Failed to restart, stop listening
          shouldBeListeningRef.current = false;
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      switch (event.error) {
        case "no-speech":
          // This is normal when user pauses - just log as debug, don't show error
          log.debug('No speech detected, continuing to listen');
          // Don't set error or stop listening for no-speech
          return;
        case "aborted":
          // User or system aborted - this is expected when stopping
          log.debug('Aborted');
          break;
        case "audio-capture":
          log.error('Audio capture error', undefined, { errorCode: event.error });
          setError("No microphone found. Please check your microphone.");
          setIsListening(false);
          break;
        case "not-allowed":
          log.error('Microphone not allowed', undefined, { errorCode: event.error });
          setError("Microphone access denied. Please allow microphone access.");
          setIsListening(false);
          break;
        case "network":
          log.error('Network error', undefined, { errorCode: event.error });
          setError("Network error. Please check your connection.");
          setIsListening(false);
          break;
        default:
          log.error('Speech recognition error', undefined, { errorCode: event.error });
          setError(`Speech recognition error: ${event.error}`);
          setIsListening(false);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      shouldBeListeningRef.current = false;
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current) {
      setError("Speech recognition not supported");
      return;
    }

    setError(null);
    shouldBeListeningRef.current = true;
    setIsListening(true);

    try {
      recognitionRef.current.start();
    } catch (err) {
      // Handle case where recognition is already started
      log.warn('Start error', { error: String(err) });
      shouldBeListeningRef.current = false;
      setIsListening(false);
    }
  }, []);

  const stopListening = useCallback(() => {
    shouldBeListeningRef.current = false; // Prevent auto-restart
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsListening(false);
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setInterimTranscript("");
    setError(null);
  }, []);

  return {
    isListening,
    transcript,
    interimTranscript,
    isSupported,
    startListening,
    stopListening,
    resetTranscript,
    error,
  };
}
