import type { ComponentProps } from 'react';
import styles from './controls.module.css';

type ButtonVariant = 'primary' | 'quiet' | 'icon';
type ButtonProps = ComponentProps<'button'> & { variant?: ButtonVariant };

export function buttonClassName(variant: ButtonVariant, className?: string) {
  return [styles.button, styles[variant], className].filter(Boolean).join(' ');
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} data-button-variant={variant} className={buttonClassName(variant, className)} />;
}
