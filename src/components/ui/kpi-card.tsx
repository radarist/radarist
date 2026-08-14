/**
 * @file kpi-card.tsx
 * @description KPI (Key Performance Indicator) card component for landing pages
 *
 * Displays a metric with an icon, value, and label in a compact card format.
 * Used on landing pages (Library, Lab, Agents) to show summary statistics.
 *
 * @author Radarist Team
 * @created 2025-11-30
 */

import { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface KPICardProps {
  /** Icon to display */
  icon: LucideIcon;
  /** Value to display (number or string) */
  value: number | string;
  /** Label describing the metric */
  label: string;
  /** Color class for the icon (e.g., "text-blue-500") */
  color?: string;
  /** Whether the data is loading */
  isLoading?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * KPI Card Component
 *
 * Displays a compact metric card with icon, value, and label.
 *
 * @example
 * ```tsx
 * <KPICard
 *   icon={Bot}
 *   value={4}
 *   label="Total Agents"
 *   color="text-blue-500"
 * />
 * ```
 */
export function KPICard({
  icon: Icon,
  value,
  label,
  color = "text-primary",
  isLoading = false,
  className,
}: KPICardProps) {
  return (
    <Card className={cn("hover:shadow-md transition-shadow", className)}>
      <CardContent className="p-4 flex flex-col items-center justify-center text-center">
        <Icon className={cn("h-8 w-8 mb-2", color)} />
        <div className="text-2xl font-bold">
          {isLoading ? "-" : value}
        </div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
