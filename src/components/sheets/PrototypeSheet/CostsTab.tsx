import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { DollarSign, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { cn } from '@/lib/utils';

import type { PrototypeFormValues } from './constants';
import { COST_CATEGORIES, CURRENCY_OPTIONS } from './constants';

// ============================================================================
// TYPES
// ============================================================================

export interface CostsTabProps {
  form: UseFormReturn<PrototypeFormValues>;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatCurrency(value: number | undefined, currency: string) {
  if (value === undefined) return 'Not set';
  // Values are stored in thousands
  if (value >= 1000) {
    return `${currency} ${(value / 1000).toFixed(1)}M`;
  }
  return `${currency} ${value}K`;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function CostsTab({ form }: CostsTabProps) {
  const [newCategory, setNewCategory] = React.useState('');
  const [newAmount, setNewAmount] = React.useState<number>(0);
  const [newDescription, setNewDescription] = React.useState('');
  const [isAddingItem, setIsAddingItem] = React.useState(false);

  const handleAddBreakdownItem = () => {
    if (!newCategory || newAmount <= 0) return;

    const current = form.getValues('costs.breakdown') || [];
    const existingIndex = current.findIndex((item) => item.category === newCategory);

    if (existingIndex >= 0) {
      // Update existing category
      const updated = [...current];
      updated[existingIndex] = {
        category: newCategory,
        amount: newAmount,
        description: newDescription || undefined,
      };
      form.setValue('costs.breakdown', updated, { shouldDirty: true });
    } else {
      // Add new category
      form.setValue(
        'costs.breakdown',
        [
          ...current,
          {
            category: newCategory,
            amount: newAmount,
            description: newDescription || undefined,
          },
        ],
        { shouldDirty: true }
      );
    }

    setNewCategory('');
    setNewAmount(0);
    setNewDescription('');
    setIsAddingItem(false);
  };

  const handleRemoveBreakdownItem = (category: string) => {
    const current = form.getValues('costs.breakdown') || [];
    form.setValue(
      'costs.breakdown',
      current.filter((item) => item.category !== category),
      { shouldDirty: true }
    );
  };

  const breakdown = form.watch('costs.breakdown') || [];
  const totalBreakdown = breakdown.reduce((sum, item) => sum + item.amount, 0);
  const currency = form.watch('costs.currency') || 'USD';
  const estimated = form.watch('costs.estimated');
  const actual = form.watch('costs.actual');

  // Calculate variance
  const variance = estimated && actual ? actual - estimated : undefined;
  const variancePercent =
    estimated && actual && estimated > 0 ? (((actual - estimated) / estimated) * 100).toFixed(1) : undefined;

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Currency Selection */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Cost Tracking</h3>

          <FormField
            control={form.control}
            name="costs.currency"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Currency</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || 'USD'}>
                  <FormControl>
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder="Currency" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {CURRENCY_OPTIONS.map((curr) => (
                      <SelectItem key={curr} value={curr}>
                        {curr}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Estimated vs Actual */}
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="costs.estimated"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Estimated Cost (K)</FormLabel>
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
                  <FormDescription>{formatCurrency(field.value, currency)}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="costs.actual"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Actual Cost (K)</FormLabel>
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
                  <FormDescription>{formatCurrency(field.value, currency)}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Variance Display */}
          {variance !== undefined && (
            <div
              className={cn(
                'rounded-lg border p-4',
                variance > 0 ? 'border-red-500/30 bg-red-500/10' : 'border-green-500/30 bg-green-500/10'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Budget Variance</span>
                <div className="text-right">
                  <div className={cn('font-semibold', variance > 0 ? 'text-red-600' : 'text-green-600')}>
                    {variance > 0 ? '+' : ''}
                    {formatCurrency(variance, currency)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {variance > 0 ? '+' : ''}
                    {variancePercent}%
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Cost Breakdown */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">Cost Breakdown</h3>
            {!isAddingItem && (
              <Button type="button" variant="outline" size="sm" onClick={() => setIsAddingItem(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Item
              </Button>
            )}
          </div>

          {/* Breakdown List */}
          {breakdown.length > 0 && (
            <div className="space-y-2">
              {breakdown.map((item) => (
                <div key={item.category} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{item.category}</Badge>
                      <span className="font-medium">{formatCurrency(item.amount, currency)}</span>
                    </div>
                    {item.description && <p className="text-xs text-muted-foreground mt-1">{item.description}</p>}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleRemoveBreakdownItem(item.category)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              {/* Total */}
              <div className="flex items-center justify-between rounded-lg bg-muted p-3">
                <span className="font-medium">Total Breakdown</span>
                <span className="font-semibold">{formatCurrency(totalBreakdown, currency)}</span>
              </div>
            </div>
          )}

          {/* Add Item Form */}
          {isAddingItem && (
            <div className="rounded-lg border p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Category</label>
                  <Select value={newCategory} onValueChange={setNewCategory}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {COST_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Amount ({currency} K)</label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={newAmount || ''}
                    onChange={(e) => setNewAmount(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Description (optional)</label>
                <Input
                  placeholder="Brief description of this cost..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsAddingItem(false);
                    setNewCategory('');
                    setNewAmount(0);
                    setNewDescription('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAddBreakdownItem}
                  disabled={!newCategory || newAmount <= 0}
                >
                  Add
                </Button>
              </div>
            </div>
          )}

          {/* Empty State */}
          {breakdown.length === 0 && !isAddingItem && (
            <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
              <DollarSign className="mx-auto h-8 w-8 opacity-50" />
              <p className="mt-2 text-sm">No cost breakdown items yet</p>
              <p className="text-xs mt-1">Add items to track costs by category</p>
            </div>
          )}
        </div>
      </form>
    </Form>
  );
}
