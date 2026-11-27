import type { ComponentProps } from 'react';
import styles from './controls.module.css';

export function fieldClassName(className?: string) {
  return className ? `${styles.field} ${className}` : styles.field;
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={fieldClassName(className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={fieldClassName(className)} {...props} />;
}
