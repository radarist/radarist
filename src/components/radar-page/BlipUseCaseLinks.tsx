/**
 * @file BlipUseCaseLinks.tsx
 * @description Component to display use cases linked to a specific radar blip.
 * 
 * @author Radarist Team
 * @created 2025-11-25
 */

"use client";

import { useState, useEffect } from "react";
import { getUseCasesByBlipId } from "@/lib/use-cases";
import type { UseCase } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Target } from "lucide-react";
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/BlipUseCaseLinks');

interface BlipUseCaseLinksProps {
    radarId: string;
    radarEntryId: number;
    onUseCaseClick?: (useCase: UseCase) => void;
}

export function BlipUseCaseLinks({ radarId, radarEntryId, onUseCaseClick }: BlipUseCaseLinksProps) {
    const [linkedUseCases, setLinkedUseCases] = useState<UseCase[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const loadLinks = async () => {
            if (!radarId || radarEntryId === undefined) return;
            setIsLoading(true);
            try {
                // Fetch use cases linked to this blip
                // Note: getUseCasesByBlipId expects blipId as string, but radarEntryId is number.
                // We need to ensure we pass the correct ID format.
                // In use-cases.ts, it queries "radarTechnologyIds" array.
                // If radarTechnologyIds stores strings like "101", we convert.
                // If it stores "radarId-entryId", we need that.
                // Let's assume it stores just the ID as string for now, or check how it's stored.
                // Based on previous code, it seems to store just the ID.
                const useCases = await getUseCasesByBlipId(radarEntryId.toString());
                setLinkedUseCases(useCases);
            } catch (error) {
                log.error('Failed to load linked use cases', error instanceof Error ? error : undefined);
            } finally {
                setIsLoading(false);
            }
        };

        loadLinks();
    }, [radarId, radarEntryId]);

    if (isLoading) {
        return <div className="text-sm text-muted-foreground animate-pulse">Loading related use cases...</div>;
    }

    if (linkedUseCases.length === 0) {
        return null;
    }

    return (
        <div className="space-y-3">
            <h3 className="text-lg font-semibold flex items-center gap-2">
                <Target className="w-4 h-4 text-green-500" />
                Related Use Cases
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {linkedUseCases.map((useCase) => (
                    <Card
                        key={useCase.id}
                        className={`p-3 flex flex-col gap-2 transition-colors ${onUseCaseClick ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                        onClick={() => onUseCaseClick?.(useCase)}
                    >
                        <div className="flex items-center justify-between">
                            <span className="font-medium text-sm truncate">{useCase.title}</span>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 font-normal">
                                {useCase.category}
                            </Badge>
                        </div>
                        {useCase.description && (
                            <p className="text-xs text-muted-foreground line-clamp-2" title={useCase.description}>
                                {useCase.description}
                            </p>
                        )}
                    </Card>
                ))}
            </div>
        </div>
    );
}
