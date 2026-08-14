import type { UseFormReturn } from 'react-hook-form';
import { FileText, ExternalLink, Video, Github } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

import type { PrototypeFormValues } from './constants';

// ============================================================================
// TYPES
// ============================================================================

export interface ArtifactsTabProps {
  form: UseFormReturn<PrototypeFormValues>;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ArtifactsTab({ form }: ArtifactsTabProps) {
  return (
    <Form {...form}>
      <form className="space-y-6">
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Demo & Resources</h3>

          <FormField
            control={form.control}
            name="artifacts.demoUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Live Demo URL</FormLabel>
                <FormControl>
                  <div className="relative">
                    <ExternalLink className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="https://demo.example.com" className="pl-9" {...field} />
                  </div>
                </FormControl>
                <FormDescription>URL to the live demo (if available)</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="artifacts.repoUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Repository URL</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Github className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="https://github.com/org/repo" className="pl-9" {...field} />
                  </div>
                </FormControl>
                <FormDescription>Link to source code repository</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="artifacts.demoVideo"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Demo Video URL</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Video className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="https://loom.com/share/..." className="pl-9" {...field} />
                  </div>
                </FormControl>
                <FormDescription>Link to demo video (Loom, YouTube, etc.)</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Future: Presentation documents upload */}
        <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
          <FileText className="mx-auto h-8 w-8 opacity-50" />
          <p className="mt-2 text-sm">Presentation documents coming soon</p>
        </div>
      </form>
    </Form>
  );
}
