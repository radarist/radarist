import * as React from 'react';

import {cn} from '@/lib/utils';

/**
 * TextareaProps type - extends standard textarea props
 */
export type TextareaProps = React.ComponentProps<'textarea'>;

/**
 * Standard Textarea component.
 * A wrapper around the native HTML textarea element with standard styling.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({className, ...props}, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export {Textarea};
