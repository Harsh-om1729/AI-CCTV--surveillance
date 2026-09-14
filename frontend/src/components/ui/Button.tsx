import React from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium transition-colors duration-100 rounded-xl focus:outline-none focus:ring-1 focus:ring-ink/20 disabled:opacity-40 disabled:cursor-not-allowed select-none relative overflow-hidden';

    const variants = {
      primary:
        // .btn-3d-primary is a solid brand-teal fill in both themes, so its
        // text stays fixed white rather than following text-primary.
        'btn-3d-primary text-white font-semibold',
      secondary:
        'btn-3d-secondary text-text-primary hover:border-ink/20',
      ghost:
        'bg-transparent text-text-dim hover:text-text-primary hover:bg-ink/[0.04] border border-transparent',
      danger:
        'bg-accent-red text-white font-semibold hover:bg-accent-red/90 border border-ink/10',
    };


    const sizes = {
      sm: 'text-xs px-3 py-1 gap-1.5 h-8',
      md: 'text-sm px-4 py-2 gap-2 h-9',
      lg: 'text-base px-5 py-2.5 gap-2.5 h-11',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-current" />
        ) : (
          leftIcon && <span className="inline-flex shrink-0">{leftIcon}</span>
        )}
        <span>{children}</span>
        {!isLoading && rightIcon && (
          <span className="inline-flex shrink-0">{rightIcon}</span>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
