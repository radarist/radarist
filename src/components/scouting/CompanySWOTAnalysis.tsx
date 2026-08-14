/**
 * @file CompanySWOTAnalysis.tsx
 * @description SWOT Analysis tab for Company Dialog - Strengths, Weaknesses, Opportunities, Threats
 *
 * Provides an interface for documenting and managing strategic analysis:
 * - Strengths: Internal positive attributes
 * - Weaknesses: Internal limitations
 * - Opportunities: External favorable factors
 * - Threats: External challenges
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Plus, X, TrendingUp, TrendingDown, Target, AlertTriangle, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { createLogger } from "@/lib/logger";

const log = createLogger("ui/CompanySWOTAnalysis");

export interface SWOTData {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
}

interface CompanySWOTAnalysisProps {
  initialData?: SWOTData;
  onUpdate?: (data: SWOTData) => void;
  onSave: (
    data: SWOTData
  ) => Promise<"saved-and-queued" | "saved-locally" | "rejected" | "status-unavailable">;
}

/**
 * SWOT Analysis component for strategic company analysis
 */
export function CompanySWOTAnalysis({ initialData, onUpdate, onSave }: CompanySWOTAnalysisProps) {
  const [swotData, setSwotData] = useState<SWOTData>(
    initialData || {
      strengths: [],
      weaknesses: [],
      opportunities: [],
      threats: []
    }
  );
  const [newItem, setNewItem] = useState({
    strengths: "",
    weaknesses: "",
    opportunities: "",
    threats: ""
  });
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (initialData) {
      setSwotData(initialData);
    }
  }, [initialData]);

  const addItem = (category: keyof SWOTData) => {
    const item = newItem[category].trim();
    if (!item) return;

    const updated = {
      ...swotData,
      [category]: [...swotData[category], item]
    };

    setSwotData(updated);
    setNewItem({ ...newItem, [category]: "" });
  };

  const removeItem = (category: keyof SWOTData, index: number) => {
    const updated = {
      ...swotData,
      [category]: swotData[category].filter((_, i) => i !== index)
    };

    setSwotData(updated);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const status = await onSave(swotData);
      if (status === "rejected") {
        toast({
          title: "SWOT analysis not saved",
          description: "The update was rejected. Review the company and try again.",
          variant: "destructive"
        });
        return;
      }
      if (status === "status-unavailable") {
        toast({
          title: "Save status unavailable",
          description: "Reload the company before trying again to avoid overwriting a possible committed update.",
          variant: "destructive"
        });
        return;
      }
      if (onUpdate) {
        onUpdate(swotData);
      }
      toast({
        title: status === "saved-locally" ? "SWOT saved locally" : "SWOT Analysis Saved",
        description:
          status === "saved-locally"
            ? "Strategic analysis is saved, but graph synchronization was not acknowledged."
            : "Strategic analysis updated successfully"
      });
    } catch (error) {
      log.error("Failed to save SWOT analysis", error instanceof Error ? error : undefined);
      toast({
        title: "Error",
        description: "Failed to save SWOT analysis",
        variant: "destructive"
      });
    } finally {
      setIsSaving(false);
    }
  };

  const categories: Array<{
    key: keyof SWOTData;
    title: string;
    description: string;
    icon: typeof TrendingUp;
    color: string;
    bgColor: string;
  }> = [
    {
      key: "strengths",
      title: "Strengths",
      description: "Internal positive attributes and capabilities",
      icon: TrendingUp,
      color: "text-green-600",
      bgColor: "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800"
    },
    {
      key: "weaknesses",
      title: "Weaknesses",
      description: "Internal limitations and areas for improvement",
      icon: TrendingDown,
      color: "text-red-600",
      bgColor: "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800"
    },
    {
      key: "opportunities",
      title: "Opportunities",
      description: "External favorable factors and potential",
      icon: Target,
      color: "text-blue-600",
      bgColor: "bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800"
    },
    {
      key: "threats",
      title: "Threats",
      description: "External challenges and risks",
      icon: AlertTriangle,
      color: "text-orange-600",
      bgColor: "bg-orange-50 dark:bg-orange-950 border-orange-200 dark:border-orange-800"
    }
  ];

  const hasChanges = () => {
    if (!initialData) return true;
    return JSON.stringify(swotData) !== JSON.stringify(initialData);
  };

  return (
    <div className="space-y-6">
      {/* Header with Save Button */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">SWOT Analysis</h3>
          <p className="text-sm text-muted-foreground">Strategic analysis framework for decision-making</p>
        </div>
        <Button onClick={handleSave} disabled={isSaving || !hasChanges()} size="sm">
          <Save className="h-4 w-4 mr-2" />
          Save Analysis
        </Button>
      </div>

      {/* SWOT Grid */}
      <div className="grid md:grid-cols-2 gap-4">
        {categories.map((category) => {
          const Icon = category.icon;
          return (
            <Card key={category.key} className={`${category.bgColor} border`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Icon className={`h-5 w-5 ${category.color}`} />
                  {category.title}
                </CardTitle>
                <CardDescription className="text-xs">{category.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Existing Items */}
                {swotData[category.key].length > 0 && (
                  <div className="space-y-2">
                    {swotData[category.key].map((item, index) => (
                      <div key={index} className="flex items-start gap-2 bg-background p-2 rounded border">
                        <span className="flex-1 text-sm">{item}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 hover:bg-red-100 hover:text-red-600"
                          onClick={() => removeItem(category.key, index)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Empty State */}
                {swotData[category.key].length === 0 && (
                  <div className="text-center py-4 text-sm text-muted-foreground">
                    No {category.title.toLowerCase()} added yet
                  </div>
                )}

                {/* Add New Item */}
                <div className="flex gap-2">
                  <Textarea
                    placeholder={`Add ${category.title.toLowerCase()}...`}
                    value={newItem[category.key]}
                    onChange={(e) => setNewItem({ ...newItem, [category.key]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        addItem(category.key);
                      }
                    }}
                    className="min-h-[60px] text-sm"
                  />
                  <Button
                    onClick={() => addItem(category.key)}
                    disabled={!newItem[category.key].trim()}
                    size="sm"
                    className="shrink-0"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Summary Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Analysis Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4 text-center">
            {categories.map((category) => {
              const Icon = category.icon;
              const count = swotData[category.key].length;
              return (
                <div key={category.key} className="space-y-1">
                  <div className="flex items-center justify-center gap-1">
                    <Icon className={`h-4 w-4 ${category.color}`} />
                    <span className="text-2xl font-bold">{count}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{category.title}</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
