// Context chips below the composer textarea (BIBLE §7.2): Board · Repo · Instruments
// · Safety, each backed by the selected BoardProfile and opening the details-on-demand
// Drawer (§6.2) with that section's detail.
import { useState } from 'react';
import type { BoardProfile } from '@boardex/contract';
import { Drawer, KeyValue } from '../../design';

type ChipKind = 'board' | 'repo' | 'instruments' | 'safety';

function repoBasename(repoPath: string): string {
  return repoPath.split('/').filter(Boolean).pop() ?? repoPath;
}

function Chip({ label, value, onOpen }: { label: string; value: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-panel px-3 py-1 text-meta transition-colors hover:border-border-strong hover:text-text-primary"
    >
      <span className="text-text-secondary">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </button>
  );
}

function DrawerBody({ kind, profile }: { kind: ChipKind; profile: BoardProfile }) {
  switch (kind) {
    case 'board':
      return (
        <div>
          <KeyValue label="Name" value={profile.name} />
          <KeyValue label="MCU" value={profile.mcu} />
          {profile.knownQuirks.length > 0 && (
            <div className="mt-4">
              <h3 className="text-meta font-medium text-text-secondary">Known quirks</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {profile.knownQuirks.map((quirk) => (
                  <li key={quirk} className="text-body text-text-primary">
                    {quirk}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    case 'repo':
      return (
        <div>
          <KeyValue label="Repo path" value={profile.repoPath} mono />
          <KeyValue label="Build" value={profile.buildCommand} mono />
          <KeyValue label="Flash" value={profile.flashCommand} mono />
          <KeyValue label="Reset" value={profile.resetCommand} mono />
        </div>
      );
    case 'instruments':
      return (
        <div>
          <KeyValue label="Debug probe" value={profile.instruments.debugProbe} />
          {profile.instruments.logicAnalyzer && (
            <KeyValue label="Logic analyzer" value={profile.instruments.logicAnalyzer} />
          )}
          <KeyValue label="Serial port" value={profile.serial.port} mono />
          <KeyValue label="Baud" value={String(profile.serial.baud)} mono />
        </div>
      );
    case 'safety':
      return (
        <div>
          <KeyValue label="Max iterations" value={String(profile.safety.maxIterations)} />
          <KeyValue
            label="Flash requires approval"
            value={profile.safety.flashRequiresApproval ? 'Yes' : 'No'}
          />
          <KeyValue label="Power" value={profile.safety.powerNote} />
        </div>
      );
  }
}

const DRAWER_TITLES: Record<ChipKind, string> = {
  board: 'Board',
  repo: 'Repo',
  instruments: 'Instruments',
  safety: 'Safety',
};

export function ContextChips({ profile }: { profile: BoardProfile }) {
  const [open, setOpen] = useState<ChipKind | null>(null);

  return (
    <div className="flex flex-wrap gap-2">
      <Chip label="Board" value={profile.name} onOpen={() => setOpen('board')} />
      <Chip label="Repo" value={repoBasename(profile.repoPath)} onOpen={() => setOpen('repo')} />
      <Chip
        label="Instruments"
        value={String(1 + (profile.instruments.logicAnalyzer ? 1 : 0))}
        onOpen={() => setOpen('instruments')}
      />
      <Chip
        label="Safety"
        value={profile.safety.flashRequiresApproval ? 'Flash gated' : 'Open'}
        onOpen={() => setOpen('safety')}
      />
      {open && (
        <Drawer open title={DRAWER_TITLES[open]} onClose={() => setOpen(null)}>
          <DrawerBody kind={open} profile={profile} />
        </Drawer>
      )}
    </div>
  );
}
