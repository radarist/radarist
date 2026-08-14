/**
 * @file ChatInput.tsx
 * @description Enhanced chat input component with file attachments, voice input, and tool selection
 *
 * Features:
 * - Auto-growing textarea
 * - File attachment with preview
 * - Voice input via Web Speech API
 * - Tool selection (placeholder for future)
 * - Enter to send, Shift+Enter for new line
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  Send,
  Plus,
  Mic,
  MicOff,
  X,
  FileText,
  Wrench,
  Globe,
  Search,
  FileSearch,
  Loader2,
  Library,
  Sparkles,
  Network,
  Wand2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { createLogger } from '@/lib/logger';
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";

const log = createLogger('ui/ChatInput');
import type {
  FileAttachment,
  ChatSubmitOptions,
  ChatTool,
} from "@/types/ai-assistant";
import { filterSlashCommands, type SlashCommand, type SlashIconName } from "./slash-commands";

// ============================================================================
// CONSTANTS
// ============================================================================

const CHAT_SUPPORTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 3;

const AVAILABLE_TOOLS: ChatTool[] = [];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function getFileType(mimeType: string): "image" | "document" {
  return mimeType.startsWith("image/") ? "image" : "document";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

interface AttachmentPreviewProps {
  attachments: FileAttachment[];
  onRemove: (id: string) => void;
  saveToLibrary: boolean;
  onSaveToLibraryChange: (value: boolean) => void;
}

function AttachmentPreview({
  attachments,
  onRemove,
  saveToLibrary,
  onSaveToLibraryChange,
}: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  // Check if there are any document attachments (non-image)
  const hasDocuments = attachments.some((a) => a.type === "document");

  return (
    <div className="space-y-2">
      <div className="flex gap-2 overflow-x-auto pb-1">
        <AnimatePresence mode="popLayout">
          {attachments.map((attachment) => (
            <motion.div
              key={attachment.id}
              initial={{ opacity: 0, scale: 0.8, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 10 }}
              transition={{ duration: 0.2 }}
              className="relative flex-shrink-0 group"
            >
              {attachment.type === "image" && attachment.preview ? (
                <div className="relative w-14 h-14 rounded-lg overflow-hidden border bg-background shadow-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={attachment.preview}
                    alt={attachment.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border bg-background shadow-sm">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <div className="max-w-[100px]">
                    <p className="text-[11px] font-medium truncate">
                      {attachment.name}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {formatFileSize(attachment.size)}
                    </p>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-foreground/80 text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                aria-label={`Remove ${attachment.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Save to Library toggle for documents */}
      {hasDocuments && (
        <div
          className="flex items-center gap-2 cursor-pointer px-1"
          onClick={() => onSaveToLibraryChange(!saveToLibrary)}
        >
          <Checkbox
            checked={saveToLibrary}
            onCheckedChange={(checked) =>
              onSaveToLibraryChange(checked === true)
            }
            className="pointer-events-none h-3.5 w-3.5"
          />
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Library className="h-3 w-3" />
            <span>Save to Library</span>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground/50 cursor-help">
                  (?)
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">
                  Save the document to your library for future Q&A sessions and
                  entity linking. Recommended for large documents.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
    </div>
  );
}

interface VoiceButtonProps {
  isListening: boolean;
  isSupported: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

function _VoiceButton({
  isListening,
  isSupported,
  onToggle,
  disabled,
}: VoiceButtonProps) {
  if (!isSupported) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-8 w-8 shrink-0 transition-colors",
              isListening && "bg-destructive/10 text-destructive"
            )}
            onClick={onToggle}
            disabled={disabled}
            data-testid="voice-button"
          >
            {isListening ? (
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                <MicOff className="h-4 w-4" />
              </motion.div>
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {isListening ? "Stop recording" : "Voice input"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface ToolSelectorProps {
  selectedTools: string[];
  onToolsChange: (tools: string[]) => void;
  disabled?: boolean;
}

function ToolSelector({
  selectedTools,
  onToolsChange,
  disabled,
}: ToolSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleToolToggle = (toolId: string, tool: ChatTool) => {
    // Only allow toggling if tool is enabled
    if (!tool.enabled) return;

    if (selectedTools.includes(toolId)) {
      onToolsChange(selectedTools.filter((id) => id !== toolId));
    } else {
      onToolsChange([...selectedTools, toolId]);
    }
  };

  const getToolIcon = (iconName: string) => {
    switch (iconName) {
      case "Globe":
        return <Globe className="h-4 w-4" />;
      case "FileText":
        return <FileSearch className="h-4 w-4" />;
      case "Search":
        return <Search className="h-4 w-4" />;
      default:
        return <Wrench className="h-4 w-4" />;
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 relative rounded-full text-muted-foreground hover:text-foreground hover:bg-white/50 dark:hover:bg-background/50"
                disabled={disabled}
                data-testid="tool-selector-button"
                aria-label="Tools"
              >
                <Wrench className="h-4 w-4" />
                {selectedTools.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="absolute -top-1 -right-1 h-4 w-4 p-0 flex items-center justify-center text-[10px]"
                  >
                    {selectedTools.length}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">Tools</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        className="w-64 p-2"
        align="end"
        data-testid="tool-selector-popover"
      >
        <div className="space-y-1">
          <p className="text-sm font-medium px-2 py-1">Available Tools</p>
          {AVAILABLE_TOOLS.map((tool) => (
            <div
              key={tool.id}
              className={cn(
                "flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer transition-colors",
                tool.enabled
                  ? "hover:bg-muted"
                  : "opacity-50 cursor-not-allowed"
              )}
              onClick={() => handleToolToggle(tool.id, tool)}
            >
              <Checkbox
                checked={selectedTools.includes(tool.id)}
                disabled={!tool.enabled}
                className="pointer-events-none"
              />
              <div className="text-muted-foreground">
                {getToolIcon(tool.icon)}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium flex items-center gap-2">
                  {tool.label}
                  {!tool.enabled && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      Soon
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground truncate block">
                  {tool.description}
                </span>
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const SLASH_ICONS: Record<SlashIconName, React.ComponentType<{ className?: string }>> = {
  Sparkles,
  Search,
  Network,
  Wand2,
  FileText,
};
function SlashIcon({ name, className }: { name: SlashIconName; className?: string }) {
  // Record<SlashIconName,…> guarantees a hit; ?? Wand2 stays as a runtime guard.
  const Icon = SLASH_ICONS[name] ?? Wand2;
  return <Icon className={className} />;
}

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}
function SlashCommandMenu({ commands, activeIndex, onSelect, onHover }: SlashCommandMenuProps) {
  if (commands.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 right-0 mb-2 z-20 overflow-y-auto max-h-64 rounded-xl border bg-popover text-popover-foreground shadow-lg p-1"
      data-testid="slash-menu"
      data-slash-menu-open=""
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
          className={cn(
            "w-full flex items-start gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors",
            i === activeIndex ? "bg-muted" : "hover:bg-muted/60"
          )}
        >
          <SlashIcon name={cmd.icon} className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <span className="min-w-0">
            <span className="text-sm font-medium">{cmd.label}</span>
            <span className="block text-[11px] text-muted-foreground truncate">{cmd.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export interface ChatInputProps {
  /** Current input value */
  value: string;
  /** Called when input value changes */
  onChange: (value: string) => void;
  /** Called when message is submitted */
  onSubmit: (message: string, options: ChatSubmitOptions) => void;
  /** Whether a message is being processed */
  isLoading: boolean;
  /** Input placeholder */
  placeholder?: string;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
}

export interface ChatInputRef {
  focus: () => void;
  clear: () => void;
}

/**
 * Enhanced chat input component with file attachments, voice input, and tool selection.
 *
 * @example
 * ```tsx
 * <ChatInput
 *   value={input}
 *   onChange={setInput}
 *   onSubmit={handleSubmit}
 *   isLoading={isLoading}
 *   placeholder="Ask anything..."
 * />
 * ```
 */
export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSubmit,
      isLoading,
      placeholder: _placeholder = "Ask anything...",
      disabled = false,
      className,
    },
    ref
  ) {
    const [attachments, setAttachments] = useState<FileAttachment[]>([]);
    const [selectedTools, setSelectedTools] = useState<string[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [saveToLibrary, setSaveToLibrary] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [slashIndex, setSlashIndex] = useState(0);
    const [slashDismissed, setSlashDismissed] = useState(false);

    const MAX_SLASH = 8;
    const slashQuery = value.startsWith("/") && !value.includes(" ") ? value.slice(1) : null;
    const slashOpen = slashQuery !== null && !slashDismissed;
    const slashMatches = slashOpen ? filterSlashCommands(slashQuery).slice(0, MAX_SLASH) : [];

    useEffect(() => { setSlashIndex(0); }, [slashQuery]);

    const handleChange = useCallback((next: string) => {
      setSlashDismissed(false); // typing re-opens the menu after an Escape
      onChange(next);
    }, [onChange]);

    const selectSlash = useCallback((cmd: SlashCommand) => {
      onChange(cmd.template);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }, [onChange]);

    // Voice recognition
    const {
      isListening,
      transcript,
      interimTranscript,
      isSupported: voiceSupported,
      startListening,
      stopListening,
      resetTranscript,
    } = useSpeechRecognition();

    // Track what transcript we've already appended to avoid duplicates
    const lastAppendedTranscript = useRef("");

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      clear: () => {
        onChange("");
        setAttachments([]);
        setSelectedTools([]);
        setSaveToLibrary(false);
      },
    }));

    // Handle voice transcript changes - only append FINAL transcript
    useEffect(() => {
      if (transcript && transcript !== lastAppendedTranscript.current) {
        // Append only the new part of the final transcript
        const newText = transcript.slice(lastAppendedTranscript.current.length);
        if (newText) {
          onChange(value + newText);
        }
        lastAppendedTranscript.current = transcript;
      }
    }, [transcript, onChange, value]);

    // Reset tracking when listening stops
    useEffect(() => {
      if (!isListening) {
        lastAppendedTranscript.current = "";
        resetTranscript();
      }
    }, [isListening, resetTranscript]);

    // Auto-resize textarea - minimum 2 lines (56px), max 200px
    const MIN_HEIGHT = 56; // ~2 lines
    const MAX_HEIGHT = 200;

    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      // When value is empty, reset to min height and let CSS handle it
      if (!value) {
        textarea.style.height = `${MIN_HEIGHT}px`;
        return;
      }

      // For non-empty values, calculate the content height properly
      // First, temporarily set to auto to get the true scrollHeight
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;

      // Clamp between min and max
      const newHeight = Math.max(MIN_HEIGHT, Math.min(scrollHeight, MAX_HEIGHT));
      textarea.style.height = `${newHeight}px`;
    }, [value]);

    // Handle voice toggle
    const handleVoiceToggle = useCallback(() => {
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    }, [isListening, startListening, stopListening]);

    // Handle keyboard events
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (slashOpen && slashMatches.length > 0) {
          if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
          if (e.key === "Enter") { e.preventDefault(); selectSlash(slashMatches[slashIndex]); return; }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSlashDismissed(true); return; }
        }

        // Cmd/Ctrl+Shift+M to toggle microphone (Cmd+M alone minimizes window on macOS)
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "m") {
          e.preventDefault();
          if (voiceSupported && !disabled && !isLoading) {
            handleVoiceToggle();
          }
          return;
        }

        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (value.trim() && !isLoading && !disabled) {
            onSubmit(value.trim(), {
              attachments: attachments.length > 0 ? attachments : undefined,
              enabledTools: selectedTools.length > 0 ? selectedTools : undefined,
              saveToLibrary: saveToLibrary || undefined,
            });
            setAttachments([]);
            setSaveToLibrary(false);
            // Clean up attachment previews
            attachments.forEach((a) => {
              if (a.preview) URL.revokeObjectURL(a.preview);
            });
          }
        }
      },
      [value, isLoading, disabled, onSubmit, attachments, selectedTools, voiceSupported, handleVoiceToggle, slashOpen, slashMatches, slashIndex, selectSlash]
    );

    // Handle form submit
    const handleSubmit = useCallback(
      (e: React.FormEvent) => {
        e.preventDefault();
        if (value.trim() && !isLoading && !disabled) {
          onSubmit(value.trim(), {
            attachments: attachments.length > 0 ? attachments : undefined,
            enabledTools: selectedTools.length > 0 ? selectedTools : undefined,
            saveToLibrary: saveToLibrary || undefined,
          });
          setAttachments([]);
          setSaveToLibrary(false);
          // Clean up attachment previews
          attachments.forEach((a) => {
            if (a.preview) URL.revokeObjectURL(a.preview);
          });
        }
      },
      [value, isLoading, disabled, onSubmit, attachments, selectedTools, saveToLibrary]
    );

    // Handle file selection
    const handleFileSelect = useCallback(
      (files: FileList | File[]) => {
        const fileArray = Array.from(files);
        const availableSlots = MAX_FILES - attachments.length;

        if (fileArray.length > availableSlots) {
          log.warn('File limit reached', { availableSlots });
          fileArray.splice(availableSlots);
        }

        const newAttachments: FileAttachment[] = [];

        for (const file of fileArray) {
          // Validate file type
          if (!CHAT_SUPPORTED_TYPES.includes(file.type)) {
            log.warn('Unsupported file type', { fileType: file.type });
            continue;
          }

          // Validate file size
          if (file.size > MAX_FILE_SIZE) {
            log.warn('File too large', { fileName: file.name });
            continue;
          }

          // Check for duplicates
          if (
            attachments.some(
              (a) => a.name === file.name && a.size === file.size
            )
          ) {
            continue;
          }

          const fileType = getFileType(file.type);
          const attachment: FileAttachment = {
            id: generateId(),
            file,
            type: fileType,
            name: file.name,
            size: file.size,
          };

          // Create preview for images
          if (fileType === "image") {
            attachment.preview = URL.createObjectURL(file);
          }

          newAttachments.push(attachment);
        }

        if (newAttachments.length > 0) {
          setAttachments((prev) => [...prev, ...newAttachments]);
        }
      },
      [attachments]
    );

    // Handle file input change
    const handleFileInputChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
          handleFileSelect(e.target.files);
        }
        // Always reset to prevent stale state and browser navigation issues
        e.target.value = "";
      },
      [handleFileSelect]
    );

    // Handle attachment removal
    const handleRemoveAttachment = useCallback((id: string) => {
      setAttachments((prev) => {
        const attachment = prev.find((a) => a.id === id);
        if (attachment?.preview) {
          URL.revokeObjectURL(attachment.preview);
        }
        return prev.filter((a) => a.id !== id);
      });
    }, []);

    // Handle drag and drop
    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
    }, []);

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files.length > 0) {
          handleFileSelect(e.dataTransfer.files);
        }
      },
      [handleFileSelect]
    );

    const canSubmit = value.trim().length > 0 && !isLoading && !disabled;
    const canAddFiles = attachments.length < MAX_FILES;

    const [isFocused, setIsFocused] = useState(false);

    return (
      <div
        className={cn(
          "bg-background px-3 py-3",
          isDragging && "ring-2 ring-primary ring-inset",
          className
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="chat-input-container"
      >
        {/* Attachments Preview - Above the unified container */}
        {attachments.length > 0 && (
          <div className="mb-2">
            <AttachmentPreview
              attachments={attachments}
              onRemove={handleRemoveAttachment}
              saveToLibrary={saveToLibrary}
              onSaveToLibraryChange={setSaveToLibrary}
            />
          </div>
        )}

        {/* Unified Input Container */}
        <form onSubmit={handleSubmit}>
          <div
            className={cn(
              "flex items-end gap-1 rounded-2xl bg-muted/40 px-2 py-2 transition-all duration-200",
              isFocused && "ring-2 ring-primary/20 bg-muted"
            )}
          >
            {/* Left Actions - Inside container */}
            <div className="flex items-center gap-0.5 shrink-0">
              {/* File Attachment */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-white/50 dark:hover:bg-background/50"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!canAddFiles || disabled || isLoading}
                      data-testid="attachment-button"
                      aria-label={canAddFiles ? "Attach file" : `Max ${MAX_FILES} files`}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {canAddFiles
                      ? "Attach file"
                      : `Max ${MAX_FILES} files`}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <input
                ref={fileInputRef}
                type="file"
                accept={CHAT_SUPPORTED_TYPES.join(",")}
                multiple
                onChange={handleFileInputChange}
                className="hidden"
                data-testid="file-input"
              />

              {/* Voice Input */}
              {voiceSupported && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-white/50 dark:hover:bg-background/50 transition-colors",
                          isListening && "bg-destructive/10 text-destructive hover:bg-destructive/20"
                        )}
                        onClick={handleVoiceToggle}
                        disabled={disabled || isLoading}
                        data-testid="voice-button"
                        aria-label={isListening ? "Stop recording" : "Voice input"}
                      >
                        {isListening ? (
                          <motion.div
                            animate={{ scale: [1, 1.2, 1] }}
                            transition={{ duration: 1, repeat: Infinity }}
                          >
                            <MicOff className="h-4 w-4" />
                          </motion.div>
                        ) : (
                          <Mic className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isListening ? "Stop recording" : "Voice input"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>

            {/* Textarea - Transparent, no borders */}
            <div className="flex-1 relative min-w-0">
              {slashOpen && (
                <SlashCommandMenu
                  commands={slashMatches}
                  activeIndex={slashIndex}
                  onSelect={selectSlash}
                  onHover={setSlashIndex}
                />
              )}
              {/* Interim transcript preview while speaking */}
              {isListening && interimTranscript && (
                <div className="absolute bottom-full left-0 right-0 mb-1 px-2 py-1 bg-primary/10 rounded text-xs text-muted-foreground italic">
                  {interimTranscript}...
                </div>
              )}
              <Textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => handleChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder={isListening ? "Listening..." : "How can I help you today?"}
                className={cn(
                  "w-full !min-h-[40px] max-h-[200px] resize-none py-2 px-1 text-sm",
                  "border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0",
                  "placeholder:text-muted-foreground/70"
                )}
                style={{ minHeight: '40px' }}
                disabled={disabled || isLoading}
                rows={1}
                data-testid="chat-input"
              />
            </div>

            {/* Right Actions - Inside container */}
            <div className="flex items-center gap-0.5 shrink-0">
              {/* Tool Selector - Only show when tools are available */}
              {AVAILABLE_TOOLS.some(t => t.enabled) && (
                <ToolSelector
                  selectedTools={selectedTools}
                  onToolsChange={setSelectedTools}
                  disabled={disabled || isLoading}
                />
              )}

              {/* Send Button - Primary colored, rounded */}
              <Button
                type="submit"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0 rounded-full transition-all duration-200",
                  canSubmit
                    ? "bg-primary hover:bg-primary/90 hover:scale-105"
                    : "bg-muted-foreground/20 text-muted-foreground"
                )}
                disabled={!canSubmit}
                data-testid="send-button"
                aria-label={isLoading ? "Sending..." : "Send message"}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Helper Text - Small, outside container */}
          <p className="text-[10px] text-muted-foreground/50 mt-1.5 px-2 text-center">
            ↵ send · ⇧↵ new line · <span className="font-medium">/</span> commands{voiceSupported && " · ⌘⇧M voice"}
          </p>
        </form>
      </div>
    );
  }
);
