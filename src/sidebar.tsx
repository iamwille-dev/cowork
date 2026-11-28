import { Button } from './app/components/button';
import { Input } from './app/components/input';
import { useState } from 'react';
import {
  Dialog, DialogBackdrop, DialogPanel, DialogTitle, Menu, MenuButton, MenuItem, MenuItems, TransitionChild,
} from '@headlessui/react';
import {
  Bars3Icon, BellIcon, CalendarIcon, ChatBubbleLeftRightIcon, Cog6ToothIcon, CircleStackIcon, FolderIcon, MoonIcon, SparklesIcon, SunIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { ChevronDownIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid';

const navigation = [
  { page: 'chat', name: 'Conversations', icon: ChatBubbleLeftRightIcon },
  { page: 'tasks', name: 'Tasks', icon: FolderIcon },
  { page: 'drive', name: 'Drive', icon: CircleStackIcon },
  { page: 'reminders', name: 'Reminders', icon: CalendarIcon },
] as const;

type ShellProps = {
  page: string;
  invitationCount: number;
  theme: 'dark' | 'light';
  account?: { name: string; initials: string; role: string };
  navigate: (page: string) => void;
  toggleTheme: () => void;
  signOut: () => void;
  children: React.ReactNode;
  search: (query: string) => { label: string; open: () => void }[];
};

function Brand() {
  return <a href="/" className="shell-brand" aria-label="Cowork home"><span className="brand-mark"><SparklesIcon aria-hidden="true" /></span> Cowork</a>;
}

const topbarClass = 'shell-topbar sticky top-0 z-40 flex h-16 shrink-0 items-center gap-4 px-4 sm:px-6 lg:px-8';
type ThemeControls = Pick<ShellProps, 'theme' | 'toggleTheme'>;

function ThemeToggle({ theme, toggleTheme }: ThemeControls) {
  const Icon = theme === 'dark' ? SunIcon : MoonIcon;
  return <Button type="button" onClick={toggleTheme} variant="icon" aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
    <Icon aria-hidden="true" className="size-5" />
  </Button>;
}

export function WorkspaceGuestTopbar(props: ThemeControls) {
  return <header className={topbarClass}>
    <div className="mr-auto"><Brand /></div>
    <ThemeToggle {...props} />
  </header>;
}

function SidebarNavigation({ account, page, invitationCount, navigate }: ShellProps) {
  return (
    <div className="shell-sidebar-content flex grow flex-col gap-y-5 overflow-y-auto px-4 pb-4">
      <div className="flex h-16 shrink-0 items-center px-1"><Brand /></div>
      {account && (
        <nav className="flex flex-1 flex-col" aria-label="Workspace">
          <p className="mb-2 px-3 text-xs">Workspace</p>
          <ul role="list" className="flex flex-1 flex-col gap-y-6">
            <li>
              <ul role="list" className="space-y-1">
                {navigation.map((item) => (
                  <li key={item.page}>
                    <button type="button" onClick={() => navigate(item.page)} aria-current={page === item.page ? 'page' : undefined}
                      className="shell-nav-item group flex w-full items-center gap-x-2.5 px-3 py-1.5 text-left text-sm font-semibold">
                      <item.icon aria-hidden="true" className="size-6 shrink-0" />
                      {item.name}
                      {item.page === 'chat' && invitationCount > 0 && (
                        <span className="status ml-auto" aria-label={`${invitationCount} pending invitations`}>{invitationCount}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
            <li className="shell-agent-card">
              <div className="shell-agent-label text-xs/6 font-semibold">Workspace agent</div>
              <div className="shell-agent mt-2 flex items-center gap-3 text-sm/6 font-semibold">
                <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-lg border"><SparklesIcon className="size-4" /></span>
                <span className="truncate">{account.role}</span>
              </div>
            </li>
            <li className="mt-auto">
              <button type="button" onClick={() => navigate('admin')} aria-current={page === 'admin' ? 'page' : undefined}
                className="shell-nav-item flex w-full items-center gap-x-2.5 px-3 py-1.5 text-left text-sm font-semibold">
                <Cog6ToothIcon aria-hidden="true" className="size-6 shrink-0" /> Settings
              </button>
            </li>
          </ul>
        </nav>
      )}
    </div>
  );
}

export function WorkspaceShell(props: ShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { account, theme, toggleTheme, signOut } = props;
  const navigate = (page: string) => {
    props.navigate(page);
    setSidebarOpen(false);
  };
  return (
    <div className="layout">
      <Dialog open={sidebarOpen && Boolean(account)} onClose={setSidebarOpen} className="fixed inset-0 z-50 lg:hidden">
        <DialogBackdrop transition className="fixed inset-0 bg-black/50 transition-opacity duration-300 data-closed:opacity-0" />
        <div className="fixed inset-0 flex">
          <DialogPanel transition className="shell-drawer relative mr-14 flex w-full max-w-xs flex-1 transition duration-300 ease-in-out data-closed:-translate-x-full">
            <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
            <TransitionChild>
              <div className="absolute top-0 left-full flex w-14 justify-center pt-4 transition duration-300 data-closed:opacity-0">
                <button type="button" onClick={() => setSidebarOpen(false)} className="p-2 text-white" aria-label="Close sidebar">
                  <XMarkIcon aria-hidden="true" className="size-6" />
                </button>
              </div>
            </TransitionChild>
            <SidebarNavigation {...props} navigate={navigate} />
          </DialogPanel>
        </div>
      </Dialog>

      {account && <aside className="shell-sidebar z-50 hidden flex-col lg:flex">
        <SidebarNavigation {...props} />
      </aside>}

      <div className={`shell-content min-w-0 ${account ? "shell-member" : ""}`}>
        {account ? <div className={topbarClass}>
          <Button type="button" onClick={() => setSidebarOpen(true)} variant="icon" className="shell-mobile-toggle" aria-label="Open sidebar">
            <Bars3Icon aria-hidden="true" className="size-6" />
          </Button>
          <form className="shell-search relative min-w-0 flex-1 lg:ml-auto" role="search" onSubmit={(event) => {
            event.preventDefault();
            const first = props.search(query)[0];
            if (first) { first.open(); setQuery(''); }
          }}>
            <MagnifyingGlassIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 size-5" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }} type="search" placeholder="Search" aria-label="Search conversations and tasks" />
            {query.trim() && (
              <div className="shell-search-results panel absolute top-full z-50 mt-2 w-full max-w-md">
                {props.search(query).length ? props.search(query).map((match, index) => (
                  <button key={index} type="button" onClick={() => { match.open(); setQuery(''); }}>{match.label}</button>
                )) : <p className="p-3 text-sm">No matches.</p>}
              </div>
            )}
          </form>
          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
            <Button type="button" variant="icon" className="relative" aria-label={`Conversation invitations (${props.invitationCount})`} onClick={() => navigate('chat')}>
              <BellIcon aria-hidden="true" className="size-6" />
              {props.invitationCount > 0 && <span className="shell-notification-dot" aria-hidden="true" />}
            </Button>
            <div className="shell-divider mx-1 hidden h-6 w-px sm:block" aria-hidden="true" />
            <Menu as="div" className="relative">
              <MenuButton className="flex items-center gap-3 rounded-md" aria-label="Open user menu">
                <span className="avatar rounded-full" aria-hidden="true">{account.initials}</span>
                <span className="hidden max-w-48 truncate text-sm/6 font-semibold sm:block">{account.name}</span>
                <ChevronDownIcon aria-hidden="true" className="shell-chevron hidden size-5 sm:block" />
              </MenuButton>
              <MenuItems transition className="shell-account-menu absolute right-0 z-10 mt-2.5 w-40 origin-top-right rounded-md border py-1.5 shadow-lg transition data-closed:scale-95 data-closed:opacity-0">
                <MenuItem><button type="button" onClick={() => navigate('admin')}>Workspace settings</button></MenuItem>
                <MenuItem><button type="button" onClick={() => { setSidebarOpen(false); signOut(); }}>Sign out</button></MenuItem>
              </MenuItems>
            </Menu>
          </div>
        </div> : <WorkspaceGuestTopbar theme={theme} toggleTheme={toggleTheme} />}
        {props.children}
      </div>
    </div>
  );
}
