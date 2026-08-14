import type { UseFormReturn } from 'react-hook-form';
import { DollarSign, Calendar } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Slider } from '@/components/ui/slider';

import type { PrototypeFormValues } from './constants';
import { IMPACT_TYPES } from './constants';

// ============================================================================
// TYPES
// ============================================================================

export interface ImpactTabProps {
  form: UseFormReturn<PrototypeFormValues>;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatCurrency(value: number) {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value}`;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ImpactTab({ form }: ImpactTabProps) {
  return (
    <Form {...form}>
      <form className="space-y-6">
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Impact Measurement</h3>

          <FormField
            control={form.control}
            name="impact.type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Impact Type</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select impact type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {IMPACT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="impact.estimatedValue"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Estimated Value (USD)</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="number"
                        placeholder="0"
                        className="pl-9"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </div>
                  </FormControl>
                  <FormDescription>{formatCurrency(field.value)}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="impact.actualValue"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Actual Value (USD)</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="number"
                        placeholder="0"
                        className="pl-9"
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                      />
                    </div>
                  </FormControl>
                  <FormDescription>{field.value ? formatCurrency(field.value) : 'Not measured yet'}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="impact.timeToImpact"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Time to Impact</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="e.g., 3 months, 1 year" className="pl-9" {...field} />
                  </div>
                </FormControl>
                <FormDescription>Expected time to realize the impact</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="impact.confidence"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confidence Level: {field.value}%</FormLabel>
                <FormControl>
                  <Slider
                    min={0}
                    max={100}
                    step={5}
                    value={[field.value]}
                    onValueChange={([value]) => field.onChange(value)}
                    className="py-4"
                  />
                </FormControl>
                <FormDescription>How confident are you in this estimate?</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="impact.notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Impact Notes</FormLabel>
                <FormControl>
                  <Textarea placeholder="Additional notes about impact measurement..." rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </form>
    </Form>
  );
}
