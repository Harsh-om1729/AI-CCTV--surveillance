import React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'green' | 'yellow' | 'red' | 'neutral' | 'teal' | 'purple';
  dot?: boolean;
  pulse?: boolean;
  size?: 'sm' | 'md';
}

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant = 'neutral',
  dot = false,
  pulse: _pulse = false,
  size = 'md',
  children,
  ...props
}) => {

  const baseStyles =
    'inline-flex items-center font-medium rounded-full tracking-wide select-none border backdrop-blur-md';

  const variants = {
    green:
      'bg-accent-green/10 text-accent-green border-accent-green/30',
    yellow:
      'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30',
    red:
      'bg-accent-red/10 text-accent-red border-accent-red/35',
    neutral:
      'bg-bg-elevated text-text-dim border-ink/10',
    teal:
      'bg-accent-teal/10 text-accent-teal border-accent-teal/30',
    purple:
      'bg-accent-purple/10 text-accent-purple border-accent-purple/30',
  };

  const dotColors = {
    green: 'bg-accent-green',
    yellow: 'bg-accent-yellow',
    red: 'bg-accent-red',
    neutral: 'bg-text-muted',
    teal: 'bg-accent-teal',
    purple: 'bg-accent-purple',
  };

  const sizes = {
    sm: 'text-[10px] px-1.5 py-0.5 gap-1',
    md: 'text-xs px-2 py-0.5 gap-1.5',
  };

  return (
    <span
      className={cn(baseStyles, variants[variant], sizes[size], className)}
      {...props}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          <span
            className={cn(
              'inline-flex rounded-full h-1.5 w-1.5',
              dotColors[variant]
            )}
          />
        </span>
      )}
      <span>{children}</span>
    </span>
  );
};

