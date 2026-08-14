/**
 * @file CompanyDialog.tsx
 * @description Modal dialog for viewing and editing company details.
 *
 * This component provides a tabbed interface for managing all aspects of a company:
 * - Overview: Basic information and status
 * - Contacts: Contact person management  
 * - Relationships: Links to radar blips
 * - Documents: File uploads and external links
 * - Notes: Timeline of interactions
 * - AI Research: Automated company research
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
    Building2,
    Users,
    Link2,
    FileText,
    MessageSquare,
    Sparkles,
    Lightbulb,
    Target,
    Map,
    FileUp,
    Swords,
    Plus
} from "lucide-react";
import type { Company } from "@/lib/types";
import { deleteCompany } from "@/lib/companies";
import {
    resolveCompanyCreateOutcome,
    resolveCompanyUpdateOutcome,
    type CompanyCreateInput,
    type CompanyMutationOutcome,
    type CompanyUpdateInput
} from "@/lib/company-mutation-outcome";
import { useEntityGraphSyncRecoveries } from "@/hooks/useEntityGraphSyncRecoveries";
import { EntityGraphSyncWarning } from "@/components/library/shared/EntityGraphSyncWarning";
import { CompanyOverview } from "@/components/scouting/CompanyOverview";
import { ContactManager } from "@/components/scouting/ContactManager";
import { CompanyRadarLinks } from "@/components/scouting/CompanyRadarLinks";
import { NotesTimeline } from "@/components/scouting/NotesTimeline";
import { DocumentManager } from "@/components/scouting/DocumentManager";
import { UseCaseManager } from "@/components/scouting/UseCaseManager";
import { AICompanyResearch } from "@/components/scouting/AICompanyResearch";
import { CompanySWOTAnalysis } from "@/components/scouting/CompanySWOTAnalysis";
import { CompanyCompetitors } from "@/components/scouting/CompanyCompetitors";
import { ContextualGraph } from "@/components/graphs/ContextualGraph";
import { DocumentUploadDialog } from "@/components/documents/DocumentUploadDialog";
import { createLogger } from "@/lib/logger";
import { deriveCompanyResearchPresentation, isCompanyResearchDraft } from "@/lib/company-research-presentation";

const log = createLogger("ui/CompanyDialog");

type CompanyMutationContext = "save" | "documents" | "swot";

interface CompanyDialogProps {
    /** Whether the dialog is open. */
    isOpen: boolean;
    /** Callback to update open state. */
    onOpenChange: (open: boolean) => void;
    /** Company to view/edit (null for new company). */
    company: Company | null;
    /** Whether this is a new company being created. */
    isNew: boolean;
    /** Callback when company is successfully saved. */
    onSaved: () => void;
    /** Callback when company is deleted. */
    onDeleted: () => void;
}

/**
 * CompanyDialog component.
 * Provides a comprehensive interface for managing company information.
 *
 * @param props - Component props
 * @returns The rendered company dialog
 */
export function CompanyDialog({ isOpen, onOpenChange, company, isNew, onSaved, onDeleted }: CompanyDialogProps) {
    const [activeTab, setActiveTab] = useState("overview");
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [editedCompany, setEditedCompany] = useState<Partial<Company> | null>(null);
    const [isGraphOpen, setIsGraphOpen] = useState(false);
    const [isDocumentUploadOpen, setIsDocumentUploadOpen] = useState(false);
    const { toast } = useToast();
    const {
        recoveries: graphSyncRecoveries,
        recordRecovery: recordGraphSyncRecovery,
        clearRecovery: clearGraphSyncRecovery,
        retryGraphSync,
        maxRetryAttempts: maxGraphSyncRetries
    } = useEntityGraphSyncRecoveries<Company, CompanyMutationContext>({ entityType: 'company' });

    const currentCompany = company ? ({ ...company, ...editedCompany } as Company) : null;
    const hasResearchDraft = isCompanyResearchDraft(deriveCompanyResearchPresentation(currentCompany));

    // Reset state when dialog opens/closes or company changes
    useEffect(() => {
        if (isOpen) {
            setActiveTab("overview");
            if (company) {
                setEditedCompany(company);
            } else if (!editedCompany) {
                // Initialize with default values for new company only if no data exists
                // Phase 4: Updated to use new lowercase enum values
                setEditedCompany({
                    name: "",
                    description: "",
                    website: "",
                    type: [],
                    industry: [],
                    size: "small",
                    stage: "seed",
                    location: { city: "", country: "" },
                    status: "Watching",
                    tags: [],
                    socialLinks: {},
                    technologyStack: [],
                    documents: []
                });
            }
        } else {
            // Clear edited company when dialog closes
            setEditedCompany(null);
        }
    }, [isOpen, company]);

    const applyMutationOutcome = (
        outcome: CompanyMutationOutcome,
        context: CompanyMutationContext
    ): "saved-and-queued" | "saved-locally" => {
        if (outcome.status === "rejected") {
            throw outcome.error;
        }
        setEditedCompany(outcome.entity);
        if (outcome.status === "saved-locally") {
            recordGraphSyncRecovery(outcome, context);
        }
        return outcome.status;
    };

    const persistCompanyUpdate = async (updates: CompanyUpdateInput, context: CompanyMutationContext) => {
        if (!currentCompany) {
            return "rejected" as const;
        }
        try {
            const outcome = await resolveCompanyUpdateOutcome(currentCompany, updates);
            if (outcome.status === "rejected") {
                return outcome.status;
            }
            return applyMutationOutcome(outcome, context);
        } catch (error) {
            log.error("Could not verify company save state", error instanceof Error ? error : undefined);
            return "status-unavailable" as const;
        }
    };

    const handleGraphSyncRetry = async (entityId: string) => {
        const result = await retryGraphSync(entityId);
        if (result.status === "acknowledged") {
            toast({
                title: "Graph sync acknowledged",
                description: `"${result.recovery.entity?.name ?? result.recovery.entityId}" is queued; the notice clears once the graph write is confirmed.`
            });
            if (result.recovery.context === "save") {
                onSaved();
            }
            return;
        }
        if (result.status === "failed") {
            toast({
                title: "Graph sync still unavailable",
                description: "The company remains saved locally. No company data was submitted again.",
                variant: "destructive"
            });
        }
    };

    /**
     * Handles saving the company (create or update).
     */
    const handleSave = async (companyData: Partial<Company>) => {
        if (!editedCompany) return;

        setIsSaving(true);
        try {
            let outcome: CompanyMutationOutcome;
            try {
                if (isNew) {
                    outcome = await resolveCompanyCreateOutcome(companyData as CompanyCreateInput);
                } else if (currentCompany) {
                    outcome = await resolveCompanyUpdateOutcome(currentCompany, companyData);
                } else {
                    throw new Error("No company is available for update");
                }
            } catch (error) {
                log.error("Could not verify company save state", error instanceof Error ? error : undefined);
                toast({
                    title: "Save status unavailable",
                    description: "Reload the company before trying again to avoid overwriting a possible committed save.",
                    variant: "destructive"
                });
                return;
            }
            if (outcome.status === "rejected") {
                log.error("Company write was rejected", outcome.error);
                toast({
                    title: "Company not saved",
                    description: "The write was rejected before it could be confirmed. Review the company and try again.",
                    variant: "destructive"
                });
                return;
            }
            const status = applyMutationOutcome(outcome, "save");
            if (status === "saved-locally") {
                toast({
                    title: "Saved locally",
                    description: `"${companyData.name ?? "Company"}" is saved in this workspace, but graph synchronization was not acknowledged.`
                });
                return;
            }
            onSaved();
        } catch (error) {
            log.error("Failed to save company", error instanceof Error ? error : undefined);
            toast({
                title: "Error",
                description: "Failed to save company. Please try again.",
                variant: "destructive"
            });
        } finally {
            setIsSaving(false);
        }
    };

    /**
     * Handles deleting the company.
     */
    const handleDelete = async () => {
        if (!company) return;

        const confirmed = confirm(`Are you sure you want to delete "${company.name}"? This action cannot be undone.`);

        if (!confirmed) return;

        setIsDeleting(true);
        try {
            await deleteCompany(company.id);
            clearGraphSyncRecovery(company.id);
            onDeleted();
        } catch (error) {
            log.error("Failed to delete company", error instanceof Error ? error : undefined);
            toast({
                title: "Error",
                description: "Failed to delete company. Please try again.",
                variant: "destructive"
            });
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
                <DialogHeader className="flex flex-row items-center justify-between pr-8">
                    <div className="space-y-1">
                        <DialogTitle className="text-2xl font-headline">
                            {isNew ? "Add New Company" : company?.name || "Company Details"}
                        </DialogTitle>
                        <DialogDescription>
                            {isNew
                                ? "Create a new company profile and link it to radar technologies"
                                : "View and manage company information, contacts, and relationships"}
                        </DialogDescription>
                    </div>
                    {(editedCompany?.name || !isNew) && (
                        <div className="flex items-center gap-2">
                            {company && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="gap-2 hidden sm:flex"
                                    onClick={() => setIsGraphOpen(true)}
                                >
                                    <Map className="h-4 w-4 text-primary" />
                                    Map
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2 hidden sm:flex"
                                onClick={() => setIsDocumentUploadOpen(true)}
                            >
                                <FileUp className="h-4 w-4 text-primary" />
                                Import
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2 hidden sm:flex"
                                onClick={() => setActiveTab("ai-research")}
                            >
                                <Sparkles className="h-4 w-4 text-primary" />
                                Auto-Research
                            </Button>
                        </div>
                    )}
                </DialogHeader>

                {hasResearchDraft && (
                    <div
                        role="note"
                        aria-label="AI research draft warning"
                        className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                    >
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                                This company includes an unverified AI research draft.
                            </p>
                            <p className="text-xs text-muted-foreground">
                                Review its source references before relying on generated fields.
                            </p>
                        </div>
                    </div>
                )}

                {graphSyncRecoveries.length > 0 && (
                    <div className="space-y-3">
                        {graphSyncRecoveries.map((recovery) => (
                            <EntityGraphSyncWarning
                                key={recovery.entityId}
                                entityLabel={recovery.entity?.name ?? recovery.entityId}
                  entityTypeLabel="company"
                                awaitingConfirmation={recovery.awaitingConfirmation}
                                operation={recovery.operation}
                                retryAttempts={recovery.retryAttempts}
                                maxRetryAttempts={maxGraphSyncRetries}
                                isRetrying={recovery.isRetrying}
                                onRetry={() => handleGraphSyncRetry(recovery.entityId)}
                            />
                        ))}
                    </div>
                )}

                <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
                    <TabsList className="grid w-full grid-cols-8">
                        <TabsTrigger value="overview" className="gap-2">
                            <Building2 className="h-4 w-4" />
                            <span className="hidden sm:inline">Overview</span>
                        </TabsTrigger>
                        <TabsTrigger value="contacts" className="gap-2" disabled={isNew}>
                            <Users className="h-4 w-4" />
                            <span className="hidden sm:inline">Contacts</span>
                        </TabsTrigger>
                        <TabsTrigger value="swot" className="gap-2" disabled={isNew}>
                            <Target className="h-4 w-4" />
                            <span className="hidden sm:inline">SWOT</span>
                        </TabsTrigger>
                        <TabsTrigger value="competitors" className="gap-2" disabled={isNew}>
                            <Swords className="h-4 w-4" />
                            <span className="hidden sm:inline">Rivals</span>
                        </TabsTrigger>
                        <TabsTrigger value="relationships" className="gap-2" disabled={isNew}>
                            <Link2 className="h-4 w-4" />
                            <span className="hidden sm:inline">Links</span>
                        </TabsTrigger>
                        <TabsTrigger value="documents" className="gap-2" disabled={isNew}>
                            <FileText className="h-4 w-4" />
                            <span className="hidden sm:inline">Docs</span>
                        </TabsTrigger>
                        <TabsTrigger value="notes" className="gap-2" disabled={isNew}>
                            <MessageSquare className="h-4 w-4" />
                            <span className="hidden sm:inline">Notes</span>
                        </TabsTrigger>
                        <TabsTrigger value="use-cases" className="gap-2" disabled={isNew}>
                            <Lightbulb className="h-4 w-4" />
                            <span className="hidden sm:inline">Use Cases</span>
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="overview" className="mt-6">
                        <CompanyOverview
                            company={editedCompany}
                            isNew={isNew}
                            onSave={handleSave}
                            onDelete={handleDelete}
                            isSaving={isSaving}
                            isDeleting={isDeleting}
                        />
                    </TabsContent>

                    <TabsContent value="contacts" className="mt-6">
                        {company ? <ContactManager companyId={company.id} /> : <CreateModeNotice feature="contacts" />}
                    </TabsContent>

                    <TabsContent value="swot" className="mt-6">
                        {company ? (
                            <CompanySWOTAnalysis
                                initialData={currentCompany?.swot}
                                onSave={(swot) => persistCompanyUpdate({ swot }, "swot")}
                                onUpdate={(swotData) => {
                                    setEditedCompany({ ...editedCompany, swot: swotData });
                                }}
                            />
                        ) : (
                            <CreateModeNotice feature="SWOT analysis" />
                        )}
                    </TabsContent>

                    <TabsContent value="competitors" className="mt-6">
                        {company ? (
                            <CompanyCompetitors companyId={company.id} companyName={company.name} />
                        ) : (
                            <CreateModeNotice feature="competitors" />
                        )}
                    </TabsContent>

                    <TabsContent value="relationships" className="mt-6">
                        {company ? (
                            <CompanyRadarLinks companyId={company.id} />
                        ) : (
                            <CreateModeNotice feature="radar links" />
                        )}
                    </TabsContent>

                    <TabsContent value="documents" className="mt-6">
                        {company ? (
                            <DocumentManager
                                company={currentCompany ?? company}
                                onUpdate={async (documents) => {
                                    const status = await persistCompanyUpdate({ documents }, "documents");
                                    if (status === "rejected") {
                                        toast({
                                            title: "Documents not saved",
                                            description: "The document update was rejected. Please try again.",
                                            variant: "destructive"
                                        });
                                        return false;
                                    }
                                    if (status === "status-unavailable") {
                                        toast({
                                            title: "Save status unavailable",
                                            description:
                                                "Reload the company before trying again to avoid overwriting a possible committed update.",
                                            variant: "destructive"
                                        });
                                        return false;
                                    }
                                    return true;
                                }}
                            />
                        ) : (
                            <CreateModeNotice feature="documents" />
                        )}
                    </TabsContent>

                    <TabsContent value="notes" className="mt-6">
                        {company ? <NotesTimeline companyId={company.id} /> : <CreateModeNotice feature="notes" />}
                    </TabsContent>

                    <TabsContent value="use-cases" className="mt-6">
                        {company ? <UseCaseManager companyId={company.id} /> : <CreateModeNotice feature="use cases" />}
                    </TabsContent>

                    <TabsContent value="ai-research" className="mt-6">
                        {editedCompany ? (
                            <AICompanyResearch
                                company={editedCompany}
                                onApply={(updates) => {
                                    setEditedCompany((prev) => (prev ? { ...prev, ...updates } : updates));
                                    toast({
                                        title: "Data Applied",
                                        description: "Switch to the Overview tab to review changes."
                                    });
                                }}
                            />
                        ) : (
                            <div className="text-center py-8 text-muted-foreground">Loading company data...</div>
                        )}
                    </TabsContent>
                </Tabs>
            </DialogContent>

            {/* Contextual Graph Modal */}
            {company && (
                <ContextualGraph
                    isOpen={isGraphOpen}
                    onOpenChange={setIsGraphOpen}
                    entityId={company.id}
                    entityName={company.name}
                    entityType="company"
                />
            )}

            {/* Document Upload Dialog */}
            <DocumentUploadDialog
                isOpen={isDocumentUploadOpen}
                onOpenChange={setIsDocumentUploadOpen}
                sourceEntity={
                    editedCompany?.name
                        ? {
                              type: "company",
                              id: company?.id || "",
                              name: editedCompany.name,
                              description: editedCompany.description
                          }
                        : undefined
                }
                onEntitiesImported={(count) => {
                    toast({
                        title: "Entities imported",
                        description: `Successfully linked ${count} entities from document.`
                    });
                }}
            />
        </Dialog>
    );
}

// ============================================================================
// CREATE MODE NOTICE
// ============================================================================

/**
 * CreateModeNotice - Friendly notice shown in tabs during entity creation mode.
 * Displayed when features like contacts/notes require the entity to be saved first.
 */
function CreateModeNotice({ feature }: { feature: string }) {
    return (
        <div className="py-8 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Plus className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
                {feature.charAt(0).toUpperCase() + feature.slice(1)} will be available after you save.
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
                Fill in the overview details and click Save to continue.
            </p>
        </div>
    );
}
