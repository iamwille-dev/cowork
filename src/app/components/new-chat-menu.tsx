import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { ChevronDownIcon, PlusIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { agentCatalog, type WorkspaceAgent } from '../lib/workspace-agents';
import { Button } from './button';

export function NewChatMenu({ agents, busy, opening, onChoose }: {
  agents: WorkspaceAgent[];
  busy: boolean;
  opening: boolean;
  onChoose: (agentID: string) => void;
}) {
  return <Menu>
    <MenuButton as={Button} disabled={busy || opening} aria-busy={opening}>
      <PlusIcon className="size-4" aria-hidden="true" />
      {opening ? 'Opening chat…' : 'New chat'}
      <ChevronDownIcon className="size-4" aria-hidden="true" />
    </MenuButton>
    <MenuItems className="panel new-chat-menu" anchor={{ to: 'bottom end', gap: 8, padding: 12 }} modal={false}>
      {agents.map(({ ID, Name, Role }) => {
        const Icon = agentCatalog.find(({ role }) => role === Role)?.icon ?? SparklesIcon;
        return <MenuItem as="button" type="button" key={ID} disabled={busy || opening} onClick={() => onChoose(ID)}>
          <Icon className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 wrap-anywhere">
            <strong className="block font-semibold">{Name}</strong>
            {ID && Role && Name !== Role && <small className="block">{Role}</small>}
          </span>
        </MenuItem>;
      })}
    </MenuItems>
  </Menu>;
}
