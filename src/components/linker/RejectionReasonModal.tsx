/**
 * @file components/linker/RejectionReasonModal.tsx
 * @description Modal for collecting rejection feedback reason
 *
 * Features:
 * - Predefined rejection reasons
 * - Optional custom reason input
 * - Quick submit with keyboard
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { X } from "lucide-react";

// ============================================================================
// REJECTION REASONS
// ============================================================================

const REJECTION_REASONS = [
  {
    value: "wrong_entities",
    label: "Wrong entities",
    description: "The identified entities are incorrect",
  },
  {
    value: "wrong_relation_type",
    label: "Wrong relation type",
    description: "The relation type doesn't match the actual relationship",
  },
  {
    value: "not_related",
    label: "Not related",
    description: "These entities have no meaningful relationship",
  },
  {
    value: "duplicate",
    label: "Duplicate",
    description: "This relation already exists in the system",
  },
  {
    value: "low_quality",
    label: "Low quality evidence",
    description: "The evidence doesn't support this relation",
  },
  {
    value: "other",
    label: "Other",
    description: "Specify a custom reason",
  },
] as const;

// ============================================================================
// PROPS
// ============================================================================

interface RejectionReasonModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReject: (reason?: string) => void;
  proposalName: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function RejectionReasonModal({
  open,
  onOpenChange,
  onReject,
  proposalName,
}: RejectionReasonModalProps) {
  const [selectedReason, setSelectedReason] = useState<string>("");
  const [customReason, setCustomReason] = useState("");

  const handleSubmit = () => {
    let reason: string | undefined;

    if (selectedReason === "other") {
      reason = customReason.trim() || "Other (no reason provided)";
    } else if (selectedReason) {
      const reasonConfig = REJECTION_REASONS.find(
        (r) => r.value === selectedReason
      );
      reason = reasonConfig?.label;
    }

    onReject(reason);

    // Reset state
    setSelectedReason("");
    setCustomReason("");
  };

  const handleCancel = () => {
    setSelectedReason("");
    setCustomReason("");
    onOpenChange(false);
  };

  const handleQuickReject = () => {
    // Reject without reason
    onReject();
    setSelectedReason("");
    setCustomReason("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Proposal</DialogTitle>
          <DialogDescription>
            Why are you rejecting this proposed relation?
            <span className="block mt-1 text-foreground font-medium">
              {proposalName}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <RadioGroup
            value={selectedReason}
            onValueChange={setSelectedReason}
            className="space-y-2"
          >
            {REJECTION_REASONS.map((reason) => (
              <div
                key={reason.value}
                className="flex items-start space-x-3 rounded-lg border p-3 hover:bg-muted/50 cursor-pointer"
                onClick={() => setSelectedReason(reason.value)}
              >
                <RadioGroupItem
                  value={reason.value}
                  id={reason.value}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={reason.value}
                  className="flex-1 cursor-pointer space-y-1"
                >
                  <span className="font-medium">{reason.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {reason.description}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>

          {/* Custom reason input */}
          {selectedReason === "other" && (
            <div className="space-y-2">
              <Label htmlFor="custom-reason">Custom reason</Label>
              <Textarea
                id="custom-reason"
                placeholder="Enter your reason for rejection..."
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                rows={3}
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={handleQuickReject}>
            <X className="h-4 w-4 mr-2" />
            Reject Without Reason
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={!selectedReason}
          >
            <X className="h-4 w-4 mr-2" />
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
