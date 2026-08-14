'use client';

import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, TrendingUp, AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/TrendChart');

interface TrendDataPoint {
  date: string;
  value: number;
}

interface TrendChartProps {
  keyword: string;
  className?: string;
}

export function TrendChart({ keyword, className }: TrendChartProps) {
  const [data, setData] = useState<TrendDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTrends() {
      if (!keyword) return;

      setLoading(true);
      setError(null);
      setWarning(null);

      try {
        const response = await fetchWithAuth(`/api/trends?keyword=${encodeURIComponent(keyword)}`);
        if (!response.ok) {
          throw new Error('Failed to fetch trend data');
        }

        const result = await response.json();
        if (!result.data || result.data.length === 0) {
          setError('No trend data available.');
        } else {
          setData(result.data);
          setSource(result.source);
          if (result.warning) setWarning(result.warning);
        }
      } catch (err) {
        log.error('Failed to load trend data', err instanceof Error ? err : undefined);
        setError('Could not load trend data.');
      } finally {
        setLoading(false);
      }
    }

    fetchTrends();
  }, [keyword]);

  // If we have data but it's all zeros, show a message
  const allZeros = data.every((d) => d.value === 0);
  if (!loading && !error && allZeros) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Market Interest: {keyword}</CardTitle>
        </CardHeader>
        <CardContent className="flex h-[300px] items-center justify-center text-muted-foreground">
          No sufficient search volume found for this term.
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Market Interest: {keyword}</CardTitle>
          <CardDescription>Analyzing search trends...</CardDescription>
        </CardHeader>
        <CardContent className="flex h-[300px] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Market Interest: {keyword}</CardTitle>
        </CardHeader>
        <CardContent className="flex h-[300px] items-center justify-center text-red-500">{error}</CardContent>
      </Card>
    );
  }

  // Calculate simple trend direction
  const firstVal = data.length > 0 ? data[0].value : 0;
  const lastVal = data.length > 0 ? data[data.length - 1].value : 0;
  const trendDirection = lastVal > firstVal ? 'rising' : lastVal < firstVal ? 'falling' : 'stable';
  const trendColor =
    trendDirection === 'rising' ? 'text-green-500' : trendDirection === 'falling' ? 'text-red-500' : 'text-yellow-500';

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Market Interest
              <Badge
                variant={source.includes('Google Trends') ? 'default' : 'outline'}
                className={`ml-2 font-normal ${
                  source.includes('Fallback')
                    ? 'bg-yellow-500/10 text-yellow-700 border-yellow-300'
                    : source.includes('Cached')
                      ? 'bg-blue-500/10 text-blue-700 border-blue-300'
                      : ''
                }`}
              >
                {source}
              </Badge>
            </CardTitle>
            <CardDescription>
              Interest over time for <strong>{keyword}</strong>.
            </CardDescription>
          </div>
          <div className={`flex items-center gap-1 font-medium ${trendColor}`}>
            <TrendingUp className={`h-4 w-4 ${trendDirection === 'falling' ? 'rotate-180' : ''}`} />
            <span className="capitalize">{trendDirection}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {warning && (
          <div className="mb-4 flex items-center gap-2 rounded-md bg-yellow-500/10 p-2 text-xs text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="h-3 w-3" />
            {warning}
          </div>
        )}
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12 }}
                tickMargin={10}
                interval="preserveStartEnd"
                tickFormatter={(value) => value.split(' ')[0]}
              />
              <YAxis hide />
              <Tooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid hsl(var(--border))',
                  backgroundColor: 'hsl(var(--popover))',
                  color: 'hsl(var(--popover-foreground))',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="hsl(var(--chart-1))"
                fillOpacity={1}
                fill="url(#colorValue)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
