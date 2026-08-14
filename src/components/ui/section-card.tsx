/**
 * @file section-card.tsx
 * @description Section card component for landing page navigation
 *
 * Displays an entity type card with icon, title, description, count,
 * and a browse button. Used on landing pages to navigate to entity lists.
 *
 * @author Radarist Team
 * @created 2025-11-30
 */

import { LucideIcon, ArrowRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";

interface SectionCardProps {
  /** Title of the section */
  title: string;
  /** Description of what the section contains */
  description: string;
  /** Icon to display */
  icon: LucideIcon;
  /** Count of items in the section */
  count: number;
  /** URL to navigate to */
  href: string;
  /** Color class for the icon (e.g., "text-blue-500") */
  color?: string;
  /** Whether the data is loading */
  isLoading?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Section Card Component
 *
 * Displays a navigation card for entity types on landing pages.
 *
 * @example
 * ```tsx
 * <SectionCard
 *   title="Companies"
 *   description="Partners, vendors, and competitors"
 *   icon={Building2}
 *   count={21}
 *   href="/library/companies"
 *   color="text-blue-500"
 * />
 * ```
 */
export function SectionCard({
  title,
  description,
  icon: Icon,
  count,
  href,
  color = "text-primary",
  isLoading = false,
  className,
}: SectionCardProps) {
  return (
    <Card className={cn("hover:shadow-lg transition-all hover:-translate-y-1", className)}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={cn("p-3 rounded-lg bg-muted", color)}>
              <Icon className="h-6 w-6" />
            </div>
            <div>
              <CardTitle className="text-lg">{title}</CardTitle>
              <div className="text-sm text-muted-foreground mt-1">
                {isLoading ? "-" : count} {count === 1 ? "item" : "items"}
              </div>
            </div>
          </div>
        </div>
        <CardDescription className="mt-3">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Link href={href}>
          <Button variant="outline" className="w-full group">
            Browse {title}
            <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
