/**
 * @file BlipCompanyLinks.tsx
 * @description Component to display companies linked to a specific radar blip.
 * 
 * @author Radarist Team
 * @created 2025-11-25
 */

"use client";

import { useState, useEffect } from "react";
import { getRelationshipsByBlipId } from "@/lib/company-relationships";
import { getCompanyById } from "@/lib/companies";
import type { CompanyBlipRelationship, Company } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Building2 } from "lucide-react";
import { getRelationshipTypeColor } from "@/lib/company-utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/BlipCompanyLinks');

interface BlipCompanyLinksProps {
    radarId: string;
    radarEntryId: number;
    onCompanyClick?: (company: Company) => void;
}

interface LinkedCompanyDisplay {
    link: CompanyBlipRelationship;
    company: Company | null;
}

export function BlipCompanyLinks({ radarId, radarEntryId, onCompanyClick }: BlipCompanyLinksProps) {
    const [linkedCompanies, setLinkedCompanies] = useState<LinkedCompanyDisplay[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const loadLinks = async () => {
            if (!radarId || radarEntryId === undefined) return;
            setIsLoading(true);
            try {
                // Fetch links
                const links = await getRelationshipsByBlipId(radarId, radarEntryId);

                // Fetch company details for each link
                const companiesWithLinks = await Promise.all(
                    links.map(async (link) => {
                        const company = await getCompanyById(link.companyId);
                        return { link, company };
                    })
                );

                setLinkedCompanies(companiesWithLinks);
            } catch (error) {
                log.error('Failed to load linked companies', error instanceof Error ? error : undefined);
            } finally {
                setIsLoading(false);
            }
        };

        loadLinks();
    }, [radarId, radarEntryId]);

    if (isLoading) {
        return <div className="text-sm text-muted-foreground animate-pulse">Loading related companies...</div>;
    }

    if (linkedCompanies.length === 0) {
        return null;
    }

    return (
        <div className="space-y-3">
            <h3 className="text-lg font-semibold flex items-center gap-2">
                <Building2 className="w-4 h-4 text-blue-500" />
                Related Companies
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {linkedCompanies.map(({ link, company }) => (
                    company ? (
                        <Card
                            key={link.id}
                            role={onCompanyClick ? "button" : undefined}
                            tabIndex={onCompanyClick ? 0 : undefined}
                            aria-label={onCompanyClick ? `View ${company.name} details` : undefined}
                            className={`p-3 flex items-center gap-3 transition-colors ${onCompanyClick ? 'cursor-pointer hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2' : ''}`}
                            onClick={() => onCompanyClick?.(company)}
                            onKeyDown={onCompanyClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCompanyClick(company); } } : undefined}
                        >
                            <Avatar className="h-8 w-8 rounded-lg border bg-background">
                                <AvatarImage src={`https://logo.clearbit.com/${company.website?.replace(/^https?:\/\//, '').replace(/\/$/, '')}`} alt={company.name} className="object-contain p-1" />
                                <AvatarFallback className="rounded-lg bg-primary/10 text-primary text-xs">
                                    {company.name.substring(0, 2).toUpperCase()}
                                </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="font-medium text-sm truncate">{company.name}</span>
                                    <Badge className={`text-[10px] px-1.5 py-0 h-5 font-normal ${getRelationshipTypeColor(link.relationshipType)}`}>
                                        {link.relationshipType}
                                    </Badge>
                                </div>
                                {link.notes && (
                                    <p className="text-xs text-muted-foreground line-clamp-1" title={link.notes}>
                                        {link.notes}
                                    </p>
                                )}
                            </div>
                        </Card>
                    ) : null
                ))}
            </div>
        </div>
    );
}
