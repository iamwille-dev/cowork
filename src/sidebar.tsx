import { useState } from 'react';
import {
  Dialog, DialogBackdrop, DialogPanel, DialogTitle, Menu, MenuButton, MenuItem, MenuItems, TransitionChild,
} from '@headlessui/react';
import {
  Bars3Icon, BellIcon, CalendarIcon, ChatBubbleLeftRightIcon, Cog6ToothIcon, FolderIcon, MoonIcon, SunIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { ChevronDownIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid';

const navigation = [
  { page: 'chat', name: 'Conversations', icon: ChatBubbleLeftRightIcon },
  { page: 'tasks', name: 'Tasks', icon: FolderIcon },
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
  return <a href="/" className="shell-brand" aria-label="Cowork home"><span aria-hidden="true">✳</span> cowork</a>;
}

function SidebarNavigation({ account, page, invitationCount, navigate }: ShellProps) {
  return (
    <div className="shell-sidebar-content flex grow flex-col gap-y-5 overflow-y-auto px-6 pb-4">
      <div className="flex h-16 shrink-0 items-center"><Brand /></div>
      {account && (
        <nav className="flex flex-1 flex-col" aria-label="Workspace">
          <ul role="list" className="flex flex-1 flex-col gap-y-7">
            <li>
              <ul role="list" className="-mx-2 space-y-1">
                {navigation.map((item) => (
                  <li key={item.page}>
                    <button type="button" onClick={() => navigate(item.page)} aria-current={page === item.page ? 'page' : undefined}
                      className="shell-nav-item group flex w-full items-center gap-x-3 rounded-md p-2 text-left text-sm/6 font-semibold">
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
            <li>
              <div className="shell-agent-label text-xs/6 font-semibold">Workspace agent</div>
              <div className="shell-agent mt-2 flex items-center gap-3 text-sm/6 font-semibold">
                <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-lg border text-xs">✳</span>
                <span className="truncate">{account.role}</span>
              </div>
            </li>
            <li className="mt-auto">
              <button type="button" onClick={() => navigate('admin')} aria-current={page === 'admin' ? 'page' : undefined}
                className="shell-nav-item -mx-2 flex w-[calc(100%+1rem)] items-center gap-x-3 rounded-md p-2 text-left text-sm/6 font-semibold">
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
  const ThemeIcon = theme === 'dark' ? SunIcon : MoonIcon;
  const navigate = (page: string) => {
    props.navigate(page);
    setSidebarOpen(false);
  };
  return (
    <div className="layout">
      <Dialog open={sidebarOpen && Boolean(account)} onClose={setSidebarOpen} className="fixed inset-0 z-50 lg:hidden">
        <DialogBackdrop transition className="fixed inset-0 bg-gray-900/80 transition-opacity duration-300 data-closed:opacity-0" />
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

      {account && <aside className="shell-sidebar fixed inset-y-0 z-50 hidden w-72 flex-col lg:flex">
        <SidebarNavigation {...props} />
      </aside>}

      <div className={`shell-content min-w-0 ${account ? "shell-member" : ""}`}>
        <div className="shell-topbar sticky top-0 z-40 flex h-16 shrink-0 items-center gap-4 px-4 sm:px-6 lg:px-8">
          {account && (
            <button type="button" onClick={() => setSidebarOpen(true)} className="shell-icon-button shell-mobile-toggle" aria-label="Open sidebar">
              <Bars3Icon aria-hidden="true" className="size-6" />
            </button>
          )}
          {!account && <Brand />}
          {account && (
            <form className="shell-search relative min-w-0 flex-1" role="search" onSubmit={(event) => {
              event.preventDefault();
              const first = props.search(query)[0];
              if (first) { first.open(); setQuery(''); }
            }}>
              <MagnifyingGlassIcon aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2 size-5" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }} type="search" placeholder="Search conversations and tasks" aria-label="Search conversations and tasks" />
              {query.trim() && (
                <div className="shell-search-results panel absolute top-full z-50 mt-2 w-full max-w-md">
                  {props.search(query).length ? props.search(query).map((match, index) => (
                    <button key={index} type="button" onClick={() => { match.open(); setQuery(''); }}>{match.label}</button>
                  )) : <p className="p-3 text-sm">No matches.</p>}
                </div>
              )}
            </form>
          )}
          <div className="ml-auto flex items-center gap-4">
            <button type="button" onClick={toggleTheme} className="shell-icon-button" aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <ThemeIcon aria-hidden="true" className="size-5" />
            </button>
            {account && (
              <>
                <button type="button" className="shell-icon-button relative" aria-label={`Conversation invitations (${props.invitationCount})`} onClick={() => navigate('chat')}>
                  <BellIcon aria-hidden="true" className="size-6" />
                  {props.invitationCount > 0 && <span className="shell-notification-dot" aria-hidden="true" />}
                </button>
                <div className="shell-divider h-6 w-px" aria-hidden="true" />
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
              </>
            )}
          </div>
        </div>
        {props.children}
      </div>
    </div>
  );
}
