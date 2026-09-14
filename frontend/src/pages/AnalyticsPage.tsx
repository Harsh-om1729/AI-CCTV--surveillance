import React from 'react';
import { Incident } from '@/lib/mockIncidents';
import { incidentsApi } from '@/lib/api';
import { useBackendData } from '@/lib/useBackendData';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { useTheme } from '@/components/theme/ThemeProvider';
import {
  getCategoryDistribution,
  getCameraDistribution,
  getTierDistribution,
  getPeakHourlyActivity,
} from '@/lib/analyticsUtils';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  BarChart3,
  Clock,
  PieChart as PieIcon,
  Video,
  Shield,
  Moon,
} from 'lucide-react';

// Custom Tooltip for Recharts declared outside render
const CustomAnalyticsTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="p-3 bg-bg-surface/95 border border-border-subtle/90 rounded-xl shadow-2xl text-xs space-y-1.5 min-w-[150px] backdrop-blur-md">
        <div className="text-text-primary font-semibold border-b border-border-subtle/60 pb-1 flex items-center justify-between">
          <span>{label || payload[0]?.name}</span>
          <span className="text-[10px] text-text-dim uppercase tracking-wider">Metrics</span>
        </div>
        {payload.map((entry: any, index: number) => (
          <div
            key={index}
            className="flex items-center justify-between gap-3 text-xs"
            style={{ color: entry.color || entry.fill }}
          >
            <span className="capitalize">{entry.name || 'Count'}:</span>
            <span className="font-bold">{entry.value}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export const AnalyticsPage: React.FC = () => {
  // Charts are computed from whatever the backend returns, so every bar here
  // reflects real recorded incidents rather than the sample set.
  const {
    data: incidents,
    isMock,
    error,
  } = useBackendData<Incident[]>(() => incidentsApi.getIncidents(), []);

  const categoryData = getCategoryDistribution(incidents);
  const cameraData = getCameraDistribution(incidents);
  const tierData = getTierDistribution(incidents);
  const hourlyActivity = getPeakHourlyActivity(incidents);

  // Recharts renders its own SVG strokes/fills, which Tailwind/CSS variables
  // can't reach — pick literal colors here so gridlines and axes stay
  // visible in both themes instead of "white" lines vanishing on a light
  // background.
  const { theme } = useTheme();
  const chart = {
    grid: theme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 32, 0.08)',
    axis: theme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(15, 23, 32, 0.18)',
    tick: theme === 'dark' ? '#8b949e' : '#5b6472',
    pieStroke: theme === 'dark' ? '#08080d' : '#ffffff',
  };

  return (
    <div className="space-y-6">
      {/* Top Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ink/10 pb-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-text-primary flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-accent-teal" />
            <span>Threat Intelligence Analytics</span>
            <DataSourceBadge isMock={isMock} error={error} />
          </h2>
          <p className="text-xs text-text-dim">
            Deep multi-dimensional breakdown of border activity, sector distributions, and curfew patterns
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-text-dim bg-bg-elevated px-3.5 py-2 rounded-xl border border-ink/10 shadow-inner">
          <Clock className="w-3.5 h-3.5 text-accent-teal" />
          <span>Data range: Last 24 hours</span>
        </div>
      </div>

      {/* Grid of 4 Core Analytical Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Chart 1: Incidents by Category (Donut Chart) */}
        <Card
          title={
            <div className="flex items-center gap-2">
              <PieIcon className="w-4 h-4 text-accent-teal" />
              <span>Incidents by Target Category</span>
            </div>
          }
          subtitle="Classification breakdown: Person vs. Vehicle vs. Unknown/Thermal"
          action={
            <Badge variant="teal" size="sm">
              CLASSIFIER
            </Badge>
          }
        >
          <div className="h-64 w-full flex flex-col sm:flex-row items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={4}
                  dataKey="value"
                  stroke={chart.pieStroke}
                  strokeWidth={3}
                >
                  {categoryData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={<CustomAnalyticsTooltip />} />
                <Legend
                  formatter={(value) => (
                    <span className="font-mono text-xs text-text-dim">{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Chart 2: Incidents by Camera Channel (Bar Chart) */}
        <Card
          title={
            <div className="flex items-center gap-2">
              <Video className="w-4 h-4 text-accent-teal" />
              <span>Incidents by Camera Sector</span>
            </div>
          }
          subtitle="Total detection distribution across surveillance channels"
          action={
            <Badge variant="green" size="sm">
              SECTOR LOAD
            </Badge>
          }
        >
          <div className="h-64 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={cameraData}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                <XAxis
                  dataKey="camera"
                  stroke={chart.axis}
                  tick={{ fill: chart.tick, fontSize: 11, fontFamily: 'monospace' }}
                  axisLine={{ stroke: chart.axis }}
                />
                <YAxis
                  stroke={chart.axis}
                  tick={{ fill: chart.tick, fontSize: 11, fontFamily: 'monospace' }}
                  axisLine={{ stroke: chart.axis }}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomAnalyticsTooltip />} />
                <Legend
                  formatter={(value) => (
                    <span className="font-mono text-xs text-text-dim capitalize">{value}</span>
                  )}
                />
                <Bar dataKey="red" name="Red (Critical)" fill="#ff0055" stackId="a" />
                <Bar dataKey="yellow" name="Yellow (Caution)" fill="#ffaa00" stackId="a" />
                <Bar dataKey="green" name="Green (Normal)" fill="#00ff88" stackId="a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Chart 3: Incidents by Threat Tier (Bar Chart) */}
        <Card
          title={
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-accent-teal" />
              <span>Volume by Alert Tier</span>
            </div>
          }
          subtitle="Comparative volume of Green, Yellow, and Red alerts"
          action={
            <Badge variant="yellow" size="sm">
              TIER SPLIT
            </Badge>
          }
        >
          <div className="h-64 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={tierData}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                <XAxis
                  dataKey="tier"
                  stroke={chart.axis}
                  tick={{ fill: chart.tick, fontSize: 10, fontFamily: 'Inter' }}
                  axisLine={{ stroke: chart.axis }}
                />
                <YAxis
                  stroke={chart.axis}
                  tick={{ fill: chart.tick, fontSize: 11, fontFamily: 'monospace' }}
                  axisLine={{ stroke: chart.axis }}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomAnalyticsTooltip />} />
                <Bar dataKey="count" name="Incidents" radius={[6, 6, 0, 0]}>
                  {tierData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Chart 4: Peak Activity Hours (Curfew Histogram) */}
        <Card
          title={
            <div className="flex items-center gap-2">
              <Moon className="w-4 h-4 text-accent-yellow" />
              <span>Peak Activity Hours (Curfew Analysis)</span>
            </div>
          }
          subtitle="Activity distribution across 24 hours (Curfew hours: 21:00–05:00)"
          action={
            <Badge variant="yellow" size="sm">
              21:00 - 05:00 CURFEW
            </Badge>
          }
        >
          <div className="h-64 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={hourlyActivity}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                <XAxis
                  dataKey="hour"
                  stroke={chart.axis}
                  tick={{ fill: chart.tick, fontSize: 9, fontFamily: 'monospace' }}
                  axisLine={{ stroke: chart.axis }}
                  interval={2}
                />
                <YAxis
                  stroke={chart.axis}
                  tick={{ fill: chart.tick, fontSize: 11, fontFamily: 'monospace' }}
                  axisLine={{ stroke: chart.axis }}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomAnalyticsTooltip />} />
                <Bar dataKey="count" name="Detections" radius={[4, 4, 0, 0]}>
                  {hourlyActivity.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.isCurfew ? '#ff0055' : '#00f0ff'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
};
