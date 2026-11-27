import type { ComponentProps } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import styles from './select.module.css';

type SelectProps = Omit<ComponentProps<'select'>, 'multiple' | 'size'> & { variant?: 'field' | 'filter' };

export function Select({ variant = 'field', ...props }: SelectProps) {
  return <span className={styles.control} data-variant={variant}>
    <select {...props} />
    <ChevronDownIcon className={styles.chevron} aria-hidden="true" />
  </span>;
}
