import type { Metadata } from 'next';
import { Workspace } from '../../components/workspace';

export const metadata: Metadata = { title: 'Activity | Cowork' };

export default function Page() { return <Workspace view="activity" />; }
