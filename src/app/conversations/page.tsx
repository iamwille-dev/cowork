import { Workspace } from '../components/workspace';

export default async function Page({ searchParams }: { searchParams: Promise<{ signup?: string }> }) {
  const { signup } = await searchParams;
  return <Workspace view="conversations" initialMode={signup === '1' ? 'signup' : 'login'} />;
}
