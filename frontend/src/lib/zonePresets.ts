import { Zone } from '@/lib/mockZones';

export interface ZonePreset {
  id: string;
  name: string;
  description: string;
  badge: string;
  iconName: 'horizon' | 'funnel' | 'curtain';
  createZones: (cameraName: string) => Zone[];
}

export const ZONE_PRESETS: ZonePreset[] = [
  {
    id: '3-tier-horizon',
    name: '3-Tier Horizon Split',
    description: 'Standard perimeter fence view partitioned by depth: Far line (Red), Buffer (Yellow), Patrol path (Green).',
    badge: 'RECOMMENDED',
    iconName: 'horizon',
    createZones: (cameraName: string): Zone[] => {
      const ts = Date.now();
      return [
        {
          id: `zone-${cameraName}-red-${ts}`,
          cameraName,
          tier: 'red',
          role: 'restricted',
          label: 'Restricted Perimeter Boundary',
          points: [
            { x: 0.05, y: 0.10 },
            { x: 0.95, y: 0.12 },
            { x: 0.92, y: 0.40 },
            { x: 0.08, y: 0.38 },
          ],
        },
        {
          id: `zone-${cameraName}-yellow-${ts + 1}`,
          cameraName,
          tier: 'yellow',
          role: 'buffer',
          direction: 'inward',
          label: 'Perimeter Approach Buffer',
          points: [
            { x: 0.07, y: 0.42 },
            { x: 0.93, y: 0.44 },
            { x: 0.88, y: 0.70 },
            { x: 0.12, y: 0.68 },
          ],
        },
        {
          id: `zone-${cameraName}-green-${ts + 2}`,
          cameraName,
          tier: 'green',
          role: 'authorized',
          label: 'Internal Patrol Corridor',
          points: [
            { x: 0.12, y: 0.72 },
            { x: 0.88, y: 0.74 },
            { x: 0.82, y: 0.94 },
            { x: 0.18, y: 0.92 },
          ],
        },
      ];
    },
  },
  {
    id: 'checkpoint-funnel',
    name: 'Checkpoint & Gate Funnel',
    description: 'Entry chokepoint with restricted flank walls (Red), vehicle inspection strip (Yellow), and clearance lane (Green).',
    badge: 'GATE VIEW',
    iconName: 'funnel',
    createZones: (cameraName: string): Zone[] => {
      const ts = Date.now();
      return [
        {
          id: `zone-${cameraName}-red-left-${ts}`,
          cameraName,
          tier: 'red',
          role: 'restricted',
          label: 'West Barrier Flank',
          points: [
            { x: 0.02, y: 0.08 },
            { x: 0.28, y: 0.08 },
            { x: 0.28, y: 0.92 },
            { x: 0.02, y: 0.92 },
          ],
        },
        {
          id: `zone-${cameraName}-red-right-${ts + 1}`,
          cameraName,
          tier: 'red',
          role: 'restricted',
          label: 'East Barrier Flank',
          points: [
            { x: 0.72, y: 0.08 },
            { x: 0.98, y: 0.08 },
            { x: 0.98, y: 0.92 },
            { x: 0.72, y: 0.92 },
          ],
        },
        {
          id: `zone-${cameraName}-yellow-${ts + 2}`,
          cameraName,
          tier: 'yellow',
          role: 'buffer',
          direction: 'inward',
          label: 'Inbound Vehicle Approach Zone',
          points: [
            { x: 0.30, y: 0.10 },
            { x: 0.70, y: 0.10 },
            { x: 0.68, y: 0.52 },
            { x: 0.32, y: 0.52 },
          ],
        },
        {
          id: `zone-${cameraName}-green-${ts + 3}`,
          cameraName,
          tier: 'green',
          role: 'authorized',
          label: 'Authorized Gate Passage',
          points: [
            { x: 0.32, y: 0.55 },
            { x: 0.68, y: 0.55 },
            { x: 0.65, y: 0.94 },
            { x: 0.35, y: 0.94 },
          ],
        },
      ];
    },
  },
  {
    id: 'perimeter-curtain',
    name: 'Border Fence Curtain',
    description: 'High-security fence line with continuous outer barrier strip and inner buffer clearance zone.',
    badge: 'HIGH SECURITY',
    iconName: 'curtain',
    createZones: (cameraName: string): Zone[] => {
      const ts = Date.now();
      return [
        {
          id: `zone-${cameraName}-red-${ts}`,
          cameraName,
          tier: 'red',
          role: 'restricted',
          label: 'Border Physical Fence Line',
          points: [
            { x: 0.04, y: 0.15 },
            { x: 0.96, y: 0.18 },
            { x: 0.94, y: 0.45 },
            { x: 0.06, y: 0.42 },
          ],
        },
        {
          id: `zone-${cameraName}-yellow-${ts + 1}`,
          cameraName,
          tier: 'yellow',
          role: 'buffer',
          direction: 'inward',
          label: 'Immediate Stand-Off Buffer',
          points: [
            { x: 0.06, y: 0.48 },
            { x: 0.94, y: 0.50 },
            { x: 0.90, y: 0.88 },
            { x: 0.10, y: 0.85 },
          ],
        },
      ];
    },
  },
];
