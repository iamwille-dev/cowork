import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, EllipsisHorizontalIcon } from '@heroicons/react/20/solid';

type Reminder = { ID: string; Text: string; Due: string; Author: string; Done: boolean };
type CalendarProps = {
  selected: Date;
  reminders: Reminder[];
  select: (day: Date) => void;
  add: () => void;
  complete: (id: string) => void;
};

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
const dueTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function dayKey(day: Date) {
  return [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((value) => String(value).padStart(2, '0')).join('-');
}

function ReminderRow({ reminder, complete }: { reminder: Reminder; complete: CalendarProps['complete'] }) {
  const initials = reminder.Author.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] ?? '').join('').toUpperCase();
  return (
    <li className="reminder-row relative flex items-start gap-x-4 py-5 xl:items-center">
      <span className="avatar shrink-0 rounded-full" aria-hidden="true">{initials}</span>
      <div className="min-w-0 flex-auto">
        <h3 className="pr-8 font-semibold">{reminder.Text}</h3>
        <dl className="reminder-meta mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-x-2">
            <dt><span className="sr-only">Due time</span><CalendarIcon aria-hidden="true" className="size-5" /></dt>
            <dd><time dateTime={reminder.Due}>{dueTime.format(new Date(reminder.Due))}</time></dd>
          </div>
          <div className="flex items-center gap-x-2">
            <dt className="sr-only">Added by</dt>
            <dd>{reminder.Author}</dd>
          </div>
        </dl>
      </div>
      {reminder.Done ? (
        <span className="status review">Completed</span>
      ) : (
        <Menu as="div" className="relative shrink-0">
          <MenuButton aria-label={`Options for ${reminder.Text}`} className="calendar-icon-button rounded-full">
            <EllipsisHorizontalIcon aria-hidden="true" className="size-5" />
          </MenuButton>
          <MenuItems transition className="shell-account-menu absolute right-0 z-10 mt-2 w-36 origin-top-right rounded-md border py-1 shadow-lg transition data-closed:scale-95 data-closed:opacity-0">
            <MenuItem><button type="button" onClick={() => complete(reminder.ID)}>Mark done</button></MenuItem>
          </MenuItems>
        </Menu>
      )}
    </li>
  );
}

export function ReminderCalendar({ selected, reminders, select, add, complete }: CalendarProps) {
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const start = new Date(year, month, 1);
  const leading = (start.getDay() + 6) % 7;
  const count = Math.ceil((leading + new Date(year, month + 1, 0).getDate()) / 7) * 7;
  const days = Array.from({ length: count }, (_, index) => new Date(year, month, index - leading + 1));
  const today = dayKey(new Date());
  const selectedKey = dayKey(selected);
  const grouped = new Map<string, Reminder[]>();
  for (const reminder of [...reminders].sort((a, b) => Date.parse(a.Due) - Date.parse(b.Due))) {
    const due = new Date(reminder.Due);
    if (Number.isNaN(due.getTime())) continue;
    const key = dayKey(due);
    const items = grouped.get(key) ?? [];
    items.push(reminder);
    grouped.set(key, items);
  }
  const entries = grouped.get(selectedKey) ?? [];

  return (
    <div className="reminder-layout lg:grid lg:grid-cols-12 lg:gap-x-12">
      <section className="calendar-picker panel text-center lg:col-start-8 lg:col-end-13 lg:row-start-1 xl:col-start-9" aria-label="Reminder calendar">
        <div className="flex items-center">
          <button type="button" className="calendar-icon-button" aria-label="Previous month" onClick={() => select(new Date(year, month - 1, 1))}>
            <ChevronLeftIcon aria-hidden="true" className="size-5" />
          </button>
          <h2 className="flex-auto text-sm font-semibold" aria-live="polite">{monthLabel.format(selected)}</h2>
          <button type="button" className="calendar-icon-button" aria-label="Next month" onClick={() => select(new Date(year, month + 1, 1))}>
            <ChevronRightIcon aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div className="calendar-weekdays mt-4 grid grid-cols-7 text-xs/6" aria-hidden="true">
          {weekdays.map((day) => <span key={day}>{day[0]}</span>)}
        </div>
        <div className="calendar-picker-grid isolate mt-2 grid grid-cols-7 gap-px overflow-hidden rounded-lg text-sm" aria-label="Calendar days">
          {days.map((day) => {
            const key = dayKey(day);
            const size = grouped.get(key)?.length ?? 0;
            const isToday = key === today;
            return (
              <button key={key} type="button" className="calendar-picker-day relative py-1.5 focus:z-10"
                data-current={day.getMonth() === month}
                aria-pressed={key === selectedKey}
                aria-current={isToday ? 'date' : undefined}
                aria-label={fullDate.format(day) + (size ? `, ${size} ${size === 1 ? 'reminder' : 'reminders'}` : '')}
                onClick={() => select(day)}>
                <time dateTime={key} className="mx-auto flex size-7 items-center justify-center rounded-full">{day.getDate()}</time>
                {size > 0 && <span className="calendar-reminder-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex gap-2">
          <button type="button" className="quiet" onClick={() => select(new Date())}>Today</button>
          <button type="button" className="primary flex-1" onClick={add}>Add reminder</button>
        </div>
      </section>
      <section className="panel reminder-agenda lg:col-span-7 lg:row-start-1 xl:col-span-8" aria-label="Daily agenda">
        <div className="reminder-agenda-header">
          <h2 className="font-semibold" aria-live="polite">{fullDate.format(selected)}</h2>
        </div>
        {entries.length ? (
          <ol role="list" className="px-5 text-sm/6">
            {entries.map((reminder) => <ReminderRow key={reminder.ID} reminder={reminder} complete={complete} />)}
          </ol>
        ) : <p className="p-5 text-sm">No reminders for this day.</p>}
      </section>
    </div>
  );
}
