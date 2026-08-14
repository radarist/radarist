/**
 * @file CompanyRadarLinks.tsx
 * @description Component for managing relationships between companies and radar blips.
 *
 * This component allows linking companies to radar technologies with metadata about
 * the relationship type (Vendor, User, Partner, Competitor) and associated use cases.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, Link2 } from 'lucide-react';
import type { CompanyBlipRelationship, RelationshipType, RadarEntry, RadarData } from '@/lib/types';
import { getRelationshipsByCompanyId, linkCompanyToBlip, unlinkCompanyFromBlip } from '@/lib/company-relationships';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { RELATIONSHIP_TYPES } from '@/lib/scouting-constants';
import { getRelationshipTypeColor } from '@/lib/company-utils';
import { useToast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/CompanyRadarLinks');

interface CompanyRadarLinksProps {
  /** Company ID */
  companyId: string;
}

/**
 * CompanyRadarLinks component.
 * Displays and manages all radar entry relationships for a company.
 *
 * @param props - Component props
 * @returns The rendered company-radar links manager
 */
export function CompanyRadarLinks({ companyId }: CompanyRadarLinksProps) {
  const [relationships, setRelationships] = useState<CompanyBlipRelationship[]>([]);
  const [radars, setRadars] = useState<Omit<RadarData, 'entries'>[]>([]);
  const [entries, setEntries] = useState<Map<string, RadarEntry[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedRadarId, setSelectedRadarId] = useState<string>('');
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('Vendor');
  const [notes, setNotes] = useState('');
  const { toast } = useToast();

  /**
   * Loads relationships and radar data.
   */
  const loadData = async () => {
    setIsLoading(true);
    try {
      // Load relationships
      const rels = await getRelationshipsByCompanyId(companyId);
      setRelationships(rels);

      // Load radars from Firestore
      const radarsCollection = collection(db, 'radars');
      const radarsSnapshot = await getDocs(radarsCollection);
      const allRadars = radarsSnapshot.docs.map((doc) => doc.data() as Omit<RadarData, 'entries'>);
      setRadars(allRadars);

      // Load entries for each radar
      const entriesMap = new Map<string, RadarEntry[]>();
      for (const radar of allRadars) {
        const entriesCollection = collection(db, 'radars', radar.id, 'entries');
        const entriesSnapshot = await getDocs(entriesCollection);
        const radarEntries = entriesSnapshot.docs.map((doc) => doc.data() as RadarEntry);
        entriesMap.set(radar.id, radarEntries);
      }
      setEntries(entriesMap);
    } catch (error) {
      log.error('Failed to load relationships', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to load relationships.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [companyId]);

  /**
   * Opens the dialog for adding a new link.
   */
  const handleAddLink = () => {
    setSelectedRadarId('');
    setSelectedEntryId(null);
    setRelationshipType('Vendor');
    setNotes('');
    setIsDialogOpen(true);
  };

  /**
   * Handles creating a new relationship.
   */
  const handleSubmit = async () => {
    if (!selectedRadarId || selectedEntryId === null) {
      toast({
        title: 'Validation Error',
        description: 'Please select a radar and technology.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await linkCompanyToBlip(companyId, selectedRadarId, selectedEntryId, relationshipType, notes);
      toast({
        title: 'Link Created',
        description: 'Company has been linked to the technology.',
      });
      setIsDialogOpen(false);
      loadData();
    } catch (error) {
      log.error('Failed to create link', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to create link.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Handles deleting a relationship.
   */
  const handleDelete = async (relationshipId: string) => {
    if (!confirm('Are you sure you want to remove this link?')) return;

    try {
      await unlinkCompanyFromBlip(relationshipId);
      toast({
        title: 'Link Removed',
        description: 'Relationship has been removed.',
      });
      loadData();
    } catch (error) {
      log.error('Failed to delete link', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to delete link.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Gets the entry name for a relationship.
   */
  const getEntryName = (rel: CompanyBlipRelationship): string => {
    const radarEntries = entries.get(rel.radarId);
    if (!radarEntries) return 'Unknown Technology';
    const entry = radarEntries.find((e) => e.id === rel.radarEntryId);
    return entry?.name || 'Unknown Technology';
  };

  /**
   * Gets the radar name for a relationship.
   */
  const getRadarName = (radarId: string): string => {
    const radar = radars.find((r) => r.id === radarId);
    return radar?.name || 'Unknown Radar';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {relationships.length} {relationships.length === 1 ? 'link' : 'links'}
        </p>
        <Button onClick={handleAddLink} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Link
        </Button>
      </div>

      {relationships.length === 0 ? (
        <Card className="p-8 text-center">
          <Link2 className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-muted-foreground mb-4">No radar links yet</p>
          <Button onClick={handleAddLink} variant="outline">
            <Plus className="h-4 w-4 mr-2" />
            Add First Link
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {relationships.map((rel) => (
            <Card key={rel.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Link2 className="h-4 w-4 text-muted-foreground" />
                    <h4 className="font-semibold">{getEntryName(rel)}</h4>
                    <Badge className={getRelationshipTypeColor(rel.relationshipType)}>{rel.relationshipType}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">Radar: {getRadarName(rel.radarId)}</p>
                  {rel.notes && <p className="text-sm text-muted-foreground/80 italic">{rel.notes}</p>}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(rel.id)}
                  aria-label={`Delete radar link to ${getEntryName(rel)}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Link Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Radar Link</DialogTitle>
            <DialogDescription>Link this company to a technology on one of your radars</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="radar-select">Radar *</Label>
              <Select
                value={selectedRadarId}
                onValueChange={(value) => {
                  setSelectedRadarId(value);
                  setSelectedEntryId(null); // Reset entry when radar changes
                }}
              >
                <SelectTrigger id="radar-select">
                  <SelectValue placeholder="Select a radar" />
                </SelectTrigger>
                <SelectContent>
                  {radars.map((radar) => (
                    <SelectItem key={radar.id} value={radar.id}>
                      {radar.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="entry-select">Technology *</Label>
              <Select
                value={selectedEntryId?.toString() || ''}
                onValueChange={(value) => setSelectedEntryId(parseInt(value))}
                disabled={!selectedRadarId}
              >
                <SelectTrigger id="entry-select">
                  <SelectValue placeholder="Select a technology" />
                </SelectTrigger>
                <SelectContent>
                  {selectedRadarId &&
                    entries.get(selectedRadarId)?.map((entry, index) => (
                      <SelectItem key={`${entry.id}-${index}`} value={entry.id.toString()}>
                        {entry.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="relationship-type">Relationship Type *</Label>
              <Select
                value={relationshipType}
                onValueChange={(value) => setRelationshipType(value as RelationshipType)}
              >
                <SelectTrigger id="relationship-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RELATIONSHIP_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="relationship-notes">Notes</Label>
              <Textarea
                id="relationship-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Additional notes about this relationship..."
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>Add Link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
