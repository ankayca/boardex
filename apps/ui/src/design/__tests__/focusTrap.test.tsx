// The shared modal focus trap + Esc convention (Sprint 7 P0, §6.2 v2.3):
// stacked surfaces close topmost-first (a consuming handler stops propagation),
// Tab cycles inside the open surface, and focus restores to the invoking
// control on close.
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '../ConfirmDialog';
import { Drawer } from '../Drawer';
import { LogViewer } from '../LogViewer';

function StackedHarness() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setDrawerOpen(true)}>
        Open drawer
      </button>
      <Drawer open={drawerOpen} title="Evidence" onClose={() => setDrawerOpen(false)}>
        <button type="button" onClick={() => setConfirmOpen(true)}>
          Open confirm
        </button>
        <ConfirmDialog
          open={confirmOpen}
          title="Roll back this change?"
          confirmLabel="Rollback"
          onConfirm={() => setConfirmOpen(false)}
          onCancel={() => setConfirmOpen(false)}
        />
      </Drawer>
    </>
  );
}

describe('Esc closes only the topmost surface', () => {
  it('a confirm stacked over a drawer closes alone; the next Esc closes the drawer', async () => {
    const user = userEvent.setup();
    render(<StackedHarness />);

    await user.click(screen.getByRole('button', { name: 'Open drawer' }));
    await user.click(screen.getByRole('button', { name: 'Open confirm' }));
    expect(screen.getByRole('dialog', { name: 'Roll back this change?' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Roll back this change?' })).not.toBeInTheDocument();
    // The drawer beneath never saw the keypress.
    expect(screen.getByRole('dialog', { name: 'Evidence' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Evidence' })).not.toBeInTheDocument();
  });
});

describe('focus restore (§6.2 v2.3)', () => {
  it('closing the confirm restores focus into the drawer; closing the drawer restores the invoker', async () => {
    const user = userEvent.setup();
    render(<StackedHarness />);

    const opener = screen.getByRole('button', { name: 'Open drawer' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Open confirm' }));

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open confirm' }));

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(opener);
  });

  it('Tab cycles inside the open confirm — Shift+Tab from the first lands on the last', async () => {
    const user = userEvent.setup();
    render(<StackedHarness />);
    await user.click(screen.getByRole('button', { name: 'Open drawer' }));
    await user.click(screen.getByRole('button', { name: 'Open confirm' }));

    // autoFocus lands on Cancel (the first tabbable).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rollback' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rollback' }));
  });
});

describe('find-in-log Esc consumption', () => {
  function DrawerWithLog() {
    const [open, setOpen] = useState(true);
    return (
      <Drawer open={open} title="Evidence" onClose={() => setOpen(false)}>
        <LogViewer lines={['alpha', 'beta']} label="Serial log" />
      </Drawer>
    );
  }

  it('Esc with an active query clears the find WITHOUT closing the drawer', async () => {
    const user = userEvent.setup();
    render(<DrawerWithLog />);
    const find = screen.getByRole('textbox', { name: 'Find in Serial log' });
    await user.click(find);
    await user.keyboard('alp');
    expect(find).toHaveValue('alp');

    await user.keyboard('{Escape}');
    expect(find).toHaveValue('');
    expect(screen.getByRole('dialog', { name: 'Evidence' })).toBeInTheDocument();
  });

  it('Esc on an EMPTY find bubbles — the drawer is the topmost consumer', async () => {
    const user = userEvent.setup();
    render(<DrawerWithLog />);
    await user.click(screen.getByRole('textbox', { name: 'Find in Serial log' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Evidence' })).not.toBeInTheDocument();
  });
});
