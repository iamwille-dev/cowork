'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowDownTrayIcon, ArrowTopRightOnSquareIcon, ChevronRightIcon, DocumentIcon,
  FolderIcon, FolderPlusIcon, MagnifyingGlassIcon, PencilSquareIcon, TrashIcon,
} from '@heroicons/react/24/outline';
import { api } from './api';
import { Button, buttonClassName } from './button';
import { Input, Textarea } from './input';
import { Modal } from './forms';
import styles from './drive.module.css';

type Item = {
  ID: string; Name: string; Kind: 'file' | 'folder'; Size: number; Editable: boolean; Revision: number; UpdatedAt: string;
};
type Artifact = { ID: string; Name: string; TaskTitle: string; URL: string };
type Event = { ID: number; At: string; ActorName: string; AgentName: string; Source: string; Action: string; ItemName: string };
type Folder = { ID: string; Name: string };
type Listing = {
  items: Item[]; trail: Folder[]; artifactFolders: (Folder & { Count: number })[]; artifacts: Artifact[]; more: boolean;
};
type Activity = { events: Event[]; more: boolean };
type Area = 'files' | 'artifacts' | 'activity';
type Editor = { type: 'folder' | 'upload' } | { type: 'edit' | 'delete'; item: Item; text?: string };

const areas = { files: 'Files', artifacts: 'Task artifacts', activity: 'Access log' };
const actions: Record<string, string> = {
  list: 'Listed', search: 'Searched', read: 'Read', download: 'Downloaded', open: 'Opened',
  create: 'Created', edit: 'Edited', delete: 'Deleted',
};
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` :
  bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const date = (value: string, seconds = false) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: seconds ? 'medium' : 'short' });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Cowork could not complete the drive operation.';
const download = (id: string) => '/api/drive/download?id=' + encodeURIComponent(id);

async function encodeUpload(file: File) {
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a file up to 5 MiB.');
  const encoded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  return encoded.slice(encoded.indexOf(',') + 1);
}

export function SharedDrive({ owner }: { owner: boolean }) {
  const [area, setArea] = useState<Area>('files');
  const [parent, setParent] = useState('');
  const [phrase, setPhrase] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [listing, setListing] = useState<Listing>();
  const [activity, setActivity] = useState<Activity>();
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [editError, setEditError] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams({ page: String(page), parent, q: query });
    if (area === 'artifacts') params.set('area', area);
    setLoading(true);
    setError('');
    setListing(undefined);
    setActivity(undefined);
    const request = area === 'activity'
      ? api<Activity>('drive/activity?' + params).then((result) => { if (current) setActivity(result); })
      : api<Listing>('drive/list?' + params).then((result) => { if (current) setListing(result); });
    void request.catch((error: unknown) => {
      if (current) setError(errorMessage(error));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [area, page, parent, query, reload]);

  function browse(nextArea: Area, folder = '') {
    setError('');
    setNotice('');
    setArea(nextArea);
    setParent(folder);
    setPage(0);
    setPhrase('');
    setQuery('');
  }

  async function openEditor(item: Item) {
    setNotice('');
    setError('');
    setEditError('');
    setWorking(true);
    try {
      if (item.Editable) {
        const loaded = await api<{ item: Item; text: string }>('drive/read?id=' + encodeURIComponent(item.ID));
        setEditor({ type: 'edit', item: loaded.item, text: loaded.text });
      } else {
        setEditor({ type: 'edit', item });
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || working) return;
    const fields = new FormData(event.currentTarget);
    setWorking(true);
    setEditError('');
    try {
      const name = String(fields.get('name') ?? '').trim();
      if ((editor.type === 'edit' || editor.type === 'folder') && !name) {
        throw new Error('Enter a name.');
      }
      const selected = fields.get('file');
      const replacement = selected instanceof File && selected.name ? await encodeUpload(selected) : undefined;
      if ('item' in editor) {
        const { item, type } = editor;
        const editedText = fields.get('text');
        const changes = type === 'edit' ? {
          Name: name !== item.Name ? name : undefined,
          Text: replacement === undefined && typeof editedText === 'string' && editedText !== editor.text?.replace(/\r\n?/g, '\n') ? editedText : undefined,
          Content: replacement,
        } : {};
        if (type === 'edit' && Object.values(changes).every((value) => value === undefined)) {
          throw new Error('Change the name or contents before saving.');
        }
        const saved = await api<Item>('drive/' + type, { ID: item.ID, Revision: item.Revision, ...changes });
        setNotice(type === 'delete' ? `Deleted ${item.Name}.` : `Saved ${saved.Name}.`);
      } else {
        const upload = editor.type === 'upload';
        if (upload && !(selected instanceof File && selected.name)) throw new Error('Choose a file to upload.');
        const newName = upload && selected instanceof File ? selected.name : name;
        await api('drive/create', { ParentID: parent, Name: newName, Kind: upload ? 'file' : 'folder', Content: replacement });
        setNotice(upload ? `Uploaded ${newName}.` : `Created ${newName}.`);
      }
      setEditor(undefined);
      setPage(0);
      setReload((value) => value + 1);
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  const hasRows = area === 'activity' ? activity?.events.length :
    area === 'files' ? listing?.items.length : listing?.artifactFolders.length || listing?.artifacts.length;
  const more = area === 'activity' ? activity?.more : listing?.more;
  const title = editor?.type === 'edit' ? `Edit ${editor.item.Name}` : editor?.type === 'delete' ? `Delete ${editor.item.Name}?` :
    editor?.type === 'upload' ? 'Upload file' : 'New folder';

  return <section className={`page ${styles.drive}`} aria-label="Shared drive">
    <nav className={styles.areas} aria-label="Drive views">
      {(Object.keys(areas) as Area[]).filter((entry) => owner || entry !== 'activity').map((entry) =>
        <button key={entry} type="button" aria-pressed={area === entry} onClick={() => browse(entry)}>{areas[entry]}</button>)}
    </nav>

    <div className={styles.toolbar}>
      {area !== 'activity' && <nav className={styles.breadcrumbs} aria-label="Current folder">
        <Button variant="quiet" onClick={() => browse(area)} aria-current={!parent && !query ? 'location' : undefined}>
          {area === 'files' ? 'All files' : 'All task artifacts'}
        </Button>
        {!query && listing?.trail.map((folder, index) => <div key={folder.ID}>
          <ChevronRightIcon className="size-4 shrink-0" aria-hidden="true" />
          <Button variant="quiet" onClick={() => browse(area, folder.ID)} aria-current={index === listing.trail.length - 1 ? 'location' : undefined}>{folder.Name}</Button>
        </div>)}
        {query && <span className={styles.searchLocation}>Search results</span>}
      </nav>}
      {area !== 'activity' && <form className={styles.search} aria-label="Drive search" role="search" onSubmit={(event) => {
        event.preventDefault();
        setPage(0);
        setQuery(phrase.trim());
        setReload((value) => value + 1);
      }}>
        <Input type="search" value={phrase} onChange={(event) => {
          setPhrase(event.target.value);
          if (!event.target.value) { setQuery(''); setPage(0); }
        }} maxLength={120} placeholder={area === 'files' ? 'Search files' : 'Search artifacts'} aria-label={area === 'files' ? 'Search files' : 'Search artifacts'} />
        <Button type="submit" variant="icon" aria-label="Search drive"><MagnifyingGlassIcon className="size-5" aria-hidden="true" /></Button>
      </form>}
      {area === 'files' && !query && <div className={styles.controls}>
        <Button variant="quiet" disabled={working || loading} onClick={() => { setEditError(''); setEditor({ type: 'folder' }); }}>
          <FolderPlusIcon className="size-4" aria-hidden="true" /> New folder
        </Button>
        <Button disabled={working || loading} onClick={() => { setEditError(''); setEditor({ type: 'upload' }); }}>Upload file</Button>
      </div>}
      {area === 'activity' && <Button variant="quiet" onClick={() => { setPage(0); setReload((value) => value + 1); }}>Refresh log</Button>}
    </div>

    {notice && <p role="status" className={styles.message}>{notice}</p>}
    {error && <div className={styles.message} role="alert">
      {error} <Button variant="quiet" onClick={() => setReload((value) => value + 1)}>Reload drive</Button>
    </div>}

    <div className="panel" aria-busy={loading}>
      {loading ? <p className={styles.empty} role="status">Loading {areas[area].toLowerCase()}…</p> :
        area === 'files' ? <ul className={styles.rows} aria-label="Files and folders">
          {listing?.items.map((item) => {
            const icon = item.Kind === 'folder' ? <FolderIcon aria-hidden="true" /> : <DocumentIcon aria-hidden="true" />;
            return <li key={item.ID} className={styles.row}>
              {item.Kind === 'folder' || item.Editable ?
                <button type="button" className={styles.entry} disabled={working} onClick={() => item.Kind === 'folder' ? browse('files', item.ID) : void openEditor(item)}>
                  {icon}<span>{item.Name}</span>
                </button> :
                <a className={styles.entry} href={download(item.ID)}>{icon}<span>{item.Name}</span></a>}
              <div className={styles.metadata}>{item.Kind === 'folder' ? 'Folder' : size(item.Size)}<br /><time dateTime={item.UpdatedAt}>{date(item.UpdatedAt)}</time></div>
              <div className={styles.rowActions}>
                {item.Kind === 'file' && <a className={buttonClassName('icon')} href={download(item.ID)} aria-label={`Download ${item.Name}`}><ArrowDownTrayIcon className="size-4" aria-hidden="true" /></a>}
                <Button variant="icon" disabled={working} onClick={() => void openEditor(item)} aria-label={`Edit ${item.Name}`}><PencilSquareIcon className="size-4" aria-hidden="true" /></Button>
                <Button variant="icon" disabled={working} onClick={() => { setEditError(''); setEditor({ type: 'delete', item }); }} aria-label={`Delete ${item.Name}`}><TrashIcon className="size-4" aria-hidden="true" /></Button>
              </div>
            </li>;
          })}
        </ul> : area === 'artifacts' ? <ul className={styles.rows} aria-label="Task artifacts">
          {listing?.artifactFolders.map((folder) => <li key={folder.ID} className={styles.row}>
            <button type="button" className={styles.entry} onClick={() => browse('artifacts', folder.ID)}>
              <FolderIcon aria-hidden="true" />
              <span>{folder.Name}<small>{folder.Count} {folder.Count === 1 ? 'artifact' : 'artifacts'}</small></span>
              <ChevronRightIcon aria-hidden="true" />
            </button>
          </li>)}
          {listing?.artifacts.map((artifact) => <li key={artifact.ID} className={styles.row}>
            <a className={styles.entry} href={artifact.URL} target="_blank" rel="noreferrer">
              <DocumentIcon aria-hidden="true" />
              <span>{artifact.Name}{query && <small>{artifact.TaskTitle}</small>}</span>
              <ArrowTopRightOnSquareIcon aria-hidden="true" />
            </a>
          </li>)}
        </ul> : <ul className={styles.rows} aria-label="Drive access history">
          {activity?.events.map((entry) => <li key={entry.ID} className={`${styles.row} ${styles.event}`}>
            <div><strong>{actions[entry.Action] ?? entry.Action}</strong><span className={styles.target}>{entry.ItemName}</span></div>
            <div><strong>{entry.AgentName || entry.ActorName}</strong>
              <small>{entry.AgentName ? `${entry.Source === 'task' ? 'Task for' : 'Chat with'} ${entry.ActorName}` : 'Workspace member'}</small>
            </div>
            <time dateTime={entry.At}>{date(entry.At, true)}</time>
          </li>)}
        </ul>}
      {!loading && !error && !hasRows &&
        <p className={styles.empty}>{query ? 'No matches found.' : area === 'files' ? 'This folder is empty.' : area === 'artifacts' ? 'No task artifacts yet.' : 'No drive activity yet.'}</p>}
    </div>

    {!loading && (page > 0 || more) && <div className={styles.pagination} aria-label="Drive pages">
      <Button variant="quiet" onClick={() => setPage(page - 1)} disabled={page === 0}>Previous</Button>
      <span>Page {page + 1}</span>
      <Button variant="quiet" onClick={() => setPage(page + 1)} disabled={!more}>Next</Button>
    </div>}

    {editor && <Modal title={title} close={() => { if (!working) setEditor(undefined); }}>
      <form className="stack" onSubmit={(event) => void save(event)}>
        {editor.type === 'delete' ? <p>{editor.item.Kind === 'folder'
          ? 'Empty the folder before deleting it. Deletion is permanent.' : 'This file will be permanently deleted from the shared drive.'}</p> : <>
          {editor.type !== 'upload' && <label>Name<Input name="name" defaultValue={editor.type === 'edit' ? editor.item.Name : ''} required maxLength={180} /></label>}
          {editor.type === 'edit' && editor.text !== undefined && <label>File contents<Textarea name="text" rows={10} defaultValue={editor.text} /></label>}
          {(editor.type === 'upload' || (editor.type === 'edit' && editor.item.Kind === 'file')) &&
            <label>{editor.type === 'upload' ? 'File (up to 5 MiB)' : 'Replace file (optional)'}
              <Input name="file" type="file" required={editor.type === 'upload'} />
            </label>}
        </>}
        {editError && <p role="alert">{editError}</p>}
        <Button type="submit" className="justify-self-start" disabled={working}>{working ? 'Saving…' : editor.type === 'delete' ? 'Delete' :
          editor.type === 'upload' ? 'Upload' : editor.type === 'folder' ? 'Create folder' : 'Save changes'}</Button>
      </form>
    </Modal>}
  </section>;
}
