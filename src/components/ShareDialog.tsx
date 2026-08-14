/**
 * @file ShareDialog.tsx
 * @description Dialog for sharing a radar via URL
 *
 * Phase 4.1 Refactor: Supports both controlled and uncontrolled modes
 * - Controlled: Pass `open` and `onOpenChange` props
 * - Uncontrolled: Uses internal state with DialogTrigger
 *
 * @author Radarist Team
 * @updated 2025-11-29 - Added controlled mode support
 */

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Copy, Share2, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { getRadarById, updateRadar } from "@/lib/radars";

interface ShareDialogProps {
  /** The unique ID of the radar to share. */
  radarId: string;
  /** Controlled open state (optional). */
  open?: boolean;
  /** Callback when open state changes (optional). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * A dialog that provides a shareable link for the current radar.
 * Generates a read-only URL and allows the user to copy it to the clipboard.
 *
 * Supports both controlled and uncontrolled modes:
 * - Controlled: Pass `open` and `onOpenChange` props
 * - Uncontrolled: Uses internal state with DialogTrigger button
 *
 * @param props - Component props.
 * @returns The rendered dialog.
 */
export function ShareDialog({ radarId, open, onOpenChange }: ShareDialogProps) {
  const { toast } = useToast();
  const [internalOpen, setInternalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // AUDIT-001: public access is an explicit opt-in, mirroring the report and
  // visualization share gates. null = still loading the current state.
  const [shared, setShared] = useState<boolean | null>(null);
  const [togglingShare, setTogglingShare] = useState(false);

  // Use controlled state if provided, otherwise use internal state
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange! : setInternalOpen;

  // Bumped on every user toggle: an in-flight open-fetch that started
  // BEFORE the toggle must never clobber the user's choice (adversarial #2).
  const shareGenerationRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setShared(null); // reset — never show the previous open's (or radar's) stale value
    const generation = shareGenerationRef.current;
    let cancelled = false;
    getRadarById(radarId)
      .then((radar) => {
        if (!cancelled && shareGenerationRef.current === generation) setShared(radar?.shared === true);
      })
      .catch(() => {
        if (!cancelled && shareGenerationRef.current === generation) setShared(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, radarId]);

  const handleToggleShared = async (next: boolean) => {
    shareGenerationRef.current += 1;
    setTogglingShare(true);
    try {
      await updateRadar(radarId, { shared: next });
      setShared(next);
      toast({ title: next ? "Public link enabled" : "Public link disabled" });
    } catch {
      toast({ title: "Failed to update sharing", variant: "destructive" });
    } finally {
      setTogglingShare(false);
    }
  };

  // Construct the URL. In production, this should use the actual domain.
  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/share/${radarId}`
      : `/share/${radarId}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast({ title: "Link copied!", description: "Share this link with anyone." });

      // Reset copied state after 2 seconds
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Failed to copy",
        description: "Please copy the link manually.",
        variant: "destructive",
      });
    }
  };

  const dialogContent = (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Share Radar</DialogTitle>
        <DialogDescription>
          Anyone with this link can view this radar in read-only mode.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="share-toggle">Enable public link</Label>
          <p className="text-xs text-muted-foreground">
            Off by default — the link below only works while this is on.
          </p>
        </div>
        <Switch
          id="share-toggle"
          checked={shared === true}
          disabled={shared === null || togglingShare}
          onCheckedChange={(v) => void handleToggleShared(v)}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="share-link" className="sr-only">
            Share Link
          </Label>
          <Input
            id="share-link"
            value={shareUrl}
            readOnly
            className="font-mono text-sm"
            onClick={(e) => e.currentTarget.select()}
          />
        </div>
        <Button
          type="button"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          <span className="sr-only">Copy link</span>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This link provides view-only access. Recipients cannot edit the radar.
      </p>
    </DialogContent>
  );

  // Controlled mode: no trigger button
  if (isControlled) {
    return (
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        {dialogContent}
      </Dialog>
    );
  }

  // Uncontrolled mode: with trigger button
  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Share2 className="h-4 w-4" />
          Share
        </Button>
      </DialogTrigger>
      {dialogContent}
    </Dialog>
  );
}
